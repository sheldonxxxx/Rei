// Code mode (ticket 02): who may call what, and what scripts see. Every built-in tool names its callers; a script gets
// no model-only tool and no connector tool its agent may not use; declarations carry no `_activity`; namespaces keep the
// `codemode` section stable.

import { afterEach, describe, expect, it } from "vitest";
import { tool as directive } from "./helpers/approvals.ts";
import { FakeBrowser } from "./helpers/browser.ts";
import { startExecServer } from "./helpers/exec.ts";
import { FakeMcpGateway, tool } from "./helpers/fake-mcp.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { homeChat, say, settled, stepPayloads } from "./helpers/sessions.ts";
import { toolResults } from "./helpers/web.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

/** Every tool a tree installs, with the extension and its callers. */
const treeTools = (s: TestServer, sessionId: string) =>
  [
    ...s.host.plane.adapter.trees
      .get(s.host.plane.store.getSessionRow(sessionId)!.tree_id)!
      .registry.snapshot()
      .installed(),
  ].flatMap((e) =>
    (e.tools ?? []).map((t) => ({
      extension: e.name,
      name: t.name,
      callers: (t as { callers?: readonly string[] }).callers,
    })),
  );

const setCodeMode = async (s: TestServer) => {
  const res = await s.client.call("PUT", "/api/settings/behavior", { body: { codeMode: { enabled: true } } });
  expect(res.status).toBe(200);
};

/** The value a script returned: Pi frames it as "Script completed", the wall time and "Output:". */
const outputOf = (text: string): string => {
  expect(text).toMatch(/^Script completed/);
  return text.slice(text.indexOf("Output:\n") + "Output:\n".length).trim();
};

/** Runs a script and returns what the model got back. */
async function run(s: TestServer, id: string, code: string, runs: number): Promise<string> {
  await say(s, id, directive("codemode", { code }));
  await settled(s, id, runs);
  return toolResults(s, id).at(-1)!.text;
}

/** The `codemode` prompt section as the last request had it. */
function codemodeSection(s: TestServer, id: string): string {
  const request = JSON.parse(stepPayloads(s, id).at(-1)!) as {
    messages: { role: string; sections?: Record<string, string | null> }[];
  };
  let text = "";
  for (const m of request.messages) if (m.sections && "codemode" in m.sections) text = m.sections.codemode ?? "";
  return text;
}

/** The tools only the model may call, with why (docs/code-mode.md has the table). */
const MODEL_ONLY = [
  "browser_takeover",
  "cancel_session",
  "codemode",
  "create_plugin",
  "create_trigger",
  "delete_trigger",
  "dismiss_event",
  "message_session",
  "report",
  "save_skill",
  "search_capabilities",
  "show_surface",
  "start_session",
  "update_plugin",
  "update_surface",
  "update_trigger",
  "use_skill",
];

describe("callers of built-in tools", () => {
  it("every built-in tool names its callers, and only the expected ones are model-only", async () => {
    server = await startExecServer({ browserDriver: new FakeBrowser() });
    const id = homeChat(server);
    await setCodeMode(server);
    await say(server, id, "hello");
    await settled(server, id, 1);
    const tools = treeTools(server, id);
    // The tree has the sandbox, the browser, the web, memory and the rest: a missing extension would hide a tool.
    for (const name of ["bash", "browser_open", "web_fetch", "memory_add", "knowledge_search", "codemode"])
      expect(tools.map((t) => t.name)).toContain(name);
    const none = tools.filter((t) => t.callers === undefined || t.callers.length === 0);
    expect(none, `tools without explicit callers: ${none.map((t) => t.name).join(", ")}`).toEqual([]);
    const modelOnly = tools.filter((t) => !t.callers!.includes("tools")).map((t) => t.name);
    expect(modelOnly.sort()).toEqual(MODEL_ONLY);
    // The model must be able to call every tool: a tool for scripts only would never be offered.
    expect(tools.filter((t) => !t.callers!.includes("model"))).toEqual([]);
  });

  it("gives scripts a caller error for a model-only tool of each group, and does not list them", async () => {
    server = await startExecServer({ browserDriver: new FakeBrowser() });
    const id = homeChat(server);
    await setCodeMode(server);
    const probe = [
      "show_surface",
      "start_session",
      "create_trigger",
      "save_skill",
      "create_plugin",
      "browser_takeover",
      "search_capabilities",
      "codemode",
    ];
    const out = await run(
      server,
      id,
      `const out = {};
for (const name of ${JSON.stringify(probe)}) {
  try { await tools[name]({}); out[name] = "called"; } catch (e) { out[name] = String(e.message ?? e); }
}
out.listed = (await searchTools("surface session trigger skill plugin takeover capabilities script", { limit: 50 })).map((t) => t.name);
return JSON.stringify(out);`,
      1,
    );
    const seen = JSON.parse(outputOf(out)) as Record<string, string | string[]>;
    for (const name of probe) expect(seen[name], name).not.toBe("called");
    for (const name of probe) expect(seen.listed).not.toContain(name);
    // A tool both may call is still there.
    expect(outputOf(await run(server, id, `return String(typeof tools.list_sessions)`, 2))).toBe("function");
  });
});

