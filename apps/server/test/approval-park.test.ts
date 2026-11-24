// Approval gates park on Pi signals: a pending approval holds no Pi invocation, and every rerun of the gates (a wake, a
// registry publication, an open) reads the same rows and gives the same answer, with no second row, notice or call.

import type { JsonObject } from "@earendil-works/pi-durable";
import type { Approval, LiveTool } from "@rei/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunRow } from "../src/conversation/runs.ts";
import { ConnectorToolDirectory, createConnectorToolsExtension } from "../src/mcp/connector-tools.ts";
import { createPolicyExtension, POLICY_MEMO, ToolCatalog } from "../src/pi/policy-ext.ts";
import { ApprovalWake } from "../src/pi/signals.ts";
import { GLOBAL_STREAM } from "../src/store/events.ts";
import { nullLogger } from "../src/util/log.ts";
import { decide, tool as directive, pending, waitPending } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { FakeMcpGateway, tool } from "./helpers/fake-mcp.ts";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.destroy();
  server = undefined;
});

const world = (): FakeMcpGateway => {
  const gw = new FakeMcpGateway();
  gw.add("con_notes", "Notes", [
    tool("search_notes", "Search the user's notes by text.", { readOnlyHint: true }, "Search notes"),
    tool("add_note", "Create a new note with a title and body."),
  ]);
  gw.add("con_cal", "Calendar", [tool("list_events", "List calendar events in a date range.", { readOnlyHint: true })]);
  return gw;
};
const start = async (gw: FakeMcpGateway) => {
  server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
  return server;
};
const treeOf = (s: TestServer, id: string) =>
  s.host.plane.adapter.trees.get(s.host.plane.store.getSessionRow(id)!.tree_id)!;
/** Pi's view of the tree's work: inactive once every live call is parked. */
const inactive = (s: TestServer, id: string) =>
  until(async () => (treeOf(s, id).harness.wake().active ? undefined : true), 10_000, "the tree to go inactive");
const liveTools = async (s: TestServer, id: string): Promise<LiveTool[]> =>
  ((await s.client.get(`/api/sessions/${id}`)).body.live?.tools ?? []) as LiveTool[];
const rowsOf = (s: TestServer, id: string) =>
  s.host.plane.store.db.all<{ id: string }>("SELECT id FROM approvals WHERE session_id = ?", id);
const notices = (s: TestServer, id: string) =>
  s.host.plane.store.db.all<{ request_id: string }>(
    "SELECT request_id FROM outbox WHERE session_id = ? AND kind = 'notify' AND request_id LIKE 'notify:approval:%'",
    id,
  );
/** Approvals announced with `status` from now on (a gate that made a second row would announce it as pending). */
const announcements = (s: TestServer, status: Approval["status"] = "pending") => {
  const seen: string[] = [];
  const stop = s.host.plane.store.events.subscribe(GLOBAL_STREAM, (event) => {
    if (event.type !== "approval.upserted") return;
    const { approval } = JSON.parse(event.data) as { approval: Approval };
    if (approval.status === status) seen.push(approval.id);
  });
  return { seen, stop };
};
/** A connector gains a tool: the trees install the new connector tools, a registry publication. */
const changeRegistry = async (s: TestServer, gw: FakeMcpGateway) => {
  gw.tools.set("con_cal", [...(gw.tools.get("con_cal") ?? []), tool("create_event", "Create a calendar event.")]);
  expect((await s.client.get("/api/connectors/con_cal/tools?refresh=1")).status).toBe(200);
};
/** Every pass of the policy gates looks the call's approval up by its task. */
const gatePasses = (s: TestServer) => vi.spyOn(s.host.plane.approvals, "forTask");

async function park(s: TestServer, id: string, name: string, args: unknown = {}) {
  await say(s, id, directive(name, args));
  const [approval] = await waitPending(s, id);
  expect(approval).toMatchObject({ resumesTool: true, status: "pending", tool: name });
  await inactive(s, id);
  return approval!;
}

