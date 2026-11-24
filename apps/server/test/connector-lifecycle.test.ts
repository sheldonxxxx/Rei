// Capability changes in an open conversation (issue 05): connector tools are re-registered in place when a connector is
// added, removed, refreshed or signed in, or an agent's access changes, without reopening the tree.

import { afterEach, describe, expect, it } from "vitest";
import { approve, tool as call, pending, waitPending } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { FakeMcpGateway, tool } from "./helpers/fake-mcp.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled, stepPayloads } from "./helpers/sessions.ts";
import { callTool, toolResults } from "./helpers/web.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const NOTES = [
  tool("search_notes", "Search the user's notes by text.", { readOnlyHint: true }),
  tool("add_note", "Create a new note."),
];

async function setup() {
  const gw = new FakeMcpGateway();
  gw.add("con_notes", "Notes", structuredClone(NOTES));
  server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
  const s = server;
  const id = await chat(s);
  // Opens the tree.
  await callTool(s, id, "search_capabilities", { load: ["notes__search_notes"] });
  const trees = s.host.plane.adapter.trees;
  const treeId = s.host.plane.store.getSessionRow(id)!.tree_id;
  const tree = trees.get(treeId)!;
  expect(tree).toBeDefined();
  const settle = () => trees.syncConnectors();
  return { gw, s, id, trees, treeId, tree, settle };
}

function offered(s: TestServer, id: string): Set<string> {
  const request = JSON.parse(stepPayloads(s, id).at(-1)!) as {
    messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[];
  };
  const names = new Set<string>();
  for (const m of request.messages) {
    if (m.role !== "system") continue;
    // A changed definition comes as a removal and an addition in one message.
    for (const t of m.toolsRemoved ?? []) names.delete(t.name);
    for (const t of m.toolsAdded ?? []) names.add(t.name);
  }
  return names;
}
/** The Capabilities index as the last request had it: section changes come as later system messages. */
function index(s: TestServer, id: string): string {
  const request = JSON.parse(stepPayloads(s, id).at(-1)!) as {
    messages: { role: string; sections?: Record<string, string | null> }[];
  };
  let text = "";
  for (const m of request.messages)
    if (m.sections && "capabilities" in m.sections) text = m.sections.capabilities ?? "";
  return text;
}
/** Makes a request and returns the index it had. */
const registered = (s: TestServer, id: string) =>
  callTool(s, id, "search_capabilities", { query: "zzqx" }).then(() => index(s, id));

