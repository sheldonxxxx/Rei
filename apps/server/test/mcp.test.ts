import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Approval, McpProfile, SessionTraceResponse } from "@rei/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultClass, McpService } from "../src/mcp/service.ts";
import * as faux from "../src/pi/faux.ts";
import { allowMatches } from "../src/pi/policy-ext.ts";
import { checkAllow } from "../src/triggers/spec.ts";
import { nullLogger } from "../src/util/log.ts";
import { approve, decide, tool as directive, grants, pending, setProfile, waitPending } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { FakeMcpGateway, tool } from "./helpers/fake-mcp.ts";
import { STANDIN, startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";
import { chat, childrenOf, detail, homeChat, say, settled, stepPayloads } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const NOTES = [
  tool("search_notes", "Search the user's notes by text.", { readOnlyHint: true }, "Search notes"),
  tool("add_note", "Create a new note with a title and body."),
  tool("delete_note", "Delete a note for good.", { destructiveHint: true }),
  tool("mail_note", "Email a note to someone.", {}),
];
async function start(gw: FakeMcpGateway) {
  server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
  return server;
}
const world = (): FakeMcpGateway => {
  const gw = new FakeMcpGateway();
  gw.add("con_notes", "Notes", NOTES);
  gw.add("con_cal", "Calendar", [
    tool("list_events", "List calendar events in a date range.", { readOnlyHint: true }),
    tool("create_event", "Create a calendar event."),
  ]);
  gw.add("con_mail", "Mail", [tool("search_mail", "Search mail.", { readOnlyHint: true })], "needs_auth");
  return gw;
};
const lastPayload = (s: TestServer, id: string): string => stepPayloads(s, id).at(-1) ?? "";
const taintOf = (s: TestServer, id: string): string[] => JSON.parse(s.host.plane.store.getSessionRow(id)!.taint);
async function askMcp(s: TestServer, id: string, name: string, args: unknown = {}) {
  await say(s, id, directive(name, args));
  const [approval] = await waitPending(s, id);
  expect(approval).toMatchObject({ resumesTool: true, status: "pending", tool: name });
  return approval!;
}
const selectProfile = async (s: TestServer, profile: McpProfile, id = "con_notes") => {
  const c = (await s.host.plane.mcp.list()).find((c) => c.id === id)!;
  return s.host.plane.mcp.setProfile(id, profile, c.providerIdentity!, c.mcpProfileRevision!, profile === "yolo");
};
const trustProvider = (s: TestServer, id = "con_notes") => selectProfile(s, "read_only", id);

/** The tools the session's last model request offered (its system messages' tool changes, replayed). */
function offered(s: TestServer, id: string): Set<string> {
  const request = JSON.parse(lastPayload(s, id)) as {
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
const search = (s: TestServer, id: string, args: { query?: string; load?: string[] }) =>
  callTool(s, id, "search_capabilities", args);

describe("connector tools in search_capabilities", () => {
  it("registers each connected connector's tools as deferred tools, and offers none before they are loaded", async () => {
    const s = await start(world());
    const id = await chat(s);
    await search(s, id, { query: "zzqx" });
    const names = s.host.plane.catalog.names();
    for (const name of ["notes__search_notes", "notes__add_note", "calendar__list_events", "calendar__create_event"])
      expect(names, name).toContain(name);
    // Mail needs sign-in, so it has no tools listed.
    expect(names.some((n) => n.startsWith("mail__"))).toBe(false);
    expect(names).not.toContain("find_tools");
    expect(names).not.toContain("call_tool");
    expect([...offered(s, id)].some((n) => n.includes("__"))).toBe(false);
    // The index lists the agent's connectors and their state.
    const payload = lastPayload(s, id);
    expect(payload).toContain("- Calendar (2 tools)");
    expect(payload).toContain("- Notes (4 tools)");
    expect(payload).toContain("- Mail — needs sign-in");
  });

  it("loads the best connector tools for a task, one by one, and lists the next best as also relevant", async () => {
    const s = await start(world());
    const id = await chat(s);
    const r = await search(s, id, { query: "list calendar events" });
    expect(r.last!.isError).toBe(false);
    expect(r.last!.text).toContain("- calendar__list_events (Calendar): Calendar connector, list_events");
    expect(r.last!.text).not.toContain("Loaded the");
    const now = offered(s, id);
    expect(now.has("calendar__list_events")).toBe(true);
    expect(now.has("calendar__create_event")).toBe(false);
    expect(now.has("notes__search_notes")).toBe(false);
  });

  it("loads at most five tools, at least half the top score, and the next eight best are listed, not loaded", async () => {
    const gw = new FakeMcpGateway();
    gw.add(
      "con_big",
      "Big",
      Array.from({ length: 20 }, (_, i) => tool(`thing_${i}`, "Count the widgets in a box.", { readOnlyHint: true })),
    );
    const s = await start(gw);
    const id = await chat(s);
    const text = (await search(s, id, { query: "count widgets" })).last!.text;
    expect(text).toContain("Loaded 5 tools:");
    const loaded = [...offered(s, id)].filter((n) => n.startsWith("big__"));
    expect(loaded).toHaveLength(5);
    const also = text.slice(text.indexOf("Also relevant")).match(/^- big__thing_\d+/gm) ?? [];
    expect(also).toHaveLength(8);
    for (const line of also) expect(loaded).not.toContain(line.slice(2));
  });

  it("answers a connector's name alone with its directory and loads nothing; load then picks from it", async () => {
    const s = await start(world());
    const id = await chat(s);
    const r = await search(s, id, { query: "Notes" });
    expect(r.last!.text).toContain("Notes has 4 tools; none was loaded.");
    expect(r.last!.text).toContain("- notes__delete_note: Delete a note for good.");
    expect([...offered(s, id)].some((n) => n.startsWith("notes__"))).toBe(false);
    const loaded = await search(s, id, { load: ["notes__add_note"] });
    expect(loaded.last!.text).toContain("Loaded 1 tool:");
    expect(offered(s, id).has("notes__add_note")).toBe(true);
    expect(offered(s, id).has("notes__delete_note")).toBe(false);
  });

  it("answers a connector's name in load with its directory, and a tool's own name with its full name", async () => {
    const s = await start(world());
    const id = await chat(s);
    const r = await search(s, id, { load: ["Notes", "search_notes", "nothing_here"] });
    const text = r.last!.text;
    expect(text).toContain('"Notes" is a connector, not a tool. Notes has 4 tools; none was loaded.');
    expect(text).toContain("- notes__delete_note: Delete a note for good.");
    expect(text).toContain("search_notes is a connector tool's own name; load it as notes__search_notes.");
    expect(text).toContain("Not found: search_notes, nothing_here.");
    expect(text).not.toContain("Not found: Notes");
    expect([...offered(s, id)].some((n) => n.startsWith("notes__"))).toBe(false);
  });

  it("is read_internal: searching asks nothing and taints nothing", async () => {
    const s = await start(world());
    const id = await chat(s);
    await search(s, id, { query: "search notes" });
    expect(taintOf(s, id)).toEqual([]);
    expect(await pending(s)).toEqual([]);
  });

  it("suggests the owning plugin's skills with a loaded connector tool", async () => {
    const s = await start(world());
    const plugins = s.host.plane.plugins;
    plugins.guidance = (id: string) => (id === "con_notes" ? { plugin: "notes", skills: ["notes/filing"] } : undefined);
    s.host.plane.skills.save({
      files: [
        {
          path: "SKILL.md",
          encoding: "text",
          content: "---\nname: filing\ndescription: How to file notes.\n---\n\nSteps.\n",
        },
      ],
      author: "user",
      note: "Imported",
      log: false,
    });
    const skill = s.host.plane.skills.list().find((k) => !k.id.startsWith("builtin_"))!;
    plugins.skillInfo = (id: string) => (id === skill.id ? { plugin: "notes", reference: "notes/filing" } : undefined);
    const id = await chat(s);
    const text = (await search(s, id, { query: "search my notes" })).last!.text;
    expect(text).toContain("notes__search_notes");
    expect(text).toContain("- notes/filing (plugin notes): How to file notes.");
  });
});

describe("connector tool names", () => {
  it("are provider-safe, at most 64 characters, and never collide", async () => {
    const gw = new FakeMcpGateway();
    const long = "x".repeat(80);
    gw.add("con_a", "Team Notes!", [tool("search.notes", "A"), tool("search_notes", "B"), tool(long, "C")]);
    gw.add("con_b", "team-notes", [tool("search_notes", "D")]);
    gw.add("con_c", "日本", [tool("検索", "E")]);
    const s = await start(gw);
    await chat(s);
    const directory = s.host.plane.connectorTools;
    await directory.refresh();
    const names = directory.entries().map((e) => e.name);
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("team_notes__search_notes");
    expect(names.filter((n) => n.startsWith("team_notes_")).length).toBe(4);
    expect(names.find((n) => directory.info(n)?.connectorId === "con_b")).toMatch(
      /^team_notes_[0-9a-f]{8}__search_notes$/,
    );
    expect(names.find((n) => directory.info(n)?.tool === long)).toHaveLength(64);
    expect(names.find((n) => directory.info(n)?.connectorId === "con_c")).toBe("connector__tool");
    // Assigned once: a refresh gives every tool the same name.
    await directory.refresh();
    expect(directory.entries().map((e) => e.name)).toEqual(names);
  });
});

describe("calling a connector tool", () => {
  it("shows the claimed Read class but asks for consent to an untrusted provider", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    const tools = await s.client.get("/api/connectors/con_notes/tools");
    expect(tools.body.tools[0]).toMatchObject({
      defaultClass: "read_external",
      effectiveClass: "read_external",
      override: null,
    });
    await askMcp(s, id, "notes__search_notes", {});
    expect((await waitPending(s, id))[0]).toMatchObject({
      actionClass: "read_external",
      lengths: ["once"],
      preview: {
        kind: "mcp-provider",
        connectorId: "con_notes",
        connectorName: "Notes",
        url: "https://notes.example/mcp",
        tool: "search_notes",
        claimedReadOnly: true,
        mcpProfile: "always_ask",
      },
    });
    expect(gw.calls).toEqual([]);
  });

  it("never downgrades destructive + read-only, even with an explicit read override", async () => {
    const gw = world();
    gw.tools.set("con_notes", [tool("danger", "Deletes data", { readOnlyHint: true, destructiveHint: true })]);
    const s = await start(gw);
    await s.host.plane.mcp.setOverride("con_notes", "danger", "read_external");
    const id = await chat(s);
    await setProfile(s, id, "yolo");
    const tools = await s.client.get("/api/connectors/con_notes/tools");
    expect(tools.body.tools[0]).toMatchObject({ override: "read_external", effectiveClass: "irreversible" });
    await askMcp(s, id, "notes__danger", {});
    expect((await waitPending(s, id))[0]).toMatchObject({ actionClass: "irreversible", lengths: ["once"] });
    expect(gw.calls).toEqual([]);
  });

  it.each(["schema", "hints", "override", "connector", "tool name"])(
    "refuses %s drift after a one-time approval was requested",
    async (change) => {
      const gw = world();
      const s = await start(gw);
      const id = await chat(s);
      await askMcp(s, id, "notes__add_note", {});
      const changed = structuredClone(NOTES);
      if (change === "schema") changed[1]!.inputSchema = { type: "object", required: ["danger"] };
      if (change === "hints") changed[1]!.annotations = { destructiveHint: true };
      if (change === "override") await s.host.plane.mcp.setOverride("con_notes", "add_note", "send");
      if (change === "tool name") changed[1]!.name = "renamed_note";
      if (change === "connector") {
        gw.connectors = gw.connectors.filter((c) => c.id !== "con_notes");
        gw.add("con_replacement", "Notes", changed);
      } else gw.tools.set("con_notes", changed);
      await approve(s, id, { length: "once" });
      expect(gw.calls).toEqual([]);
      expect(gw.requests.filter((r) => r.path.endsWith("/call"))).toEqual([]);
    },
  );

  it("classifies claimed reads separately from authorization, with a destructive floor", () => {
    expect(defaultClass({ readOnlyHint: true })).toBe("read_external");
    expect(defaultClass({ readOnlyHint: false })).toBe("write_external");
    expect(defaultClass({ destructiveHint: true })).toBe("irreversible");
    expect(defaultClass({ readOnlyHint: true, destructiveHint: true })).toBe("irreversible");
    expect(defaultClass({})).toBe("write_external");
    expect(defaultClass({ destructiveHint: false })).toBe("write_external");
    expect(defaultClass(undefined)).toBe("write_external");
    expect(defaultClass(null)).toBe("write_external");
    expect(defaultClass({ readOnlyHint: "true", destructiveHint: "true" } as never)).toBe("write_external");
  });

  it("lets a read through in Standard, sends the call to the gateway with the step id, taints external and private", async () => {
    const gw = world();
    gw.callReply = () => ({ json: { isError: false, text: "3 notes", structured: null, truncated: false } });
    const s = await start(gw);
    await s.host.plane.mcp.setOverride("con_notes", "search_notes", "read_external");
    await trustProvider(s);
    const id = await chat(s);
    const r = await callTool(s, id, "notes__search_notes", { q: "x" });
    expect(r.last!.isError).toBe(false);
    expect(r.last!.text).toContain("3 notes");
    expect(r.last!.text).toContain("not from the user");
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]).toMatchObject({
      connector: "con_notes",
      tool: "search_notes",
      args: { q: "x" },
      auth: `Bearer ${STANDIN}`,
    });
    const step = s.host.plane.store.db.get<{ type: string }>(
      "SELECT type FROM steps WHERE id = ?",
      gw.calls[0]!.stepId!,
    );
    expect(step?.type).toBe("llm.call");
    expect(taintOf(s, id)).toEqual(["external", "private"]);
    expect(await pending(s)).toEqual([]);
  });

  it("adds only external when the connector does not hold the user's data", async () => {
    const s = await start(world());
    await s.host.plane.mcp.setOverride("con_cal", "list_events", "read_external");
    await s.client.call("PATCH", "/api/connectors/con_cal", { body: { holdsPrivate: false } });
    await trustProvider(s, "con_cal");
    const id = await chat(s);
    await callTool(s, id, "calendar__list_events", {});
    expect(taintOf(s, id)).toEqual(["external"]);
  });

  it("asks for a write in Standard with a card that names connector, tool and arguments; asks in Relaxed too", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await askMcp(s, id, "notes__add_note", { title: "Milk", body: "2 litres" });
    expect(gw.calls).toHaveLength(0);
    const [a] = (await waitPending(s, id, 1)) as Approval[];
    expect(a).toMatchObject({
      tool: "notes__add_note",
      connector: "mcp",
      operation: "call",
      actionClass: "write_external",
      destination: "con_notes.add_note",
    });
    expect(a!.summary).toContain("Notes: add_note");
    expect(a!.summary).toContain('"title":"Milk"');
    expect(JSON.parse(a!.argsPreview)).toEqual({
      connector: "Notes",
      tool: "add_note",
      arguments: { title: "Milk", body: "2 litres" },
    });
    expect(a!.argsPreview).toContain("\n"); // pretty printed
    const relaxed = await chat(s);
    await setProfile(s, relaxed, "relaxed");
    await askMcp(s, relaxed, "notes__add_note", { title: "Eggs" });
    expect(gw.calls).toHaveLength(0);
  });

  it("uses the override: a read made a send asks, a manual write-to-read still asks", async () => {
    const gw = world();
    const s = await start(gw);
    await s.client.call("PUT", "/api/connectors/con_notes/tools/search_notes", { body: { actionClass: "send" } });
    const inspected = (await s.client.get("/api/connectors/con_notes/tools")).body.tools.find(
      (t: { name: string }) => t.name === "add_note",
    );
    await s.client.call("PUT", "/api/connectors/con_notes/tools/add_note", {
      body: { actionClass: "read_external", definitionFingerprint: inspected.definitionFingerprint },
    });
    await trustProvider(s);
    const id = await chat(s);
    await askMcp(s, id, "notes__add_note", {});
    await approve(s, id);
    await askMcp(s, id, "notes__search_notes", {});
    const [a] = await waitPending(s, id, 1);
    expect(a!.actionClass).toBe("send");
    // Tainted (the first call read private data), so a send asks every time and only "once" is offered.
    expect(a!.lengths).toEqual(["once"]);
  });

  it("asks for an irreversible call even in YOLO, once only, and never makes a standing grant", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await setProfile(s, id, "yolo");
    await askMcp(s, id, "notes__delete_note", { id: "1" });
    const [a] = await waitPending(s, id, 1);
    expect(a).toMatchObject({ actionClass: "irreversible", lengths: ["once"] });
    await approve(s, id, { length: "once" });
    expect(gw.calls).toHaveLength(1);
    expect(await grants(s)).toEqual([]);
  });

  it("offers only once; a legacy session grant cannot bypass the connector profile", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await askMcp(s, id, "notes__add_note", {});
    const request = (await waitPending(s, id))[0]!;
    expect(
      (await s.client.post(`/api/approvals/${request.id}/decide`, { decision: "approve", length: "session" })).status,
    ).toBe(400);
    const db = s.host.plane.store.db;
    db.run(
      "INSERT INTO grants (id, connector, operation, destination, length, session_id, approval_id, created_at) VALUES ('legacy', 'mcp', 'call', 'con_notes.add_note', 'session', ?, ?, ?)",
      id,
      request.id,
      s.clock.now(),
    );
    await approve(s, id);
    expect(gw.calls).toHaveLength(1);
    await askMcp(s, id, "notes__add_note", {});
    expect(gw.calls).toHaveLength(1);
    await s.host.plane.mcp.remove("con_notes");
    expect(await grants(s)).toEqual([]);
  });

  it("does not reuse a write approval as a familiar send destination after classification changes", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await askMcp(s, id, "notes__add_note", {});
    await approve(s, id, { length: "once" });
    expect(gw.calls).toHaveLength(1);
    await s.host.plane.mcp.setOverride("con_notes", "add_note", "send");
    await setProfile(s, id, "relaxed");
    await askMcp(s, id, "notes__add_note", {});
    expect((await waitPending(s, id))[0]).toMatchObject({ actionClass: "send", lengths: ["once"] });
    expect(gw.calls).toHaveLength(1);
  });

  it("matches a trigger's allow entry by the connector tool's name, and by its destination when it names one", () => {
    const allow = [{ tool: "notes__add_note", destination: "con_notes.add_note" }];
    expect(allowMatches(allow, "notes__add_note", "write_external", "con_notes.add_note", [])).toBe(true);
    expect(allowMatches(allow, "notes__mail_note", "write_external", "con_notes.mail_note", [])).toBe(false);
    expect(allowMatches(allow, "notes__add_note", "irreversible", "con_notes.add_note", [])).toBe(false);
    expect(
      allowMatches([{ tool: "notes__add_note" }], "notes__add_note", "write_external", "con_notes.add_note", []),
    ).toBe(true);
  });

  it("the trigger allow list validator takes a connector tool by its name alone", async () => {
    const s = await start(world());
    await callTool(s, await chat(s), "search_capabilities", { query: "notes" });
    expect(checkAllow([{ tool: "notes__add_note" }], s.host.plane.catalog)).toEqual([{ tool: "notes__add_note" }]);
    expect(() => checkAllow([{ tool: "notes__delete_note" }], s.host.plane.catalog)).not.toThrow();
  });

  it("gives the model the tool's own error text", async () => {
    const gw = world();
    gw.callReply = () => ({ json: { isError: true, text: "Note not found", structured: null, truncated: false } });
    const s = await start(gw);
    await s.host.plane.mcp.setOverride("con_notes", "search_notes", "read_external");
    await trustProvider(s);
    const r = await callTool(s, await chat(s), "notes__search_notes", {});
    expect(r.last).toMatchObject({ isError: true });
    expect(r.last!.text).toContain("Note not found");
  });

  it("turns needs_auth, an unreachable connector, a gateway outage and unknown or removed tools into clear messages", async () => {
    const gw = world();
    const s = await start(gw);
    await trustProvider(s);
    const id = await chat(s);
    await setProfile(s, id, "relaxed");
    gw.callReply = () => ({ status: 409, json: { error: { code: "needs_auth", message: "Sign in again." } } });
    expect((await callTool(s, id, "notes__search_notes", {})).last!.text).toMatch(
      /needs the user to sign in again.*Settings → Capabilities → Connectors/,
    );
    gw.callReply = () => ({
      status: 502,
      json: { error: { code: "connector_unreachable", message: "It did not answer." } },
    });
    expect((await callTool(s, id, "notes__search_notes", {})).last!.text).toMatch(
      /could not be reached right now \(It did not answer\.\)/,
    );
    // A connector that needs sign-in has no tools registered, and a made-up name is no tool: neither runs.
    expect((await callTool(s, id, "mail__search_mail", {})).last!.text).toMatch(/mail__search_mail is not available/);
    expect((await callTool(s, id, "notes__nope", {})).last!.text).toMatch(/notes__nope is not available/);
    gw.tools.set("con_notes", NOTES.slice(1));
    expect((await callTool(s, id, "notes__search_notes", {})).last!.text).toMatch(
      /Notes no longer has the tool "search_notes"/,
    );
    // Refreshed with the tool back: it is registered again.
    gw.tools.set("con_notes", NOTES);
    await s.host.plane.mcp.tools("con_notes", true);
    await s.host.plane.adapter.trees.syncConnectors();
    gw.down = true;
    expect((await callTool(s, id, "notes__search_notes", {})).last!.text).toMatch(/could not be reached right now/);
  });
});

