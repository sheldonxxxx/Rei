// An @-mentioned connector (issue 06): the message carries the directory of the tools the tree registered for it, and
// loads nothing; a connector that is not ready, or that the agent can't use, gives one line instead.

import { afterEach, describe, expect, it } from "vitest";
import { tool } from "./helpers/approvals.ts";
import { FakeMcpGateway, tool as mcpTool } from "./helpers/fake-mcp.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, settled, stepPayloads } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const NOTES = [
  mcpTool("search_notes", "Search the user's notes by text.", { readOnlyHint: true }),
  mcpTool("add_note", "Create a new note."),
];

async function setup(status: "connected" | "needs_auth" | "error" = "connected") {
  const gw = new FakeMcpGateway();
  gw.add("con_notes", "Notes", status === "connected" ? structuredClone(NOTES) : [], status);
  server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
  return { gw, s: server, id: await chat(server) };
}

const mention = [{ kind: "connector", id: "con_notes", label: "Notes", start: 0, end: 6 }];
const send = (s: TestServer, id: string, text: string, mentions: unknown[] = []) =>
  s.client.post(`/api/sessions/${id}/messages`, { requestId: crypto.randomUUID(), text, mentions });

/** The user message the model received last (with its selected context). */
function userText(s: TestServer, id: string): string {
  const request = JSON.parse(stepPayloads(s, id).at(-1)!) as {
    messages: { role: string; content?: unknown }[];
  };
  const users = request.messages.filter((m) => m.role === "user");
  return JSON.stringify(users.map((m) => m.content));
}

function offered(s: TestServer, id: string): Set<string> {
  const request = JSON.parse(stepPayloads(s, id).at(-1)!) as {
    messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[];
  };
  const names = new Set<string>();
  for (const m of request.messages) {
    if (m.role !== "system") continue;
    for (const t of m.toolsRemoved ?? []) names.delete(t.name);
    for (const t of m.toolsAdded ?? []) names.add(t.name);
  }
  return names;
}

describe("an @-mentioned connector", () => {
  it("lists the registered tools without loading any; a load from the directory then offers the tool", async () => {
    const { s, id, gw } = await setup();
    expect((await send(s, id, "@Notes what do I have?", mention)).status).toBe(200);
    await settled(s, id);
    const text = userText(s, id);
    expect(text).toContain('The user mentioned the connector \\"Notes\\"');
    expect(text).toContain("It has 2 tools; none is loaded.");
    expect(text).toContain("- notes__search_notes: Search the user's notes by text.");
    expect(text).toContain("- notes__add_note: Create a new note.");
    expect(text).not.toContain("Preferred MCP connector");
    expect(offered(s, id).has("notes__search_notes")).toBe(false);

    await send(s, id, tool("search_capabilities", { load: ["notes__search_notes"] }));
    await settled(s, id, 2);
    expect(stepPayloads(s, id).at(-1)).toContain("Loaded 1 tool");
    expect(offered(s, id).has("notes__search_notes")).toBe(true);
    expect(offered(s, id).has("notes__add_note")).toBe(false);
    // A mention grants nothing: the connector was never called.
    expect(gw.calls).toEqual([]);
  });

  it("says a connector that needs sign-in can't be used", async () => {
    const { s, id } = await setup("needs_auth");
    await send(s, id, "@Notes what do I have?", mention);
    await settled(s, id);
    const text = userText(s, id);
    expect(text).toContain("it needs sign-in (Settings → Capabilities → Connectors), so its tools can't be used.");
    expect(text).not.toContain("none is loaded");
  });

  it("says a connector that is failing can't be used", async () => {
    const { s, id } = await setup("error");
    await send(s, id, "@Notes what do I have?", mention);
    await settled(s, id);
    expect(userText(s, id)).toContain("it is not working right now");
  });

  it("says a connector this agent can't use isn't available, and lists none of its tools", async () => {
    const { s, id } = await setup();
    const { store } = s.host.plane;
    store.updateAgentSettings(store.getSessionRow(id)!.agent_id, { allowedConnectorIds: [] });
    await send(s, id, "@Notes what do I have?", mention);
    await settled(s, id);
    const text = userText(s, id);
    expect(text).toContain("it isn't available to this agent.");
    expect(text).not.toContain("notes__search_notes");
  });

  it("keeps the directory in a fork, which can load from it", async () => {
    const { s, id } = await setup();
    await send(s, id, "@Notes what do I have?", mention);
    const history = await settled(s, id);
    const assistant = history.messages.findLast((m) => m.role === "assistant")!;
    const fork = (await s.client.post(`/api/sessions/${id}/fork`, { messageId: assistant.id })).body.session
      .id as string;
    await send(s, fork, tool("search_capabilities", { load: ["notes__add_note"] }));
    await settled(s, fork);
    expect(userText(s, fork)).toContain("- notes__add_note: Create a new note.");
    expect(offered(s, fork).has("notes__add_note")).toBe(true);
    expect((await detail(s, fork)).messages.some((m) => m.mentions?.[0]?.id === "con_notes")).toBe(true);
  });
});
