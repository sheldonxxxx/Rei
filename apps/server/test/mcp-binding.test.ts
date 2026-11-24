// Deterministic inspect -> execute and durable-memo interleavings, using only fixture data.

import type { JsonObject } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { ConnectorToolDirectory, createConnectorToolsExtension } from "../src/mcp/connector-tools.ts";
import { McpService } from "../src/mcp/service.ts";
import { createPolicyExtension, evaluateTool, POLICY_MEMO, ToolCatalog } from "../src/pi/policy-ext.ts";
import { nullLogger } from "../src/util/log.ts";
import { FakeMcpGateway, tool } from "./helpers/fake-mcp.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

async function setup(annotations: Parameters<typeof tool>[2] = { readOnlyHint: true }) {
  const gw = new FakeMcpGateway();
  gw.add("con_fixture", "Fixture", [tool("act", "Fixture action", annotations)]);
  server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
  const s = server;
  const id = await chat(s);
  const { store, approvals, mcp } = s.host.plane;
  const session = store.getSessionRow(id)!;
  store.db.run("UPDATE sessions SET pi_conversation_id = ? WHERE id = ?", "fixture-conversation", id);
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
  let allow: { tool: string; destination: string }[] | undefined = [
    { tool: "fixture__act", destination: "con_fixture.act" },
  ];
  const policy = createPolicyExtension({
    treeId: session.tree_id,
    store,
    approvals,
    catalog,
    log: nullLogger,
    approvalTtlMs: 60_000,
    triggerAllow: () => allow,
  });
  const call = ext.tools!.find((t) => t.name === "fixture__act")!;
  const memos = new Map<string, unknown>();
  const api = {
    conversationId: "fixture-conversation",
    taskId: "fixture-task",
    memo: async (key: string, ...values: unknown[]) => {
      if (values.length === 2 && !memos.has(key)) memos.set(key, structuredClone(values[0]));
      return memos.get(key);
    },
  };
  const args: JsonObject = { q: "fixture" };
  const { beforeTool: hook } = policy.hooks![0]!.handlers as {
    beforeTool: (call: unknown, api: unknown, context: unknown) => Promise<{ block?: string } | undefined>;
  };
  const before = () => hook({ id: "fixture-call", name: "fixture__act", arguments: args }, api, {});
  const execute = () => call.execute(args, api as never, {} as never);
  const trust = async () => {
    await mcp.setOverride("con_fixture", "act", "read_external");
    const c = (await mcp.list()).find((c) => c.id === "con_fixture")!;
    await mcp.setProfile(c.id, "read_only", c.providerIdentity!, c.mcpProfileRevision!);
  };
  const blocked = async () => {
    expect((await execute()).isError).toBe(true);
    expect(gw.calls).toEqual([]);
    expect(gw.requests.filter((r) => r.path.endsWith("/call"))).toEqual([]);
  };
  return {
    s,
    gw,
    id,
    store,
    approvals,
    mcp,
    catalog,
    session,
    call,
    memos,
    api,
    args,
    before,
    execute,
    trust,
    blocked,
    removeAllow: () => {
      allow = [];
    },
  };
}

it("keeps activity metadata out of the bound execution arguments and remote call", async () => {
  const f = await setup();
  await f.trust();
  f.args._activity = "Read the fixture";
  expect(await f.before()).toBeUndefined();
  f.args._activity = "Check the fixture";
  expect((await f.execute()).isError).not.toBe(true);
  expect(f.gw.calls).toHaveLength(1);
  expect(f.gw.calls[0]!.args).toEqual({ q: "fixture" });
});

