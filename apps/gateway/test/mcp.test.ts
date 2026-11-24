import { statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { McpRig } from "./mcp-rig.ts";
import { startMcpRig } from "./mcp-rig.ts";
import { AUTH_URL, MCP_URL } from "./mcp-world.ts";

const REDIRECT = "https://app.example.net/api/mcp/oauth/callback";
let rig: McpRig;
afterEach(() => rig?.stop());

const create = async (body: Record<string, unknown> = {}) =>
  rig.request("POST", "/mcp/connectors", { name: "Fake", url: MCP_URL, ...body });
const err = async (res: Response) => (await rig.json<{ error: { code: string; message: string } }>(res)).error;

// Current gateway calls carry the exact connector and tool definition they authorize.
async function call(
  id: string,
  body: Record<string, unknown> | undefined,
  options: { token?: string | null; raw?: string } = {},
) {
  if (!body || options.token !== undefined || options.raw !== undefined)
    return rig.request("POST", `/mcp/connectors/${id}/call`, body, options);
  if (body.expected !== undefined || typeof body.tool !== "string")
    return rig.request("POST", `/mcp/connectors/${id}/call`, body);
  const response = await rig.request("GET", "/mcp/connectors");
  if (!response.ok) return rig.request("POST", `/mcp/connectors/${id}/call`, body);
  const { connectors } = await rig.json(response);
  const connector = connectors.find((c: { id: string }) => c.id === id);
  if (!connector) return rig.request("POST", `/mcp/connectors/${id}/call`, body);
  const listed = await rig.request("GET", `/mcp/connectors/${id}/tools`);
  if (!listed.ok) return rig.request("POST", `/mcp/connectors/${id}/call`, body);
  const { tools } = await rig.json(listed);
  const { name, url, auth, tokenHeader, status, createdAt } = connector;
  return rig.request("POST", `/mcp/connectors/${id}/call`, {
    ...body,
    expected: {
      connector: { id, name, url, auth, tokenHeader, status, createdAt },
      tool: tools.find((t: { name: string }) => t.name === body.tool),
    },
  });
}
describe("definition-bound app-server calls", () => {
  async function bound() {
    const { connector } = await rig.json(await create());
    const { tools } = await rig.json(await rig.request("GET", `/mcp/connectors/${connector.id}/tools`));
    const { id, name, url, auth, status, createdAt } = connector;
    return {
      id,
      expected: {
        connector: { id, name, url, auth, status, createdAt },
        tool: tools.find((t: { name: string }) => t.name === "echo"),
      },
    };
  }

  it("rejects a call without an authorized definition before execution", async () => {
    rig = startMcpRig({ world: { require: null } });
    const { id } = await bound();
    const response = await rig.request("POST", `/mcp/connectors/${id}/call`, { tool: "echo", arguments: {} });
    expect(response.status).toBe(409);
    expect((await err(response)).code).toBe("tool_changed");
    expect(rig.world.state.toolCalls).toEqual([]);
  });

  it("refreshes on the call connection and executes an unchanged definition once", async () => {
    rig = startMcpRig({ world: { require: null, ttlMs: 600_000 } });
    const { id, expected } = await bound();
    const listed = rig.world.state.toolsListCalls;
    const res = await call(id, { tool: "echo", arguments: { text: "fixture" }, expected });
    expect(res.status).toBe(200);
    expect(rig.world.state.toolsListCalls).toBe(listed + 1);
    expect(rig.world.state.toolCalls).toEqual([{ name: "echo", arguments: { text: "fixture" } }]);
  });

  it.each(["schema", "output schema", "hints", "name", "connector", "duplicate"])(
    "rejects %s drift despite a warm gateway cache",
    async (change) => {
      rig = startMcpRig({ world: { require: null, ttlMs: 600_000 } });
      const { id, expected } = await bound();
      if (change === "schema") rig.world.state.tools[0]!.inputSchema = { type: "object", required: ["new"] };
      if (change === "output schema") rig.world.state.tools[0]!.outputSchema = { type: "object", required: ["new"] };
      if (change === "hints") rig.world.state.tools[0]!.annotations = { destructiveHint: true };
      if (change === "name") rig.world.state.tools[0]!.name = "renamed";
      if (change === "duplicate") rig.world.state.tools.push(structuredClone(rig.world.state.tools[0]!));
      if (change === "connector") await rig.request("PATCH", `/mcp/connectors/${id}`, { name: "Renamed" });
      const res = await call(id, { tool: "echo", arguments: {}, expected });
      expect(res.status).toBe(409);
      expect((await err(res)).code).toBe("tool_changed");
      expect(rig.world.state.toolCalls).toEqual([]);
    },
  );

  it("does not bypass authentication when a caller supplies expected metadata", async () => {
    rig = startMcpRig({ world: { require: null } });
    const { id, expected } = await bound();
    expect((await call(id, { tool: "echo", expected }, { token: null })).status).toBe(401);
    expect(rig.world.state.toolCalls).toEqual([]);
  });
});

/** Create an OAuth connector and run the whole sign-in; returns what the tests need next. */
async function signIn(opts: { start?: Record<string, unknown> } = {}) {
  const created = (await rig.json(await create())).connector;
  const started = await rig.json<{ authorizationUrl: string }>(
    await rig.request("POST", `/mcp/connectors/${created.id}/oauth/start`, { redirectUri: REDIRECT, ...opts.start }),
  );
  const approval = rig.world.approve(started.authorizationUrl);
  const done = await rig.request("POST", "/mcp/oauth/callback", {
    state: approval.state,
    code: approval.code,
    iss: rig.world.issuer,
  });
  return { id: created.id as string, authorizationUrl: started.authorizationUrl, approval, done };
}

describe("connector create and probe", () => {
  it("none: connected, tools counted, nothing secret listed", async () => {
    rig = startMcpRig({ world: { require: null } });
    const res = await create();
    expect(res.status).toBe(200);
    const { connector } = await rig.json(res);
    expect(connector).toMatchObject({
      name: "Fake",
      url: MCP_URL,
      auth: "none",
      status: "connected",
      error: null,
      toolCount: 5,
      createdAt: 1_700_000_000_000,
    });
    expect(connector.id).toMatch(/^con_[A-Za-z0-9_-]{16}$/);
    const list = await rig.json(await rig.request("GET", "/mcp/connectors"));
    expect(list.connectors).toEqual([connector]);
  });

  it("token: sent as a bearer, kept out of every response; a wrong token needs_auth", async () => {
    rig = startMcpRig({ world: { require: { token: "tok-secret-1234567890" } } });
    const ok = await rig.json(await create({ token: "tok-secret-1234567890" }));
    expect(ok.connector).toMatchObject({ auth: "token", status: "connected", toolCount: 5 });
    expect(JSON.stringify(ok)).not.toContain("tok-secret");
    expect(
      rig.world.seen
        .filter((s) => s.url === MCP_URL)
        .every((s) => s.headers.authorization === "Bearer tok-secret-1234567890"),
    ).toBe(true);

    const bad = await rig.json(await create({ name: "Bad", token: "wrong-token-1234567890" }));
    expect(bad.connector).toMatchObject({ auth: "token", status: "needs_auth", toolCount: null });
    expect(bad.connector.error).toMatch(/rejected the token/);
  });

  it("oauth: a 401 with resource metadata makes it an oauth connector that needs sign-in", async () => {
    rig = startMcpRig();
    const { connector } = await rig.json(await create());
    expect(connector).toMatchObject({ auth: "oauth", status: "needs_auth", toolCount: null });
    const tools = await rig.request("GET", `/mcp/connectors/${connector.id}/tools`);
    expect(tools.status).toBe(409);
    expect((await err(tools)).code).toBe("needs_auth");
  });

  it("uses a custom token header for probing, discovery and calls, and can switch back without entering the token", async () => {
    const token = "fixture-private-token";
    rig = startMcpRig({ world: { require: { token, header: "X-Api-Key" } } });
    const { connector } = await rig.json(await create({ token, tokenHeader: "X-Api-Key" }));
    expect(connector).toMatchObject({ auth: "token", tokenHeader: "X-Api-Key", status: "connected", toolCount: 5 });
    expect(JSON.stringify(connector)).not.toContain(token);
    const { id } = connector;
    const oldTools = await rig.json(await rig.request("GET", `/mcp/connectors/${id}/tools`));
    const oldTool = oldTools.tools.find((tool: { name: string }) => tool.name === "echo");
    const { name, url, auth, tokenHeader, status, createdAt } = connector;
    expect((await call(id, { tool: "echo", arguments: { text: "fixture" } })).status).toBe(200);
    expect(rig.world.state.toolCalls).toHaveLength(1);
    expect(rig.world.seen.every((s) => s.headers["x-api-key"] === token && !s.headers.authorization)).toBe(true);
    rig.world.state.require = { token };
    const result = await rig.json(await rig.request("PATCH", `/mcp/connectors/${id}`, { tokenHeader: null }));
    expect(result.connector.status).toBe("connected");
    expect(result.connector.tokenHeader).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(token);
    const stale = await call(id, {
      tool: "echo",
      expected: { connector: { id, name, url, auth, tokenHeader, status, createdAt }, tool: oldTool },
    });
    expect((await err(stale)).code).toBe("tool_changed");
    expect(rig.world.state.toolCalls).toHaveLength(1);
  });

  it("rejects malformed or reserved header names and a custom header without a token before contacting the provider", async () => {
    rig = startMcpRig();
    for (const tokenHeader of ["Host", "Content-Type", "Mcp-Session-Id", "X-Test\r\nInjected: true"]) {
      expect((await create({ token: "test-token", tokenHeader })).status).toBe(400);
    }
    expect((await create({ tokenHeader: "X-Api-Key" })).status).toBe(400);
    expect(rig.world.seen).toHaveLength(0);
  });

  it("blocks redirecting a custom credential on the probe and on SDK requests", async () => {
    const token = "fixture-private-token";
    const tokenHeader = "X-Api-Key";
    rig = startMcpRig({ world: { require: { token, header: tokenHeader } } });
    const { connector } = await rig.json(await create({ token, tokenHeader }));
    rig.world.state.redirectMcp = true;
    expect((await create({ token, tokenHeader })).status).toBe(502);
    expect((await rig.request("GET", `/mcp/connectors/${connector.id}/tools?refresh=1`)).status).toBe(502);
    expect(rig.world.seen.every((s) => s.url === MCP_URL)).toBe(true);
  });

  it("talks to a 2025-style server: era probe falls back to initialize and the session id is kept", async () => {
    rig = startMcpRig({ world: { require: null, sessions: true } });
    const { connector } = await rig.json(await create());
    expect(connector).toMatchObject({ status: "connected", toolCount: 5 });
    const methods = rig.world.seen.filter((s) => s.url === MCP_URL).map((s) => (s.body as { method?: string })?.method);
    expect(methods).toContain("server/discover");
    expect(methods).toContain("initialize");
  });

  it("patch renames, sets and drops a token; delete forgets everything", async () => {
    rig = startMcpRig({ world: { require: { token: "tok-secret-1234567890" } } });
    const { connector } = await rig.json(await create());
    expect(connector.status).toBe("needs_auth"); // no token, no OAuth metadata (the fake serves it, so oauth)
    const renamed = await rig.json(await rig.request("PATCH", `/mcp/connectors/${connector.id}`, { name: "Renamed" }));
    expect(renamed.connector.name).toBe("Renamed");
    const withToken = await rig.json(
      await rig.request("PATCH", `/mcp/connectors/${connector.id}`, { token: "tok-secret-1234567890" }),
    );
    expect(withToken.connector).toMatchObject({ auth: "token", status: "connected", toolCount: 5 });
    expect(rig.secretFile()).toContain("tok-secret-1234567890");
    const dropped = await rig.json(await rig.request("PATCH", `/mcp/connectors/${connector.id}`, { token: null }));
    expect(dropped.connector).toMatchObject({ auth: "oauth", status: "needs_auth" });
    expect(rig.secretFile()).not.toContain("tok-secret-1234567890");
    const del = await rig.request("DELETE", `/mcp/connectors/${connector.id}`);
    expect(del.status).toBe(204);
    expect((await rig.request("GET", `/mcp/connectors/${connector.id}/tools`)).status).toBe(404);
    expect((await rig.json(await rig.request("GET", "/mcp/connectors"))).connectors).toEqual([]);
  });

  it("an unreachable server is a 502 and nothing is created", async () => {
    rig = startMcpRig({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const res = await create();
    expect(res.status).toBe(502);
    expect((await err(res)).code).toBe("connector_unreachable");
    expect((await rig.json(await rig.request("GET", "/mcp/connectors"))).connectors).toEqual([]);
  });

  it("a server that errors on tools/list is created with status error", async () => {
    rig = startMcpRig({ world: { require: null } });
    rig.world.state.tools = null as never; // the fake then answers tools/list with an invalid result
    const { connector } = await rig.json(await create());
    expect(connector.status).toBe("error");
    expect(connector.error).toBeTruthy();
  });
});

describe("URL validation", () => {
  it.each([
    ["http://mcp.example.com/mcp", "plain http"],
    ["https://127.0.0.1/mcp", "loopback"],
    ["https://localhost/mcp", "localhost"],
    ["https://10.1.2.3/mcp", "private address"],
    ["https://gateway/mcp", "single-label host"],
    ["https://foo.internal/mcp", "internal name"],
    ["https://user:pw@mcp.example.com/mcp", "credentials"],
    ["ftp://mcp.example.com/mcp", "other scheme"],
    ["not a url", "garbage"],
  ])("refuses %s (%s)", async (url) => {
    rig = startMcpRig({ world: { require: null } });
    const res = await create({ url });
    expect(res.status).toBe(400);
    expect((await err(res)).code).toBe("bad_url");
    expect(rig.world.seen).toEqual([]); // nothing was fetched
  });

  it("allows http for a dev-allowlisted host only", async () => {
    rig = startMcpRig({ world: { require: null }, devHosts: ["mcp.example.com"] });
    expect((await create({ url: "http://mcp.example.com/mcp" })).status).toBe(200);
    expect((await create({ url: "http://other.example.com/mcp" })).status).toBe(400);
  });

  it("refuses an authorization server on a private address", async () => {
    rig = startMcpRig({ world: { tokenEndpoint: "https://10.0.0.5/token" } });
    const { connector } = await rig.json(await create());
    const res = await rig.request("POST", `/mcp/connectors/${connector.id}/oauth/start`, { redirectUri: REDIRECT });
    expect(res.status).toBe(502);
    expect((await err(res)).code).toBe("oauth_failed");
    expect(rig.world.registrations).toEqual([]);
  });

  it("refuses a redirectUri that is not an http(s) URL", async () => {
    rig = startMcpRig();
    const { connector } = await rig.json(await create());
    for (const redirectUri of ["not-a-url", "javascript:alert(1)", "https://u:p@app.example.net/cb", 5]) {
      const res = await rig.request("POST", `/mcp/connectors/${connector.id}/oauth/start`, { redirectUri });
      expect(res.status).toBe(400);
    }
  });
});

describe("OAuth", () => {
  it("start, callback, token exchange, tools/list and tools/call", async () => {
    rig = startMcpRig();
    const { id, authorizationUrl, done } = await signIn();
    const u = new URL(authorizationUrl);
    expect(u.origin + u.pathname).toBe(`${AUTH_URL}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
      resource: MCP_URL,
      scope: "mcp.read",
    });
    expect(u.searchParams.get("state")).toHaveLength(43);
    expect(rig.world.registrations).toEqual([
      expect.objectContaining({ client_name: "Rei", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    ]);

    expect(done.status).toBe(200);
    const { connector } = await rig.json(done);
    expect(connector).toMatchObject({ id, auth: "oauth", status: "connected", error: null, toolCount: 5 });
    const exchange = rig.world.state.tokenRequests[0]!;
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      client_id: "client-1",
      redirect_uri: REDIRECT,
      resource: MCP_URL,
    });
    expect(exchange.code_verifier).toBeTruthy();

    const tools = await rig.json<{ tools: any[]; fetchedAt: number }>(
      await rig.request("GET", `/mcp/connectors/${id}/tools`),
    );
    expect(tools.tools.map((t) => t.name)).toEqual(["echo", "write", "big", "mixed", "boom"]);
    expect(tools.tools[0]).toEqual({
      name: "echo",
      title: "Echo",
      description: "Echo the text back.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: true },
    });
    expect(tools.tools[1]).toMatchObject({ title: "Write", annotations: { destructiveHint: true } });

    const called = await rig.json(await call(id, { tool: "echo", arguments: { text: "hi" } }));
    expect(called).toEqual({ isError: false, text: "echo: hi", structured: null, truncated: false });
    const mcpRequests = rig.world.seen.filter((s) => s.url === MCP_URL && s.headers.authorization);
    expect(mcpRequests.length).toBeGreaterThan(0);
    expect(mcpRequests.every((s) => s.headers.authorization === `Bearer ${[...rig.world.accessTokens][0]}`)).toBe(true);
  });

  it("state and pending sign-in survive a gateway restart; so does the token", async () => {
    rig = startMcpRig();
    const created = (await rig.json(await create())).connector;
    const started = await rig.json<{ authorizationUrl: string }>(
      await rig.request("POST", `/mcp/connectors/${created.id}/oauth/start`, { redirectUri: REDIRECT }),
    );
    rig.restart();
    const approval = rig.world.approve(started.authorizationUrl);
    expect(
      (
        await rig.request("POST", "/mcp/oauth/callback", {
          state: approval.state,
          code: approval.code,
          iss: rig.world.issuer,
        })
      ).status,
    ).toBe(200);
    rig.restart();
    expect((await rig.json(await rig.request("GET", "/mcp/connectors"))).connectors[0]).toMatchObject({
      status: "connected",
      toolCount: 5,
    });
    const tools = await rig.request("GET", `/mcp/connectors/${created.id}/tools?refresh=1`);
    expect(tools.status).toBe(200);
    expect(statSync(rig.paths.secretsFile).mode & 0o777).toBe(0o600);
  });

  it("a state that is unknown, expired or used twice is refused", async () => {
    rig = startMcpRig();
    const created = (await rig.json(await create())).connector;
    const start = async () =>
      rig.world.approve(
        (
          await rig.json<{ authorizationUrl: string }>(
            await rig.request("POST", `/mcp/connectors/${created.id}/oauth/start`, { redirectUri: REDIRECT }),
          )
        ).authorizationUrl,
      );

    const mismatch = await start();
    const bad = await rig.request("POST", "/mcp/oauth/callback", { state: "not-the-state", code: mismatch.code });
    expect(bad.status).toBe(400);
    expect((await err(bad)).code).toBe("invalid_state");

    const stale = await start();
    rig.clock.t += 10 * 60_000 + 1;
    const expired = await rig.request("POST", "/mcp/oauth/callback", { state: stale.state, code: stale.code });
    expect(expired.status).toBe(400);
    expect((await err(expired)).code).toBe("state_expired");
    const replay = await rig.request("POST", "/mcp/oauth/callback", { state: stale.state, code: stale.code });
    expect((await err(replay)).code).toBe("invalid_state");

    const fresh = await start();
    expect(
      (
        await rig.request("POST", "/mcp/oauth/callback", {
          state: fresh.state,
          code: fresh.code,
          iss: rig.world.issuer,
        })
      ).status,
    ).toBe(200);
    const again = await rig.request("POST", "/mcp/oauth/callback", {
      state: fresh.state,
      code: fresh.code,
      iss: rig.world.issuer,
    });
    expect((await err(again)).code).toBe("invalid_state");
    expect(rig.world.state.tokenRequests).toHaveLength(1); // only the one good callback reached the token endpoint
  });

  it("refuses a callback whose iss is not the authorization server, before redeeming the code", async () => {
    rig = startMcpRig();
    const created = (await rig.json(await create())).connector;
    const started = await rig.json<{ authorizationUrl: string }>(
      await rig.request("POST", `/mcp/connectors/${created.id}/oauth/start`, { redirectUri: REDIRECT }),
    );
    const a = rig.world.approve(started.authorizationUrl);
    const res = await rig.request("POST", "/mcp/oauth/callback", {
      state: a.state,
      code: a.code,
      iss: "https://evil.example.org",
    });
    expect(res.status).toBe(400);
    expect((await err(res)).code).toBe("iss_mismatch");
    expect(rig.world.state.tokenRequests).toEqual([]);
    expect((await rig.json(await rig.request("GET", "/mcp/connectors"))).connectors[0].status).toBe("needs_auth");
  });

  it("refuses a callback with no iss when the server advertises it (RFC 9207)", async () => {
    rig = startMcpRig();
    const created = (await rig.json(await create())).connector;
    const started = await rig.json<{ authorizationUrl: string }>(
      await rig.request("POST", `/mcp/connectors/${created.id}/oauth/start`, { redirectUri: REDIRECT }),
    );
    const a = rig.world.approve(started.authorizationUrl);
    const res = await rig.request("POST", "/mcp/oauth/callback", { state: a.state, code: a.code });
    expect((await err(res)).code).toBe("iss_mismatch");
  });

  it("without dynamic registration it asks for a client ID, and uses one it is given", async () => {
    rig = startMcpRig({ world: { noRegistration: true } });
    const created = (await rig.json(await create())).connector;
    const res = await rig.request("POST", `/mcp/connectors/${created.id}/oauth/start`, { redirectUri: REDIRECT });
    expect(res.status).toBe(400);
    expect((await err(res)).code).toBe("client_id_required");
    const ok = await rig.json<{ authorizationUrl: string }>(
      await rig.request("POST", `/mcp/connectors/${created.id}/oauth/start`, {
        redirectUri: REDIRECT,
        clientId: "my-client",
        clientSecret: "my-client-secret-xyz",
      }),
    );
    expect(new URL(ok.authorizationUrl).searchParams.get("client_id")).toBe("my-client");
    const a = rig.world.approve(ok.authorizationUrl);
    expect(
      (await rig.request("POST", "/mcp/oauth/callback", { state: a.state, code: a.code, iss: rig.world.issuer }))
        .status,
    ).toBe(200);
    expect(rig.world.state.tokenRequests[0]).toMatchObject({
      client_id: "my-client",
      client_secret: "my-client-secret-xyz",
    });
  });

  it("reuses a registration for the same redirect URI and registers again for another", async () => {
    rig = startMcpRig();
    const created = (await rig.json(await create())).connector;
    const start = (redirectUri: string) =>
      rig.request("POST", `/mcp/connectors/${created.id}/oauth/start`, { redirectUri });
    await start(REDIRECT);
    await start(REDIRECT);
    expect(rig.world.registrations).toHaveLength(1);
    await start("https://other.example.net/cb");
    expect(rig.world.registrations).toHaveLength(2);
  });
});

describe("token refresh", () => {
  it("refreshes before expiry, rotates the refresh token and keeps going", async () => {
    rig = startMcpRig({ world: { expiresIn: 300 } });
    const { id } = await signIn();
    const first = [...rig.world.accessTokens][0]!;
    const firstRefresh = [...rig.world.refreshTokens.keys()][0]!;

    rig.clock.t += 250_000; // inside the 60 s skew window
    const called = await rig.json(await call(id, { tool: "echo", arguments: { text: "a" } }));
    expect(called.text).toBe("echo: a");
    const refreshRequests = rig.world.state.tokenRequests.filter((r) => r.grant_type === "refresh_token");
    expect(refreshRequests).toHaveLength(1);
    expect(refreshRequests[0]).toMatchObject({ refresh_token: firstRefresh, client_id: "client-1", resource: MCP_URL });
    const last = rig.world.seen.filter((s) => s.url === MCP_URL).at(-1)!;
    expect(last.headers.authorization).not.toBe(`Bearer ${first}`);

    // The rotated refresh token is what the next refresh uses (the old one is dead at the fake).
    rig.clock.t += 250_000;
    expect((await call(id, { tool: "echo", arguments: {} })).status).toBe(200);
    expect(rig.world.state.tokenRequests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(2);
    expect((await rig.json(await rig.request("GET", "/mcp/connectors"))).connectors[0].status).toBe("connected");
  });

  it("a server 401 on a token the clock still trusts triggers one refresh and a retry", async () => {
    rig = startMcpRig();
    const { id } = await signIn();
    rig.world.revokeAccessTokens();
    const called = await rig.json(await call(id, { tool: "echo", arguments: { text: "b" } }));
    expect(called.text).toBe("echo: b");
    expect(rig.world.state.tokenRequests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(1);
  });

  it("a refresh the server refuses sets needs_auth and answers needs_auth", async () => {
    rig = startMcpRig({ world: { expiresIn: 300 } });
    const { id } = await signIn();
    rig.world.state.refuseRefresh = true;
    rig.clock.t += 250_000;
    const res = await call(id, { tool: "echo", arguments: {} });
    expect(res.status).toBe(409);
    expect((await err(res)).code).toBe("needs_auth");
    expect((await rig.json(await rig.request("GET", "/mcp/connectors"))).connectors[0]).toMatchObject({
      status: "needs_auth",
      error: expect.stringMatching(/sign in again/),
    });
    // Later calls fail fast on the stored state instead of trying again.
    const before = rig.world.seen.length;
    expect((await err(await call(id, { tool: "echo", arguments: {} }))).code).toBe("needs_auth");
    expect(rig.world.seen.length).toBe(before);
  });

  it("a refresh that fails on the network keeps the sign-in and works once the network is back", async () => {
    let down = false;
    rig = startMcpRig({
      world: { expiresIn: 300 },
      wrapFetch: (real) =>
        (async (input, init) => {
          if (down && String(input).includes("/token")) throw new TypeError("fetch failed");
          return real(input, init);
        }) as typeof fetch,
    });
    const { id } = await signIn();
    down = true;
    rig.clock.t += 250_000;
    const res = await call(id, { tool: "echo", arguments: { text: "c" } });
    expect(res.status).toBe(502);
    expect((await rig.json(await rig.request("GET", "/mcp/connectors"))).connectors[0].status).toBe("connected");
    down = false;
    expect((await rig.json(await call(id, { tool: "echo", arguments: { text: "c" } }))).text).toBe("echo: c");
  });
});

describe("tools cache", () => {
  it("serves the list from cache until refresh=1", async () => {
    rig = startMcpRig({ world: { require: null } });
    const { connector } = await rig.json(await create());
    const calls = () => rig.world.state.toolsListCalls;
    expect(calls()).toBe(1); // the create already listed them
    const a = await rig.json<{ fetchedAt: number }>(await rig.request("GET", `/mcp/connectors/${connector.id}/tools`));
    await rig.request("GET", `/mcp/connectors/${connector.id}/tools`);
    expect(calls()).toBe(1);
    expect(a.fetchedAt).toBe(rig.clock.t);
    rig.clock.t += 1_000;
    const b = await rig.json<{ fetchedAt: number }>(
      await rig.request("GET", `/mcp/connectors/${connector.id}/tools?refresh=1`),
    );
    expect(calls()).toBe(2);
    expect(b.fetchedAt).toBe(rig.clock.t);
  });

  it("expires after 10 minutes by default and after the server's ttlMs when it sends one", async () => {
    rig = startMcpRig({ world: { require: null } });
    const { connector } = await rig.json(await create());
    const get = () => rig.request("GET", `/mcp/connectors/${connector.id}/tools`);
    rig.clock.t += 9 * 60_000;
    await get();
    expect(rig.world.state.toolsListCalls).toBe(1);
    rig.clock.t += 61_000;
    await get();
    expect(rig.world.state.toolsListCalls).toBe(2);
    rig.stop();

    rig = startMcpRig({ world: { require: null, ttlMs: 5_000 } });
    const second = (await rig.json(await create())).connector;
    rig.clock.t += 4_000;
    await rig.request("GET", `/mcp/connectors/${second.id}/tools`);
    expect(rig.world.state.toolsListCalls).toBe(1);
    rig.clock.t += 2_000;
    await rig.request("GET", `/mcp/connectors/${second.id}/tools`);
    expect(rig.world.state.toolsListCalls).toBe(2);
  });
});

describe("tool calls", () => {
  const setup = async () => {
    rig = startMcpRig({ world: { require: null } });
    return (await rig.json(await create())).connector.id as string;
  };

  it("keeps bounded typed media alongside flattened text and structured content", async () => {
    const id = await setup();
    const res = await rig.json(await call(id, { tool: "mixed", arguments: {} }));
    expect(res).toEqual({
      isError: false,
      text: "first\n\n[image: image/png]\n\n[audio: audio/wav]\n\n[resource: file:///a.txt]\n\nlast",
      structured: { answer: 42 },
      truncated: false,
      media: [
        { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "audio", mimeType: "audio/wav", data: "AAAA" },
        { type: "resource", mimeType: "text/plain", text: "secret body", uri: "file:///a.txt" },
      ],
    });
    expect(res.text).not.toContain("secret body");
  });

  it("redacts secrets in structured content as it does in the text", async () => {
    const id = await setup();
    const secret = "Bearer abcdefghijklmnop1234567890";
    const structured = { key: secret, nested: [{ [secret]: 1, ok: "fine" }], count: 3 };
    const res = await rig.json<{ text: string; structured: unknown }>(
      await call(id, { tool: "echo", arguments: { text: secret, structured } }),
    );
    expect(res.text).toBe("echo: Bearer [REDACTED]");
    expect(res.structured).toEqual({
      key: "Bearer [REDACTED]",
      nested: [{ "Bearer [REDACTED]": 1, ok: "fine" }],
      count: 3,
    });
  });

  it("caps the text at 100 KB and says so", async () => {
    const id = await setup();
    rig.world.state.bigText = "é".repeat(100_000); // 200 KB in UTF-8
    const res = await rig.json<{ text: string; truncated: boolean }>(await call(id, { tool: "big", arguments: {} }));
    expect(res.truncated).toBe(true);
    expect(new TextEncoder().encode(res.text).length).toBeLessThanOrEqual(100 * 1024);
    expect(res.text).not.toContain("�");
    expect(res.text.length).toBeGreaterThan(50_000);
  });

  it("a tool that reports an error, and a protocol error, come back as isError results", async () => {
    const id = await setup();
    expect(await rig.json(await call(id, { tool: "boom", arguments: {} }))).toMatchObject({
      isError: true,
      text: "it broke",
    });
    const unknown = await rig.json<{ isError: boolean; text: string }>(await call(id, { tool: "nope", arguments: {} }));
    expect(unknown).toMatchObject({ error: { code: "tool_changed" } });
  });

  it("passes the arguments, records the call under its step, and logs neither arguments nor results", async () => {
    const id = await setup();
    await call(id, { tool: "echo", arguments: { text: "launch code 8472" }, stepId: "step_1" });
    expect(rig.world.state.toolCalls.at(-1)).toEqual({ name: "echo", arguments: { text: "launch code 8472" } });
    const records = await rig.json<any[]>(await rig.request("GET", "/calls?stepId=step_1"));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ stepId: "step_1", model: `mcp:${id}/echo`, status: 200 });
    expect(rig.logs.join("\n")).toContain('"event":"mcp.call","stepId":"step_1"');
    expect(rig.logs.join("\n")).not.toContain("8472");
  });

  it("validates the request", async () => {
    const id = await setup();
    expect((await call(id, { arguments: {} })).status).toBe(400);
    expect((await call(id, { tool: "echo", arguments: [] })).status).toBe(400);
    expect((await call(id, undefined, { raw: "nope" })).status).toBe(400);
    expect((await rig.request("POST", `/mcp/connectors/con_missing/call`, { tool: "echo" })).status).toBe(404);
  });
});

describe("auth and secrets", () => {
  it("every new route needs the stand-in bearer token", async () => {
    rig = startMcpRig({ world: { require: null } });
    const routes: [string, string][] = [
      ["GET", "/mcp/connectors"],
      ["POST", "/mcp/connectors"],
      ["PATCH", "/mcp/connectors/con_x"],
      ["DELETE", "/mcp/connectors/con_x"],
      ["POST", "/mcp/connectors/con_x/oauth/start"],
      ["POST", "/mcp/oauth/callback"],
      ["GET", "/mcp/connectors/con_x/tools"],
      ["POST", "/mcp/connectors/con_x/call"],
      ["GET", "/notify/webpush/key"],
      ["POST", "/notify/webpush/send"],
    ];
    for (const [method, path] of routes) {
      for (const token of [null, "wrong-token-wrong-token-wrong"]) {
        const res = await rig.request(method, path, method === "GET" || method === "DELETE" ? undefined : {}, {
          token,
        });
        expect(res.status, `${method} ${path} with ${token}`).toBe(401);
        expect((await err(res)).code).toBe("bad_token");
      }
    }
    expect(rig.world.seen).toEqual([]);
  });

  it("no token, refresh token, code verifier or client secret reaches a log line, stdout, stderr or a non-secret file; the secret file is private", async () => {
    rig = startMcpRig();
    const { id, done } = await signIn({ start: { clientId: "my-client", clientSecret: "my-client-secret-xyz" } });
    expect(done.status).toBe(200);
    rig.world.revokeAccessTokens();
    await call(id, { tool: "echo", arguments: { text: "x" }, stepId: "s" }); // refresh path
    await call(id, { tool: "nope", arguments: {} });
    await rig.request("GET", `/mcp/connectors/${id}/tools?refresh=1`);

    const secretText = rig.secretFile();
    const kept = [...rig.world.accessTokens, ...rig.world.refreshTokens.keys(), "my-client-secret-xyz"];
    expect(kept.length).toBeGreaterThan(2);
    for (const s of kept) expect(secretText, "the secret file holds what it must").toContain(s);
    const secrets = [
      ...kept,
      rig.world.state.tokenRequests[0]!.code_verifier!,
      rig.world.state.tokenRequests[0]!.code!,
    ]; // the verifier is used up and gone from the file
    const everything = [rig.logs.join("\n"), rig.printed.join(""), ...rig.nonSecretFiles()].join("\n");
    for (const s of secrets) expect(everything).not.toContain(s);
    expect(statSync(rig.paths.secretsFile).mode & 0o777).toBe(0o600);
    expect(statSync(rig.paths.secretDir).mode & 0o777).toBe(0o700);
  });
});

it("provisions an MCP connection idempotently across concurrent requests and restart", async () => {
  rig = startMcpRig();
  const request = { ownerKey: "plugin/notes/endpoint" };
  const responses = await Promise.all([create(request), create(request)]);
  const entries = await Promise.all(responses.map((r) => rig.json(r)));
  expect(entries[0].connector.id).toBe(entries[1].connector.id);
  expect((await rig.json(await rig.request("GET", "/mcp/connectors"))).connectors).toHaveLength(1);
  rig.restart();
  expect((await rig.json(await create(request))).connector.id).toBe(entries[0].connector.id);
  expect(entries[0].connector).not.toHaveProperty("ownerKey");
});
