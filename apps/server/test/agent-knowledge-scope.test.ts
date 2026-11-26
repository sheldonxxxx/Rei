import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { tool } from "./helpers/approvals.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { say, settled, stepPayloads } from "./helpers/sessions.ts";
import { toolResults } from "./helpers/web.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const USER = { actor: "user" } as const;
const k = () => server!.host.plane.knowledge;

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

async function createScopedAgent(s: TestServer, name: string, allowedKnowledgePageIds: string[] | null) {
  const created = await s.client.post("/api/agents", { name, avatar: "bot:default" });
  expect(created.status).toBe(200);
  const agentId = created.body.agent.id as string;
  if (allowedKnowledgePageIds !== null) {
    const patch = await s.client.call("PATCH", `/api/agents/${agentId}`, {
      body: { allowedKnowledgePageIds },
    });
    expect(patch.status).toBe(200);
  }
  const sessionRes = await s.client.post("/api/sessions", { agentId });
  expect(sessionRes.status).toBe(200);
  return { agentId, chatId: sessionRes.body.session.id as string };
}

describe("database migration and PATCH /api/agents/:id allowedKnowledgePageIds", () => {
  it("adds allowed_knowledge_page_ids when upgrading an existing v20 database", () => {
    const db = openSqliteDb(":memory:");
    initializeDatabase(db, () => 1_000);
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
        can_create_triggers_for_other_agents INTEGER NOT NULL DEFAULT 0,
        capabilities_json TEXT
      );
      INSERT INTO agents_old (id, name, avatar, created_at) VALUES ('a1', 'Legacy', 'bot:default', 1000);
      DROP TABLE agents;
      ALTER TABLE agents_old RENAME TO agents;
    `);
    initializeDatabase(db, () => 2_000);
    const cols = db.all<{ name: string }>("PRAGMA table_info(agents)").map((c) => c.name);
    expect(cols).toContain("allowed_knowledge_page_ids");
    const row = db.get<{ allowed_knowledge_page_ids: string | null }>(
      "SELECT allowed_knowledge_page_ids FROM agents WHERE id = 'a1'",
    )!;
    expect(row.allowed_knowledge_page_ids).toBeNull();
    db.close();
  });

  it("validates, persists, preserves existing trashed roots, and resets allowedKnowledgePageIds", async () => {
    server = await startSignedIn();
    const live = k().create({ parentId: null, title: "Allowed" }, USER);
    const trashed = k().create({ parentId: null, title: "Trashed" }, USER);
    k().trashPage(trashed.id, USER);

    const created = await server.client.post("/api/agents", { name: "Scoped", avatar: "bot:default" });
    expect(created.status).toBe(200);
    const agentId = created.body.agent.id as string;
    expect(created.body.agent.allowedKnowledgePageIds).toBeNull();

    // Rejects unknown or newly added trashed pages, and empty IDs.
    const badMissing = await server.client.call("PATCH", `/api/agents/${agentId}`, {
      body: { allowedKnowledgePageIds: ["pg_missing"] },
    });
    expect(badMissing.status).toBe(400);

    const badTrashed = await server.client.call("PATCH", `/api/agents/${agentId}`, {
      body: { allowedKnowledgePageIds: [trashed.id] },
    });
    expect(badTrashed.status).toBe(400);

    const badBlank = await server.client.call("PATCH", `/api/agents/${agentId}`, {
      body: { allowedKnowledgePageIds: ["   "] },
    });
    expect(badBlank.status).toBe(400);

    // Deduplicates and persists live pages.
    const okSet = await server.client.call("PATCH", `/api/agents/${agentId}`, {
      body: { allowedKnowledgePageIds: [live.id, ` ${live.id} `] },
    });
    expect(okSet.status).toBe(200);
    expect(okSet.body.agent.allowedKnowledgePageIds).toEqual([live.id]);

    // If an already-assigned page is later trashed, updating other settings or keeping it succeeds.
    const other = k().create({ parentId: null, title: "Other" }, USER);
    k().trashPage(live.id, USER);
    const keepTrashed = await server.client.call("PATCH", `/api/agents/${agentId}`, {
      body: { allowedKnowledgePageIds: [live.id, other.id] },
    });
    expect(keepTrashed.status).toBe(200);
    expect(keepTrashed.body.agent.allowedKnowledgePageIds).toEqual([live.id, other.id]);

    // Resetting back to null restores All Knowledge.
    const reset = await server.client.call("PATCH", `/api/agents/${agentId}`, {
      body: { allowedKnowledgePageIds: null },
    });
    expect(reset.status).toBe(200);
    expect(reset.body.agent.allowedKnowledgePageIds).toBeNull();
  });
});

describe("scoped agent Knowledge tools, prompt pointer, and @page mentions", () => {
  it("scopes prompt pointer, browse, read, and search without leaking outside ancestors", async () => {
    server = await startSignedIn();
    const secretTop = k().create({ parentId: null, title: "TopSecretParent" }, USER);
    const allowedRoot = k().create(
      { parentId: secretTop.id, title: "PublicProject", description: "Visible folder", body: "Root body" },
      USER,
    );
    const child = k().create(
      {
        parentId: allowedRoot.id,
        title: "Roadmap",
        description: "Milestones",
        body: "## Q1\nLaunch widget keywordAlpha",
      },
      USER,
    );
    const siblingSecret = k().create(
      {
        parentId: secretTop.id,
        title: "HiddenSibling",
        body: "Private notes keywordAlpha",
      },
      USER,
    );

    const { chatId } = await createScopedAgent(server, "ProjectBot", [allowedRoot.id]);

    // Browse root lists only effective allowed folders, never TopSecretParent or HiddenSibling.
    await say(server, chatId, tool("knowledge_browse", {}));
    await settled(server, chatId);
    const browseRoot = toolResults(server, chatId).at(-1)!.text;
    expect(browseRoot).toContain("Allowed Knowledge folders:");
    expect(browseRoot).toContain(`PublicProject (${allowedRoot.id})`);
    expect(browseRoot).not.toContain("TopSecretParent");
    expect(browseRoot).not.toContain("HiddenSibling");

    // Prompt pointer includes scoped path and excludes outside folders.
    const promptKnowledge = sectionsOf(stepPayloads(server, chatId).at(-1)!).get("knowledge") ?? "";
    expect(promptKnowledge).toContain("Allowed folders:");
    expect(promptKnowledge).toContain(`PublicProject (${allowedRoot.id})`);
    expect(promptKnowledge).not.toContain("TopSecretParent");
    expect(promptKnowledge).not.toContain("HiddenSibling");

    // Browse out-of-scope page fails with generic message.
    await say(server, chatId, tool("knowledge_browse", { pageId: secretTop.id }));
    await settled(server, chatId, 2);
    const browseBlocked = toolResults(server, chatId).at(-1)!;
    expect(browseBlocked.isError).toBe(true);
    expect(browseBlocked.text).toContain("is not accessible or does not exist");

    // Read in-scope child uses scopedPath (starts at PublicProject, omits TopSecretParent).
    await say(server, chatId, tool("knowledge_read", { pageId: child.id }));
    await settled(server, chatId, 3);
    const readChild = toolResults(server, chatId).at(-1)!;
    expect(readChild.isError).toBeFalsy();
    expect(readChild.text).toContain(`PublicProject › Roadmap (${child.id})`);
    expect(readChild.text).not.toContain("TopSecretParent");

    // Read out-of-scope sibling fails.
    await say(server, chatId, tool("knowledge_read", { pageId: siblingSecret.id }));
    await settled(server, chatId, 4);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    // Search returns only in-scope hit with scopedPath.
    await say(server, chatId, tool("knowledge_search", { query: "keywordAlpha" }));
    await settled(server, chatId, 5);
    const searchOut = toolResults(server, chatId).at(-1)!;
    expect(searchOut.text).toContain(`PublicProject › Roadmap (${child.id})`);
    expect(searchOut.text).not.toContain("HiddenSibling");
    expect(searchOut.text).not.toContain("TopSecretParent");

    // Search with out-of-scope `under` fails.
    await say(server, chatId, tool("knowledge_search", { query: "keywordAlpha", under: secretTop.id }));
    await settled(server, chatId, 6);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);
  });

  it("enforces write boundaries on create, edit, move, archive, and page links", async () => {
    server = await startSignedIn();
    const secretTop = k().create({ parentId: null, title: "Vault" }, USER);
    const outsidePage = k().create({ parentId: secretTop.id, title: "OutsideNote" }, USER);
    const rootA = k().create({ parentId: secretTop.id, title: "WorkspaceA" }, USER);
    const rootB = k().create({ parentId: null, title: "WorkspaceB" }, USER);
    const existingInA = k().create(
      {
        parentId: rootA.id,
        title: "ExistingDoc",
        body: `Preexisting [link](page:${outsidePage.id})`,
      },
      USER,
    );

    const { chatId } = await createScopedAgent(server, "WriterBot", [rootA.id, rootB.id]);

    // 1. Create at "top" or under out-of-scope parent fails.
    await say(server, chatId, tool("knowledge_write", { action: "create", parentId: "top", title: "TopFail" }));
    await settled(server, chatId);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    await say(
      server,
      chatId,
      tool("knowledge_write", { action: "create", parentId: secretTop.id, title: "OutsideFail" }),
    );
    await settled(server, chatId, 2);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    // 2. Create with out-of-scope page: link via body or sourceMarkdown fails.
    await say(
      server,
      chatId,
      tool("knowledge_write", {
        action: "create",
        parentId: rootA.id,
        title: "LeakyBody",
        body: `See [secret](page:${outsidePage.id})`,
      }),
    );
    await settled(server, chatId, 3);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    await say(
      server,
      chatId,
      tool("knowledge_write", {
        action: "create",
        parentId: rootA.id,
        sourceMarkdown: `---\ntitle: LeakySource\n---\nSee [secret](page:${outsidePage.id})`,
      }),
    );
    await settled(server, chatId, 4);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    // 3. Create under allowed root succeeds and uses scopedPath.
    await say(
      server,
      chatId,
      tool("knowledge_write", {
        action: "create",
        parentId: rootA.id,
        title: "Spec",
        body: "Clean body",
      }),
    );
    await settled(server, chatId, 5);
    const createdRes = toolResults(server, chatId).at(-1)!;
    expect(createdRes.isError).toBeFalsy();
    expect(createdRes.text).toContain("Created WorkspaceA › Spec");
    expect(createdRes.text).not.toContain("Vault");
    const specId = k()
      .children(rootA.id)
      .find((p) => p.title === "Spec")!.id;

    // 4. Edit out-of-scope page fails; adding an out-of-scope link fails; preserving pre-existing link succeeds.
    await say(
      server,
      chatId,
      tool("knowledge_write", {
        action: "edit",
        pageId: outsidePage.id,
        ops: [{ op: "append", text: "hack" }],
      }),
    );
    await settled(server, chatId, 6);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    await say(
      server,
      chatId,
      tool("knowledge_write", {
        action: "edit",
        pageId: specId,
        ops: [{ op: "append", text: `Leak [x](page:${outsidePage.id})` }],
      }),
    );
    await settled(server, chatId, 7);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    await say(
      server,
      chatId,
      tool("knowledge_write", {
        action: "edit",
        pageId: existingInA.id,
        ops: [{ op: "append", text: "Appended safely" }],
      }),
    );
    await settled(server, chatId, 8);
    expect(toolResults(server, chatId).at(-1)!.isError).toBeFalsy();

    // 5. Move cannot move granted root, move to "top", or move outside scope; moving descendant between allowed roots works.
    await say(server, chatId, tool("knowledge_write", { action: "move", pageId: rootA.id, parentId: rootB.id }));
    await settled(server, chatId, 9);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    await say(server, chatId, tool("knowledge_write", { action: "move", pageId: specId, parentId: "top" }));
    await settled(server, chatId, 10);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    await say(server, chatId, tool("knowledge_write", { action: "move", pageId: specId, parentId: rootB.id }));
    await settled(server, chatId, 11);
    const movedRes = toolResults(server, chatId).at(-1)!;
    expect(movedRes.isError).toBeFalsy();
    expect(movedRes.text).toContain("Moved to WorkspaceB › Spec");

    // 6. Archive cannot trash granted root or out-of-scope page, but can trash descendant in scope.
    await say(server, chatId, tool("knowledge_write", { action: "archive", pageId: rootB.id }));
    await settled(server, chatId, 12);
    expect(toolResults(server, chatId).at(-1)!.isError).toBe(true);

    await say(server, chatId, tool("knowledge_write", { action: "archive", pageId: specId }));
    await settled(server, chatId, 13);
    expect(toolResults(server, chatId).at(-1)!.isError).toBeFalsy();
  });

  it("rejects out-of-scope @page mentions and explains empty scope in prompt pointer", async () => {
    server = await startSignedIn();
    const allowedFolder = k().create({ parentId: null, title: "AllowedFolder" }, USER);
    const allowedChild = k().create({ parentId: allowedFolder.id, title: "AllowedChild" }, USER);
    const outside = k().create({ parentId: null, title: "SecretFolder" }, USER);

    const { chatId } = await createScopedAgent(server, "MentionBot", [allowedFolder.id]);

    // Out-of-scope @page mention is rejected with 400.
    const badMention = await server.client.post(`/api/sessions/${chatId}/messages`, {
      requestId: crypto.randomUUID(),
      text: "Read @SecretFolder",
      mentions: [{ kind: "page", id: outside.id, label: "SecretFolder", start: 5, end: 18 }],
    });
    expect(badMention.status).toBe(400);

    // In-scope descendant @page mention is accepted.
    const goodMention = await server.client.post(`/api/sessions/${chatId}/messages`, {
      requestId: crypto.randomUUID(),
      text: "Read @AllowedChild",
      mentions: [{ kind: "page", id: allowedChild.id, label: "AllowedChild", start: 5, end: 18 }],
    });
    expect(goodMention.status).toBe(200);
    await settled(server, chatId);

    // Agent with empty scope [] gets the empty-scope prompt pointer and sees no pages.
    const { chatId: emptyChatId } = await createScopedAgent(server, "EmptyScopeBot", []);
    await say(server, emptyChatId, tool("knowledge_browse", {}));
    await settled(server, emptyChatId);
    expect(toolResults(server, emptyChatId).at(-1)!.text).toContain("No allowed folders configured");
    const promptSection = sectionsOf(stepPayloads(server, emptyChatId).at(-1)!).get("knowledge") ?? "";
    expect(promptSection).toContain("no live folders are currently allowed");
  });
});