it.each([
  "schema",
  "output schema",
  "annotations",
  "tool name",
  "removed",
  "replacement",
  "renamed",
  "override",
  "private role",
  "profile",
  "agent",
])("blocks %s drift between inspect and execution", async (change) => {
  const f = await setup();
  await f.trust();
  expect(await f.before()).toBeUndefined();
  if (change === "schema") f.gw.tools.get("con_fixture")![0]!.inputSchema = { type: "object", required: ["new"] };
  if (change === "output schema")
    f.gw.tools.get("con_fixture")![0]!.outputSchema = { type: "object", properties: { n: { type: "number" } } };
  if (change === "annotations")
    f.gw.tools.get("con_fixture")![0]!.annotations = { readOnlyHint: true, destructiveHint: true };
  if (change === "tool name") f.gw.tools.get("con_fixture")![0]!.name = "renamed";
  if (change === "removed" || change === "replacement") {
    f.gw.connectors = [];
    if (change === "replacement")
      f.gw.add("con_other", "Fixture", [tool("act", "Fixture action", { readOnlyHint: true })]);
  }
  if (change === "renamed") f.gw.connectors[0]!.name = "Renamed";
  if (change === "override") await f.mcp.setOverride("con_fixture", "act", "write_external");
  if (change === "private role")
    f.store.db.run("INSERT INTO connector_settings (connector_id, holds_private) VALUES (?, 0)", "con_fixture");
  if (change === "profile") f.store.db.run("UPDATE sessions SET profile = 'strict' WHERE id = ?", f.id);
  if (change === "agent") f.store.db.run("UPDATE sessions SET origin = 'spawned' WHERE id = ?", f.id);
  await f.blocked();
});

it("requires a bound memo, and rejects legacy or argument-mismatched memos", async () => {
  const f = await setup();
  await f.trust();
  await f.blocked();
  f.memos.set(POLICY_MEMO, "profile");
  await f.blocked();
  f.memos.clear();
  await f.before();
  f.args.q = "altered";
  await f.blocked();
});

it("fails closed for a tool the connector no longer has, without reaching gateway call", async () => {
  const f = await setup();
  f.gw.tools.set("con_fixture", []);
  expect((await f.before())?.block).toContain('no longer has the tool "act"');
  expect(f.catalog.get("fixture__act")!.classFor!(f.args, [], { resolved: false, actionClass: "write_external" })).toBe(
    "write_external",
  );
  await f.blocked();
});

it("refreshes the catalog despite a warm cache and fails closed on a gateway outage", async () => {
  const f = await setup();
  await f.trust();
  await f.mcp.connectorTools();
  await f.before();
  f.gw.down = true;
  await f.blocked();
});

it("normalizes schema key order, preserves taint, and leaves calls unsafe to replay", async () => {
  const f = await setup();
  await f.trust();
  await f.before();
  f.gw.tools.get("con_fixture")![0]!.inputSchema = { properties: { q: { type: "string" } }, type: "object" };
  expect((await f.execute()).isError).not.toBe(true);
  expect(f.gw.calls).toHaveLength(1);
  expect(JSON.parse(f.store.getSessionRow(f.id)!.taint)).toEqual(["external", "private"]);
  expect(f.call.replay).not.toBe("safe");
  // Inspection and execution each refresh the catalog, despite the warm cache from registration and trust().
  expect(f.gw.requests.filter((r) => r.path.endsWith("/tools"))).toHaveLength(4);
});

it("revalidates a durable memo on hook replay and refuses catalog drift", async () => {
  const f = await setup();
  await f.trust();
  await f.before();
  const persisted = JSON.parse(JSON.stringify(f.memos.get(POLICY_MEMO)));
  f.memos.set(POLICY_MEMO, persisted);
  expect(await f.before()).toBeUndefined();
  f.gw.tools.get("con_fixture")![0]!.inputSchema = { type: "object", required: ["new"] };
  expect((await f.before())?.block).toContain("Refused:");
  await f.blocked();
});

it.each(["revoke", "expire"])("ignores legacy standing grants and their one-time companions (%s)", async (change) => {
  // Exercise standing write grants, independently of the provider-read consent gate.
  const f = await setup({});
  expect((await f.before())?.block).toContain("Blocked:");
  const row = f.approvals.pendingForSession(f.id)[0]!;
  // Fixture approval/grant, without enqueuing a model run; exercise the same persisted rows as the UI.
  f.store.db.run(
    "UPDATE approvals SET status = 'approved', grant_length = 'hours', once_expires_at = ? WHERE id = ?",
    f.s.clock.now() + 60_000,
    row.id,
  );
  f.store.db.run(
    "INSERT INTO grants (id, connector, operation, destination, length, expires_at, approval_id, created_at) VALUES ('gnt_fixture', 'mcp', 'call', 'con_fixture.act', 'hours', ?, ?, ?)",
    f.s.clock.now() + 3_600_000,
    row.id,
    f.s.clock.now(),
  );
  expect((await f.before())?.block).toContain("Blocked:");
  if (change === "revoke") f.approvals.revoke("gnt_fixture");
  else f.s.clock.advance(3_600_001);
  expect((await f.before())?.block).toContain("Blocked:");
  await f.blocked();
});

