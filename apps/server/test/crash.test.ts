import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Approval, Message, Run, SessionTraceResponse } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Child, STANDIN, setUpAccount, startChild } from "./helpers/child.ts";
import { until } from "./helpers/client.ts";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.ts";
import { FakeMcpGateway, tool } from "./helpers/fake-mcp.ts";

let dir: string;
let child: Child | undefined;
let gateway: FakeGateway | undefined;
afterEach(async () => {
  if (child && child.proc.exitCode === null) await child.kill();
  child = undefined;
  await gateway?.close();
  gateway = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Detail = { session: { status: string }; messages: Message[]; runs: Run[] };

async function boot(env: Record<string, string> | ((dir: string) => Record<string, string>) = {}) {
  dir = mkdtempSync(join(tmpdir(), "rei-crash-"));
  writeFileSync(join(dir, "standin.txt"), `${STANDIN}\n`, { mode: 0o600 });
  child = await startChild(dir, typeof env === "function" ? env(dir) : env);
  await setUpAccount(child, dir);
  const session = (await child.client.post("/api/sessions", {})).body.session;
  return session as { id: string };
}

/** A new process on the same folder, signed in with the cookie the old one issued. */
async function reboot(env: Record<string, string> = {}) {
  const cookie = child!.client.cookie;
  child = await startChild(dir, env);
  child.client.cookie = cookie;
}

const detail = async (id: string) => (await child!.client.get(`/api/sessions/${id}`)).body as Detail;
/** The epoch of the session stream's first snapshot (a new process watches the conversation in a new epoch). */
const epochOf = async (id: string) => {
  const res = await child!.client.raw("GET", `/api/sessions/${id}/stream`);
  const reader = res.body!.getReader();
  let text = "";
  const decoder = new TextDecoder();
  while (!/\nevent: snapshot\ndata: .*\n/.test(`\n${text}`)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  const m = /event: snapshot\ndata: (.*)\n/.exec(text);
  return (JSON.parse(m![1]!) as { epoch: string }).epoch;
};
function readdirRecursive(at: string): string[] {
  return readdirSync(at).flatMap((name) => {
    const path = join(at, name);
    return statSync(path).isDirectory() ? readdirRecursive(path) : [path];
  });
}
const assistantsOf = (d: Detail, runId: string) =>
  d.messages.filter((m) => m.role === "assistant" && m.runId === runId);

describe("kill -9 around an approved MCP write", () => {
  it.each(["waiting for approval", "during dispatch"])("recovers when killed %s", async (when) => {
    const duringDispatch = when === "during dispatch";
    const fixture = new FakeMcpGateway();
    fixture.add("con_notes", "Notes", [tool("add_note", "Create a note.")]);
    gateway = await startFakeGateway({ bearer: STANDIN, mcp: { fixture, hangCalls: duringDispatch } });
    const env = { GATEWAY_URL: gateway.url };
    const { id } = await boot(env);
    const args = { q: "buy milk" };
    const sent = await child!.client.post(`/api/sessions/${id}/messages`, {
      requestId: "mcp-write",
      text: `[tool: notes__add_note ${JSON.stringify(args)}]`,
    });
    expect(sent.status).toBe(200);
    const getPending = async () => ((await child!.client.get("/api/approvals")).body.approvals as Approval[])[0];
    const approval = await until(getPending, 10_000, "the write approval");
    expect(approval).toMatchObject({ resumesTool: true, status: "pending" });
    expect(fixture.calls).toHaveLength(0);
    const approve = async () => {
      const response = await child!.client.post(`/api/approvals/${approval.id}/decide`, { decision: "approve" });
      expect(response.status).toBe(200);
    };
    if (duringDispatch) {
      await approve();
      await until(() => fixture.calls[0], 10_000, "the gateway to receive the write");
    }
    await child!.kill();
    await reboot(env);
    if (!duringDispatch) {
      expect(await getPending()).toMatchObject({ id: approval.id, status: "pending" });
      expect(fixture.calls).toHaveLength(0);
      await approve();
    }
    const finished = await until(
      async () => {
        const d = await detail(id);
        return d.runs[0]?.status === "completed" ? d : undefined;
      },
      15_000,
      "the original run to finish",
    );
    expect(finished.runs.map(({ id }) => id)).toEqual([sent.body.runId]);
    expect(fixture.calls.map(({ tool, args }) => ({ tool, args }))).toEqual([{ tool: "add_note", args }]);
    expect(finished.messages.find((m) => m.approval?.id === approval.id)?.approval).toMatchObject({
      status: "approved",
      execution: duringDispatch ? "interrupted" : "ran",
    });
  });
});

describe("kill -9 during a tool call", () => {
  it("does not run the interrupted command again, and shows the call as interrupted", async () => {
    const env = (at: string) => ({ REI_EXEC: "local", REI_EXEC_ROOT: join(at, "ws") });
    const session = await boot(env);
    const command = 'echo ran >> "$PWD/marker.txt"; sleep 20';
    await child!.client.post(`/api/sessions/${session.id}/messages`, {
      requestId: "t-1",
      text: `[tool: bash ${JSON.stringify({ command })}]`,
    });
    const marker = () => {
      try {
        return readdirRecursive(join(dir, "ws"))
          .filter((f) => f.endsWith("marker.txt"))
          .map((f) => readFileSync(f, "utf8"));
      } catch {
        return [];
      }
    };
    await until(() => (marker().join("").includes("ran") ? true : undefined), 15_000, "the command to start");
    await child!.kill();
    await reboot(env(dir));
    const d = await until(
      async () => {
        const x = await detail(session.id);
        return x.runs[0] && x.runs[0].status !== "running" && x.runs[0].status !== "queued" ? x : undefined;
      },
      30_000,
      "the run to end",
    );
    expect(marker().join("").match(/ran/g)).toHaveLength(1);
    const trace = (await child!.client.get(`/api/sessions/${session.id}/trace`)).body as SessionTraceResponse;
    const recoveredRun = trace.runs.find((r) => r.run.id === d.runs[0]!.id);
    expect(recoveredRun).toBeDefined();
    const call = recoveredRun!.steps.find((s) => s.type === "tool.call" && s.toolName === "bash");
    // Pi supplies the interrupted result on recovery; the public contract calls that not_executed.
    expect(call).toMatchObject({ runId: d.runs[0]!.id, status: "not_executed", errorCode: "interrupted" });
    expect(d.runs[0]!.status).not.toBe("running");
  });
});

describe("kill -9 mid-reply", () => {
  it("restarts into one assistant message, a finished run, and a new stream epoch", async () => {
    const session = await boot({ REI_FAUX_TPS: "150" });
    const sent = (
      await child!.client.post(`/api/sessions/${session.id}/messages`, {
        requestId: "crash-1",
        text: "write something long [len=3000]",
      })
    ).body;
    await until(
      async () => (await detail(session.id)).messages.some((m) => m.role === "assistant" && m.text.length > 100),
      15_000,
      "streaming to start",
    );
    const before = await detail(session.id);
    expect(before.runs[0]!.status).toBe("running");
    const epochBefore = await epochOf(session.id);

    await child!.kill();
    await reboot({ REI_FAUX_TPS: "600" });

    // The new process finishes the work, or fails it cleanly; there is never a second assistant message for the run.
    const after = await until(
      async () => {
        const d = await detail(session.id);
        return d.runs[0] && !["queued", "running"].includes(d.runs[0].status) ? d : undefined;
      },
      30_000,
      "the run to settle after the restart",
    );
    expect(["completed", "failed"]).toContain(after.runs[0]!.status);
    const replies = assistantsOf(after, sent.runId);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.id).toBe(before.messages.find((m) => m.role === "assistant")!.id);
    if (after.runs[0]!.status === "completed") {
      expect(replies[0]!.status).toBe("complete");
      expect(replies[0]!.text.length).toBe(3000);
    } else {
      expect(replies[0]!.status).toBe("error");
      expect(replies[0]!.error?.code).toBeTruthy();
    }
    expect(after.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(await epochOf(session.id)).not.toBe(epochBefore);
    // The model call the kill cut off is closed in the Trace as interrupted, not left running in a finished run.
    const trace = (await child!.client.get(`/api/sessions/${session.id}/trace`)).body as {
      runs: { steps: { type: string; status: string; errorCode?: string | null }[] }[];
    };
    const calls = trace.runs.flatMap((r) => r.steps).filter((s) => s.type === "llm.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((s) => s.status === "running")).toEqual([]);
    expect(calls[0]).toMatchObject({ status: "error", errorCode: "interrupted" });

    // Resending the same requestId after the crash returns the same ids and starts nothing.
    const again = (
      await child!.client.post(`/api/sessions/${session.id}/messages`, {
        requestId: "crash-1",
        text: "write something long [len=3000]",
      })
    ).body;
    expect(again).toEqual(sent);
    await new Promise((r) => setTimeout(r, 600));
    const final = await detail(session.id);
    expect(final.runs).toHaveLength(1);
    expect(assistantsOf(final, sent.runId)).toHaveLength(1);

    // The chat is usable again.
    await child!.client.post(`/api/sessions/${session.id}/messages`, { requestId: "crash-2", text: "still there?" });
    const next = await until(
      async () => {
        const d = await detail(session.id);
        return d.runs.length === 2 && d.runs[1]!.status === "completed" ? d : undefined;
      },
      20_000,
      "the next run",
    );
    expect(next.session.status).toBe("idle");
  });

  // Pi 1.5 counts a host stop mid-answer as a failed attempt, so recovery needs the retries production has.
  it("recovers a queued message that never reached Pi", async () => {
    const session = await boot({ REI_FAUX_TPS: "150", REI_RETRY_MAX: "2", REI_RETRY_BASE_MS: "50" });
    await child!.client.post(`/api/sessions/${session.id}/messages`, { requestId: "q-a", text: "first [len=3000]" });
    const queued = (
      await child!.client.post(`/api/sessions/${session.id}/messages`, { requestId: "q-b", text: "second" })
    ).body;
    await until(
      async () => (await detail(session.id)).messages.some((m) => m.role === "assistant" && m.text.length > 50),
      15_000,
      "streaming",
    );
    await child!.kill();
    await reboot({ REI_FAUX_TPS: "600", REI_RETRY_MAX: "2", REI_RETRY_BASE_MS: "50" });
    const after = await until(
      async () => {
        const d = await detail(session.id);
        return d.runs.length === 2 && d.runs.every((r) => !["queued", "running"].includes(r.status)) ? d : undefined;
      },
      30_000,
      "both runs to settle",
    );
    expect(after.runs.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(assistantsOf(after, queued.runId)).toHaveLength(1);
    expect(after.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("ends a run that keeps killing the server with a truthful run failure, and takes new messages", async () => {
    const session = await boot({ REI_FAUX_TPS: "100", REI_RESTART_LIMIT: "1" });
    const sent = (
      await child!.client.post(`/api/sessions/${session.id}/messages`, {
        requestId: "p-1",
        text: "never ends [len=20000]",
      })
    ).body;
    for (let i = 0; i < 3; i++) {
      await until(
        async () => {
          const d = await detail(session.id);
          return d.runs[0]!.status !== "running" || d.messages.some((m) => m.role === "assistant" && m.text.length > 30)
            ? true
            : undefined;
        },
        15_000,
        `streaming (kill ${i})`,
      );
      if ((await detail(session.id)).runs[0]!.status !== "running") break;
      await child!.kill();
      await reboot({ REI_FAUX_TPS: "100", REI_RESTART_LIMIT: "1" });
    }
    const d = await until(
      async () => {
        const x = await detail(session.id);
        return x.runs[0]!.status === "failed" ? x : undefined;
      },
      20_000,
      "the run to fail",
    );
    expect(d.runs[0]!.error?.code).toMatch(/^(restart_limit|interrupted)$/);
    expect(assistantsOf(d, sent.runId).length).toBeLessThanOrEqual(1);
    expect(d.session.status).toBe("failed");
    // A new message still goes through.
    await child!.client.post(`/api/sessions/${session.id}/messages`, { requestId: "p-2", text: "hello again" });
    await until(async () => (await detail(session.id)).runs[1]?.status === "completed", 20_000, "the next run");
  });

  it("shuts down cleanly on SIGTERM and keeps the data", async () => {
    const session = await boot();
    await child!.client.post(`/api/sessions/${session.id}/messages`, { requestId: "t-1", text: "hello" });
    await until(async () => (await detail(session.id)).runs[0]?.status === "completed", 15_000, "reply");
    expect(await child!.stop()).toBe(0);
    await reboot();
    const d = await detail(session.id);
    expect(d.messages).toHaveLength(2);
    expect(d.session.status).toBe("idle");
  });
});