describe("what a script sees", () => {
  it("leaves _activity out of the declarations", async () => {
    server = await startExecServer({ browserDriver: new FakeBrowser() });
    const id = homeChat(server);
    await setCodeMode(server);
    const out = await run(
      server,
      id,
      `const names = ["list_sessions", "bash", "web_fetch", "memory_add"];
const described = await Promise.all(names.map((n) => describeTool(n)));
const found = await searchTools("list sessions run command", { limit: 20 });
return JSON.stringify({ described, found, all: JSON.stringify(ALL_TOOLS) });`,
      1,
    );
    expect(outputOf(out)).not.toContain("_activity");
    expect(out).toContain("list_sessions");
    await say(server, id, "hello");
    await settled(server, id, 2);
    const section = codemodeSection(server, id);
    expect(section).toContain("## sandbox");
    expect(section).not.toContain("_activity");
  });

  it("groups tools in namespaces", async () => {
    server = await startExecServer({ browserDriver: new FakeBrowser() });
    const id = homeChat(server);
    await setCodeMode(server);
    await say(server, id, "hello");
    await settled(server, id, 1);
    const section = codemodeSection(server, id);
    for (const name of [
      "memory",
      "knowledge",
      "library",
      "web",
      "browser",
      "sandbox",
      "sessions",
      "plugins",
      "skills",
      "triggers",
    ])
      expect(section, name).toContain(`## ${name}\n`);
  });
});

describe("connector tools in scripts", () => {
  const NOTES = [tool("search_notes", "Search the user's notes by text.", { readOnlyHint: true })];

  async function setup() {
    const gw = new FakeMcpGateway();
    gw.add("con_notes", "Notes", structuredClone(NOTES));
    server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
    const id = homeChat(server);
    await setCodeMode(server);
    await say(server, id, "hello");
    await settled(server, id, 1);
    const { store } = server.host.plane;
    return { gw, id, store, agentId: store.getSessionRow(id)!.agent_id };
  }
  const SEE = `return JSON.stringify({
  listed: (await searchTools("notes search", { limit: 20 })).map((t) => t.name),
  all: JSON.stringify(ALL_TOOLS).includes("notes__search_notes"),
  described: (await describeTool("notes__search_notes")) !== undefined,
  callable: await (async () => { try { return typeof tools.notes__search_notes; } catch { return "missing"; } })(),
});`;

  it("are visible to an agent that may use the connector", async () => {
    const { id } = await setup();
    const seen = JSON.parse(outputOf(await run(server!, id, SEE, 2)));
    expect(seen).toMatchObject({ all: true, described: true, callable: "function" });
    expect(seen.listed).toContain("notes__search_notes");
  });

  it("are neither listed nor callable for an agent that may not use the connector, in a tree another agent shares", async () => {
    const { id, store, agentId } = await setup();
    const trees = server!.host.plane.adapter.trees;
    const treeId = store.getSessionRow(id)!.tree_id;
    // Agent A (the home chat's) may use only another connector; agent B has a session in the same tree and may use all.
    store.updateAgentSettings(agentId, { allowedConnectorIds: ["con_other"] });
    const other = store.createAgent({ name: "Other", avatar: "bot:default", instructions: "" }).agent;
    const now = Date.now();
    store.db.run(
      "INSERT INTO sessions (id, agent_id, tree_id, origin, title, status, preview, created_at, updated_at) VALUES (?, ?, ?, 'user', 'B', 'idle', '', ?, ?)",
      "ses_other_agent",
      other.id,
      treeId,
      now,
      now,
    );
    await trees.syncConnectors();
    // The tree registers the connector tool because B may use it...
    const registered = () =>
      trees
        .get(treeId)!
        .registry.snapshot()
        .tools()
        .some((t) => t.tool.name === "notes__search_notes");
    expect(registered()).toBe(true);
    // ...but A's script neither lists, describes nor reaches it.
    const seen = JSON.parse(outputOf(await run(server!, id, SEE, 2)));
    expect(seen).toMatchObject({ all: false, described: false, callable: "missing" });
    expect(seen.listed).not.toContain("notes__search_notes");
  });
});

describe("the codemode section", () => {
  it("does not change when a connector connects or disconnects", async () => {
    const gw = new FakeMcpGateway();
    gw.add("con_notes", "Notes", [tool("search_notes", "Search notes.", { readOnlyHint: true })]);
    server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
    const id = homeChat(server);
    await setCodeMode(server);
    await say(server, id, "one");
    await settled(server, id, 1);
    const before = codemodeSection(server, id);
    expect(before).toContain("## connectors");
    // The connector goes away, then comes back with another tool.
    gw.connectors.length = 0;
    gw.tools.clear();
    await server.host.plane.adapter.trees.syncConnectors();
    await say(server, id, "two");
    await settled(server, id, 2);
    expect(codemodeSection(server, id)).toBe(before);
    gw.add("con_cal", "Calendar", [tool("list_events", "List events.", { readOnlyHint: true })]);
    await server.host.plane.adapter.trees.syncConnectors();
    await say(server, id, "three");
    await settled(server, id, 3);
    expect(codemodeSection(server, id)).toBe(before);
  });
});