it("preserves one-time approval consumption on replay, but rejects expiry and a second task", async () => {
  const f = await setup();
  await f.before();
  const row = f.approvals.pendingForSession(f.id)[0]!;
  f.store.db.run(
    "UPDATE approvals SET status = 'approved', grant_length = 'once', once_expires_at = ? WHERE id = ?",
    f.s.clock.now() + 60_000,
    row.id,
  );
  expect(await f.before()).toBeUndefined();
  const consumed = f.approvals.row(row.id)!.consumed_at;
  expect(await f.before()).toBeUndefined();
  expect(f.approvals.row(row.id)!.consumed_at).toBe(consumed);
  const checked = await f.catalog.revalidate(
    f.session.tree_id,
    "fixture__act",
    f.args,
    f.memos.get(POLICY_MEMO),
    f.api.taskId,
    String(f.api.conversationId),
  );
  expect(() => checked.assert()).not.toThrow();
  f.api.taskId = "other-task";
  await f.blocked();
  f.api.taskId = "fixture-task";
  f.s.clock.advance(60_001);
  expect((await f.before())?.block).toContain("Refused:");
  await f.blocked();
});

it("requires exact-call approval with or without a trigger allow entry", async () => {
  const f = await setup({});
  // Fixture trigger identity; the policy's allow lookup is injected above.
  f.store.db.run("UPDATE sessions SET origin = 'trigger', trigger_id = 'trg_fixture' WHERE id = ?", f.id);
  expect((await f.before())?.block).toContain("Blocked:");
  f.removeAllow();
  expect((await f.before())?.block).toContain("Blocked:");
  await f.blocked();
});

it("rechecks local authority again after asynchronous validation, immediately before dispatch", async () => {
  const f = await setup();
  await f.trust();
  await f.before();
  const checked = await f.catalog.revalidate(
    f.session.tree_id,
    "fixture__act",
    f.args,
    f.memos.get(POLICY_MEMO),
    f.api.taskId,
    String(f.api.conversationId),
  );
  f.store.db.run("UPDATE sessions SET profile = 'strict' WHERE id = ?", f.id);
  expect(() => checked.assert()).toThrow(/Refused:/);
  expect(f.gw.calls).toEqual([]);
});

it("runs the final authority check after token acquisition and before any gateway call", async () => {
  const f = await setup();
  await f.trust();
  await f.before();
  const checked = await f.catalog.revalidate(
    f.session.tree_id,
    "fixture__act",
    f.args,
    f.memos.get(POLICY_MEMO),
    f.api.taskId,
    String(f.api.conversationId),
  );
  const resolution = (checked.facts as { resolution: Awaited<ReturnType<McpService["resolve"]>> }).resolution;
  const controlled = new McpService({
    store: f.store,
    approvals: f.approvals,
    clock: f.s.clock,
    log: nullLogger,
    gatewayUrl: "http://gateway.test",
    fetchImpl: f.gw.fetch,
    token: async () => {
      f.store.db.run("UPDATE sessions SET profile = 'strict' WHERE id = ?", f.id);
      return undefined;
    },
  });
  await expect(
    controlled.call(resolution.connector, "act", {}, undefined, {
      definition: resolution.tool,
      beforeDispatch: checked.assert,
    }),
  ).rejects.toThrow();
  expect(f.gw.calls).toEqual([]);
  expect(f.gw.requests.filter((r) => r.path.endsWith("/call"))).toEqual([]);
});

it("keeps execution guards isolated when another tree installs its policy", async () => {
  const f = await setup();
  await f.trust();
  await f.before();
  createPolicyExtension({
    treeId: "another-tree",
    store: f.store,
    approvals: f.approvals,
    catalog: f.catalog,
    log: nullLogger,
    approvalTtlMs: 60_000,
  });
  expect((await f.execute()).isError).not.toBe(true);
  expect(f.gw.calls).toHaveLength(1);
});

