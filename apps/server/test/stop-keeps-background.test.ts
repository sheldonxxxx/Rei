import type { SessionReport, TriggerMessage } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { AdmitInput } from "../src/conversation/commands.ts";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, homeChat, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const report: SessionReport = { sessionId: "ses_child", title: "Worker", outcome: "completed", summary: "Done" };
const trigger: TriggerMessage = {
  kind: "report",
  triggerId: "trg_1",
  triggerName: "Check",
  triggerRunId: "trr_1",
  sessionId: null,
  text: "Nothing changed",
};

const background: Record<string, Pick<AdmitInput, "role" | "text" | "modelText" | "report" | "trigger" | "from">> = {
  report: { role: "report", text: "Worker finished", modelText: "[Session report] Worker finished", report },
  trigger: { role: "trigger", text: "Nothing changed", modelText: "[Trigger result] Nothing changed", trigger },
  brief: { role: "user", text: "Look into this", from: { sessionId: "ses_parent", title: "Parent" } },
};

async function runLong(s: TestServer, id: string) {
  await say(s, id, "long one [len=20000]");
  await until(async () => ((await detail(s, id)).runs[0]?.status === "running" ? true : undefined));
}
const stop = (s: TestServer, id: string) => s.client.post(`/api/sessions/${id}/cancel`, {});
const admit = (s: TestServer, sessionId: string, name: keyof typeof background, requestId: string) =>
  s.host.plane.adapter.commands.admit({ sessionId, requestId, ...background[name]! });

describe("Stop and inputs their sender cannot resend", () => {
  for (const name of ["report", "trigger", "brief"] as const) {
    it(`keeps a queued ${name} through Stop and answers it once the stopped run settles`, async () => {
      server = await startSignedIn();
      const id = await chat(server);
      await runLong(server, id);
      const { runId } = await admit(server, id, name, `bg-${name}`);
      expect((await stop(server, id)).status).toBe(200);
      const d = await settled(server, id, 2);
      expect(d.runs.map((r) => [r.id === runId, r.status])).toEqual([
        [false, "cancelled"],
        [true, "completed"],
      ]);
      const input = d.messages.find((m) => m.runId === runId && m.role !== "assistant");
      expect(input?.status).not.toBe("aborted");
      expect(d.messages.filter((m) => m.role === "assistant" && m.runId === runId)).toHaveLength(1);
      // The session is not left busy: a plain message goes straight through.
      await say(server, id, "Hello");
      expect((await settled(server, id, 3)).runs.at(-1)?.status).toBe("completed");
    });
  }

  it("still withdraws a queued user message and shows it cancelled, while keeping the report behind it", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await runLong(server, id);
    await say(server, id, "queued behind it");
    const { runId } = await admit(server, id, "report", "bg-mixed");
    await stop(server, id);
    const d = await settled(server, id, 3);
    expect(d.runs.map((r) => r.status)).toEqual(["cancelled", "cancelled", "completed"]);
    expect(d.messages.find((m) => m.role === "user" && m.text === "queued behind it")).toMatchObject({
      status: "aborted",
    });
    expect(d.runs[2]?.id).toBe(runId);
  });

  it("answers every kept input once, in one pass, when several are queued", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await runLong(server, id);
    await admit(server, id, "report", "bg-1");
    await admit(server, id, "trigger", "bg-2");
    await stop(server, id);
    const d = await settled(server, id, 3);
    expect(d.runs.map((r) => r.status)).toEqual(["cancelled", "completed", "completed"]);
  });

  it("Stop ends a report that is being answered right now", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await admit(server, id, "report", "bg-live");
    // The report's reply is long enough to still be running when Stop arrives.
    await server.host.plane.adapter.commands.admit({
      sessionId: id,
      requestId: "bg-live-long",
      role: "report",
      text: "Second",
      modelText: "[Session report] long one [len=20000]",
      report,
    });
    await until(async () => ((await detail(server!, id)).runs.some((r) => r.status === "running") ? true : undefined));
    await stop(server, id);
    const d = await settled(server, id, 2);
    expect(d.runs.some((r) => r.status === "cancelled")).toBe(true);
  });

  it("lets the agent dismiss the reply to a kept report", async () => {
    server = await startSignedIn();
    const home = homeChat(server);
    await runLong(server, home);
    const { runId } = await server.host.plane.adapter.commands.admit({
      sessionId: home,
      requestId: "bg-quiet",
      role: "report",
      text: "Worker finished",
      modelText: "[Session report] Nothing to add [dismiss-event]",
      report,
    });
    await stop(server, home);
    const d = await settled(server, home, 2);
    expect(d.runs.at(-1)).toMatchObject({ id: runId, status: "completed" });
    expect(server.host.plane.store.getRun(runId)!.silent).toBe(1);
  });

  it("withdraws a queued report when the caller ends the work on purpose (session deletion, cancel_session)", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await runLong(server, id);
    const { runId } = await admit(server, id, "report", "bg-withdrawn");
    await server.host.plane.adapter.commands.cancel(id, { withdrawAll: true });
    const d = await settled(server, id, 2);
    expect(d.runs.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(d.messages.find((m) => m.runId === runId && m.role !== "assistant")).toMatchObject({ status: "aborted" });
    expect(d.messages.filter((m) => m.runId === runId && m.role === "assistant")).toHaveLength(0);
  });

  it("deletes a session that has a kept report queued without answering it", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await runLong(server, id);
    await admit(server, id, "report", "bg-deleted");
    expect((await server.client.raw("DELETE", `/api/sessions/${id}`)).status).toBe(200);
    expect(server.host.plane.store.getSessionRow(id)).toBeUndefined();
    expect(server.host.plane.store.nonTerminalRuns(id)).toHaveLength(0);
  });
});
