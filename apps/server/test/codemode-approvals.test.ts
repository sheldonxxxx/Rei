// Code mode approvals (ticket 03): a nested call that needs approval parks on the single-task path while its script
// waits on the promise; approving runs it once, and earlier writes in the script are never repeated. In trigger sessions
// a nested ask blocks at once. When the script ends first (deadline or Stop), the approval is withdrawn and says why.

import type { Trigger } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { TriggerFields } from "../src/triggers/spec.ts";
import { decide, tool as directive, effects, pending, waitPending } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { FakeMcpGateway, tool as mcpTool } from "./helpers/fake-mcp.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, childrenOf, detail, homeChat, restart, say, settled, stepPayloads } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const setCodeMode = async (s: TestServer) => {
  const res = await s.client.call("PUT", "/api/settings/behavior", { body: { codeMode: { enabled: true } } });
  expect(res.status).toBe(200);
};
const script = (code: string) => directive("codemode", { code });
const effectTools = (s: TestServer) => effects(s).map((e) => e.tool);
const lastAssistant = async (s: TestServer, id: string) =>
  (await detail(s, id)).messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
/** What the model got back last: the script's output. */
const scriptOutput = (s: TestServer, id: string) => stepPayloads(s, id).at(-1) ?? "";
const rowsOf = (s: TestServer, id: string) =>
  s.host.plane.store.db.all<{ id: string }>("SELECT id FROM approvals WHERE session_id = ?", id);
const codemodeCallId = (s: TestServer, id: string) =>
  s.host.plane.store.db.get<{ tool_call_id: string }>(
    "SELECT tool_call_id FROM steps WHERE session_id = ? AND tool_name = 'codemode'",
    id,
  )?.tool_call_id;

/** A write that runs at once (standard profile), then a send that asks. */
const WRITE_THEN_SEND = `await tools.demo_add_todo({ text: "milk" });
try {
  await tools.demo_send_message({ to: "sam", text: "hi" });
  console.log("sent");
} catch (e) {
  console.log("not sent: " + String((e && e.message) || e));
}
console.log("finished");`;

async function parked(s: TestServer, id: string) {
  await setCodeMode(s);
  await say(s, id, script(WRITE_THEN_SEND));
  const [approval] = await waitPending(s, id);
  expect(approval).toMatchObject({ tool: "demo_send_message", status: "pending", resumesTool: true });
  expect(effectTools(s)).toEqual(["demo_add_todo"]);
  return approval!;
}

async function withdrawn(s: TestServer, id: string, approvalId: string) {
  await until(
    async () => (s.host.plane.approvals.row(approvalId)?.status !== "pending" ? true : undefined),
    10_000,
    "the approval to leave pending",
  );
  const card = (await detail(s, id)).messages.find((m) => m.approval?.id === approvalId)!;
  expect(card.approval).toMatchObject({ status: "cancelled", cancelReason: "script_ended" });
  expect(card.text).toContain("the script that asked for this ended");
  expect((await pending(s)).filter((a) => a.sessionId === id)).toEqual([]);
}