it.each([false, true])(
  "rejects MCP profile revocation during execution, including change-and-restore (%s)",
  async (reenable) => {
    const f = await setup();
    await f.trust();
    await f.before();
    const checked = await f.catalog.revalidate(
      f.session.tree_id,
      "fixture__act",
      f.args,
      f.memos.get(POLICY_MEMO),
      f.api.taskId,
      String(f.api.conversationId),
    );
    const original = (await f.mcp.list())[0]!;
    await f.mcp.setProfile(original.id, "always_ask", original.providerIdentity!, original.mcpProfileRevision!);
    if (reenable) {
      const c = (await f.mcp.list())[0]!;
      await f.mcp.setProfile(c.id, "read_only", c.providerIdentity!, c.mcpProfileRevision!);
    }
    expect(() => checked.assert()).toThrow(/Refused:/);
    expect((await f.before())?.block).toContain("Refused:");
    await f.blocked();
  },
);

it("never lets a trigger allow entry bypass missing provider consent, including in Yolo", async () => {
  const f = await setup();
  f.store.db.run(
    "UPDATE sessions SET origin = 'trigger', trigger_id = 'trg_fixture', profile = 'yolo' WHERE id = ?",
    f.id,
  );
  expect((await f.before())?.block).toContain("Blocked:");
  expect(f.approvals.pendingForSession(f.id)[0]).toMatchObject({ actionClass: "read_external", lengths: ["once"] });
  await f.blocked();
});

it("does not substitute another approval when the specifically resumed one-call token expires", async () => {
  const f = await setup();
  await f.before();
  const first = f.approvals.pendingForSession(f.id)[0]!;
  const row = f.approvals.row(first.id)!;
  f.store.db.run(
    "UPDATE approvals SET status = 'approved', grant_length = 'once', once_expires_at = ? WHERE id = ?",
    f.s.clock.now() - 1,
    first.id,
  );
  const second = f.approvals.findOrCreate({
    session: f.store.getSessionRow(f.id)!,
    runId: null,
    assignedBy: null,
    tool: row.tool,
    args: JSON.parse(row.args_json),
    argsHash: row.args_hash,
    connector: row.connector,
    operation: row.operation,
    actionClass: "read_external",
    destination: row.destination,
    summary: row.summary,
    argsPreview: row.args_preview,
    taint: [],
    lengths: ["once"],
    ttlMs: 60_000,
  }).approval;
  f.store.db.run(
    "UPDATE approvals SET status = 'approved', grant_length = 'once', once_expires_at = ? WHERE id = ?",
    f.s.clock.now() + 60_000,
    second.id,
  );
  expect(f.approvals.consumeOnce(f.id, row.tool, row.args_hash, "resumed-task", true, first.id)).toBeUndefined();
  expect(f.approvals.row(second.id)!.consumed_by).toBeNull();
  expect(f.approvals.consumeOnce(f.id, row.tool, row.args_hash, "resumed-task", true, second.id)?.id).toBe(second.id);
  expect(f.gw.calls).toEqual([]);
});

it("rejects taint added after inspection before dispatch", async () => {
  const f = await setup();
  f.store.db.run("INSERT INTO connector_settings (connector_id, holds_private) VALUES ('con_fixture', 0)");
  await f.trust();
  await f.before();
  f.store.addTaint(f.id, ["private"]);
  await f.blocked();
});

it("keeps the independent credential/takeover refusal even for an automatic MCP policy", async () => {
  const f = await setup();
  expect(
    evaluateTool(
      f.approvals,
      f.store.getSessionRow(f.id)!,
      {
        actionClass: "credentials",
        connector: "mcp",
        operation: "call",
        summary: () => "credential fixture",
        mcpPolicy: () => ({ automatic: true, authority: "fixture" }),
      },
      {},
    ).decision.kind,
  ).toBe("deny");
});

it("rejects a previously authorized call when the agent connector limit changes", async () => {
  const f = await setup();
  await f.trust();
  expect(await f.before()).toBeUndefined();
  f.store.updateAgentSettings(f.session.agent_id, { allowedConnectorIds: [] });
  await f.blocked();
});

it("refuses a call when the connector changed the tool after the tree registered it", async () => {
  const f = await setup();
  await f.trust();
  f.gw.tools.get("con_fixture")![0]!.description = "Fixture action, changed";
  expect((await f.before())?.block).toContain("changed the tool act since it was loaded");
  await f.blocked();
});