describe("MCP permission profiles", () => {
  it("resumes a single read in place before processing a queued message", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await search(s, id, { load: ["notes__search_notes"] });
    const callsBefore = stepPayloads(s, id).length;
    const approval = await askMcp(s, id, "notes__search_notes", { q: "receipt" });
    const waiting = await detail(s, id);
    const original = waiting.runs.at(-1)!;
    expect(waiting.session.status).toBe("waiting_for_user");
    expect(original.status).toBe("running");
    expect(stepPayloads(s, id)).toHaveLength(callsBefore + 1);
    expect(gw.calls).toEqual([]);

    // Queued on purpose (the default would steer it into the parked run).
    const queued = await s.client.post(`/api/sessions/${id}/messages`, {
      requestId: crypto.randomUUID(),
      text: "Thanks for checking.",
      whenBusy: "queue",
    });
    expect((await detail(s, id)).runs.at(-1)).toMatchObject({ id: queued.body.runId, status: "queued" });
    expect((await decide(s, approval.id, { decision: "approve" })).status).toBe(200);
    const done = await settled(s, id, waiting.runs.length + 1);
    expect(done.runs.slice(-2).map(({ id }) => id)).toEqual([original.id, queued.body.runId]);
    expect(stepPayloads(s, id)).toHaveLength(callsBefore + 3);
    expect(gw.calls.map(({ tool, args }) => ({ tool, args }))).toEqual([
      { tool: "search_notes", args: { q: "receipt" } },
    ]);
    expect(done.messages.find((m) => m.approval?.id === approval.id)).toMatchObject({
      runId: original.id,
      approval: { status: "approved", execution: "ran" },
    });
  });

  it.each(["denied", "expired", "cancelled"])("settles the original call when its approval is %s", async (status) => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    const approval = await askMcp(s, id, "notes__add_note");
    if (status === "denied") expect((await decide(s, approval.id, { decision: "deny" })).status).toBe(200);
    if (status === "expired") {
      s.clock.advance(approval.expiresAt - s.clock.now() + 1);
      expect((await decide(s, approval.id, { decision: "approve" })).status).toBe(409);
    }
    if (status === "cancelled") expect((await s.client.post(`/api/sessions/${id}/cancel`, {})).status).toBe(200);
    const done = await settled(s, id);
    expect(done.runs.map((run) => run.status)).toEqual([status === "cancelled" ? "cancelled" : "completed"]);
    expect(done.messages.find((m) => m.approval?.id === approval.id)?.approval?.status).toBe(status);
    expect(done.messages.filter((m) => m.role === "notice")).toEqual([]);
    expect(gw.calls).toEqual([]);
    expect(await pending(s)).toEqual([]);
  });

  for (const profile of ["always_ask", "read_only", "read_write", "yolo"] as const) {
    it.each(["strict", "standard", "relaxed", "yolo"] as const)(
      `${profile} obeys the MCP matrix under chat %s`,
      async (chatProfile) => {
        const gw = world();
        gw.tools.set("con_notes", [
          ...NOTES,
          tool("false_read", "False hint", { readOnlyHint: false }),
          tool("conflict", "Conflict", { readOnlyHint: true, destructiveHint: true }),
        ]);
        const s = await start(gw);
        await selectProfile(s, profile);
        await s.host.plane.mcp.setOverride("con_notes", "mail_note", "send");
        const id = await chat(s);
        await setProfile(s, id, chatProfile);
        let effects = 0;
        for (const [name, actionClass] of [
          ["search_notes", "read_external"],
          ["add_note", "write_external"],
          ["mail_note", "send"],
          ["delete_note", "irreversible"],
          ["false_read", "write_external"],
          ["conflict", "irreversible"],
        ]) {
          const automatic =
            profile === "yolo" ||
            (profile === "read_only" && name === "search_notes") ||
            (profile === "read_write" && ["search_notes", "add_note", "false_read"].includes(name as string));
          if (automatic) {
            const result = await callTool(s, id, `notes__${name}`, { q: "fixture" });
            expect(result.last!.isError).toBe(false);
          } else {
            expect(gw.calls).toHaveLength(effects);
            const pending = await askMcp(s, id, `notes__${name}`, { q: "fixture" });
            expect(pending).toMatchObject({
              actionClass,
              lengths: ["once"],
              preview: { kind: "mcp-provider", url: "https://notes.example/mcp", tool: name, mcpProfile: profile },
            });
            expect(
              (await s.client.post(`/api/approvals/${pending.id}/decide`, { decision: "approve", length: "always" }))
                .status,
            ).toBe(400);
            await approve(s, id);
          }
          expect(gw.calls).toHaveLength(++effects);
        }
        expect(taintOf(s, id)).toEqual(["external", "private"]);
        expect(await grants(s)).toEqual([]);
      },
    );
  }

  it("Always Ask needs a fresh exact-call approval every time", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await askMcp(s, id, "notes__search_notes", {});
    await approve(s, id);
    expect((await s.host.plane.mcp.list())[0]!.mcpProfile).toBe("always_ask");
    await askMcp(s, id, "notes__search_notes", {});
    expect(gw.calls).toHaveLength(1);
  });

  it("reviews a new round of reads after the approved connector call finishes", async () => {
    const fallback = faux.fauxFactory();
    const scripted = vi.spyOn(faux, "fauxFactory").mockReturnValue((ctx) => {
      const request = faux.lastUserText(ctx.messages);
      const input = ctx.messages.findLastIndex((message) => message.role === "user");
      const results = ctx.messages.slice(input + 1).filter((message) => message.role === "toolResult");
      const result = results[0];
      if (
        request.includes("access check") &&
        results.length === 1 &&
        result &&
        "isError" in result &&
        result.isError === false
      ) {
        return fauxAssistantMessage(
          [
            fauxToolCall("calendar__list_events", {}, { id: "follow-up-list" }),
            fauxToolCall("notes__search_notes", { q: "find notes" }, { id: "follow-up-search" }),
          ],
          { stopReason: "toolUse" },
        );
      }
      return fallback(ctx);
    });
    try {
      const gw = world();
      const s = await start(gw);
      const sid = await chat(s);
      await search(s, sid, { load: ["notes__search_notes", "calendar__list_events"] });
      const check = await askMcp(s, sid, "notes__search_notes", { q: "access check" });
      const count = (await detail(s, sid)).runs.length;
      expect((await decide(s, check.id, { decision: "approve" })).status).toBe(200);

      const reads = await until(
        async () => {
          const waiting = (await pending(s)).filter((request) => request.sessionId === sid);
          const runs = (await detail(s, sid)).runs;
          if (waiting.length === 2 || runs.at(-1)?.status === "completed") return waiting;
          return undefined;
        },
        5_000,
        "the requests or the end of the approval run",
      );
      expect(gw.calls.map((call) => call.tool)).toEqual(["search_notes"]);
      expect(reads.map((request) => request.tool)).toEqual(["calendar__list_events", "notes__search_notes"]);
      expect(reads[0]!.groupId).toBeDefined();
      expect(reads[1]!.groupId).toBe(reads[0]!.groupId);

      const response = await s.client.post(`/api/approval-groups/${encodeURIComponent(reads[0]!.groupId!)}/decide`, {
        decisions: reads.map((request) => ({ id: request.id, decision: "approve" })),
      });
      expect(response.status).toBe(200);
      expect((await settled(s, sid, count)).runs).toHaveLength(count);
      expect(gw.calls.map(({ tool, args }) => ({ tool, args }))).toEqual([
        { tool: "search_notes", args: { q: "access check" } },
        { tool: "list_events", args: {} },
        { tool: "search_notes", args: { q: "find notes" } },
      ]);
    } finally {
      scripted.mockRestore();
    }
  });

  it("pauses a worker's original run, executes the allowed reads, and reports their results together", async () => {
    const gw = world();
    const s = await start(gw);
    const parent = homeChat(s);
    const brief = [
      "[tool round]",
      directive("notes__search_notes", { q: "first" }),
      directive("calendar__list_events", {}),
      directive("notes__search_notes", { q: "second" }),
    ].join(" ");
    await say(s, parent, `[spawn: ${brief}]`);
    const worker = await until(async () => (await childrenOf(s, parent))[0], 10_000, "the worker");
    const requests = await waitPending(s, worker.id, 3);
    const groupId = requests[0]!.groupId;
    expect(groupId).toBeDefined();
    expect(requests.every((approval) => approval.groupId === groupId)).toBe(true);
    expect((await detail(s, worker.id)).runs.map((run) => run.status)).toEqual(["running"]);
    expect((await detail(s, parent)).messages.filter((m) => m.role === "report")).toHaveLength(0);
    expect(gw.calls).toEqual([]);
    const callCount = stepPayloads(s, worker.id).length;
    const trace = async () => (await s.client.get(`/api/sessions/${worker.id}/trace`)).body as SessionTraceResponse;
    expect((await trace()).runs[0]?.steps).toContainEqual(
      expect.objectContaining({
        status: "running",
        decision: "ask",
        approvalId: requests[0]!.id,
      }),
    );

    const submit = (decisions: { id: string; decision: string }[]) =>
      s.client.post(`/api/approval-groups/${encodeURIComponent(groupId!)}/decide`, { decisions });
    const decisions = requests.map((request, i) => ({ id: request.id, decision: i === 1 ? "deny" : "approve" }));
    expect((await submit(decisions.slice(0, 2))).status).toBe(409);
    expect(await pending(s)).toHaveLength(3);
    s.clock.advance(31 * 60_000);
    expect((await submit(decisions)).status).toBe(200);
    const finished = await settled(s, worker.id);
    expect((await submit(decisions)).status).toBe(200);
    expect(finished.runs.map((run) => run.status)).toEqual(["completed"]);
    expect((await trace()).runs[0]?.totals.approvalWaitMs).toBeGreaterThanOrEqual(31 * 60_000);
    expect(gw.calls.map(({ tool, args }) => ({ tool, args }))).toEqual([
      { tool: "search_notes", args: { q: "first" } },
      { tool: "search_notes", args: { q: "second" } },
    ]);
    expect(stepPayloads(s, worker.id)).toHaveLength(callCount + 1);
    expect(
      finished.messages
        .filter((m) => m.approval)
        .map((m) => m.approval!.execution)
        .sort(),
    ).toEqual(["ran", "ran", undefined]);
    await until(
      async () => (await detail(s, parent)).messages.find((m) => m.role === "report"),
      10_000,
      "the worker's report",
    );
    expect((await detail(s, parent)).messages.filter((m) => m.role === "report")).toHaveLength(1);
  });

  it.each(["deny all", "expire all"])("releases a connector read batch with no dispatch after %s", async (outcome) => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await say(
      s,
      id,
      ["[tool round]", directive("notes__search_notes", {}), directive("calendar__list_events", {})].join(" "),
    );
    const requests = await waitPending(s, id, 2);
    const group = requests[0]!.groupId;
    expect(group).toBeTruthy();
    if (outcome === "deny all") {
      const response = await s.client.post(`/api/approval-groups/${encodeURIComponent(group!)}/decide`, {
        decisions: requests.map((request) => ({ id: request.id, decision: "deny" })),
      });
      expect(response.status).toBe(200);
    } else {
      s.clock.advance(Math.max(...requests.map((request) => request.expiresAt)) - s.clock.now() + 1);
      await s.host.plane.adapter.approvals.sweep();
    }
    const finished = await settled(s, id);
    expect(finished.runs.map((run) => run.status)).toEqual(["completed"]);
    expect(finished.messages.filter((message) => message.approval).map((message) => message.approval?.status)).toEqual(
      Array(2).fill(outcome === "deny all" ? "denied" : "expired"),
    );
    expect(await pending(s)).toEqual([]);
    expect(gw.calls).toEqual([]);
  });

  it("keeps a pending checkpoint across restart and revalidates each tool definition on resume", async () => {
    const gw = world();
    const s = await start(gw);
    const sid = await chat(s);
    const brief = [
      "[tool round]",
      directive("notes__search_notes", { q: "fixture" }),
      directive("calendar__list_events", {}),
    ].join(" ");
    await say(s, sid, brief);
    const requests = await waitPending(s, sid, 2);
    const [notes, calendar] = requests;
    expect(notes!.groupId).toBeDefined();
    expect((await decide(s, notes!.id, { decision: "approve" })).status).toBe(200);
    expect(gw.calls).toEqual([]);

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
    expect((await waitPending(reopened, sid)).map(({ id }) => id)).toEqual([calendar!.id]);
    await selectProfile(reopened, "read_only", "con_cal");
    const response = await reopened.client.post(`/api/approval-groups/${encodeURIComponent(notes!.groupId!)}/decide`, {
      decisions: [{ id: calendar!.id, decision: "approve" }],
    });
    expect(response.status).toBe(200);
    const result = await settled(reopened, sid);
    expect(result.runs.map((run) => run.status)).toEqual(["completed"]);
    expect(gw.calls.map(({ tool, args }) => ({ tool, args }))).toEqual([
      { tool: "search_notes", args: { q: "fixture" } },
    ]);
    expect(result.messages.find((m) => m.approval?.id === notes!.id)?.approval?.execution).toBe("ran");
    expect(result.messages.find((m) => m.approval?.id === calendar!.id)?.approval?.execution).toBe("needs_approval");
  });

  it("cancels every pending read when the user stops a waiting run", async () => {
    const gw = world();
    const s = await start(gw);
    const sid = await chat(s);
    await say(
      s,
      sid,
      ["[tool round]", directive("notes__search_notes", {}), directive("calendar__list_events", {})].join(" "),
    );
    const requests = await waitPending(s, sid, 2);
    expect(requests[0]!.groupId).toBeDefined();
    expect((await s.client.post(`/api/sessions/${sid}/cancel`, {})).status).toBe(200);
    const result = await settled(s, sid);
    expect(result.runs.map((run) => run.status)).toEqual(["cancelled"]);
    expect(await pending(s)).toEqual([]);
    expect(gw.calls).toEqual([]);
  });

  it("runs separately approved reads from the same worker run after the first read taints the session", async () => {
    const gw = world();
    const s = await start(gw);
    const parent = homeChat(s);
    const brief = [
      directive("notes__search_notes", { q: "first" }),
      directive("calendar__list_events", {}),
      directive("notes__search_notes", { q: "second" }),
    ].join(" ");
    await say(s, parent, `[spawn: ${brief}]`);
    const worker = await until(async () => (await childrenOf(s, parent))[0], 10_000, "the worker");
    const tools = ["notes__search_notes", "calendar__list_events", "notes__search_notes"];
    for (const [i, name] of tools.entries()) {
      const [request] = await waitPending(s, worker.id);
      expect(request).toMatchObject({ tool: name, resumesTool: true });
      expect(gw.calls).toHaveLength(i);
      expect((await decide(s, request!.id, { decision: "approve" })).status).toBe(200);
    }
    expect((await settled(s, worker.id)).runs).toHaveLength(1);
    expect(gw.calls.map(({ tool, args }) => ({ tool, args }))).toEqual([
      { tool: "search_notes", args: { q: "first" } },
      { tool: "list_events", args: {} },
      { tool: "search_notes", args: { q: "second" } },
    ]);
    expect(taintOf(s, worker.id)).toEqual(["external", "private"]);
    expect(await pending(s)).toEqual([]);
  });

  it("rejects stale pending approvals after any profile revision, including change-and-restore", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await askMcp(s, id, "notes__search_notes", {});
    await selectProfile(s, "read_only");
    await selectProfile(s, "always_ask");
    await approve(s, id);
    expect(gw.calls).toEqual([]);
  });

  it("persists Read-only through refresh and a new service; new declared reads work only for that connector", async () => {
    const gw = world();
    const s = await start(gw);
    await selectProfile(s, "read_only");
    const changed = structuredClone(NOTES);
    changed[0]!.inputSchema = { type: "object", properties: { newer: { type: "boolean" } } };
    gw.tools.set("con_notes", [...changed, tool("new_read", "New read", { readOnlyHint: true })]);
    await s.host.plane.mcp.tools("con_notes", true);
    const reopened = new McpService({
      store: s.host.plane.store,
      approvals: s.host.plane.approvals,
      clock: s.clock,
      log: nullLogger,
      gatewayUrl: "http://gateway.test",
      fetchImpl: gw.fetch,
      token: async () => undefined,
    });
    expect((await reopened.list())[0]!.mcpProfile).toBe("read_only");
    const id = await chat(s);
    for (const name of ["search_notes", "new_read"])
      expect((await callTool(s, id, `notes__${name}`, {})).last!.isError).toBe(false);
    await askMcp(s, id, "calendar__list_events", {});
    expect(gw.calls).toHaveLength(2);
  });

  it("rejects old schema approval even in YOLO and permits a fresh invocation", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await askMcp(s, id, "notes__search_notes", {});
    await selectProfile(s, "yolo");
    const changed = structuredClone(NOTES);
    changed[0]!.inputSchema = { type: "object", properties: { changed: { type: "string" } } };
    gw.tools.set("con_notes", changed);
    await approve(s, id);
    expect(gw.calls).toEqual([]);
    expect((await callTool(s, await chat(s), "notes__search_notes", {})).last!.isError).toBe(false);
    expect(gw.calls).toHaveLength(1);
  });

  it("requires explicit YOLO confirmation, identity and current revision; concurrent edits fail", async () => {
    const s = await start(world());
    const c = (await s.host.plane.mcp.list())[0]!;
    const body = { profile: "yolo", providerIdentity: c.providerIdentity, expectedRevision: c.mcpProfileRevision };
    expect((await s.client.call("PUT", "/api/connectors/con_notes/profile", { body })).status).toBe(400);
    expect(
      (await s.client.call("PUT", "/api/connectors/con_notes/profile", { body: { ...body, confirmYolo: true } }))
        .status,
    ).toBe(200);
    expect(
      (await s.client.call("PUT", "/api/connectors/con_notes/profile", { body: { ...body, profile: "read_only" } }))
        .status,
    ).toBe(409);
    expect((await s.host.plane.mcp.list())[0]!.mcpProfile).toBe("yolo");
  });

  it("rejects stale pending approval when session taint changes", async () => {
    const gw = world();
    const s = await start(gw);
    const id = await chat(s);
    await askMcp(s, id, "notes__add_note", {});
    s.host.plane.store.addTaint(id, ["external", "private"]);
    await approve(s, id);
    expect(gw.calls).toEqual([]);
  });

  it("rejects an earlier public read approval if the session gains private data while waiting", async () => {
    const gw = world();
    const s = await start(gw);
    await s.host.plane.mcp.update("con_cal", { holdsPrivate: false });
    const id = await chat(s);
    await askMcp(s, id, "calendar__list_events", {});
    const [publicRead] = await waitPending(s, id);
    s.host.plane.store.addTaint(id, ["external", "private"]);
    await approve(s, id);
    expect(gw.calls).toEqual([]);
    expect(s.host.plane.approvals.row(publicRead!.id)).toMatchObject({
      consumed_by: null,
      execution: "needs_approval",
    });
  });

  it("allows only one simultaneous profile edit for an observed revision", async () => {
    const s = await start(world());
    const c = (await s.host.plane.mcp.list())[0]!;
    const edits = await Promise.allSettled([
      s.host.plane.mcp.setProfile(c.id, "read_only", c.providerIdentity!, c.mcpProfileRevision!),
      s.host.plane.mcp.setProfile(c.id, "yolo", c.providerIdentity!, c.mcpProfileRevision!, true),
    ]);
    expect(edits.filter((e) => e.status === "fulfilled")).toHaveLength(1);
    expect(edits.filter((e) => e.status === "rejected")).toHaveLength(1);
  });

  it("YOLO cannot bypass a connector sign-in requirement", async () => {
    const gw = world();
    const s = await start(gw);
    await selectProfile(s, "yolo", "con_mail");
    // A connector that needs sign-in registers no tools; the Capabilities index says it needs sign-in.
    const id = await chat(s);
    const result = await callTool(s, id, "mail__search_mail", {});
    expect(result.last!.text).toContain("mail__search_mail is not available");
    expect(lastPayload(s, id)).toContain("- Mail — needs sign-in");
    expect(gw.calls).toEqual([]);
  });
});

