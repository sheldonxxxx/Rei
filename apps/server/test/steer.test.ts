import { afterEach, describe, expect, it } from "vitest";
import { steers } from "../src/conversation/commands.ts";
import { until, ViewReader } from "./helpers/client.ts";
import { bash, type ExecServer, startExecServer } from "./helpers/exec.ts";
import { chat, detail, settled } from "./helpers/sessions.ts";

let server: ExecServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const send = (s: ExecServer, id: string, text: string, extra: Record<string, unknown> = {}) =>
  s.client.post(`/api/sessions/${id}/messages`, { requestId: crypto.randomUUID(), text, ...extra });
/** A message whose reply is one slow tool round: the steer is sent while the command sleeps. */
const SLOW = `${bash("sleep 2; echo slept")} check the build`;
const setWhenBusy = (s: ExecServer, whenBusy: "steer" | "queue") =>
  s.client.call("PUT", "/api/settings/behavior", { body: { chat: { whenBusy } } });
/** Waits until the session's first run has a tool call going. */
const toolRunning = (s: ExecServer, id: string) =>
  until(
    async () => {
      const d = await detail(s, id);
      return d.runs[0]?.status === "running" && s.host.plane.store.latestModelStep(d.runs[0].id) ? d : undefined;
    },
    10_000,
    "the tool round to start",
  );

describe("steering a running reply", () => {
  it("defaults to steer: the message joins the running reply after its tool round and gets the answer", async () => {
    server = await startExecServer();
    const s = server;
    expect((await s.client.get("/api/settings/behavior")).body.settings.chat).toEqual({ whenBusy: "steer" });
    const id = await chat(s);
    const sse = new ViewReader(await s.sse(`/api/sessions/${id}/stream`));
    const first = await send(s, id, SLOW);
    await toolRunning(s, id);
    const steer = await send(s, id, "use pnpm instead [len=900]");
    const steerItem = `u:${steer.body.runId}`;
    // Waiting for the tool round to end: labeled as a steer.
    const waiting = await sse.waitForView((v) => v.items.some((i) => i.id === steerItem && i.status === "pending"));
    expect(waiting.items.find((i) => i.id === steerItem)?.steer).toBe(true);
    // Placed: what the model writes now streams under the steer, and the first message's reply is not streaming.
    const placed = await sse.waitForView(
      (v) =>
        v.live.runId === steer.body.runId &&
        v.items.some((i) => i.runId === steer.body.runId && i.role === "assistant" && i.text.length > 0),
    );
    expect(
      placed.items.some((i) => i.runId === first.body.runId && i.role === "assistant" && i.status === "streaming"),
    ).toBe(false);
    expect(placed.runs.find((r) => r.id === first.body.runId)?.status).toBe("running");

    const d = await settled(s, id, 2);
    expect(d.runs.map((r) => r.status)).toEqual(["completed", "completed"]);
    // One answer, under the steer; the first message's tool-only part shows nothing of its own.
    expect(d.messages.map((m) => [m.role, m.runId])).toEqual([
      ["user", first.body.runId],
      ["user", steer.body.runId],
      ["assistant", steer.body.runId],
    ]);
    expect(d.messages.at(-1)?.text).toContain("Echo: use pnpm instead");
    expect(d.messages.at(-1)?.status).toBe("complete");
    expect(d.session.status).toBe("idle");
    await sse.close();
  });

  it("queues instead when the setting says queue, and a per-message whenBusy overrides the setting", async () => {
    server = await startExecServer();
    const s = server;
    expect((await setWhenBusy(s, "queue")).status).toBe(200);
    const id = await chat(s);
    const first = await send(s, id, SLOW);
    await toolRunning(s, id);
    const queued = await send(s, id, "then run the tests");
    const d = await settled(s, id, 2);
    expect(d.messages.map((m) => [m.role, m.runId])).toEqual([
      ["user", first.body.runId],
      ["assistant", first.body.runId],
      ["user", queued.body.runId],
      ["assistant", queued.body.runId],
    ]);
    expect(d.messages[1]?.text).toContain("slept");
    expect(d.messages.some((m) => m.steer)).toBe(false);

    // The setting queues; this one message steers.
    const second = await send(s, id, SLOW);
    await until(
      async () => {
        const run = (await detail(s, id)).runs.find((r) => r.id === second.body.runId);
        return run?.status === "running" && s.host.plane.store.latestModelStep(run.id);
      },
      10_000,
      "the second tool round",
    );
    const steer = await send(s, id, "stop, wrong branch", { whenBusy: "steer" });
    const after = await settled(s, id, 4);
    const tail = after.messages.slice(-3).map((m) => [m.role, m.runId]);
    expect(tail).toEqual([
      ["user", second.body.runId],
      ["user", steer.body.runId],
      ["assistant", steer.body.runId],
    ]);
  });

  it("queues a message sent with whenBusy queue although the setting steers", async () => {
    server = await startExecServer();
    const s = server;
    const id = await chat(s);
    const first = await send(s, id, SLOW);
    await toolRunning(s, id);
    const queued = await send(s, id, "afterwards, summarize", { whenBusy: "queue" });
    const d = await settled(s, id, 2);
    expect(d.messages.map((m) => [m.role, m.runId])).toEqual([
      ["user", first.body.runId],
      ["assistant", first.body.runId],
      ["user", queued.body.runId],
      ["assistant", queued.body.runId],
    ]);
  });

  it("withdraws a waiting steer on Stop, like a queued message", async () => {
    server = await startExecServer();
    const s = server;
    const id = await chat(s);
    await send(s, id, `${bash("sleep 5; echo slept")} slow`);
    await toolRunning(s, id);
    const steer = await send(s, id, "change course");
    expect((await s.client.post(`/api/sessions/${id}/cancel`)).status).toBe(200);
    const d = await settled(s, id, 2);
    expect(d.runs.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    const item = d.messages.find((m) => m.id === `u:${steer.body.runId}`);
    expect(item?.status).toBe("aborted");
    expect(d.messages.filter((m) => m.role === "assistant" && m.runId === steer.body.runId)).toHaveLength(0);
  });

  it("refuses an unknown whenBusy value in the settings", async () => {
    server = await startExecServer();
    const s = server;
    const res = await s.client.call("PUT", "/api/settings/behavior", { body: { chat: { whenBusy: "interrupt" } } });
    expect(res.status).toBe(400);
  });
});

describe("who can steer", () => {
  it("is only your own typed message in one of your chats", () => {
    const own = { role: "user" as const, whenBusy: "steer" as const };
    for (const origin of ["home", "user", "fork", "import"]) expect(steers(own, origin)).toBe(true);
    for (const origin of ["spawned", "trigger"]) expect(steers(own, origin)).toBe(false);
    expect(steers({ ...own, whenBusy: "queue" }, "user")).toBe(false);
    expect(steers({ role: "user" }, "user")).toBe(false);
    // Background input always queues: a report, a trigger result, another agent's message, a parent's brief.
    expect(steers({ ...own, role: "report" }, "home")).toBe(false);
    expect(steers({ ...own, role: "trigger" }, "home")).toBe(false);
    expect(steers({ ...own, from: { sessionId: "ses_1", title: "Worker" } }, "user")).toBe(false);
    expect(steers({ ...own, assignedBy: "ses_parent" }, "user")).toBe(false);
  });
});
