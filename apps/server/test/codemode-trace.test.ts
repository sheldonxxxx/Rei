// Code mode Trace links (ticket 04): a script's nested calls are steps whose parent is the script's step, the script's
// step keeps its code, its output and its call list, and nothing the nested calls returned reaches the model.

import type { LiveTool, SessionTraceResponse, StepDetailResponse, StepSummary } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../src/blobs/blob-store.ts";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { StepRecorder } from "../src/pi/steps.ts";
import { toStep } from "../src/trace.ts";
import { systemClock } from "../src/util/clock.ts";
import { nullLogger } from "../src/util/log.ts";
import { tool as directive } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { type ExecServer, startExecServer } from "./helpers/exec.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, homeChat, say, settled, stepPayloads } from "./helpers/sessions.ts";

let server: TestServer | undefined;
let exec: ExecServer | undefined;
afterEach(async () => {
  await server?.destroy();
  await exec?.destroy();
  server = undefined;
  exec = undefined;
});

const setCodeMode = async (s: TestServer) => {
  const res = await s.client.call("PUT", "/api/settings/behavior", { body: { codeMode: { enabled: true } } });
  expect(res.status).toBe(200);
};
const script = (code: string) => directive("codemode", { code });
const trace = async (s: TestServer, id: string, query = ""): Promise<SessionTraceResponse> =>
  (await s.client.get(`/api/sessions/${id}/trace${query}`)).body;
const toolSteps = async (s: TestServer, id: string): Promise<StepSummary[]> =>
  (await trace(s, id)).runs.flatMap((r) => r.steps).filter((x) => x.type === "tool.call");
const stepDetail = async (s: TestServer, stepId: string): Promise<StepDetailResponse> =>
  (await s.client.get(`/api/steps/${stepId}`)).body;

/** An option line the model may add: the step keeps the code as given, this line included. */
const CODE = `// @options: {"timeout_ms": 60000}
const a = await tools.list_sessions({});
const b = await tools.list_sessions({});
console.log("listed twice: " + (a.length + b.length));`;

