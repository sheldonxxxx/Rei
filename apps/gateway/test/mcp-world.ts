// A fake internet for the MCP connector tests, as an injectable fetch: an MCP server (the older JSON-RPC-over-POST
// flavour: `initialize` handshake, no `server/discover`), its protected resource metadata, and an authorization server
// (metadata, dynamic client registration, authorize is only a URL here, token endpoint with PKCE check and refresh rotation).
import { createHash, randomBytes } from "node:crypto";

export const MCP_URL = "https://mcp.example.com/mcp";
export const AUTH_URL = "https://auth.example.com";
export const PRM_URL = "https://mcp.example.com/.well-known/oauth-protected-resource";

export interface WorldOptions {
  /** The MCP server wants OAuth or a fixed token, optionally under a custom header. */
  require?: { oauth: true } | { token: string; header?: string } | null;
  /** The authorization server has no registration endpoint. */
  noRegistration?: boolean;
  /** Seconds the access tokens live. */
  expiresIn?: number;
  /** Put `ttlMs` into the tools/list reply. */
  ttlMs?: number;
  /** The metadata and the callback's `iss`. */
  issuer?: string;
  /** The authorization server rotates refresh tokens (default true). */
  rotate?: boolean;
  /** Behave like a 2025 server with sessions: every request after `initialize` must carry the Mcp-Session-Id it issued. */
  sessions?: boolean;
  /** Override the token endpoint the metadata advertises. */
  tokenEndpoint?: string;
}

export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const b64u = (buf: Buffer) => buf.toString("base64url");