describe("a parked approval gate", () => {
  it("holds no invocation, shows the call as sleeping, and survives a registry change with one row and one call", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    const approval = await park(s, id, "notes__add_note", { q: "milk" });
    expect((await liveTools(s, id)).map((t) => t.status)).toEqual(["sleeping"]);
    expect(treeOf(s, id).harness.wake()).toMatchObject({ active: false });

    const passes = gatePasses(s);
    const announced = announcements(s);
    await changeRegistry(s, gw);
    // A new connector registration is a registry publication: Pi runs the parked call's gates again.
    await until(async () => (passes.mock.calls.length > 0 ? true : undefined), 10_000, "the gates to run again");
    await inactive(s, id);
    expect(rowsOf(s, id)).toHaveLength(1);
    expect(notices(s, id)).toHaveLength(1);
    expect(announced.seen).toEqual([]);
    expect(gw.calls).toEqual([]);

    expect((await decide(s, approval.id, { decision: "approve" })).status).toBe(200);
    const done = await settled(s, id);
    announced.stop();
    expect(done.runs.map((run) => run.status)).toEqual(["completed"]);
    expect(gw.calls.map(({ tool, args }) => ({ tool, args }))).toEqual([{ tool: "add_note", args: { q: "milk" } }]);
    expect(done.messages.find((m) => m.approval?.id === approval.id)?.approval).toMatchObject({
      status: "approved",
      execution: "ran",
    });
    expect(rowsOf(s, id)).toHaveLength(1);
  });

  it("parks a group of reads under one key and wakes the started call once the group is decided", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await say(
      s,
      id,
      ["[tool round]", directive("notes__search_notes", {}), directive("calendar__list_events", {})].join(" "),
    );
    const requests = await waitPending(s, id, 2);
    const group = requests[0]!.groupId!;
    expect(requests.every((r) => r.groupId === group)).toBe(true);
    await inactive(s, id);
    expect((await liveTools(s, id)).map((t) => t.status)).toEqual(["sleeping", "pending"]);

    const passes = gatePasses(s);
    await changeRegistry(s, gw);
    await until(async () => (passes.mock.calls.length > 0 ? true : undefined), 10_000, "the gates to run again");
    await inactive(s, id);
    expect(rowsOf(s, id)).toHaveLength(2);
    expect(notices(s, id)).toHaveLength(1);

    const response = await s.client.post(`/api/approval-groups/${encodeURIComponent(group)}/decide`, {
      decisions: requests.map((r) => ({ id: r.id, decision: "approve" })),
    });
    expect(response.status).toBe(200);
    const done = await settled(s, id);
    expect(done.runs.map((run) => run.status)).toEqual(["completed"]);
    expect(gw.calls.map(({ tool }) => tool)).toEqual(["search_notes", "list_events"]);
    expect(rowsOf(s, id)).toHaveLength(2);
  });

  it("keeps parking across a restart, then runs the call once after approval", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    const approval = await park(s, id, "notes__add_note", { q: "eggs" });
    const cookie = s.client.cookie;
    await s.stop();
    server = await startTestServer({
      dir: s.dir,
      clock: s.clock,
      fetchImpl: gw.fetch,
      mcp: { gatewayUrl: "http://gateway.test" },
    });
    server.client.cookie = cookie;
    const reopened = server;
    expect((await waitPending(reopened, id)).map((a) => a.id)).toEqual([approval.id]);
    await reopened.host.plane.adapter.trees.open(reopened.host.plane.store.getSessionRow(id)!.tree_id);
    await inactive(reopened, id);
    expect(rowsOf(reopened, id)).toHaveLength(1);
    expect(gw.calls).toEqual([]);

    expect((await decide(reopened, approval.id, { decision: "approve" })).status).toBe(200);
    const done = await settled(reopened, id);
    expect(done.runs.map((run) => run.status)).toEqual(["completed"]);
    expect(gw.calls.map(({ tool }) => tool)).toEqual(["add_note"]);
  });

  it("keeps its tree open while parked when idle trees are closed, and runs the call once approved", async () => {
    const gw = world();
    server = await startSignedIn({
      fetchImpl: gw.fetch,
      mcp: { gatewayUrl: "http://gateway.test" },
      config: { idleCloseMs: 50 },
    });
    const s = server;
    const id = await chat(s);
    const approval = await park(s, id, "notes__add_note", { q: "tea" });
    const treeId = s.host.plane.store.getSessionRow(id)!.tree_id;
    await new Promise((r) => setTimeout(r, 1_500));
    expect(s.host.plane.adapter.trees.get(treeId)).toBeDefined();
    expect((await decide(s, approval.id, { decision: "approve" })).status).toBe(200);
    const done = await settled(s, id);
    expect(done.runs.map((run) => run.status)).toEqual(["completed"]);
    expect(gw.calls.map(({ tool }) => tool)).toEqual(["add_note"]);
  });

  it("ends the parked call when its session is deleted", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    const approval = await park(s, id, "notes__add_note");
    const cancelled = announcements(s, "cancelled");
    expect((await s.client.call("DELETE", `/api/sessions/${id}`)).status).toBe(200);
    await until(async () => (cancelled.seen.includes(approval.id) ? true : undefined), 10_000, "the cancellation");
    cancelled.stop();
    expect(await pending(s)).toEqual([]);
    expect(gw.calls).toEqual([]);
    expect(s.host.plane.store.nonTerminalRuns(id)).toEqual([]);
  });

  it("wakes at once when the sweep expires the approval, and blocks the call", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    const approval = await park(s, id, "notes__add_note");
    s.clock.advance(approval.expiresAt - s.clock.now() + 1);
    await s.host.plane.adapter.approvals.sweep();
    const done = await settled(s, id);
    expect(done.runs.map((run) => run.status)).toEqual(["completed"]);
    expect(done.messages.find((m) => m.approval?.id === approval.id)?.approval?.status).toBe("expired");
    expect(gw.calls).toEqual([]);
    expect((await detail(s, id)).messages.filter((m) => m.role === "notice")).toEqual([]);
  });
});

