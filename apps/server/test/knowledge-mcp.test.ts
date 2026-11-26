import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CLIENT_HEADER, clientIdHeader, SESSION_COOKIE } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { totpCode } from "../src/auth/totp.ts";
import { FAKE_KNOWLEDGE_COSINE_FLOOR, FakeEmbedder, withEmbedder } from "./helpers/fake-embedder.ts";
import { PASSWORD, startSignedIn, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const USER = { actor: "user" } as const;
const k = () => server!.host.plane.knowledge;

function mcpClientFor(secret: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp/knowledge"), {
    authProvider: { token: async () => secret },
    fetch: (input, init) => Promise.resolve(server!.host.plane.app.request(input, init)),
  });
  const client = new Client({ name: "test-mcp-client", version: "1.0.0" });
  return { client, transport };
}

async function rpc(
  secret: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const res = await server!.host.plane.app.request("http://localhost/api/mcp/knowledge", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, headers: res.headers, body };
}

async function callTool(secret: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(secret, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  return res.body.result as { content: { type: string; text: string }[]; isError?: boolean };
}

describe("Knowledge MCP server and admin REST API", () => {
  it("enforces owner auth on admin routes, credential isolation, and HTTP hardening on /api/mcp/knowledge", async () => {
    server = await startSignedIn({ config: { publicUrl: "https://rei.example" } });
    const folder = k().create({ parentId: null, title: "Docs" }, USER);

    // Owner creates a token via admin REST route (with CSRF).
    const created = await server.client.post("/api/knowledge/mcp/tokens", {
      name: "Test Client",
      permissions: { read: true },
      allowedPageIds: [folder.id],
    });
    expect(created.status).toBe(201);
    const { token, secret } = created.body as { token: { id: string; tokenPrefix: string }; secret: string };
    expect(secret).toMatch(/^rei_kmcp_/);

    // CSRF header is required for cookie-authenticated mutations.
    const noCsrf = await server.client.raw("POST", "/api/knowledge/mcp/tokens", {
      csrf: false,
      body: { name: "No CSRF" },
    });
    expect(noCsrf.status).toBe(403);

    // List returns the created token without any secret.
    const listed = await server.client.get("/api/knowledge/mcp/tokens");
    expect(listed.status).toBe(200);
    expect(listed.body.endpointPath).toBe("/api/mcp/knowledge");
    expect(listed.body.tokens).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(secret);

    // MCP token is rejected on normal /api/* and admin routes.
    const treeWithMcp = await server.host.plane.app.request("http://localhost/api/knowledge/tree", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(treeWithMcp.status).toBe(401);

    const adminWithMcp = await server.host.plane.app.request("http://localhost/api/knowledge/mcp/tokens", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(adminWithMcp.status).toBe(401);

    // User session cookie and native device bearer token are rejected on /api/mcp/knowledge.
    const cookieHeader = `${SESSION_COOKIE}=${server.client.cookie}`;
    const mcpWithCookie = await server.host.plane.app.request("http://localhost/api/mcp/knowledge", {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcpWithCookie.status).toBe(401);
    expect(mcpWithCookie.headers.get("www-authenticate")).toBe('Bearer realm="rei-knowledge-mcp"');

    server.clock.advance(30_000);
    const deviceLogin = await server.client.post(
      "/api/auth/login",
      { password: PASSWORD, totpCode: await totpCode(server.totpSecret, server.clock.now()) },
      { headers: { [CLIENT_HEADER]: clientIdHeader("cli") }, cookie: false, csrf: false },
    );
    expect(deviceLogin.status).toBe(200);
    const deviceBearer = (deviceLogin.body as { token: string }).token;
    expect(deviceBearer).toBeTypeOf("string");
    const mcpWithDevice = await rpc(deviceBearer, "tools/list");
    expect(mcpWithDevice.status).toBe(401);

    // Missing or invalid bearer token returns uniform 401 + WWW-Authenticate.
    const noAuth = await server.host.plane.app.request("http://localhost/api/mcp/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toBe('Bearer realm="rei-knowledge-mcp"');

    const badAuth = await rpc("rei_kmcp_not_a_valid_secret_token_000", "tools/list");
    expect(badAuth.status).toBe(401);
    expect(badAuth.headers.get("www-authenticate")).toBe('Bearer realm="rei-knowledge-mcp"');

    // GET and DELETE return 405 Method Not Allowed (Allow: POST).
    const getRes = await server.host.plane.app.request("http://localhost/api/mcp/knowledge", { method: "GET" });
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get("allow")).toBe("POST");

    const delRes = await server.host.plane.app.request("http://localhost/api/mcp/knowledge", { method: "DELETE" });
    expect(delRes.status).toBe(405);
    expect(delRes.headers.get("allow")).toBe("POST");

    // Cross-origin Origin header is rejected with 403; same-origin and publicUrl Origin are allowed.
    const badOrigin = await rpc(secret, "tools/list", {}, { origin: "https://evil.example" });
    expect(badOrigin.status).toBe(403);

    const forgedOrigin = await rpc(
      secret,
      "tools/list",
      {},
      {
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    );
    expect(forgedOrigin.status).toBe(403);

    const sameOrigin = await rpc(secret, "tools/list", {}, { origin: "http://localhost" });
    expect(sameOrigin.status).toBe(200);

    const publicOrigin = await rpc(secret, "tools/list", {}, { origin: "https://rei.example" });
    expect(publicOrigin.status).toBe(200);

    // Oversized body (> 512 KiB) returns 413.
    const huge = await server.host.plane.app.request("http://localhost/api/mcp/knowledge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "x".repeat(512 * 1024 + 10),
    });
    expect(huge.status).toBe(413);

    // Verify admin PATCH, rotate, and revoke take effect immediately.
    const patchRes = await server.client.call("PATCH", `/api/knowledge/mcp/tokens/${token.id}`, {
      body: { enabled: false },
    });
    expect(patchRes.status).toBe(200);
    expect((await rpc(secret, "tools/list")).status).toBe(401);

    await server.client.call("PATCH", `/api/knowledge/mcp/tokens/${token.id}`, { body: { enabled: true } });
    expect((await rpc(secret, "tools/list")).status).toBe(200);

    const rotated = await server.client.post(`/api/knowledge/mcp/tokens/${token.id}/rotate`, {});
    expect(rotated.status).toBe(200);
    const nextSecret = (rotated.body as { secret: string }).secret;
    expect((await rpc(secret, "tools/list")).status).toBe(401);
    expect((await rpc(nextSecret, "tools/list")).status).toBe(200);

    const revoked = await server.client.call("DELETE", `/api/knowledge/mcp/tokens/${token.id}`);
    expect(revoked.status).toBe(200);
    expect((await rpc(nextSecret, "tools/list")).status).toBe(401);
  });

  it("enforces deny-all defaults, subtree isolation, anti-leakage, and scoped search", async () => {
    const fake = new FakeEmbedder({ espresso: "coffee", latte: "coffee" });
    server = await startSignedIn(
      withEmbedder(fake, {
        memory: { fetch: fake.fetch, knowledgeCosineFloor: FAKE_KNOWLEDGE_COSINE_FLOOR },
      }),
    );

    const privateParent = k().create({ parentId: null, title: "Private Vault" }, USER);
    const privateSibling = k().create(
      {
        parentId: privateParent.id,
        title: "Secret Coffee Ledger",
        body: `Hidden espresso recipe and [shared](page:${privateParent.id})`,
      },
      USER,
    );
    const allowedRoot = k().create(
      { parentId: privateParent.id, title: "Shared Coffee", description: "Public coffee notes" },
      USER,
    );
    const child = k().create(
      {
        parentId: allowedRoot.id,
        title: "Espresso Guide",
        body: "## Dial In\nPull a balanced shot.\n\nSee [Private](page:" + privateSibling.id + ").",
      },
      USER,
    );
    // Private sibling links to child's heading to test sectionLinksBrokenBy filtering.
    k().edit(
      privateSibling.id,
      [{ op: "replace_text", old: "Hidden espresso recipe", new: `Hidden espresso [dial](page:${child.id}#dial-in)` }],
      USER,
      1,
    );
    // Duplicate title outside scope should never appear in similar() hints.
    k().create({ parentId: privateParent.id, title: "Latte Art Secrets" }, USER);
    await k().meaning!.settle();

    // Fresh token: 0 tools listed and all tool calls denied.
    const created = await server.client.post("/api/knowledge/mcp/tokens", { name: "Scoped Client" });
    const { token, secret } = created.body as { token: { id: string }; secret: string };

    const list0 = await rpc(secret, "tools/list");
    expect((list0.body.result as { tools: unknown[] }).tools).toEqual([]);
    const deniedRead = await callTool(secret, "knowledge_browse", {});
    expect(deniedRead.isError).toBe(true);
    expect(deniedRead.content[0]!.text).toContain("Permission denied");

    // Enable read with 0 folders: browse & search return empty; reading any page fails uniformly.
    await server.client.call("PATCH", `/api/knowledge/mcp/tokens/${token.id}`, {
      body: { permissions: { read: true } },
    });
    const listRead = await rpc(secret, "tools/list");
    expect((listRead.body.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual([
      "knowledge_browse",
      "knowledge_read",
      "knowledge_search",
    ]);
    const emptyBrowse = await callTool(secret, "knowledge_browse", {});
    expect(emptyBrowse.isError).toBeUndefined();
    expect(emptyBrowse.content[0]!.text).toContain("No allowed pages configured");

    const emptySearch = await callTool(secret, "knowledge_search", { query: "espresso" });
    expect(emptySearch.content[0]!.text).toBe("No matching pages.");

    const outOfScopeRead = await callTool(secret, "knowledge_read", { pageId: child.id });
    const missingRead = await callTool(secret, "knowledge_read", { pageId: "pg_does_not_exist" });
    expect(outOfScopeRead.isError).toBe(true);
    expect(missingRead.isError).toBe(true);
    expect(outOfScopeRead.content[0]!.text).toBe(`Page ${child.id} is not accessible or does not exist.`);
    expect(missingRead.content[0]!.text).toBe("Page pg_does_not_exist is not accessible or does not exist.");

    // Grant allowedRoot: browse/read/search never reveal Private Vault or Private Sibling.
    await server.client.call("PATCH", `/api/knowledge/mcp/tokens/${token.id}`, {
      body: { allowedPageIds: [allowedRoot.id] },
    });

    const rootBrowse = await callTool(secret, "knowledge_browse", { depth: 2 });
    expect(rootBrowse.content[0]!.text).toContain("Shared Coffee");
    expect(rootBrowse.content[0]!.text).toContain("Espresso Guide");
    expect(rootBrowse.content[0]!.text).not.toContain("Private Vault");
    expect(rootBrowse.content[0]!.text).not.toContain("Secret Coffee Ledger");

    const readChild = await callTool(secret, "knowledge_read", { pageId: child.id });
    expect(readChild.content[0]!.text).toContain(`Shared Coffee › Espresso Guide (${child.id})`);
    expect(readChild.content[0]!.text).not.toContain("Private Vault");

    const searchKw = await callTool(secret, "knowledge_search", { query: "espresso" });
    expect(searchKw.content[0]!.text).toContain("Shared Coffee › Espresso Guide");
    expect(searchKw.content[0]!.text).not.toContain("Secret Coffee Ledger");
    expect(searchKw.content[0]!.text).not.toContain("Private Vault");

    const searchMeaning = await callTool(secret, "knowledge_search", { query: "latte" });
    expect(searchMeaning.content[0]!.text).toContain("Shared Coffee › Espresso Guide");
    expect(searchMeaning.content[0]!.text).not.toContain("Secret Coffee Ledger");

    const searchBadUnder = await callTool(secret, "knowledge_search", { query: "espresso", under: privateParent.id });
    expect(searchBadUnder.isError).toBe(true);
    expect(searchBadUnder.content[0]!.text).toBe(`Page ${privateParent.id} is not accessible or does not exist.`);

    // Read-only cannot write or delete.
    expect((await callTool(secret, "knowledge_create", { parentId: allowedRoot.id, title: "X" })).isError).toBe(true);
    expect((await callTool(secret, "knowledge_delete", { pageId: child.id })).isError).toBe(true);

    // Enable write: test create, similar() filtering, link filtering, pre-existing link preservation, and locked pages.
    await server.client.call("PATCH", `/api/knowledge/mcp/tokens/${token.id}`, {
      body: { permissions: { write: true } },
    });

    // Refuses top-level create.
    const topCreate = await callTool(secret, "knowledge_create", { parentId: "top", title: "Top Note" });
    expect(topCreate.isError).toBe(true);

    // Refuses creating page with out-of-scope page: link.
    const badCreateLink = await callTool(secret, "knowledge_create", {
      parentId: allowedRoot.id,
      title: "Bad Link",
      body: `See [vault](page:${privateParent.id})`,
    });
    expect(badCreateLink.isError).toBe(true);
    expect(badCreateLink.content[0]!.text).toBe(`Page ${privateParent.id} is not accessible or does not exist.`);

    // Create page whose title matches private "Latte Art Secrets": similar() hint must NOT mention the private page.
    const createdNote = await callTool(secret, "knowledge_create", {
      parentId: allowedRoot.id,
      title: "Latte Art Secrets",
      body: "Microfoam basics.",
    });
    expect(createdNote.isError).toBeUndefined();
    expect(createdNote.content[0]!.text).toContain("Shared Coffee › Latte Art Secrets");
    expect(createdNote.content[0]!.text).not.toContain("Private Vault");
    expect(createdNote.content[0]!.text).not.toContain("Similar pages");

    // Pre-existing out-of-scope link on `child` survives an unrelated edit, while adding a new out-of-scope link fails,
    // and renaming `## Dial In` does NOT leak `Secret Coffee Ledger` in sectionLinksBrokenBy.
    const childRev = k().live(child.id).revision;
    const renamedEdit = await callTool(secret, "knowledge_edit", {
      pageId: child.id,
      baseRevision: childRev,
      ops: [{ op: "replace_section", section: "Dial In", text: "## Extraction\nPull a balanced shot." }],
    });
    expect(renamedEdit.isError).toBeUndefined();
    expect(renamedEdit.content[0]!.text).not.toContain("Secret Coffee Ledger");
    expect(renamedEdit.content[0]!.text).not.toContain("Private Vault");

    const addBadLink = await callTool(secret, "knowledge_edit", {
      pageId: child.id,
      ops: [{ op: "append", text: `Link to [root](page:${privateParent.id})` }],
    });
    expect(addBadLink.isError).toBe(true);
    expect(addBadLink.content[0]!.text).toBe(`Page ${privateParent.id} is not accessible or does not exist.`);

    // Validate links in the final Markdown, including links assembled across an edit boundary.
    expect(
      (
        await callTool(secret, "knowledge_edit", {
          pageId: child.id,
          ops: [{ op: "append", text: "Draft [root](page:PLACEHOLDER)" }],
        })
      ).isError,
    ).toBe(true);
    await callTool(secret, "knowledge_edit", {
      pageId: child.id,
      ops: [{ op: "append", text: "Draft [root](REPLACE_ME)" }],
    });
    const patchLink = await callTool(secret, "knowledge_edit", {
      pageId: child.id,
      baseRevision: k().live(child.id).revision,
      ops: [{ op: "replace_text", old: "REPLACE_ME", new: `page:${privateParent.id}` }],
    });
    expect(patchLink.content[0]!.text).toBe(`Page ${privateParent.id} is not accessible or does not exist.`);
    expect(k().live(child.id).body).toContain("REPLACE_ME");

    // Verify actor attribution and external taint.
    const detail = k().detail(child.id);
    expect(detail.page.external).toBe(true);
    expect(detail.page.updatedBy).toEqual({ kind: "mcp", id: token.id, name: "Scoped Client" });

    // Locked page allows append only over MCP.
    k().setFlags(child.id, { locked: true });
    expect(
      (await callTool(secret, "knowledge_edit", { pageId: child.id, ops: [{ op: "append", text: "Note" }] })).isError,
    ).toBeUndefined();
    expect(
      (
        await callTool(secret, "knowledge_edit", {
          pageId: child.id,
          baseRevision: k().live(child.id).revision,
          ops: [{ op: "set_title", title: "Unlocked?" }],
        })
      ).isError,
    ).toBe(true);
    k().setFlags(child.id, { locked: false });

    // Moving granted root or moving outside allowed folders is refused; moving descendant within scope succeeds.
    expect((await callTool(secret, "knowledge_move", { pageId: allowedRoot.id, parentId: child.id })).isError).toBe(
      true,
    );
    expect((await callTool(secret, "knowledge_move", { pageId: child.id, parentId: privateParent.id })).isError).toBe(
      true,
    );
    const createdSub = k()
      .children(allowedRoot.id)
      .find((p) => p.title === "Latte Art Secrets")!;
    const moved = await callTool(secret, "knowledge_move", { pageId: createdSub.id, parentId: child.id });
    expect(moved.isError).toBeUndefined();
    expect(moved.content[0]!.text).toContain("Shared Coffee › Espresso Guide › Latte Art Secrets");
    const ownerPage = k().create({ parentId: allowedRoot.id, title: "Owner Draft" }, USER);
    expect(
      (await callTool(secret, "knowledge_move", { pageId: ownerPage.id, parentId: child.id })).isError,
    ).toBeUndefined();
    expect(k().detail(ownerPage.id).page).toMatchObject({ external: true, updatedBy: { kind: "mcp", id: token.id } });
  });

  it("enforces descendant-only Trash delete and completes an end-to-end MCP SDK client session", async () => {
    server = await startSignedIn();
    const inbox = k().ensureInbox();
    const rootFolder = k().create({ parentId: null, title: "Workspace" }, USER);
    const subPage = k().create({ parentId: rootFolder.id, title: "Scratchpad", body: "Initial notes." }, USER);
    const lockedSub = k().create({ parentId: rootFolder.id, title: "Locked Guide" }, USER);
    const nestedGrant = k().create({ parentId: subPage.id, title: "Granted Nested Folder" }, USER);
    const lockedParent = k().create({ parentId: rootFolder.id, title: "Parent of Locked Guide" }, USER);
    k().move(lockedSub.id, lockedParent.id, USER);
    k().setFlags(lockedSub.id, { locked: true });

    const created = await server.client.post("/api/knowledge/mcp/tokens", {
      name: "SDK Client",
      permissions: { read: true, write: true, delete: true },
      allowedPageIds: [rootFolder.id, inbox.id, nestedGrant.id],
    });
    const { token, secret } = created.body as { token: { id: string }; secret: string };

    const { client } = mcpClientFor(secret);
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp/knowledge"), {
        authProvider: { token: async () => secret },
        fetch: (input, init) => Promise.resolve(server!.host.plane.app.request(input, init)),
      }),
    );

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "knowledge_browse",
      "knowledge_create",
      "knowledge_delete",
      "knowledge_edit",
      "knowledge_move",
      "knowledge_read",
      "knowledge_search",
    ]);

    const readRes = await client.callTool({ name: "knowledge_read", arguments: { pageId: subPage.id } });
    expect(readRes.isError).toBeFalsy();
    expect((readRes.content as { text: string }[])[0]!.text).toContain("Initial notes.");

    // Refuses deleting granted root folder, Inbox, or locked descendant.
    const delRoot = await client.callTool({ name: "knowledge_delete", arguments: { pageId: rootFolder.id } });
    expect(delRoot.isError).toBe(true);
    const delInbox = await client.callTool({ name: "knowledge_delete", arguments: { pageId: inbox.id } });
    expect(delInbox.isError).toBe(true);
    const delLocked = await client.callTool({ name: "knowledge_delete", arguments: { pageId: lockedSub.id } });
    expect(delLocked.isError).toBe(true);

    for (const page of [subPage, lockedParent]) {
      const result = await client.callTool({ name: "knowledge_delete", arguments: { pageId: page.id } });
      expect(result.isError).toBe(true);
      expect(k().live(page.id).trashed_at).toBeNull();
    }
    expect(k().live(nestedGrant.id).trashed_at).toBeNull();
    expect(k().live(lockedSub.id).trashed_at).toBeNull();
    await server.client.call("PATCH", `/api/knowledge/mcp/tokens/${token.id}`, {
      body: { allowedPageIds: [rootFolder.id, inbox.id] },
    });

    // Deleting descendant moves it to Trash (recoverable, never purged).
    const delSub = await client.callTool({ name: "knowledge_delete", arguments: { pageId: subPage.id } });
    expect(delSub.isError).toBeFalsy();
    expect(k().page(subPage.id)?.trashed_at).not.toBeNull();
    expect(
      k()
        .trash()
        .some((p) => p.id === subPage.id),
    ).toBe(true);

    // Restoring from Trash brings it back.
    k().restorePage(subPage.id);
    expect(k().detail(subPage.id).page).toMatchObject({
      external: true,
      updatedBy: { kind: "mcp", id: token.id, name: "SDK Client" },
    });

    // Trashing the root folder immediately removes its subtree from scope; removing the folder from token also removes access.
    k().trashPage(rootFolder.id, USER);
    const afterTrash = await client.callTool({ name: "knowledge_read", arguments: { pageId: subPage.id } });
    expect(afterTrash.isError).toBe(true);

    k().restorePage(rootFolder.id);
    await server.client.call("PATCH", `/api/knowledge/mcp/tokens/${token.id}`, { body: { allowedPageIds: [] } });
    const afterUnassign = await client.callTool({ name: "knowledge_read", arguments: { pageId: subPage.id } });
    expect(afterUnassign.isError).toBe(true);

    await client.close();
  });
});