export function createWorld(options: WorldOptions = {}) {
  const seen: Seen[] = [];
  const issuer = options.issuer ?? AUTH_URL;
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, string>(); // refresh token -> client id
  const codes = new Map<string, { challenge: string; redirectUri: string; resource: string | null }>();
  const registrations: unknown[] = [];
  const state = {
    require: options.require === undefined ? { oauth: true as const } : options.require,
    refuseRefresh: false,
    redirectMcp: false,
    toolsListCalls: 0,
    toolCalls: [] as { name: string; arguments: unknown }[],
    tokenRequests: [] as Record<string, string>[],
    sessionCounter: 0,
    expiresIn: options.expiresIn ?? 3600,
    tools: [
      {
        name: "echo",
        description: "Echo the text back.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        annotations: { readOnlyHint: true, title: "Echo" },
      },
      {
        name: "write",
        title: "Write",
        description: "Write something.",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: true },
      },
      { name: "big", description: "A very long answer.", inputSchema: { type: "object" } },
      { name: "mixed", description: "Several kinds of content.", inputSchema: { type: "object" } },
      { name: "boom", description: "Always fails.", inputSchema: { type: "object" } },
    ] as Record<string, unknown>[],
    bigText: "x".repeat(150 * 1024),
  };

  function issue(clientId: string) {
    const access = `at-${randomBytes(12).toString("hex")}`;
    accessTokens.add(access);
    const out: Record<string, unknown> = { access_token: access, token_type: "Bearer", expires_in: state.expiresIn };
    if (options.rotate !== false || !refreshTokens.size) {
      const refresh = `rt-${randomBytes(12).toString("hex")}`;
      refreshTokens.set(refresh, clientId);
      out.refresh_token = refresh;
    }
    return out;
  }

  function mcp(req: Request, body: any): Response {
    const auth = req.headers.get("authorization") ?? "";
    const need = state.require;
    if (need) {
      const ok =
        "token" in need
          ? need.header
            ? req.headers.get(need.header) === need.token && !auth
            : auth === `Bearer ${need.token}`
          : auth.startsWith("Bearer ") && accessTokens.has(auth.slice(7));
      if (!ok)
        return new Response("unauthorized", {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${PRM_URL}", scope="mcp.read"` },
        });
    }
    if (options.sessions && body.method !== "initialize" && req.headers.get("mcp-session-id") !== "sess-1")
      return json(
        { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32600, message: "Bad Request: missing session" } },
        400,
      );
    const reply = (result: unknown) =>
      json({ jsonrpc: "2.0", id: body.id, result }, 200, { "mcp-session-id": "sess-1" });
    switch (body.method) {
      case "initialize":
        return reply({
          protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1.0.0" },
        });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        state.toolsListCalls++;
        return reply({ tools: state.tools, ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}) });
      case "tools/call": {
        const { name, arguments: args } = body.params;
        state.toolCalls.push({ name, arguments: args });
        if (name === "echo")
          return reply({
            content: [{ type: "text", text: `echo: ${args?.text ?? ""}` }],
            ...(args?.structured !== undefined ? { structuredContent: args.structured } : {}),
          });
        if (name === "big") return reply({ content: [{ type: "text", text: state.bigText }] });
        if (name === "boom") return reply({ isError: true, content: [{ type: "text", text: "it broke" }] });
        if (name === "mixed")
          return reply({
            content: [
              { type: "text", text: "first" },
              { type: "image", data: "AAAA", mimeType: "image/png" },
              { type: "audio", data: "AAAA", mimeType: "audio/wav" },
              { type: "resource", resource: { uri: "file:///a.txt", text: "secret body" } },
              { type: "text", text: "last" },
            ],
            structuredContent: { answer: 42 },
          });
        return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      }
      default:
        return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    }
  }

  async function worldFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    let body: any = text;
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("json")) body = text ? JSON.parse(text) : undefined;
    else if (type.includes("x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(text));
    seen.push({ method: req.method, url: req.url, headers: Object.fromEntries(req.headers), body });

    if (url.origin === "https://mcp.example.com") {
      if (url.pathname === "/mcp") {
        if (state.redirectMcp) {
          if (req.redirect === "error") throw new TypeError("Redirect blocked");
          if (req.redirect === "follow") return worldFetch("https://other.example.com/mcp", init);
          return Response.redirect("https://other.example.com/mcp", 307);
        }
        if (req.method === "POST") return mcp(req, body);
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        return new Response("method not allowed", { status: 405 });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource")
        return json({
          resource: MCP_URL,
          authorization_servers: [AUTH_URL],
          scopes_supported: ["mcp.read", "mcp.write"],
        });
      return new Response("not found", { status: 404 });
    }
    if (url.origin === AUTH_URL) {
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json({
          issuer,
          authorization_endpoint: `${AUTH_URL}/authorize`,
          token_endpoint: options.tokenEndpoint ?? `${AUTH_URL}/token`,
          ...(options.noRegistration ? {} : { registration_endpoint: `${AUTH_URL}/register` }),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
          authorization_response_iss_parameter_supported: true,
        });
      if (url.pathname === "/register") {
        registrations.push(body);
        return json({ ...body, client_id: "client-1" }, 201);
      }
      if (url.pathname === "/token") {
        state.tokenRequests.push(body);
        if (body.grant_type === "authorization_code") {
          const code = codes.get(body.code);
          const challenge = createHash("sha256").update(String(body.code_verifier)).digest("base64url");
          if (!code || code.challenge !== challenge || code.redirectUri !== body.redirect_uri)
            return json({ error: "invalid_grant", error_description: "bad code" }, 400);
          codes.delete(body.code);
          return json(issue(body.client_id));
        }
        if (body.grant_type === "refresh_token") {
          if (state.refuseRefresh || !refreshTokens.has(body.refresh_token))
            return json({ error: "invalid_grant", error_description: "refresh token revoked" }, 400);
          const client = refreshTokens.get(body.refresh_token)!;
          if (options.rotate !== false) refreshTokens.delete(body.refresh_token);
          return json(issue(client));
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
    }
    return new Response("not found", { status: 404 });
  }

  return {
    fetch: worldFetch as typeof fetch,
    seen,
    state,
    registrations,
    issuer,
    /** The code the "user's browser" would bring back after approving: bound to the authorization URL's challenge. */
    approve(authorizationUrl: string) {
      const u = new URL(authorizationUrl);
      const code = `code-${randomBytes(8).toString("hex")}`;
      codes.set(code, {
        challenge: u.searchParams.get("code_challenge")!,
        redirectUri: u.searchParams.get("redirect_uri")!,
        resource: u.searchParams.get("resource"),
      });
      return { code, state: u.searchParams.get("state")!, url: u };
    },
    /** Invalidate every access token (the server restarted, or revoked them). */
    revokeAccessTokens: () => accessTokens.clear(),
    accessTokens,
    refreshTokens,
    b64u,
  };
}
export type World = ReturnType<typeof createWorld>;
