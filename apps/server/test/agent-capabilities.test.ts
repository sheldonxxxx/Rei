import { deflateSync } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AgentCapabilities,
  DEFAULT_AGENT_CAPABILITIES,
  inlineAttachmentKind,
  resolveAgentCapabilities,
} from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { readUploadSource } from "../src/browser/upload-source.ts";
import { agentAllowsTool } from "../src/capabilities/agent-access.ts";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { tool } from "./helpers/approvals.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled, stepPayloads } from "./helpers/sessions.ts";
import { toolResults } from "./helpers/web.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

function offered(payload: string): Set<string> {
  const request = JSON.parse(payload) as {
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

function sectionsOf(payload: string): Map<string, string> {
  const shown = new Map<string, string>();
  const body = JSON.parse(payload) as { messages: { role: string; sections?: Record<string, string | null> }[] };
  for (const m of body.messages) {
    if (m.role !== "system" || !m.sections) continue;
    for (const [key, value] of Object.entries(m.sections)) {
      if (value === null) shown.delete(key);
      else shown.set(key, value);
    }
  }
  return shown;
}

function makePng(width = 2, height = 2): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const kind = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([kind, data])), 0);
    return Buffer.concat([len, kind, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3, 200);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function createAgent(s: TestServer, name: string, capabilities?: Partial<AgentCapabilities>) {
  const created = await s.client.post("/api/agents", { name, avatar: "bot:default" });
  expect(created.status).toBe(200);
  const agentId = created.body.agent.id as string;
  const homeId = created.body.session.id as string;
  if (capabilities) {
    const patch = await s.client.call("PATCH", `/api/agents/${agentId}`, { body: { capabilities } });
    expect(patch.status).toBe(200);
  }
  const sessionRes = await s.client.post("/api/sessions", { agentId });
  expect(sessionRes.status).toBe(200);
  return { agentId, homeId, chatId: sessionRes.body.session.id as string };
}

describe("protocol capability helpers", () => {
  it("resolves defaults and legacy trigger flag", () => {
    expect(resolveAgentCapabilities()).toEqual(DEFAULT_AGENT_CAPABILITIES);
    expect(resolveAgentCapabilities(null, true).triggers).toBe("all");
    expect(resolveAgentCapabilities({ triggers: "off" }, true).triggers).toBe("off");
  });

  it("classifies inline attachments for sandbox-disabled agents", () => {
    expect(inlineAttachmentKind({ name: "photo.png", mediaType: "image/png" })).toBe("image");
    expect(inlineAttachmentKind({ name: "notes.md", mediaType: "application/octet-stream" })).toBe("text");
    expect(inlineAttachmentKind({ name: "data", mediaType: "application/json" })).toBe("text");
    expect(inlineAttachmentKind({ name: "report.pdf", mediaType: "application/pdf" })).toBeNull();
    expect(
      inlineAttachmentKind({
        name: "deck.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBeNull();
    expect(inlineAttachmentKind({ name: "vector.svg", mediaType: "image/svg+xml" })).toBeNull();
  });
});

describe("database schema upgrade and PATCH /api/agents/:id", () => {
  it("adds capabilities_json when upgrading an existing v20 database and preserves legacy trigger flag", () => {
    const db = openSqliteDb(":memory:");
    initializeDatabase(db, () => 1_000);
    // Simulate a pre-capabilities agents table row by checking PRAGMA and legacy fallback.
    const cols = db.all<{ name: string }>("PRAGMA table_info(agents)").map((c) => c.name);
    expect(cols).toContain("capabilities_json");
    db.run(
      "INSERT INTO agents (id, name, avatar, created_at, can_create_triggers_for_other_agents) VALUES ('a_legacy', 'Legacy', 'bot:default', 1000, 1)",
    );
    const row = db.get<{ capabilities_json: string | null; can_create_triggers_for_other_agents: number }>(
      "SELECT capabilities_json, can_create_triggers_for_other_agents FROM agents WHERE id = 'a_legacy'",
    )!;
    expect(row.capabilities_json).toBeNull();
    expect(resolveAgentCapabilities(null, row.can_create_triggers_for_other_agents === 1).triggers).toBe("all");
    db.close();
  });

  it("upgrades a v20 table missing capabilities_json without losing agents", () => {
    const db = openSqliteDb(":memory:");
    initializeDatabase(db, () => 1_000);
    // Rebuild agents without capabilities_json and re-run initializeDatabase.
    db.exec(`
      CREATE TABLE agents_old (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        home_session_id TEXT,
        created_at INTEGER NOT NULL,
        default_profile TEXT NOT NULL DEFAULT 'standard',
        model TEXT,
        allowed_connector_ids TEXT,
        thinking_level TEXT NOT NULL DEFAULT 'off',
        network_mode TEXT NOT NULL DEFAULT 'block',
        can_create_triggers_for_other_agents INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO agents_old VALUES ('a1', 'Old', 'bot:default', '', NULL, 1000, 'standard', NULL, NULL, 'off', 'block', 1);
      DROP TABLE agents;
      ALTER TABLE agents_old RENAME TO agents;
    `);
    expect(initializeDatabase(db, () => 2_000)).toBe(false);
    const cols = db.all<{ name: string }>("PRAGMA table_info(agents)").map((c) => c.name);
    expect(cols).toContain("capabilities_json");
    const row = db.get<{ can_create_triggers_for_other_agents: number }>(
      "SELECT can_create_triggers_for_other_agents FROM agents WHERE id = 'a1'",
    )!;
    expect(row.can_create_triggers_for_other_agents).toBe(1);
    db.close();
  });

  it("updates partial capabilities, syncs canCreateTriggersForOtherAgents, and emits agent.upserted", async () => {
    server = await startSignedIn();
    const id = server.host.plane.store.defaultAgentId()!;
    const sse = await server.sse("/api/stream");
    const res = await server.client.call("PATCH", `/api/agents/${id}`, {
      body: { capabilities: { sandbox: false, triggers: "all", knowledge: "read" } },
    });
    expect(res.status).toBe(200);
    expect(res.body.agent.canCreateTriggersForOtherAgents).toBe(true);
    expect(res.body.agent.capabilities).toEqual({
      ...DEFAULT_AGENT_CAPABILITIES,
      sandbox: false,
      triggers: "all",
      knowledge: "read",
    });
    const evt = await sse.waitFor(
      (e) => e.event === "agent.upserted" && (e.data as { agent: { id: string } }).agent.id === id,
    );
    expect((evt.data as { agent: { capabilities: AgentCapabilities } }).agent.capabilities.knowledge).toBe("read");
    await sse.close();

    // Legacy PATCH also stays in sync.
    const legacy = await server.client.call("PATCH", `/api/agents/${id}`, {
      body: { canCreateTriggersForOtherAgents: false },
    });
    expect(legacy.status).toBe(200);
    expect(legacy.body.agent.capabilities.triggers).toBe("own");
    expect(legacy.body.agent.canCreateTriggersForOtherAgents).toBe(false);
  });
});

describe("per-agent capability enforcement", () => {
  it("drops disabled extensions, tools, prompt sections, deferred groups, and built-in skills", async () => {
    server = await startSignedIn({
      browserDriver: {
        onEvent: () => () => {},
        close: async () => {},
        goto: async () => {},
        snapshot: async () => ({ raw: "", generation: 1 }),
      } as never,
    });
    const { agentId, homeId, chatId } = await createAgent(server, "LockedDown", {
      sandbox: false,
      web: false,
      browser: false,
      library: "off",
      images: false,
      knowledge: "off",
      memory: "off",
      chatHistory: "off",
      triggers: "off",
      delegation: "off",
    });

    await say(server, homeId, "hi");
    await settled(server, homeId);
    const homePayload = stepPayloads(server, homeId).at(-1)!;
    const homeTools = offered(homePayload);
    const homeSections = sectionsOf(homePayload);

    for (const removed of [
      "read",
      "write",
      "edit",
      "bash",
      "web_search",
      "web_fetch",
      "search_library",
      "read_library_file",
      "publish_files",
      "image_generate",
      "knowledge_browse",
      "knowledge_read",
      "knowledge_search",
      "knowledge_write",
      "memory_add",
      "memory_replace",
      "memory_remove",
      "memory_confirm",
      "search_history",
      "history_context",
      "read_chat",
      "start_session",
      "list_sessions",
    ]) {
      expect(homeTools.has(removed), removed).toBe(false);
    }
    expect(homeTools.has("dismiss_event")).toBe(true);
    expect(homeTools.has("search_capabilities")).toBe(true);

    for (const removedSection of [
      "sandbox",
      "web",
      "browser",
      "library",
      "knowledge",
      "memory",
      "profile",
      "history",
      "recent",
      "triggers",
      "delegation",
      "sessions",
      "recall_router",
    ]) {
      expect(homeSections.has(removedSection), removedSection).toBe(false);
    }
    expect(homeSections.get("session_role")).toContain("Worker delegation is disabled");

    // Capabilities index and search_capabilities hide disabled deferred groups (browser, triggers) and built-in skills.
    expect(homeSections.get("capabilities")).not.toContain("- browser:");
    expect(homeSections.get("capabilities")).not.toContain("- triggers:");
    expect(server.host.plane.skills.names(agentId)).not.toContain("rei-browser");
    expect(server.host.plane.skills.names(agentId)).not.toContain("rei-knowledge");

    await say(server, chatId, tool("search_capabilities", { load: ["browser", "triggers"] }));
    await settled(server, chatId);
    const searchRes = toolResults(server, chatId).at(-1)!;
    expect(searchRes.text).toContain("Not found: browser, triggers");

    // Policy defense-in-depth blocks direct calls to disabled tools.
    await say(server, chatId, tool("web_search", { query: "test" }));
    await settled(server, chatId, 2);
    const blocked = toolResults(server, chatId).at(-1)!;
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("web_search is not available");
  });

  it("enforces read-only Knowledge, Memory, and Library modes and skips background memory review", async () => {
    server = await startSignedIn();
    const { agentId, chatId } = await createAgent(server, "Reader", {
      knowledge: "read",
      memory: "read",
      library: "read",
    });

    await say(server, chatId, "remember I like green tea");
    await settled(server, chatId);
    const payload = stepPayloads(server, chatId).at(-1)!;
    const tools = offered(payload);
    const sections = sectionsOf(payload);

    expect(tools.has("knowledge_read")).toBe(true);
    expect(tools.has("knowledge_search")).toBe(true);
    expect(tools.has("knowledge_write")).toBe(false);
    expect(tools.has("search_library")).toBe(true);
    expect(tools.has("read_library_file")).toBe(true);
    expect(tools.has("publish_files")).toBe(false);
    expect(tools.has("memory_add")).toBe(false);
    expect(tools.has("search_history")).toBe(true);

    expect(sections.get("knowledge")).toContain("read-only access");
    expect(sections.get("memory")).toContain("read-only access");
    expect(sections.has("profile")).toBe(true);
    expect(sections.get("library")).not.toContain("publish_files");
    expect(sections.get("recall_router")).toContain("search_history");
    expect(sections.get("recall_router")).not.toContain("memory_add");
    expect(sections.get("recall_router")).not.toContain("knowledge_write");
    expect(server.host.plane.skills.names(agentId)).not.toContain("rei-knowledge");

    // Background memory review is skipped when memory !== "read_write".
    server.host.plane.memoryMaintenance.setEnabled(true);
    server.host.plane.memoryMaintenance.setEveryNTurns(2);
    await say(server, chatId, "turn 2");
    await settled(server, chatId, 2);
    await server.host.plane.memoryMaintenance.settle();
    const reviewJobs = server.host.plane.store.db.all(
      "SELECT id FROM background_jobs WHERE agent_id = ? AND kind = 'memory.review'",
      agentId,
    );
    expect(reviewJobs).toHaveLength(0);
  });

  it("enforces chatHistory='own', triggers='own'|'all', and delegation='own'", async () => {
    server = await startSignedIn();
    const defaultId = server.host.plane.store.defaultAgentId()!;
    const defaultChat = await chat(server);
    await say(server, defaultChat, "secret alpha project code");
    await settled(server, defaultChat);

    const { agentId, homeId, chatId } = await createAgent(server, "ScopedAgent", {
      chatHistory: "own",
      triggers: "own",
      delegation: "own",
    });
    await say(server, chatId, "own chat secret beta");
    await settled(server, chatId);

    // Searching own chats finds own message, refuses targeting default agent.
    await say(server, chatId, tool("search_history", { query: "secret", agent: defaultId }));
    await settled(server, chatId, 2);
    expect(toolResults(server, chatId).at(-1)!.text).toContain("only search its own chat history");

    // Searching without agent returns only own hits.
    await say(server, chatId, tool("search_history", { query: "secret" }));
    await settled(server, chatId, 3);
    const searchOut = toolResults(server, chatId).at(-1)!.text;
    expect(searchOut).toContain("beta");
    expect(searchOut).not.toContain("alpha");

    // read_chat refuses another agent's chat.
    await say(server, chatId, tool("read_chat", { session_id: defaultChat }));
    await settled(server, chatId, 4);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    // @chat mention to another agent's chat is refused by HTTP API.
    const badMention = await server.client.post(`/api/sessions/${chatId}/messages`, {
      requestId: crypto.randomUUID(),
      text: "Check @other",
      mentions: [{ kind: "chat", id: defaultChat, label: "other", start: 6, end: 12 }],
    });
    expect(badMention.status).toBe(400);

    // delegation='own' refuses spawning another agent, allows spawning self.
    await say(server, homeId, tool("start_session", { brief: "help", agent: defaultId }));
    await settled(server, homeId);
    expect(toolResults(server, homeId).at(-1)!.text).toContain("only start worker sessions using itself");

    await say(server, homeId, tool("start_session", { brief: "own job", agent: agentId }));
    await settled(server, homeId, 2);
    expect(toolResults(server, homeId).at(-1)!.text).toContain("Started session");
  });

  it("handles sandbox=false attachments (allows inline text and PNG images, rejects binaries)", async () => {
    server = await startSignedIn();
    const { chatId } = await createAgent(server, "NoSandbox", { sandbox: false });

    // Binary PDF upload is rejected.
    const uploadFile = (file: Blob, name: string) => {
      const form = new FormData();
      form.append("file", file, name);
      return server!.client.fetcher(`/api/sessions/${chatId}/attachments`, {
        method: "POST",
        headers: { "x-rei": "1", cookie: `rei_session=${server!.client.cookie}` },
        body: form,
      });
    };

    const pdfUpload = await uploadFile(new Blob([Buffer.from("%PDF-1.4")], { type: "application/pdf" }), "report.pdf");
    expect(pdfUpload.status).toBe(400);
    expect((await pdfUpload.json()).error.code).toBe("unsupported_attachment");

    // Text and PNG uploads succeed and reach the model inline without a workspace.
    const txtRes = await uploadFile(new Blob(["hello sandbox-off world"], { type: "text/plain" }), "notes.txt");
    expect(txtRes.status).toBe(200);
    const txtAtt = (await txtRes.json()).attachment;

    const pngRes = await uploadFile(new Blob([new Uint8Array(makePng())], { type: "image/png" }), "pixel.png");
    expect(pngRes.status).toBe(200);
    const pngAtt = (await pngRes.json()).attachment;

    const sent = await server.client.post(`/api/sessions/${chatId}/messages`, {
      requestId: crypto.randomUUID(),
      text: "Check these files",
      files: [
        { fileId: txtAtt.fileId, versionId: txtAtt.versionId },
        { fileId: pngAtt.fileId, versionId: pngAtt.versionId },
      ],
    });
    expect(sent.status).toBe(200);
    await settled(server, chatId);

    const payload = JSON.parse(stepPayloads(server, chatId).at(-1)!) as {
      messages: { role: string; content: unknown }[];
    };
    const userMsg = payload.messages.find((m) => m.role === "user")!;
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as { type: string; text?: string; mimeType?: string }[];
    expect(parts.some((p) => p.type === "text" && p.text?.includes("hello sandbox-off world"))).toBe(true);
    expect(parts.some((p) => p.type === "image" && p.mimeType === "image/png")).toBe(true);

    // browser_upload sandbox source & library off checks via readUploadSource.
    const sessionRow = server.host.plane.store.getSessionRow(chatId)!;
    await expect(
      readUploadSource(
        { type: "sandbox", path: "file.txt" },
        sessionRow,
        { store: server.host.plane.store },
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("Sandbox access is disabled");

    const { chatId: noLibChat } = await createAgent(server, "NoLib", { library: "off" });
    const noLibSession = server.host.plane.store.getSessionRow(noLibChat)!;
    await expect(
      readUploadSource(
        { type: "library", fileId: "f_1", versionId: "v_1" },
        noLibSession,
        { store: server.host.plane.store },
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("Library access is disabled");
  });

  it("applies live capability edits on an already-open conversation at the next turn", async () => {
    server = await startSignedIn();
    const { agentId, chatId } = await createAgent(server, "DynamicAgent");
    await say(server, chatId, "turn 1");
    await settled(server, chatId);
    expect(offered(stepPayloads(server, chatId).at(-1)!).has("web_search")).toBe(true);

    await server.client.call("PATCH", `/api/agents/${agentId}`, { body: { capabilities: { web: false } } });
    await say(server, chatId, "turn 2");
    await settled(server, chatId, 2);
    expect(offered(stepPayloads(server, chatId).at(-1)!).has("web_search")).toBe(false);
    expect(sectionsOf(stepPayloads(server, chatId).at(-1)!).has("web")).toBe(false);
  });

  it("blocks disallowed tools in agentAllowsTool helper and disables nativeSearch when web=false", () => {
    const noWeb = { ...DEFAULT_AGENT_CAPABILITIES, web: false };
    expect(agentAllowsTool(noWeb, "web_search")).toBe(false);
    expect(agentAllowsTool(noWeb, "web_fetch")).toBe(false);
    expect(agentAllowsTool(noWeb, "search_capabilities")).toBe(true);

    const noTriggers = { ...DEFAULT_AGENT_CAPABILITIES, triggers: "off" as const };
    expect(agentAllowsTool(noTriggers, "list_triggers")).toBe(false);
    expect(agentAllowsTool(noTriggers, "create_trigger")).toBe(false);
    expect(agentAllowsTool(noTriggers, "report")).toBe(true);
  });
});
