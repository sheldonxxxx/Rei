// End to end: Code mode in a real server process (src/main.ts, faux model). The model's script reads two records, adds
// a to-do (runs at once), then sends a message (asks). The send parks on its approval card while the script waits; the
// process is killed (kill -9) while it is parked, started again on the same data, and the approval is granted. The
// script must finish, with the write and the send each made once and one approval row in all. Only tools a script may
// call are used (`list_sessions` and the like are model-only).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Approval, SessionTraceResponse, StepSummary } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Child, STANDIN, setUpAccount, startChild } from "../../apps/server/test/helpers/child.ts";
import { until } from "../../apps/server/test/helpers/client.ts";

let dir: string | undefined;
let child: Child | undefined;
afterEach(async () => {
  if (child && child.proc.exitCode === null) await child.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
  child = dir = undefined;
});

const SCRIPT = `const titles = [];
for (const id of ["rec-01", "rec-02"]) {
  const page = await tools.demo_read_record({ id });
  titles.push(String(page).split("\\n")[0]);
}
await tools.demo_add_todo({ text: "chase two invoices" });
try {
  await tools.demo_send_message({ to: "sam", text: "chased" });
  console.log("sent");
} catch (e) {
  console.log("not sent: " + String((e && e.message) || e));
}
console.log("read " + titles.length + " records; finished");`;

type Detail = {
  runs: { id: string; status: string }[];
  messages: { role: string; text: string; approval?: Approval }[];
};
const detail = async (c: Child, id: string) => (await c.client.get(`/api/sessions/${id}`)).body as Detail;
const trace = async (c: Child, id: string) =>
  (await c.client.get(`/api/sessions/${id}/trace`)).body as SessionTraceResponse;
const steps = async (c: Child, id: string): Promise<StepSummary[]> =>
  (await trace(c, id)).runs.flatMap((r) => r.steps).filter((s) => s.type === "tool.call");
const pendingFor = async (c: Child, id: string) =>
  ((await c.client.get("/api/approvals")).body.approvals as Approval[]).filter((a) => a.sessionId === id);

describe("end to end: a script with nested calls, a nested approval and a restart while it is parked", () => {
  it("resumes after a kill -9, runs the approved call once and does not repeat the write", async () => {
    dir = mkdtempSync(join(tmpdir(), "code-mode-e2e-"));
    writeFileSync(join(dir, "standin.txt"), `${STANDIN}\n`, { mode: 0o600 });
    child = await startChild(dir);
    await setUpAccount(child, dir);
    const on = await child.client.call("PUT", "/api/settings/behavior", { body: { codeMode: { enabled: true } } });
    expect(on.status).toBe(200);
    expect(on.body.settings?.codeMode ?? on.body.codeMode).toMatchObject({ enabled: true });
    const sessionId = (await child.client.post("/api/sessions", {})).body.session.id as string;

    const sent = await child.client.post(`/api/sessions/${sessionId}/messages`, {
      requestId: "code-mode-e2e",
      text: `[tool: codemode ${JSON.stringify({ code: SCRIPT, _activity: "Chase two invoices" })}]`,
    });
    expect(sent.status).toBe(200);

    // The send asks; its card resumes that one call and says which script asked.
    const [approval] = await until(
      async () => {
        const list = await pendingFor(child!, sessionId);
        return list.length === 1 ? list : undefined;
      },
      30_000,
      "the nested approval",
    );
    expect(approval).toMatchObject({ tool: "demo_send_message", status: "pending", resumesTool: true });
    expect(approval!.parentCallId).toBeTruthy();

    // Before the restart: one script step, its calls linked to it, the write done, the send not.
    const before = await steps(child, sessionId);
    const script = before.find((s) => s.toolName === "codemode")!;
    expect(script).toBeDefined();
    const nested = before.filter((s) => s.parentStepId === script.id).map((s) => s.toolName);
    expect(nested).toEqual(expect.arrayContaining(["demo_read_record", "demo_add_todo"]));
    expect(nested.filter((n) => n === "demo_read_record")).toHaveLength(2);
    expect(before.filter((s) => s.toolName === "demo_add_todo")).toHaveLength(1);

    // kill -9 while the call is parked, then a new process on the same data and the same sign-in.
    const cookie = child.client.cookie;
    await child.kill();
    child = await startChild(dir);
    child.client.cookie = cookie;

    await until(
      async () => ((await pendingFor(child!, sessionId)).some((a) => a.id === approval!.id) ? true : undefined),
      30_000,
      "the approval to be pending after the restart",
    );
    const decided = await child.client.post(`/api/approvals/${approval!.id}/decide`, { decision: "approve" });
    expect(decided.status).toBe(200);

    const done = await until(
      async () => {
        const d = await detail(child!, sessionId);
        return d.runs.length > 0 && d.runs.every((r) => !["queued", "running"].includes(r.status)) ? d : undefined;
      },
      45_000,
      "the run to finish",
    );
    expect(done.runs.map((r) => r.status)).toEqual(["completed"]);
    expect(done.messages.filter((m) => m.approval)).toHaveLength(1);
    expect(done.messages.find((m) => m.approval)?.approval).toMatchObject({ status: "approved", execution: "ran" });

    // Each effect once, however often the script replayed; the script's output is what the model got.
    const after = await steps(child, sessionId);
    expect(after.filter((s) => s.toolName === "demo_add_todo" && s.status === "ok")).toHaveLength(1);
    expect(after.filter((s) => s.toolName === "demo_send_message" && s.status === "ok")).toHaveLength(1);
    // The script's step holds what the model got: the printed output, fenced because the records are outside content.
    const scriptStep = after.find((s) => s.toolName === "codemode")!;
    const output = JSON.stringify((await child.client.get(`/api/steps/${scriptStep.id}`)).body.tool.output);
    expect(output).toContain("<<<page-content");
    expect(output).toContain("sent");
    expect(output).not.toContain("not sent");
    expect(output).toContain("read 2 records; finished");
    expect(await pendingFor(child, sessionId)).toEqual([]);

    // Turning Code mode off again takes the tool away without a restart.
    const off = await child.client.call("PUT", "/api/settings/behavior", { body: { codeMode: { enabled: false } } });
    expect(off.status).toBe(200);
    const settings = (await child.client.get("/api/settings/behavior")).body;
    expect(settings.settings?.codeMode ?? settings.codeMode).toMatchObject({ enabled: false });
  });
});