describe("the connectors API", () => {
  it("preserves read trust across unchanged refresh, normalized schema order and a new service instance", async () => {
    const gw = world();
    const s = await start(gw);
    const before = (await s.client.get("/api/connectors/con_notes/tools?refresh=1")).body.tools[1];
    expect(
      (
        await s.client.call("PUT", "/api/connectors/con_notes/tools/add_note", {
          body: { actionClass: "read_external", definitionFingerprint: before.definitionFingerprint },
        })
      ).status,
    ).toBe(200);
    const changedOrder = structuredClone(NOTES);
    changedOrder[1]!.inputSchema = { properties: { q: { type: "string" } }, type: "object" };
    gw.tools.set("con_notes", changedOrder);
    const after = (await s.client.get("/api/connectors/con_notes/tools?refresh=1")).body.tools[1];
    expect(after).toMatchObject({
      override: "read_external",
      effectiveClass: "read_external",
      definitionFingerprint: before.definitionFingerprint,
    });
    const reopened = new McpService({
      store: s.host.plane.store,
      approvals: s.host.plane.approvals,
      clock: s.clock,
      log: nullLogger,
      gatewayUrl: "http://gateway.test",
      fetchImpl: gw.fetch,
      token: async () => undefined,
    });
    expect((await reopened.tools("con_notes", true)).tools[1]).toMatchObject({
      override: "read_external",
      effectiveClass: "read_external",
    });
    await trustProvider(s);
    const manual = await chat(s);
    await askMcp(s, manual, "notes__add_note", {});
    await approve(s, manual);
    expect(gw.calls).toHaveLength(1);
  });

  it.each(["schema", "annotations", "description", "removed", "connector"])(
    "invalidates read trust on %s drift, for a manual downgrade of an untagged write",
    async (change) => {
      const gw = world();
      const s = await start(gw);
      await s.host.plane.mcp.setOverride("con_notes", "add_note", "read_external");
      await trustProvider(s);
      const changed = structuredClone(NOTES);
      if (change === "schema") changed[1]!.inputSchema = { type: "object", required: ["extra"] };
      if (change === "annotations") changed[1]!.annotations = { idempotentHint: true };
      if (change === "description") changed[1]!.description = "A changed write operation.";
      if (change === "removed") changed.splice(1, 1);
      if (change === "connector") gw.connectors[0]!.name = "Renamed notes";
      gw.tools.set("con_notes", changed);
      const refreshed = await s.client.get("/api/connectors/con_notes/tools?refresh=1");
      const refreshedTool = refreshed.body.tools.find((t: { name: string }) => t.name === "add_note");
      if (change !== "removed")
        expect(refreshedTool).toMatchObject({ override: null, effectiveClass: "write_external" });
      // Even returning to the old definition must not resurrect trust after drift was observed.
      gw.tools.set("con_notes", structuredClone(NOTES));
      expect((await s.client.get("/api/connectors/con_notes/tools?refresh=1")).body.tools[1]).toMatchObject({
        override: null,
        effectiveClass: "write_external",
      });
      const id = await chat(s);
      const slug = change === "connector" ? "renamed_notes" : "notes";
      await askMcp(s, id, `${slug}__add_note`, {});
      expect(gw.calls).toEqual([]);
      expect((await waitPending(s, id))[0]!.actionClass).toBe("write_external");
      expect(s.logs.join("\n")).toContain("connector.read_trust_invalidated");
    },
  );

  it("rejects stale read confirmation and requires review of the refreshed fingerprint", async () => {
    const gw = world();
    const s = await start(gw);
    const old = (await s.client.get("/api/connectors/con_notes/tools")).body.tools[1];
    expect(
      (
        await s.client.call("PUT", "/api/connectors/con_notes/tools/add_note", {
          body: { actionClass: "read_external" },
        })
      ).status,
    ).toBe(400);
    const changed = structuredClone(NOTES);
    changed[1]!.inputSchema = { type: "object", required: ["new"] };
    gw.tools.set("con_notes", changed);
    expect(
      (
        await s.client.call("PUT", "/api/connectors/con_notes/tools/add_note", {
          body: { actionClass: "read_external", definitionFingerprint: old.definitionFingerprint },
        })
      ).status,
    ).toBe(409);
    const fresh = (await s.client.get("/api/connectors/con_notes/tools?refresh=1")).body.tools[1];
    expect(fresh).toMatchObject({ override: null, effectiveClass: "write_external" });
    expect(
      (
        await s.client.call("PUT", "/api/connectors/con_notes/tools/add_note", {
          body: { actionClass: "read_external", definitionFingerprint: fresh.definitionFingerprint },
        })
      ).status,
    ).toBe(200);
    expect((await s.client.get("/api/connectors/con_notes/tools")).body.tools[1]).toMatchObject({
      override: "read_external",
      effectiveClass: "read_external",
    });
  });

  it("invalidates name-only read trust on a new call's own refresh and requires explicit re-trust", async () => {
    const gw = world();
    const s = await start(gw);
    await s.host.plane.mcp.setOverride("con_notes", "add_note", "read_external");
    await trustProvider(s);
    const changed = structuredClone(NOTES);
    changed[1]!.inputSchema = { type: "object", properties: { other: { type: "string" } } };
    gw.tools.set("con_notes", changed);
    const id = await chat(s);
    // The tree registered the cached definition; the call's own refresh sees the change, so it does not run, and the
    // tree re-registers the tool under its new definition.
    expect((await callTool(s, id, "notes__add_note", {})).last!.text).toContain("changed the tool add_note");
    await s.host.plane.adapter.trees.syncConnectors();
    await askMcp(s, id, "notes__add_note", { other: "x" });
    expect(gw.calls).toEqual([]);
    const fresh = (await s.client.get("/api/connectors/con_notes/tools")).body.tools[1];
    expect(fresh).toMatchObject({ override: null, effectiveClass: "write_external" });
    expect(
      (
        await s.client.call("PUT", "/api/connectors/con_notes/tools/add_note", {
          body: { actionClass: "read_external", definitionFingerprint: fresh.definitionFingerprint },
        })
      ).status,
    ).toBe(200);
    const next = await chat(s);
    await askMcp(s, next, "notes__add_note", {});
    await approve(s, next);
    expect(gw.calls).toHaveLength(1);
    await s.client.call("DELETE", "/api/connectors/con_notes");
    expect(s.host.plane.store.db.all("SELECT key FROM meta WHERE key GLOB 'mcp:read-trust:*'")).toEqual([]);
  });

  it("does not grandfather unbound old read overrides or trust new remote tools", async () => {
    const gw = world();
    const s = await start(gw);
    s.host.plane.store.db.run(
      "INSERT INTO tool_overrides (connector_id, tool, action_class) VALUES ('con_notes', 'add_note', 'read_external')",
    );
    gw.tools.set("con_notes", [
      ...structuredClone(NOTES),
      tool("new_read", "An unreviewed read", { readOnlyHint: true }),
    ]);
    const { tools } = await s.host.plane.mcp.tools("con_notes", true);
    expect(tools[1]).toMatchObject({ override: null, effectiveClass: "write_external" });
    expect(tools.at(-1)).toMatchObject({ name: "new_read", override: null, effectiveClass: "read_external" });
    const id = await chat(s);
    await askMcp(s, id, "notes__new_read", {});
    expect(gw.calls).toEqual([]);
  });

  it("needs a session, and the CSRF header on writes", async () => {
    const gw = world();
    const s = await start(gw);
    const all = [
      ["GET", "/api/connectors"],
      ["POST", "/api/connectors"],
      ["PATCH", "/api/connectors/con_notes"],
      ["DELETE", "/api/connectors/con_notes"],
      ["GET", "/api/connectors/con_notes/tools"],
      ["PUT", "/api/connectors/con_notes/tools/add_note"],
      ["PUT", "/api/connectors/con_notes/profile"],
      ["POST", "/api/connectors/con_notes/oauth/start"],
      ["POST", "/api/connectors/oauth/finish"],
    ] as const;
    for (const [m, p] of all)
      expect(
        (await s.client.call(m, p, { cookie: false, ...(m === "GET" ? {} : { body: {} }) })).status,
        `${m} ${p}`,
      ).toBe(401);
    for (const [m, p] of all.filter(([m]) => m !== "GET")) {
      const r = await s.client.call(m, p, { csrf: false, body: {} });
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    expect(gw.requests).toHaveLength(0);
  });

  it("lists connectors with holdsPrivate (default true), adds, renames, and removes with its policy rows", async () => {
    const gw = world();
    const s = await start(gw);
    const list = await s.client.get("/api/connectors");
    expect(list.body.connectors.map((c: any) => [c.id, c.holdsPrivate])).toEqual([
      ["con_notes", true],
      ["con_cal", true],
      ["con_mail", true],
    ]);
    expect(JSON.stringify(list.body)).not.toContain("token");
    const added = await s.client.post("/api/connectors", {
      name: "Tasks",
      url: "https://tasks.example/mcp",
      token: "sekret",
    });
    expect(added.status).toBe(200);
    expect(added.body.connector).toMatchObject({ name: "Tasks", status: "needs_auth", holdsPrivate: true });
    expect(gw.requests.at(-1)!.body).toEqual({ name: "Tasks", url: "https://tasks.example/mcp", token: "sekret" });
    expect((await s.client.post("/api/connectors", { name: "", url: "x" })).status).toBe(400);
    expect((await s.client.post("/api/connectors", { name: "A" })).status).toBe(400);
    const patched = await s.client.call("PATCH", "/api/connectors/con_notes", {
      body: { name: "My notes", holdsPrivate: false },
    });
    expect(patched.body.connector).toMatchObject({ name: "My notes", holdsPrivate: false });
    expect((await s.client.call("PATCH", "/api/connectors/con_notes", { body: { holdsPrivate: "no" } })).status).toBe(
      400,
    );
    expect((await s.client.call("PATCH", "/api/connectors/con_nope", { body: { holdsPrivate: true } })).status).toBe(
      404,
    );
    await s.client.call("PUT", "/api/connectors/con_notes/tools/add_note", { body: { actionClass: "send" } });
    expect((await s.client.call("DELETE", "/api/connectors/con_notes")).status).toBe(204);
    const db = s.host.plane.store.db;
    expect(db.all("SELECT * FROM connector_settings")).toEqual([]);
    expect(db.all("SELECT * FROM tool_overrides")).toEqual([]);
  });

  it("lists tools with defaults and overrides; PUT sets and clears an override, only the four classes", async () => {
    const s = await start(world());
    const t = await s.client.get("/api/connectors/con_notes/tools?refresh=1");
    expect(t.body.fetchedAt).toBe(5);
    expect(t.body.tools.map((x: any) => [x.name, x.defaultClass, x.override])).toEqual([
      ["search_notes", "read_external", null],
      ["add_note", "write_external", null],
      ["delete_note", "irreversible", null],
      ["mail_note", "write_external", null],
    ]);
    expect(
      (await s.client.call("PUT", "/api/connectors/con_notes/tools/mail_note", { body: { actionClass: "send" } }))
        .status,
    ).toBe(200);
    expect((await s.client.get("/api/connectors/con_notes/tools")).body.tools[3]).toMatchObject({
      override: "send",
      defaultClass: "write_external",
    });
    for (const bad of ["read_internal", "credentials", "x", 3])
      expect(
        (await s.client.call("PUT", "/api/connectors/con_notes/tools/mail_note", { body: { actionClass: bad } }))
          .status,
      ).toBe(400);
    expect(
      (await s.client.call("PUT", "/api/connectors/con_notes/tools/nope", { body: { actionClass: "send" } })).status,
    ).toBe(404);
    await s.client.call("PUT", "/api/connectors/con_notes/tools/mail_note", { body: { actionClass: null } });
    expect((await s.client.get("/api/connectors/con_notes/tools")).body.tools[3].override).toBeNull();
    const na = await s.client.get("/api/connectors/con_mail/tools");
    expect(na.status).toBe(409);
    expect(na.body.error.code).toBe("needs_auth");
  });

  it("starts sign-in with the redirect address from the Origin header, passes the client id, and refuses without an origin", async () => {
    const gw = world();
    const s = await start(gw);
    const none = await s.client.post("/api/connectors/con_mail/oauth/start", {});
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("no_app_origin");
    const r = await s.client.post(
      "/api/connectors/con_mail/oauth/start",
      {},
      { headers: { origin: "https://ai.example.com" } },
    );
    expect(r.status).toBe(200);
    expect(gw.requests.at(-1)!.body.redirectUri).toBe("https://ai.example.com/api/mcp/oauth/callback");
    expect(r.body.authorizationUrl).toContain("https://auth.example/authorize");
    // The stored address (from the notification settings) is the fallback.
    s.host.plane.store.db.run("UPDATE notification_settings SET app_url = ? WHERE id = 1", "https://saved.example");
    await s.client.post("/api/connectors/con_mail/oauth/start", { clientId: "abc", clientSecret: "s" });
    expect(gw.requests.at(-1)!.body).toEqual({
      redirectUri: "https://saved.example/api/mcp/oauth/callback",
      clientId: "abc",
      clientSecret: "s",
    });
    const need = await s.client.post("/api/connectors/con_mail/oauth/start", { clientId: "none" });
    expect(need.body.error.code).toBe("client_id_required");
  });

  it("answers the provider's return without a cookie, with a redirect into the app and nothing sent to the gateway", async () => {
    const gw = world();
    const s = await start(gw);
    const ok = await s.client.raw("GET", "/api/mcp/oauth/callback?code=C0DE&state=ST8&iss=https%3A%2F%2Fauth.example", {
      cookie: false,
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/settings/connectors?state=ST8&code=C0DE&iss=https%3A%2F%2Fauth.example");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    const denied = await s.client.raw(
      "GET",
      "/api/mcp/oauth/callback?error=access_denied&error_description=No%20thanks",
      { cookie: false },
    );
    expect(denied.headers.get("location")).toBe("/settings/connectors?oauth_error=No+thanks");
    const empty = await s.client.raw("GET", "/api/mcp/oauth/callback", { cookie: false });
    expect(empty.headers.get("location")).toMatch(/oauth_error=/);
    expect(gw.requests).toHaveLength(0);
  });

  it("finishes sign-in through the gateway, signed in, and passes its errors on", async () => {
    const gw = world();
    const s = await start(gw);
    const r = await s.client.post("/api/connectors/oauth/finish", {
      state: "s",
      code: "c",
      iss: "https://auth.example",
    });
    expect(r.status).toBe(200);
    expect(r.body.connector.id).toBe("con_notes");
    expect(gw.requests.at(-1)).toMatchObject({
      path: "/mcp/oauth/callback",
      body: { state: "s", code: "c", iss: "https://auth.example" },
    });
    const bad = await s.client.post("/api/connectors/oauth/finish", { state: "bad", code: "c" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_state");
    expect((await s.client.post("/api/connectors/oauth/finish", { state: "s" })).status).toBe(400);
  });
});

it("limits discovery and direct calls per agent, without changing other agents", async () => {
  const gw = world();
  const s = await start(gw);
  const id = await chat(s);
  const { store } = s.host.plane;
  const agentId = store.getSessionRow(id)!.agent_id;
  store.updateAgentSettings(agentId, { allowedConnectorIds: ["con_cal"] });
  const found = await search(s, id, { query: "notes calendar events" });
  expect(found.last!.text).toContain("calendar__list_events");
  expect(found.last!.text).not.toContain("notes__");
  expect(lastPayload(s, id)).not.toContain("- Notes (");
  expect((await search(s, id, { load: ["notes__search_notes"] })).last!.text).toContain(
    "Not found: notes__search_notes",
  );
  // A tool loaded before the limit changed still does not run.
  store.updateAgentSettings(agentId, { allowedConnectorIds: null });
  await search(s, id, { load: ["notes__search_notes"] });
  store.updateAgentSettings(agentId, { allowedConnectorIds: ["con_cal"] });
  expect((await callTool(s, id, "notes__search_notes", {})).last!.isError).toBe(true);
  expect(gw.calls).toEqual([]);
  const other = store.createAgent({ name: "Other", avatar: "bot:default", instructions: "" }).agent;
  expect(store.agentCanUseConnector(other.id, "con_notes")).toBe(true);
});

it("hides a disabled plugin's connector from search and refuses its calls", async () => {
  const gw = world();
  const s = await start(gw);
  const id = await chat(s);
  await search(s, id, { load: ["notes__search_notes"] });
  s.host.plane.plugins.componentAvailable = (_t, _c, connectorId) => connectorId !== "con_notes";
  expect((await search(s, id, { query: "search notes" })).last!.text).not.toContain("notes__search_notes");
  expect((await callTool(s, id, "notes__search_notes", {})).last!.text).toContain("disabled for this agent");
  expect(gw.calls).toEqual([]);
});