describe("code mode in the Trace", () => {
  it("records the script as one step and each nested call as a step under it", async () => {
    server = await startSignedIn();
    const id = homeChat(server);
    await setCodeMode(server);
    await say(server, id, script(CODE));
    const done = await settled(server, id, 1);
    expect(done.runs.map((r) => r.status)).toEqual(["completed"]);

    const steps = await toolSteps(server, id);
    const scripts = steps.filter((x) => x.toolName === "codemode");
    const nested = steps.filter((x) => x.toolName === "list_sessions");
    expect(scripts).toHaveLength(1);
    expect(nested).toHaveLength(2);
    const [parent] = scripts;
    expect(parent!.parentStepId).toBeUndefined();
    for (const n of nested) {
      expect(n.parentStepId).toBe(parent!.id);
      expect(n.toolCallId).toMatch(new RegExp(`^${parent!.toolCallId}/`));
      // The same run, so a script and its calls are always on the same trace page.
      expect(n.runId).toBe(parent!.runId);
      expect(n.status).toBe("ok");
    }
    // Old steps and direct calls carry no parent.
    expect(steps.filter((x) => x.parentStepId === undefined)).toEqual(scripts);
  });

  it("keeps the code with its options line, Pi's output and the call list with the script's step", async () => {
    server = await startSignedIn();
    const id = homeChat(server);
    await setCodeMode(server);
    await say(server, id, script(CODE));
    await settled(server, id, 1);
    const [parent] = (await toolSteps(server, id)).filter((x) => x.toolName === "codemode");
    const detail = await stepDetail(server, parent!.id);
    expect(detail.tool!.input).toEqual({ code: CODE });
    expect(detail.tool!.output.map((p) => (p.type === "text" ? p.text : "")).join("")).toContain("listed twice: ");
    expect(detail.tool!.script!.calls).toMatchObject([
      { id: 1, name: "list_sessions", status: "ok" },
      { id: 2, name: "list_sessions", status: "ok" },
    ]);
    expect(detail.tool!.script!.calls[0]!.durationMs).toBeGreaterThanOrEqual(0);
    // The temp file of a cut output is a host path and stays out.
    expect(JSON.stringify(detail.tool)).not.toContain("fullOutputPath");
    // A direct call has no script details.
    const [first] = (await toolSteps(server, id)).filter((x) => x.toolName === "list_sessions");
    expect((await stepDetail(server, first!.id)).tool!.script).toBeUndefined();
  });

  it("never lets a nested call's output reach the model: the script's result is the only result", async () => {
    server = await startSignedIn();
    const id = homeChat(server);
    await setCodeMode(server);
    // The marker is built at run time, so it is not in the script's text, which the model does see.
    await say(
      server,
      id,
      script(`const r = await tools.demo_add_todo({ text: "NESTED-" + "MARKER" });\nconsole.log("added one");`),
    );
    await settled(server, id, 1);
    const steps = await toolSteps(server, id);
    const scriptStep = steps.find((x) => x.toolName === "codemode")!;
    const nested = steps.find((x) => x.parentStepId === scriptStep.id)!;
    expect((await stepDetail(server, nested.id)).tool!.output).toEqual([
      { type: "text", text: 'Added the to-do "NESTED-MARKER".' },
    ]);
    const afterScript = stepPayloads(server, id).at(-1)!;
    expect(afterScript).toContain("added one");
    // What the nested call took and returned is in the Trace only, and so is its call id.
    // (The faux model's request is Pi's whole message list, which carries the script's `details`, arguments included;
    // a provider is sent the content only. The nested call's output is not in it either way.)
    expect(afterScript).not.toContain('Added the to-do \\"NESTED-MARKER\\"');
    expect(afterScript).not.toContain(`${scriptStep.toolCallId}/`);
  });

  it("sets parentCallId on a running script's nested live slots", async () => {
    exec = await startExecServer();
    const id = homeChat(exec);
    await setCodeMode(exec);
    await say(exec, id, script(`await tools.bash({ command: ${JSON.stringify(`sleep 3`)} }); console.log("done");`));
    const live = await until(
      async () => {
        const tools = ((await exec!.client.get(`/api/sessions/${id}`)).body.live?.tools ?? []) as LiveTool[];
        return tools.some((t) => t.nested) ? tools : undefined;
      },
      10_000,
      "the nested call to show as live",
    );
    const parent = live.find((t) => t.name === "codemode")!;
    const nested = live.find((t) => t.nested)!;
    expect(parent.parentCallId).toBeUndefined();
    expect(nested.parentCallId).toBe(parent.callId);
    expect(nested.callId.startsWith(`${parent.callId}/`)).toBe(true);
    await settled(exec, id, 1);
    await exec.host.plane.codemode.idle();
  });

  it("pages a script with its calls: even a call recorded under another run joins its script's run", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const store = server.host.plane.store;
    const recorder = new StepRecorder(store.db, new MemoryBlobStore(), systemClock, nullLogger);
    const begin = (toolCallId: string, runId: string, parentToolCallId?: string) =>
      recorder.beginTool({
        sessionId: id,
        runId,
        toolCallId,
        toolName: "t",
        actionClass: null,
        summary: null,
        input: {},
        parentToolCallId,
      });
    const row = (stepId: string) =>
      store.db.get<{ run_id: string | null; parent_step_id: string | null }>(
        "SELECT run_id, parent_step_id FROM steps WHERE id = ?",
        stepId,
      )!;
    const script = begin("call_s", "run_a");
    const child = begin("call_s/c1", "run_b", "call_s");
    expect(row(child)).toEqual({ run_id: "run_a", parent_step_id: script });
    // A replayed hook finds the same step.
    expect(begin("call_s/c1", "run_b", "call_s")).toBe(child);
    // A nested call whose script's step is missing still records, without a parent, in its own run.
    const orphan = begin("call_x/c1", "run_b", "call_x");
    expect(row(orphan)).toEqual({ run_id: "run_b", parent_step_id: null });
  });

  it("reads old steps without a parent as before", () => {
    const db = openSqliteDb(":memory:");
    initializeDatabase(db);
    db.run(
      "INSERT INTO steps (id, run_id, session_id, type, status, started_at, side_effect, tool_name) VALUES ('stp_old', 'run_1', 'ses_1', 'tool.call', 'ok', 1, 0, 'bash')",
    );
    const row = db.get<Parameters<typeof toStep>[0]>("SELECT * FROM steps WHERE id = 'stp_old'")!;
    expect(row.parent_step_id).toBeNull();
    expect("parentStepId" in toStep(row, "ses_1")).toBe(false);
  });

  it("gives an existing database the column and index on its next start", () => {
    const db = openSqliteDb(":memory:");
    initializeDatabase(db);
    expect(db.all<{ name: string }>("PRAGMA table_info(steps)").map((c) => c.name)).toContain("parent_step_id");
    expect(db.all<{ name: string }>("PRAGMA index_list(steps)").map((i) => i.name)).toContain("steps_parent");
    // The path of an installation that has the older schema: drop both, start again, they come back.
    db.exec("DROP INDEX steps_parent");
    db.exec("ALTER TABLE steps DROP COLUMN parent_step_id");
    initializeDatabase(db);
    expect(db.all<{ name: string }>("PRAGMA table_info(steps)").map((c) => c.name)).toContain("parent_step_id");
    expect(db.all<{ name: string }>("PRAGMA index_list(steps)").map((i) => i.name)).toContain("steps_parent");
  });
});