describe("approvals inside a script", () => {
  it("parks the nested call: approve runs it once and the script finishes without repeating the write", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const approval = await parked(server, id);
    const row = server.host.plane.approvals.row(approval.id)!;
    expect(row.tool_task_id).not.toBeNull();
    // The card names the script's call, and the view model anchors it to the nested task under that call.
    const scriptCall = codemodeCallId(server, id);
    expect(scriptCall).toBeDefined();
    expect(approval.parentCallId).toBe(scriptCall);
    const view = await server.host.plane.adapter.views.view(id, { limit: 50 });
    const overlay = view.overlays.find((o) => view.items.find((i) => i.id === o.itemId)?.approval?.id === approval.id);
    expect(overlay?.anchor).toEqual({ taskId: row.tool_task_id, parentCallId: scriptCall });

    expect((await decide(server, approval.id, { decision: "approve" })).status).toBe(200);
    const done = await settled(server, id, 1);
    expect(done.runs.map((r) => r.status)).toEqual(["completed"]);
    expect(await lastAssistant(server, id)).toContain("sent");
    expect(await lastAssistant(server, id)).toContain("finished");
    expect(effectTools(server)).toEqual(["demo_add_todo", "demo_send_message"]);
    expect(done.messages.find((m) => m.approval?.id === approval.id)?.approval).toMatchObject({
      status: "approved",
      execution: "ran",
    });
  });

  it("rejects the promise with the denial text when denied", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const approval = await parked(server, id);
    expect((await decide(server, approval.id, { decision: "deny" })).status).toBe(200);
    await settled(server, id, 1);
    const text = scriptOutput(server, id);
    expect(text).toContain("not sent: ");
    expect(text).toContain(`Approval #${approval.number} was denied`);
    expect(text).toContain("finished");
    expect(effectTools(server)).toEqual(["demo_add_todo"]);
  });

  it("lets the parent approve a worker's nested call while the script waits", async () => {
    server = await startSignedIn();
    await setCodeMode(server);
    const parent = homeChat(server);
    await say(server, parent, `[spawn: ${script(WRITE_THEN_SEND)}]`);
    const worker = await until(async () => (await childrenOf(server!, parent))[0], 10_000, "the worker session");
    const [approval] = await waitPending(server, worker.id);
    expect(approval).toMatchObject({ tool: "demo_send_message", resumesTool: true });
    expect((await detail(server, parent)).messages.some((message) => message.approval?.id === approval!.id)).toBe(true);
    expect(effectTools(server)).toEqual(["demo_add_todo"]);

    expect((await decide(server, approval!.id, { decision: "approve" })).status).toBe(200);
    await settled(server, worker.id);
    expect(effectTools(server)).toEqual(["demo_add_todo", "demo_send_message"]);
  });

  it("survives a restart while parked: approving afterwards runs the call once and the script finishes", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const approval = await parked(server, id);
    server = await restart(server);
    await until(
      async () => ((await pending(server!)).some((a) => a.id === approval.id) ? true : undefined),
      10_000,
      "the approval to still be pending",
    );
    expect((await decide(server, approval.id, { decision: "approve" })).status).toBe(200);
    const done = await settled(server, id, 1);
    expect(done.runs.map((r) => r.status)).toEqual(["completed"]);
    expect(await lastAssistant(server, id)).toContain("finished");
    expect(effectTools(server)).toEqual(["demo_add_todo", "demo_send_message"]);
    // The replayed script reattached to the parked call: no second approval.
    expect(rowsOf(server, id)).toHaveLength(1);
  });

  it("withdraws the approval when the run is stopped while parked", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const approval = await parked(server, id);
    expect((await server.client.post(`/api/sessions/${id}/cancel`)).status).toBe(200);
    await withdrawn(server, id, approval.id);
    expect(effectTools(server)).toEqual(["demo_add_todo"]);
    await server.host.plane.codemode.idle();
    expect(server.host.plane.codemode.workers).toBe(0);
  });

  it("withdraws the approval when the script's deadline passes while parked, and the result says why", async () => {
    server = await startSignedIn({
      config: { codemode: { timeoutMs: 1500, memoryLimitBytes: 128 * 1024 * 1024, maxWorkers: 4 } },
    });
    const id = await chat(server);
    const approval = await parked(server, id);
    await settled(server, id, 1);
    await withdrawn(server, id, approval.id);
    expect(scriptOutput(server, id)).toMatch(/time(d)? ?out/i);
    expect(effectTools(server)).toEqual(["demo_add_todo"]);
    // Approving a withdrawn card does nothing.
    expect((await decide(server, approval.id, { decision: "approve" })).status).not.toBe(200);
    expect(effectTools(server)).toEqual(["demo_add_todo"]);
    await server.host.plane.codemode.idle();
    expect(server.host.plane.codemode.workers).toBe(0);
  });

  it("blocks a nested ask at once in a trigger run, without a checkpoint", async () => {
    server = await startSignedIn();
    await setCodeMode(server);
    const triggers = server.host.plane.triggers;
    const fields: TriggerFields = {
      name: "Script trigger",
      start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "UTC" } },
      action: { kind: "prompt", prompt: script(WRITE_THEN_SEND) },
      landing: "new",
      report: "on_change",
      hideInList: true,
      latenessMinutes: 120,
      catchUp: "once",
      overlap: "skip",
      profile: "standard",
      // The write is allowed for this trigger; the send is not, so it asks.
      allow: [{ tool: "demo_add_todo" }],
    };
    const t: Trigger = triggers.store.create({
      agentId: server.host.plane.store.defaultAgentId()!,
      createdBySessionId: null,
      fields,
    });
    expect((await server.client.post(`/api/triggers/${t.id}/run`, {})).status).toBe(200);
    const run = await until(
      () => {
        const r = triggers.store.runsOfTrigger(t.id).at(-1);
        return r?.session_id ? r : undefined;
      },
      20_000,
      "the trigger run's session",
    );
    const id = run.session_id!;
    const [approval] = await waitPending(server, id);
    expect(approval).toMatchObject({ tool: "demo_send_message", status: "pending" });
    expect(approval!.resumesTool).toBeUndefined();
    expect(approval!.parentCallId).toBeUndefined();
    expect(server.host.plane.approvals.row(approval!.id)!.tool_task_id).toBeNull();
    // The script did not wait: it got the "needs approval" error and finished, and so did the run.
    // (The trigger's run stays "waiting" while its approval is pending; the session's own run has ended.)
    const done = await settled(server, id, 1);
    expect(done.runs.map((r) => r.status)).toEqual(["completed"]);
    const output = scriptOutput(server, id);
    expect(output).toContain(`needs the user's approval (#${approval!.number})`);
    expect(output).toContain("finished\\n</console_output>");
    expect(effectTools(server)).toEqual(["demo_add_todo"]);
    await server.host.plane.codemode.idle();
    expect(server.host.plane.codemode.workers).toBe(0);
  });

  it("parks a script's connector call on its bound approval and runs it once at the MCP boundary", async () => {
    const gw = new FakeMcpGateway();
    gw.add("con_notes", "Notes", [mcpTool("add_note", "Create a new note with a title and body.")]);
    server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
    const id = await chat(server);
    await setCodeMode(server);
    await say(server, id, script('await tools.notes__add_note({ q: "milk" }); console.log("noted");'));
    const [approval] = await waitPending(server, id);
    expect(approval).toMatchObject({ tool: "notes__add_note", resumesTool: true });
    expect(approval!.parentCallId).toBe(codemodeCallId(server, id));
    expect(gw.calls).toEqual([]);
    expect((await decide(server, approval!.id, { decision: "approve" })).status).toBe(200);
    const done = await settled(server, id, 1);
    expect(done.runs.map((r) => r.status)).toEqual(["completed"]);
    expect(scriptOutput(server, id)).toContain("Script completed");
    expect(gw.calls.map(({ tool, args }) => ({ tool, args }))).toEqual([{ tool: "add_note", args: { q: "milk" } }]);
  });
});