/**
 * The gate driven directly, as Pi runs it on a rerun. An approval row bound to the task with no Pi memos at all is what
 * 1.5 code left behind when it stopped while awaiting a decision: the re-entered gate must find it and park.
 */
describe("the approval gate on its own", () => {
  async function setup() {
    const gw = new FakeMcpGateway();
    gw.add("con_fixture", "Fixture", [tool("act", "Fixture action", { readOnlyHint: true })]);
    const s = await start(gw);
    const id = await chat(s);
    const { store, approvals, mcp } = s.host.plane;
    const session = store.getSessionRow(id)!;
    store.db.run("UPDATE sessions SET pi_conversation_id = ? WHERE id = ?", "fixture-conversation", id);
    const run = { id: "run_fixture", status: "running", request_id: "fixture", assigned_by: null } as unknown as RunRow;
    vi.spyOn(store, "nonTerminalRuns").mockImplementation((sid) => (sid === id ? [run] : []));
    vi.spyOn(store, "runningRun").mockImplementation((sid) => (sid === id ? run : undefined));
    const catalog = new ToolCatalog();
    const directory = new ConnectorToolDirectory({ mcp, store });
    await directory.refresh();
    const ext = createConnectorToolsExtension({
      treeId: session.tree_id,
      store,
      mcp,
      catalog,
      directory,
      agentIds: [session.agent_id],
    });
    const policy = createPolicyExtension({
      treeId: session.tree_id,
      store,
      approvals,
      catalog,
      log: nullLogger,
      approvalTtlMs: 60_000,
    });
    const memos = new Map<string, unknown>();
    let signal: unknown;
    const NOW = 5_000_000;
    const api = {
      conversationId: "fixture-conversation",
      taskId: "fixture-task",
      now: () => NOW,
      snapshot: async () => undefined,
      readSignal: async (token: unknown, key: string) =>
        token === ApprovalWake && key === signalKey ? signal : undefined,
      memo: async (key: string, ...values: unknown[]) => {
        if (values.length === 2 && !memos.has(key)) memos.set(key, structuredClone(values[0]));
        return memos.get(key);
      },
    };
    let signalKey = "";
    const args: JsonObject = { q: "fixture" };
    const { beforeTool } = policy.hooks![0]!.handlers as {
      beforeTool: (call: unknown, api: unknown, context: unknown) => Promise<unknown>;
    };
    const call = ext.tools!.find((t) => t.name === "fixture__act")!;
    return {
      s,
      gw,
      id,
      approvals,
      memos,
      NOW,
      before: () => beforeTool({ id: "fixture-call", name: "fixture__act", arguments: args }, api, {}),
      execute: () => call.execute(args, api as never, {} as never),
      wake: (key: string, value: unknown) => {
        signalKey = key;
        signal = value;
      },
    };
  }

  /** A row bound to the task, and none of the memos 1.6 writes: the state 1.5 left. */
  async function legacyRow(f: Awaited<ReturnType<typeof setup>>) {
    const first = (await f.before()) as { sleep: { signals: unknown[]; until: number } };
    expect(first.sleep).toBeDefined();
    f.memos.clear();
    const [row] = await waitPending(f.s, f.id);
    return row!;
  }

  it("finds a pending approval made by 1.5 code, parks on it, and parks the same way on every rerun", async () => {
    const f = await setup();
    const row = await legacyRow(f);
    const announced = announcements(f.s);
    const remaining = row.expiresAt - f.s.clock.now();
    const parked = (await f.before()) as { sleep: { signals: unknown[]; until: number } };
    expect(parked).toEqual({ sleep: { signals: [ApprovalWake.key(row.id)], until: expect.any(Number) } });
    expect(Math.abs(parked.sleep.until - (f.NOW + remaining))).toBeLessThan(1_000);
    // A rerun keeps the deadline of the first pass.
    expect(await f.before()).toEqual(parked);
    expect(rowsOf(f.s, f.id)).toHaveLength(1);
    expect(notices(f.s, f.id)).toHaveLength(1);
    expect(announced.seen).toEqual([]);
    announced.stop();
  });

  it("lets the call through once after approval, and reruns do not consume or create anything more", async () => {
    const f = await setup();
    const row = await legacyRow(f);
    f.approvals.approve(row.id, {}, 60_000);
    f.wake(row.id, { value: {} });
    expect(await f.before()).toBeUndefined();
    expect(f.memos.get(POLICY_MEMO)).toBeDefined();
    expect(await f.before()).toBeUndefined();
    expect((await f.execute()).isError).not.toBe(true);
    expect(f.gw.calls).toHaveLength(1);
    expect(f.approvals.get(row.id)).toMatchObject({ status: "approved" });
    expect(rowsOf(f.s, f.id)).toHaveLength(1);
  });

  it("blocks after a denial", async () => {
    const f = await setup();
    const row = await legacyRow(f);
    f.approvals.deny(row.id);
    f.wake(row.id, { value: {} });
    expect(await f.before()).toEqual({ block: expect.stringContaining(`Approval #${row.number} was denied`) });
    expect(f.gw.calls).toEqual([]);
  });

  it("marks the approval expired and blocks when its deadline wakes it first", async () => {
    const f = await setup();
    const row = await legacyRow(f);
    f.wake(row.id, { expired: true });
    expect(await f.before()).toEqual({ block: expect.stringContaining(`Approval #${row.number} was expired`) });
    expect(f.approvals.get(row.id)?.status).toBe("expired");
    expect(f.gw.calls).toEqual([]);
  });
});
