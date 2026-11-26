import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeMcpTokenStore } from "../src/knowledge/mcp-tokens.ts";
import { nullLogger } from "../src/util/log.ts";
import { FAKE_KNOWLEDGE_COSINE_FLOOR, FakeEmbedder, withEmbedder } from "./helpers/fake-embedder.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const USER = { actor: "user" } as const;

describe("Knowledge MCP token store and scoped Knowledge support", () => {
  it("creates tokens with deny-all defaults, stores only hashes, and enforces rotate/disable/revoke", async () => {
    server = await startSignedIn();
    const { db } = server.host.plane.store;
    const knowledge = server.host.plane.knowledge;
    const store = new KnowledgeMcpTokenStore({
      db,
      knowledge,
      clock: server.clock,
      log: nullLogger,
    });

    const created = await store.create({ name: "  External Reader  " });
    expect(created.secret).toMatch(/^rei_kmcp_[A-Za-z0-9_-]+$/);
    expect(created.token.name).toBe("External Reader");
    expect(created.token.tokenPrefix).toBe(created.secret.slice(0, 15));
    expect(created.token.enabled).toBe(true);
    expect(created.token.permissions).toEqual({ read: false, write: false, delete: false });
    expect(created.token.allowedPages).toEqual([]);
    expect(created.token.lastUsedAt).toBeNull();

    // Plaintext secret is never stored in SQLite.
    const row = db.get<{ token_hash: string; token_prefix: string }>(
      "SELECT token_hash, token_prefix FROM knowledge_mcp_tokens WHERE id = ?",
      created.token.id,
    )!;
    expect(row.token_hash).not.toContain(created.secret);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);

    // Authentication works and throttles last_used_at updates.
    const auth1 = await store.authenticate(created.secret);
    expect(auth1).toMatchObject({
      id: created.token.id,
      name: "External Reader",
      canRead: false,
      canWrite: false,
      canDelete: false,
    });
    const firstUsed = auth1!.lastUsedAt!;
    expect(firstUsed).toBeTypeOf("number");
    server.clock.advance(10_000);
    const auth2 = await store.authenticate(created.secret);
    expect(auth2!.lastUsedAt).toBe(firstUsed);
    server.clock.advance(60_000);
    const auth3 = await store.authenticate(created.secret);
    expect(auth3!.lastUsedAt).toBeGreaterThan(firstUsed);

    // Non-matching prefix or wrong token fails.
    expect(await store.authenticate("not_a_kmcp_token_1234567890")).toBeUndefined();
    expect(await store.authenticate("rei_kmcp_wrong_token_value_1234567890")).toBeUndefined();

    // Rotate invalidates the old secret immediately.
    const rotated = await store.rotate(created.token.id);
    expect(rotated.secret).not.toBe(created.secret);
    expect(await store.authenticate(created.secret)).toBeUndefined();
    expect((await store.authenticate(rotated.secret))?.id).toBe(created.token.id);

    // Disable rejects auth; re-enable restores it.
    const disabled = store.update(created.token.id, { enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(await store.authenticate(rotated.secret)).toBeUndefined();
    const reenabled = store.update(created.token.id, { enabled: true });
    expect(reenabled.enabled).toBe(true);
    expect((await store.authenticate(rotated.secret))?.id).toBe(created.token.id);

    // Revoke removes from list(), clears roots, rejects auth, and preserves actorLabel with "(revoked)".
    expect(store.actorLabel(created.token.id)).toBe("External Reader");
    store.revoke(created.token.id);
    expect(store.list()).toEqual([]);
    expect(await store.authenticate(rotated.secret)).toBeUndefined();
    expect(store.actorLabel(created.token.id)).toBe("External Reader (revoked)");
    expect(store.actorLabel("kmcp_missing")).toBe("Removed token");
  });

  it("resolves dynamic subtree scope, deduplicates effective roots, handles trash/restore/purge, and resolves mcp actors", async () => {
    server = await startSignedIn();
    const { db } = server.host.plane.store;
    const knowledge = server.host.plane.knowledge;
    const store = new KnowledgeMcpTokenStore({
      db,
      knowledge,
      clock: server.clock,
      log: nullLogger,
    });

    const privateParent = knowledge.create({ parentId: null, title: "Private Root" }, USER);
    const allowedRoot = knowledge.create({ parentId: privateParent.id, title: "Shared Folder" }, USER);
    const child = knowledge.create({ parentId: allowedRoot.id, title: "Child Note" }, USER);
    const grandChild = knowledge.create({ parentId: child.id, title: "Grandchild Note" }, USER);
    const sibling = knowledge.create({ parentId: privateParent.id, title: "Private Sibling" }, USER);

    // Grant both parent and nested child: effectiveRootIds should deduplicate to [allowedRoot.id].
    const { token } = await store.create({
      name: "Agent Bridge",
      permissions: { read: true, write: true },
      allowedPageIds: [allowedRoot.id, child.id],
    });
    expect(token.permissions).toEqual({ read: true, write: true, delete: false });

    const scope1 = store.resolveScope(token.id);
    expect(scope1.effectiveRootIds).toEqual([allowedRoot.id]);
    expect(scope1.allowedPageIds).toEqual(new Set([allowedRoot.id, child.id, grandChild.id]));
    expect(scope1.allowedPageIds.has(privateParent.id)).toBe(false);
    expect(scope1.allowedPageIds.has(sibling.id)).toBe(false);

    // scopedPath omits private ancestors above the allowed root.
    expect(knowledge.path(grandChild.id)).toBe("Private Root › Shared Folder › Child Note › Grandchild Note");
    expect(knowledge.scopedPath(grandChild.id, scope1.allowedPageIds)).toBe(
      "Shared Folder › Child Note › Grandchild Note",
    );
    expect(knowledge.scopedPath(allowedRoot.id, scope1.allowedPageIds)).toBe("Shared Folder");
    expect(knowledge.scopedPath(privateParent.id, scope1.allowedPageIds)).toBe("");

    // Trashing a child removes it and its descendants from allowedPageIds immediately.
    knowledge.trashPage(child.id, USER);
    const scope2 = store.resolveScope(token.id);
    expect(scope2.allowedPageIds).toEqual(new Set([allowedRoot.id]));
    expect(scope2.effectiveRootIds).toEqual([allowedRoot.id]);
    expect(store.list()[0]!.allowedPages.find((p) => p.pageId === child.id)?.status).toBe("trashed");

    // Restoring the child restores it to allowedPageIds.
    knowledge.restorePage(child.id);
    const scope3 = store.resolveScope(token.id);
    expect(scope3.allowedPageIds).toEqual(new Set([allowedRoot.id, child.id, grandChild.id]));

    // Trashing and purging an allowed root cleans up knowledge_mcp_token_roots.
    knowledge.trashPage(allowedRoot.id, USER);
    const scope4 = store.resolveScope(token.id);
    expect(scope4.effectiveRootIds).toEqual([]);
    expect(scope4.allowedPageIds.size).toBe(0);

    knowledge.purge(allowedRoot.id);
    const remainingRoots = db.all<{ page_id: string }>(
      "SELECT page_id FROM knowledge_mcp_token_roots WHERE token_id = ?",
      token.id,
    );
    expect(remainingRoots).toEqual([]);

    // Actor metadata resolves active and revoked MCP tokens on pages and revisions.
    const target = knowledge.create({ parentId: privateParent.id, title: "Written by MCP" }, USER);
    const mcpWriter = { actor: `mcp:${token.id}`, taint: ["external"] as const };
    const edited = knowledge.edit(target.id, [{ op: "append", text: "Added externally" }], mcpWriter);
    const detail = knowledge.detail(edited.page.id);
    expect(detail.page.external).toBe(true);
    expect(detail.page.updatedBy).toEqual({ kind: "mcp", id: token.id, name: "Agent Bridge" });
    expect(detail.revisions[0]!.actor).toEqual({ kind: "mcp", id: token.id, name: "Agent Bridge" });
    expect(detail.revisions[0]!.external).toBe(true);
    expect(knowledge.actorName(`mcp:${token.id}`)).toBe("Agent Bridge");

    store.revoke(token.id);
    const afterRevoke = knowledge.detail(edited.page.id);
    expect(afterRevoke.page.updatedBy).toEqual({ kind: "mcp", id: token.id, name: "Agent Bridge (revoked)" });
  });

  it("restricts both keyword and meaning search to allowedPageIds and short-circuits empty scopes", async () => {
    const fake = new FakeEmbedder({ espresso: "coffee", latte: "coffee" });
    server = await startSignedIn(
      withEmbedder(fake, {
        memory: { fetch: fake.fetch, knowledgeCosineFloor: FAKE_KNOWLEDGE_COSINE_FLOOR },
      }),
    );
    const knowledge = server.host.plane.knowledge;
    const allowedPage = knowledge.create(
      {
        parentId: null,
        title: "Allowed Coffee Notes",
        body: "Brewing a smooth espresso shot.",
        metadata: { tags: ["coffee"] },
      },
      USER,
    );
    const secretPage = knowledge.create(
      {
        parentId: null,
        title: "Secret Coffee Notes",
        body: "Hidden espresso recipe and latte notes.",
        metadata: { tags: ["coffee"] },
      },
      USER,
    );
    await knowledge.meaning!.settle();

    // Empty allowedPageIds always returns [] for both blank query, keyword query, and meaning query.
    expect(await knowledge.find("", { allowedPageIds: new Set() })).toEqual([]);
    expect(await knowledge.find("espresso", { allowedPageIds: new Set() })).toEqual([]);
    expect(await knowledge.find("latte", { allowedPageIds: new Set() })).toEqual([]);

    // Scoped search returns only allowedPage (keyword and meaning).
    const allowed = new Set([allowedPage.id]);
    const kwHits = await knowledge.find("espresso", { allowedPageIds: allowed });
    expect(kwHits.map((h) => h.pageId)).toEqual([allowedPage.id]);

    const meaningHits = await knowledge.find("latte", { allowedPageIds: allowed });
    expect(meaningHits.map((h) => h.pageId)).toEqual([allowedPage.id]);
    expect(meaningHits.some((h) => h.pageId === secretPage.id)).toBe(false);

    // Blank query with tags + allowedPageIds filters properly.
    const tagged = await knowledge.find("", { tags: ["coffee"], allowedPageIds: allowed });
    expect(tagged.map((h) => h.pageId)).toEqual([allowedPage.id]);
  });
});