describe("connector changes in an open conversation", () => {
  it("registers an added connector's tools and lists it in the index from the next request", async () => {
    const { gw, s, id, trees, treeId, tree, settle } = await setup();
    await s.host.plane.mcp.create({ name: "Calendar", url: "https://calendar.example/mcp" });
    // The fake gateway adds it as needing sign-in; sign-in completes with tools.
    const added = gw.connectors.at(-1)!;
    expect((await registered(s, id)).includes("Calendar — needs sign-in")).toBe(true);
    added.status = "connected";
    gw.tools.set(added.id, [tool("list_events", "List calendar events.", { readOnlyHint: true })]);
    await s.host.plane.mcp.oauthFinish({ state: "s", code: "c" });
    await settle();
    expect(await registered(s, id)).toContain("- Calendar (1 tool)");
    const r = await callTool(s, id, "search_capabilities", { query: "list calendar events" });
    expect(r.last!.text).toContain("calendar__list_events");
    expect(offered(s, id).has("calendar__list_events")).toBe(true);
    expect(trees.get(treeId)).toBe(tree);
  });

  it("unregisters a removed connector's tools: a loaded one stops being offered and does not run", async () => {
    const { gw, s, id, trees, treeId, tree, settle } = await setup();
    expect(offered(s, id).has("notes__search_notes")).toBe(true);
    await s.host.plane.mcp.remove("con_notes");
    gw.connectors = [];
    await settle();
    const payload = await registered(s, id);
    expect(payload).not.toContain("- Notes (");
    expect(offered(s, id).has("notes__search_notes")).toBe(false);
    const r = await callTool(s, id, "notes__search_notes", {});
    expect(r.last!.text).toMatch(/is not available/);
    expect(gw.calls).toEqual([]);
    expect(trees.get(treeId)).toBe(tree);
  });

  it("says why a load of a removed connector's tool fails, so the model stops retrying", async () => {
    const { gw, s, id, settle } = await setup();
    await s.host.plane.mcp.remove("con_notes");
    gw.connectors = [];
    await settle();
    const r = await callTool(s, id, "search_capabilities", { load: ["notes__search_notes"] });
    expect(r.last!.text).toContain("Not found: notes__search_notes.");
    expect(r.last!.text).toContain(
      'notes__search_notes is not available: its connector "Notes" was removed. Do not retry it; tell the user if the task needs it.',
    );
  });

  it("says a connector tool needs sign-in when its connector does", async () => {
    const { gw, s, id, settle } = await setup();
    gw.connectors[0]!.status = "needs_auth";
    gw.tools.delete("con_notes");
    await s.host.plane.mcp.list();
    await settle();
    const r = await callTool(s, id, "search_capabilities", { load: ["notes__add_note"] });
    expect(r.last!.text).toContain('notes__add_note is not available: its connector "Notes" needs sign-in');
  });

  it("offers a loaded tool again without a new search when its connector comes back after sign-in", async () => {
    const { gw, s, id, settle } = await setup();
    gw.connectors[0]!.status = "needs_auth";
    gw.tools.delete("con_notes");
    await s.host.plane.mcp.list();
    await settle();
    expect(await registered(s, id)).toContain("- Notes — needs sign-in");
    expect(offered(s, id).has("notes__search_notes")).toBe(false);
    gw.connectors[0]!.status = "connected";
    gw.tools.set("con_notes", structuredClone(NOTES));
    await s.host.plane.mcp.oauthFinish({ state: "s", code: "c" });
    await settle();
    await callTool(s, id, "search_capabilities", { query: "zzqx" });
    expect(offered(s, id).has("notes__search_notes")).toBe(true);
    expect(offered(s, id).has("notes__add_note")).toBe(false);
  });

  it("re-registers a refresh: a changed tool stays loaded under its new schema, a removed one goes, a new one is deferred", async () => {
    const { gw, s, id, settle } = await setup();
    gw.tools.set("con_notes", [
      { ...structuredClone(NOTES[0]!), inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      tool("archive_note", "Archive a note."),
    ]);
    await s.host.plane.mcp.tools("con_notes", true);
    await settle();
    await callTool(s, id, "search_capabilities", { query: "zzqx" });
    const request = JSON.parse(stepPayloads(s, id).at(-1)!) as {
      messages: { role: string; toolsAdded?: { name: string; parameters?: unknown }[] }[];
    };
    const definitions = request.messages
      .flatMap((m) => m.toolsAdded ?? [])
      .filter((t) => t.name === "notes__search_notes");
    expect(JSON.stringify(definitions.at(-1)?.parameters)).toContain('"text"');
    const now = offered(s, id);
    expect(now.has("notes__search_notes")).toBe(true);
    expect(now.has("notes__archive_note")).toBe(false);
    const r = await callTool(s, id, "search_capabilities", { load: ["notes__archive_note", "notes__add_note"] });
    expect(r.last!.text).toContain("Not found: notes__add_note");
    expect(offered(s, id).has("notes__archive_note")).toBe(true);
  });

  it("follows the agent's connector access: revoked, its tools go; granted again, they come back", async () => {
    const { s, id, settle } = await setup();
    const { store } = s.host.plane;
    const agentId = store.getSessionRow(id)!.agent_id;
    store.updateAgentSettings(agentId, { allowedConnectorIds: [] });
    await settle();
    expect(await registered(s, id)).not.toContain("- Notes (");
    expect(offered(s, id).has("notes__search_notes")).toBe(false);
    store.updateAgentSettings(agentId, { allowedConnectorIds: null });
    await settle();
    expect(await registered(s, id)).toContain("- Notes (2 tools)");
    expect(offered(s, id).has("notes__search_notes")).toBe(true);
  });

  it("settles an approval left pending on a removed connector's tool as not executed, with the reason", async () => {
    const { gw, s, id, settle } = await setup();
    await callTool(s, id, "search_capabilities", { load: ["notes__add_note"] });
    await say(s, id, call("notes__add_note", { title: "x" }));
    const [approval] = await waitPending(s, id, 1);
    await s.host.plane.mcp.remove("con_notes");
    gw.connectors = [];
    await settle();
    // The parked call's gates run again on the registry change; its tool is gone, so Pi ends it without running it.
    await until(
      async () => (toolResults(s, id).at(-1)?.text.includes("not available") ? true : undefined),
      10_000,
      "the call to end",
    );
    expect(gw.calls).toEqual([]);
    expect(toolResults(s, id).at(-1)).toMatchObject({
      text: expect.stringContaining("Tool notes__add_note is not available"),
      isError: true,
    });
    expect(s.host.plane.approvals.get(approval!.id)?.status).toBe("cancelled");
    expect(await pending(s)).toEqual([]);
    expect((await settled(s, id)).runs.at(-1)!.status).toBe("completed");
  });

  it("blocks an approval left pending on a tool the connector changed since", async () => {
    const { gw, s, id, settle } = await setup();
    await callTool(s, id, "search_capabilities", { load: ["notes__add_note"] });
    await say(s, id, call("notes__add_note", { title: "x" }));
    await waitPending(s, id, 1);
    gw.tools.set("con_notes", [
      structuredClone(NOTES[0]!),
      {
        ...tool("add_note", "Create a new note in a folder."),
        inputSchema: { type: "object", properties: { folder: { type: "string" } } },
      },
    ]);
    await s.host.plane.mcp.tools("con_notes", true);
    await settle();
    await approve(s, id, { length: "once" });
    expect(gw.calls).toEqual([]);
    expect(stepPayloads(s, id).at(-1)!).toMatch(/definition or authorization changed.*Nothing was executed/);
  });

  it("leaves the index text unchanged when nothing it shows changed", async () => {
    const { s, id, settle } = await setup();
    const before = await registered(s, id);
    await s.host.plane.mcp.list();
    await settle();
    await callTool(s, id, "search_capabilities", { query: "zzqx" });
    const request = JSON.parse(stepPayloads(s, id).at(-1)!) as {
      messages: { role: string; sections?: Record<string, unknown> }[];
    };
    expect(request.messages.filter((m) => m.sections && "capabilities" in m.sections)).toHaveLength(1);
    expect(index(s, id)).toBe(before);
  });
});
