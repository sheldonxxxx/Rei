// MCP connectors: the registry, OAuth sign-in and tool calls. Only the gateway ever holds a connector's token.
//
// What comes from @modelcontextprotocol/client (2.4.0): Client and StreamableHTTPClientTransport for the protocol (era
// negotiation: it probes `server/discover` and falls back to the `initialize` handshake and session ids of older servers),
// and the OAuth helpers as plain functions: discoverOAuthServerInfo (RFC 9728, RFC 8414 with OIDC fallback), registerClient
// (RFC 7591), startAuthorization (PKCE S256, state, resource), exchangeAuthorization (checks `iss`, RFC 9207) and
// refreshAuthorization. Not the SDK's `auth()` orchestrator and OAuthClientProvider: they assume one process holds the
// code verifier between the redirect and the callback, while here the start and the callback are two HTTP requests that
// may be a restart apart, so the pending state lives in the secret store and the helpers are called step by step.

import type { AuthorizationServerMetadata, AuthProvider } from "@modelcontextprotocol/client";
import {
  Client,
  checkResourceAllowed,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  IssuerMismatchError,
  OAuthError,
  ProtocolError,
  refreshAuthorization,
  registerClient,
  resourceUrlFromServerUrl,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  startAuthorization,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { classifyError, type Logger } from "@rei/logging";
import type {
  ConnectorAuth,
  ConnectorStatus,
  GatewayCallRecord,
  GatewayConnector,
  McpCallResult,
  McpToolInfo,
} from "@rei/protocol";
import { b64u, HttpError } from "../http.ts";
import type { Redactor } from "../redact.ts";
import type { SecretStore } from "../secrets.ts";
import type { CallLog } from "../types.ts";
import { flattenResult, toToolInfo } from "./flatten.ts";
import { checkFetchableUrl, parseRedirectUri, requireFetchableUrl } from "./urls.ts";

const STATE_KEY = "mcp";
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 5;
const REFRESH_SKEW_MS = 60_000;
const DEFAULT_TOOLS_TTL_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 90_000;
const NAME_MAX = 80;
const RESERVED_TOKEN_HEADER =
  /^(?:accept|accept-encoding|connection|content-.*|cookie2?|date|expect|forwarded|host|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|user-agent|via|(?:mcp|proxy|sec|x-forwarded)-.*)$/i;

interface StoredClient {
  clientId: string;
  clientSecret?: string;
  /** Redirect URIs a dynamic registration covers (empty for a client ID the user entered). */
  redirectUris: string[];
}
interface PendingAuth {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}
interface OAuthRecord {
  authServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  resource: string;
  client?: StoredClient;
  tokens?: { accessToken: string; refreshToken?: string; expiresAt: number | null; scope?: string };
  pending: PendingAuth[];
}
interface ConnectorRecord {
  ownerKey?: string;
  id: string;
  name: string;
  url: string;
  auth: ConnectorAuth;
  status: ConnectorStatus;
  error: string | null;
  toolCount: number | null;
  createdAt: number;
  token?: string;
  tokenHeader?: string;
  oauth?: OAuthRecord;
}
interface McpState {
  connectors: Record<string, ConnectorRecord>;
}

/** Raised where a call cannot go on without the user signing in again. */
class NeedsAuthError extends Error {}

export interface ConnectorServiceDeps {
  secrets: SecretStore;
  fetch: typeof fetch;
  now: () => number;
  redactor: Redactor;
  log: Logger;
  calls: CallLog;
  version: string;
  /** Hosts exempt from the https and public-host rules (tests; a local MCP server). */
  devHosts: readonly string[];
  callTimeoutMs?: number;
}

const toPublic = (r: ConnectorRecord): GatewayConnector => ({
  id: r.id,
  name: r.name,
  url: r.url,
  auth: r.auth,
  ...(r.tokenHeader ? { tokenHeader: r.tokenHeader } : {}),
  status: r.status,
  error: r.error,
  toolCount: r.toolCount,
  createdAt: r.createdAt,
});

function secretsOf(r: ConnectorRecord): string[] {
  const out: (string | undefined)[] = [
    r.token,
    r.oauth?.tokens?.accessToken,
    r.oauth?.tokens?.refreshToken,
    r.oauth?.client?.clientSecret,
  ];
  for (const p of r.oauth?.pending ?? []) out.push(p.codeVerifier, p.state);
  return out.filter((s): s is string => !!s);
}

const randomId = (bytes: number) => b64u.encode(crypto.getRandomValues(new Uint8Array(bytes)));

// Stable JSON comparison of the public connector identity and normalized catalog definition.
// This binds advertised metadata only; no gateway can attest a remote server's implementation.
function canonical(value: unknown): string {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, normalize(x)]),
          )
        : v;
  return JSON.stringify(normalize(value));
}
const callIdentity = (rec: ConnectorRecord) => ({
  id: rec.id,
  name: rec.name,
  url: rec.url,
  auth: rec.auth,
  tokenHeader: rec.tokenHeader,
  status: rec.status,
  createdAt: rec.createdAt,
});
type TokenAuthentication = Pick<ConnectorRecord, "auth" | "token" | "tokenHeader">;
const tokenAuthentication = ({ auth, token, tokenHeader }: ConnectorRecord) => ({ auth, token, tokenHeader });
const sameTokenAuthentication = (a: TokenAuthentication, b: TokenAuthentication) =>
  a.auth === b.auth && a.token === b.token && a.tokenHeader === b.tokenHeader;
type ToolCatalog = { tools: McpToolInfo[]; fetchedAt: number };

export function createConnectorService(deps: ConnectorServiceDeps) {
  const { redactor, now } = deps;
  const callTimeout = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const toolCache = new Map<
    string,
    { authentication: TokenAuthentication; tools: McpToolInfo[]; fetchedAt: number; expiresAt: number }
  >();
  const refreshing = new Map<string, Promise<void>>();
  const listing = new Map<string, { connector: ConnectorRecord; result: Promise<ToolCatalog> }>();
  const safe = (text: string) => redactor.redact(text).slice(0, 500);
  /** The provider's structured content, with every string (and key) redacted as the text is: scripts read it directly. */
  const redactValue = (value: unknown): unknown => {
    if (typeof value === "string") return redactor.redact(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactor.redact(k), redactValue(v)]));
    return value;
  };
  const describe = (cause: unknown) => safe(cause instanceof Error ? cause.message : String(cause));

  // ---- storage ------------------------------------------------------------------------------------------------------

  async function load(): Promise<McpState> {
    const state = (await deps.secrets.read<McpState>(STATE_KEY)) ?? { connectors: {} };
    for (const r of Object.values(state.connectors)) redactor.add(...secretsOf(r));
    return state;
  }

  async function get(id: string): Promise<ConnectorRecord> {
    const rec = (await load()).connectors[id];
    if (!rec) throw new HttpError(404, "connector_not_found", "No such connector.");
    return rec;
  }

  /** Read-modify-write one connector; returns the stored record (undefined when it was removed meanwhile). */
  async function update(id: string, fn: (r: ConnectorRecord) => ConnectorRecord): Promise<ConnectorRecord | undefined> {
    let result: ConnectorRecord | undefined;
    await deps.secrets.modify<McpState>(STATE_KEY, (cur) => {
      const state = cur ?? { connectors: {} };
      const rec = state.connectors[id];
      if (!rec) return cur;
      result = fn(rec);
      if (result === rec) return cur;
      redactor.add(...secretsOf(result));
      return { connectors: { ...state.connectors, [id]: result } };
    });
    return result;
  }

  // ---- probing ------------------------------------------------------------------------------------------------------

  /** One bare `initialize` POST: a 401 says the server wants a sign-in (and where to find out how). Throws when unreachable. */
  async function probe(
    url: string,
    token?: string,
    tokenHeader?: string,
  ): Promise<{ unauthorized: boolean; resourceMetadataUrl?: URL; scope?: string }> {
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { [tokenHeader ?? "authorization"]: tokenHeader ? token : `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "rei-gateway", version: deps.version },
          },
        }),
        redirect: tokenHeader ? "error" : "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new HttpError(502, "connector_unreachable", `Could not reach the server: ${describe(cause)}`);
    }
    await res.body?.cancel().catch(() => {});
    if (res.status !== 401) return { unauthorized: false };
    const params = extractWWWAuthenticateParams(res);
    return {
      unauthorized: true,
      ...(params.resourceMetadataUrl ? { resourceMetadataUrl: params.resourceMetadataUrl } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
    };
  }

  // ---- OAuth --------------------------------------------------------------------------------------------------------

  /** Endpoints the server's metadata names are fetched from here too: same rules as the connector URL. */
  function checkEndpoints(authServerUrl: string, metadata: AuthorizationServerMetadata | undefined): void {
    const urls = [
      authServerUrl,
      metadata?.token_endpoint,
      metadata?.registration_endpoint,
      metadata?.authorization_endpoint,
    ];
    for (const u of urls)
      if (u && !checkFetchableUrl(u, deps.devHosts))
        throw new HttpError(
          502,
          "oauth_failed",
          "The authorization server uses an address the gateway will not connect to.",
        );
  }

  function clientInformation(c: StoredClient) {
    return { client_id: c.clientId, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}) };
  }

  async function oauthStart(
    id: string,
    body: { redirectUri?: unknown; clientId?: unknown; clientSecret?: unknown },
  ): Promise<string> {
    const rec = await get(id);
    if (rec.tokenHeader) throw new HttpError(400, "bad_request", "This connector uses a custom token header.");
    const redirectUri = parseRedirectUri(body.redirectUri);
    if (
      body.clientId !== undefined &&
      (typeof body.clientId !== "string" || !body.clientId.trim() || body.clientId.length > 512)
    )
      throw new HttpError(400, "bad_request", "clientId must be a non-empty string.");
    if (body.clientSecret !== undefined && (typeof body.clientSecret !== "string" || body.clientSecret.length > 512))
      throw new HttpError(400, "bad_request", "clientSecret must be a string.");
    const found = await probe(rec.url);
    let info;
    try {
      info = await discoverOAuthServerInfo(rec.url, {
        ...(found.resourceMetadataUrl ? { resourceMetadataUrl: found.resourceMetadataUrl } : {}),
        fetchFn: deps.fetch,
      });
    } catch (cause) {
      throw new HttpError(502, "oauth_failed", `Could not discover the sign-in server: ${describe(cause)}`);
    }
    const metadata = info.authorizationServerMetadata;
    checkEndpoints(info.authorizationServerUrl, metadata);
    if (!metadata && !info.resourceMetadata)
      throw new HttpError(400, "oauth_unsupported", "The server does not advertise OAuth sign-in.");

    // RFC 8707: the resource is what the server calls itself (RFC 9728), when that really is this server.
    let resource = resourceUrlFromServerUrl(rec.url).href;
    const claimed = info.resourceMetadata?.resource;
    if (claimed && checkResourceAllowed({ requestedResource: resource, configuredResource: claimed }))
      resource = claimed;

    // Client: one the user entered, a stored registration for this issuer and redirect URI, or a fresh dynamic one.
    let client: StoredClient | undefined;
    if (typeof body.clientId === "string") {
      client = {
        clientId: body.clientId.trim(),
        ...(typeof body.clientSecret === "string" && body.clientSecret ? { clientSecret: body.clientSecret } : {}),
        redirectUris: [],
      };
    } else if (
      rec.oauth?.client &&
      rec.oauth.authServerUrl === info.authorizationServerUrl &&
      (rec.oauth.client.redirectUris.length === 0 || rec.oauth.client.redirectUris.includes(redirectUri))
    ) {
      client = rec.oauth.client;
    } else if (metadata?.registration_endpoint) {
      try {
        const registered = await registerClient(info.authorizationServerUrl, {
          ...(metadata ? { metadata } : {}),
          clientMetadata: {
            client_name: "Rei",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
          fetchFn: deps.fetch,
        });
        client = {
          clientId: registered.client_id,
          ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
          redirectUris: [redirectUri],
        };
      } catch (cause) {
        throw new HttpError(502, "oauth_failed", `Client registration failed: ${describe(cause)}`);
      }
    } else {
      throw new HttpError(
        400,
        "client_id_required",
        "The server does not allow automatic client registration: send clientId (and clientSecret if it has one) from the server's developer settings.",
      );
    }
    redactor.add(client.clientSecret);

    const state = randomId(32);
    const scope = found.scope ?? info.resourceMetadata?.scopes_supported?.join(" ");
    let started;
    try {
      started = await startAuthorization(info.authorizationServerUrl, {
        ...(metadata ? { metadata } : {}),
        clientInformation: clientInformation(client),
        redirectUrl: redirectUri,
        state,
        resource,
        ...(scope ? { scope } : {}),
      });
    } catch (cause) {
      throw new HttpError(502, "oauth_failed", `Could not build the sign-in URL: ${describe(cause)}`);
    }
    const t = now();
    await update(id, (r) => {
      if (r.tokenHeader) throw new HttpError(409, "connector_changed", "The connector now uses a custom token header.");
      return {
        ...r,
        oauth: {
          authServerUrl: info.authorizationServerUrl,
          ...(metadata ? { metadata } : {}),
          resource,
          client,
          ...(r.oauth && r.oauth.authServerUrl === info.authorizationServerUrl && r.oauth.tokens
            ? { tokens: r.oauth.tokens }
            : {}),
          pending: [
            ...(r.oauth?.pending ?? []).filter((p) => p.expiresAt > t),
            { state, codeVerifier: started.codeVerifier, redirectUri, expiresAt: t + PENDING_TTL_MS },
          ].slice(-MAX_PENDING),
        },
      };
    });
    deps.log.info("mcp.oauth_started", { connectorId: id });
    return started.authorizationUrl.href;
  }

  async function oauthCallback(input: { state: unknown; code: unknown; iss: unknown }): Promise<GatewayConnector> {
    if (typeof input.state !== "string" || !input.state || typeof input.code !== "string" || !input.code)
      throw new HttpError(400, "bad_request", "state and code are required.");
    if (input.iss !== undefined && input.iss !== null && typeof input.iss !== "string")
      throw new HttpError(400, "bad_request", "iss must be a string.");
    const state = await load();
    const t = now();
    const owner = Object.values(state.connectors).find((r) => r.oauth?.pending.some((p) => p.state === input.state));
    if (!owner) throw new HttpError(400, "invalid_state", "Unknown sign-in state: start the sign-in again.");
    const pending = owner.oauth!.pending.find((p) => p.state === input.state)!;
    // Single use, whatever happens next; expired ones are dropped with it.
    await update(owner.id, (r) => {
      if (!r.oauth?.pending.some((p) => p.state === pending.state))
        throw new HttpError(400, "invalid_state", "Unknown sign-in state: start the sign-in again.");
      return {
        ...r,
        oauth: { ...r.oauth!, pending: r.oauth!.pending.filter((p) => p.state !== pending.state && p.expiresAt > t) },
      };
    });
    if (pending.expiresAt <= t) throw new HttpError(400, "state_expired", "The sign-in took too long: start it again.");
    const oauth = owner.oauth!;
    if (!oauth.client) throw new HttpError(400, "invalid_state", "No client registration: start the sign-in again.");
    let tokens;
    try {
      tokens = await exchangeAuthorization(oauth.authServerUrl, {
        ...(oauth.metadata ? { metadata: oauth.metadata } : {}),
        clientInformation: clientInformation(oauth.client),
        authorizationCode: input.code,
        ...(typeof input.iss === "string" ? { iss: input.iss } : {}),
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        resource: oauth.resource,
        fetchFn: deps.fetch,
      });
    } catch (cause) {
      if (cause instanceof IssuerMismatchError)
        throw new HttpError(
          400,
          "iss_mismatch",
          "The sign-in response came from a different authorization server than expected.",
        );
      throw new HttpError(502, "oauth_failed", `Token exchange failed: ${describe(cause)}`);
    }
    const saved = await update(owner.id, (r) => {
      if (!r.oauth || r.tokenHeader)
        throw new HttpError(409, "connector_changed", "Authentication changed during sign-in. Start again.");
      return {
        ...r,
        auth: "oauth",
        status: "connected",
        error: null,
        oauth: {
          ...r.oauth!,
          tokens: {
            accessToken: tokens.access_token,
            ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
            expiresAt: tokens.expires_in ? t + tokens.expires_in * 1000 : null,
            ...(tokens.scope ? { scope: tokens.scope } : {}),
          },
        },
      };
    });
    if (!saved) throw new HttpError(404, "connector_not_found", "The connector was removed.");
    toolCache.delete(owner.id);
    deps.log.info("mcp.oauth_finished", { connectorId: owner.id });
    // Learn the tool count now; a failure here is not the sign-in's.
    await tools(owner.id, true).catch(() => {});
    return toPublic(await get(owner.id));
  }

  /** Refreshes the access token (single flight per connector). Without `force` it does nothing while the token is valid. */
  function refresh(id: string, force: boolean): Promise<void> {
    const running = refreshing.get(id);
    if (running) return running;
    const run = (async () => {
      const rec = await get(id);
      const o = rec.oauth;
      if (rec.auth !== "oauth" || !o?.tokens) throw new NeedsAuthError("not signed in");
      const stillCurrent = (r: ConnectorRecord) =>
        r.auth === "oauth" && r.oauth?.tokens?.accessToken === o.tokens?.accessToken;
      const expire = () =>
        update(id, (r) =>
          stillCurrent(r) ? { ...r, status: "needs_auth", error: "The sign-in expired: sign in again." } : r,
        );
      if (!force && (o.tokens.expiresAt === null || o.tokens.expiresAt - REFRESH_SKEW_MS > now())) return;
      if (!o.tokens.refreshToken || !o.client) {
        await expire();
        throw new NeedsAuthError("no refresh token");
      }
      try {
        const next = await refreshAuthorization(o.authServerUrl, {
          ...(o.metadata ? { metadata: o.metadata } : {}),
          clientInformation: clientInformation(o.client),
          refreshToken: o.tokens.refreshToken,
          resource: o.resource,
          fetchFn: deps.fetch,
        });
        const t = now();
        await update(id, (r) =>
          stillCurrent(r)
            ? {
                ...r,
                oauth: {
                  ...r.oauth!,
                  tokens: {
                    accessToken: next.access_token,
                    refreshToken: next.refresh_token ?? o.tokens!.refreshToken!,
                    expiresAt: next.expires_in ? t + next.expires_in * 1000 : null,
                    ...((next.scope ?? o.tokens!.scope) ? { scope: (next.scope ?? o.tokens!.scope)! } : {}),
                  },
                },
              }
            : r,
        );
        deps.log.debug("mcp.oauth_refreshed", { connectorId: id });
      } catch (cause) {
        // The server refused the refresh token (invalid_grant and kin): only a new sign-in helps. Anything else may pass.
        if (cause instanceof OAuthError || cause instanceof IssuerMismatchError) {
          await expire();
          deps.log.info("mcp.oauth_refresh_refused", { connectorId: id });
          throw new NeedsAuthError(describe(cause));
        }
        throw new HttpError(502, "connector_unreachable", `Could not refresh the sign-in: ${describe(cause)}`);
      }
    })().finally(() => void refreshing.delete(id));
    refreshing.set(id, run);
    return run;
  }

  // ---- talking MCP --------------------------------------------------------------------------------------------------

  async function currentOAuthToken(id: string): Promise<string | undefined> {
    let rec = await get(id);
    if (rec.auth !== "oauth" || !rec.oauth?.tokens) throw new NeedsAuthError("not signed in");
    await refresh(id, false);
    rec = await get(id);
    if (rec.auth !== "oauth" || !rec.oauth?.tokens) throw new NeedsAuthError("not signed in");
    return rec.oauth.tokens.accessToken;
  }

  async function withClient<T>(rec: ConnectorRecord, fn: (client: Client) => Promise<T>): Promise<T> {
    const id = rec.id;
    let needsAuth = false;
    const authProvider: AuthProvider | undefined =
      rec.auth === "none" || rec.tokenHeader
        ? undefined
        : {
            token: () =>
              (rec.auth === "token" ? Promise.resolve(rec.token) : currentOAuthToken(id)).catch((cause) => {
                if (cause instanceof NeedsAuthError) needsAuth = true;
                throw cause;
              }),
            ...(rec.auth === "oauth"
              ? {
                  onUnauthorized: () =>
                    refresh(id, true).catch((cause) => {
                      if (cause instanceof NeedsAuthError) needsAuth = true;
                      throw cause;
                    }),
                }
              : {}),
          };
    const client = new Client({ name: "rei-gateway", version: deps.version }, { versionNegotiation: { mode: "auto" } });
    const url = new URL(rec.url);
    const { token, tokenHeader } = rec;
    const fetchMcp: typeof fetch =
      token && tokenHeader
        ? (input, init) => {
            const target = new URL(input instanceof Request ? input.url : input);
            if (target.origin !== url.origin) throw new Error("The MCP request moved to another origin.");
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            headers.set(tokenHeader, token);
            // Fetch only strips standard credentials on cross-origin redirects.
            return deps.fetch(input, { ...init, headers, redirect: "error" });
          }
        : deps.fetch;
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: fetchMcp,
      ...(authProvider ? { authProvider } : {}),
    });
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      return await fn(client);
    } catch (cause) {
      throw await translate(rec, cause, needsAuth);
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** What went wrong with an MCP request, as an HttpError; records `needs_auth` on the connector when that is it. */
  async function translate(rec: ConnectorRecord, cause: unknown, needsAuth: boolean): Promise<HttpError> {
    if (cause instanceof HttpError) return cause;
    const unauthorized =
      needsAuth ||
      cause instanceof NeedsAuthError ||
      cause instanceof UnauthorizedError ||
      (cause instanceof SdkHttpError && (cause.code === SdkErrorCode.ClientHttpAuthentication || cause.status === 401));
    if (unauthorized) {
      const message =
        rec.auth === "token"
          ? "The server rejected the token: set a new one."
          : "The sign-in is no longer valid: sign in again.";
      // A server that used to need no sign-in and now does is an OAuth server from here on.
      await update(rec.id, (r) =>
        sameTokenAuthentication(r, rec)
          ? {
              ...r,
              ...(r.auth === "none" ? { auth: "oauth" as const } : {}),
              status: "needs_auth",
              error: message,
            }
          : r,
      );
      return new HttpError(409, "needs_auth", message);
    }
    return new HttpError(502, "mcp_error", `The MCP server failed the request: ${describe(cause)}`, { cause });
  }

  /** Lists the tools (fresh from the server) and keeps them for the cache. */
  async function fetchTools(rec: ConnectorRecord): Promise<ToolCatalog> {
    const listed = await withClient(rec, async (client) => {
      const result = await client.listTools(undefined, { cacheMode: "bypass", timeout: CONNECT_TIMEOUT_MS });
      const ttl = (result as { ttlMs?: unknown }).ttlMs;
      return { tools: result.tools, ttlMs: typeof ttl === "number" && ttl > 0 ? ttl : DEFAULT_TOOLS_TTL_MS };
    });
    const tools = listed.tools.map(toToolInfo);
    const fetchedAt = now();
    await update(rec.id, (r) => {
      if (listing.get(rec.id)?.connector !== rec || !sameTokenAuthentication(r, rec)) return r;
      if (rec.status !== "needs_auth" && r.status === "needs_auth") return r;
      toolCache.set(rec.id, {
        authentication: tokenAuthentication(rec),
        tools,
        fetchedAt,
        expiresAt: fetchedAt + listed.ttlMs,
      });
      if (r.status === "connected" && r.toolCount === tools.length) return r;
      return {
        ...r,
        toolCount: tools.length,
        ...(r.status === "error" ? { status: "connected" as const, error: null } : {}),
      };
    });
    return { tools, fetchedAt };
  }

  async function tools(id: string, refreshCache: boolean): Promise<ToolCatalog> {
    const rec = await get(id);
    if (rec.auth === "oauth" && (!rec.oauth?.tokens || rec.status === "needs_auth"))
      throw new HttpError(409, "needs_auth", rec.error ?? "Sign in to this connector first.");
    const hit = toolCache.get(id);
    if (
      !refreshCache &&
      rec.status === "connected" &&
      hit &&
      hit.expiresAt > now() &&
      sameTokenAuthentication(hit.authentication, rec)
    )
      return { tools: hit.tools, fetchedAt: hit.fetchedAt };
    return listFreshTools(rec);
  }

  function listFreshTools(rec: ConnectorRecord): Promise<ToolCatalog> {
    const { id } = rec;
    const current = listing.get(id);
    if (
      current &&
      sameTokenAuthentication(current.connector, rec) &&
      current.connector.oauth?.tokens?.accessToken === rec.oauth?.tokens?.accessToken
    )
      return current.result;
    const result = fetchTools(rec)
      .catch(async (cause: unknown) => {
        if (cause instanceof HttpError && cause.code !== "needs_auth")
          await update(id, (r) =>
            listing.get(id)?.connector === rec &&
            sameTokenAuthentication(r, rec) &&
            r.status === rec.status &&
            r.status !== "needs_auth" &&
            (r.status !== "error" || r.error !== cause.message)
              ? { ...r, status: "error", error: cause.message }
              : r,
          );
        throw cause;
      })
      .finally(() => {
        if (listing.get(id)?.result === result) listing.delete(id);
      });
    listing.set(id, { connector: rec, result });
    return result;
  }

  async function recover(): Promise<void> {
    const { connectors } = await load();
    await Promise.all(
      Object.values(connectors)
        .filter((rec) => rec.status === "error" && !listing.has(rec.id) && (rec.auth !== "oauth" || rec.oauth?.tokens))
        .map((rec) =>
          listFreshTools(rec).catch((cause: unknown) => {
            if (!(cause instanceof HttpError)) deps.log.error("mcp.recovery_failed", classifyError(cause));
          }),
        ),
    );
  }

  async function call(
    id: string,
    input: { tool: unknown; arguments?: unknown; stepId?: unknown; expected: unknown },
  ): Promise<McpCallResult> {
    if (typeof input.tool !== "string" || !input.tool || input.tool.length > 256)
      throw new HttpError(400, "bad_request", "tool must be a tool name.");
    const args = input.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args))
      throw new HttpError(400, "bad_request", "arguments must be an object.");
    const stepId =
      typeof input.stepId === "string" ? input.stepId.replace(/[^\x21-\x7e]/g, "_").slice(0, 128) || null : null;
    const rec = await get(id);
    if (rec.auth === "oauth" && (!rec.oauth?.tokens || rec.status === "needs_auth"))
      throw new HttpError(409, "needs_auth", rec.error ?? "Sign in to this connector first.");
    const startedAt = now();
    const t0 = performance.now();
    let record: Pick<GatewayCallRecord, "status" | "error"> = { status: 200, error: null };
    try {
      const raw = await withClient(rec, async (client) => {
        // Bound app-server calls bypass every catalog cache, on the same connection used for tools/call.
        {
          const expected = input.expected as { connector?: unknown; tool?: unknown } | null;
          const result = await client.listTools(undefined, { cacheMode: "bypass", timeout: CONNECT_TIMEOUT_MS });
          const matches = result.tools.map(toToolInfo).filter((t) => t.name === input.tool);
          const current = await get(id);
          if (
            !expected ||
            canonical(expected.connector) !== canonical(callIdentity(rec)) ||
            canonical(callIdentity(current)) !== canonical(callIdentity(rec)) ||
            current.token !== rec.token ||
            matches.length !== 1 ||
            canonical(expected.tool) !== canonical(matches[0])
          ) {
            throw new HttpError(
              409,
              "tool_changed",
              "The connector or tool definition changed after authorization. Nothing was executed; inspect and approve it again.",
            );
          }
        }
        return client.callTool(
          { name: input.tool as string, arguments: args as Record<string, unknown> },
          { timeout: callTimeout },
        );
      });
      const result = flattenResult(raw);
      if (result.isError) record = { status: 200, error: { code: "tool_error" } };
      return { ...result, text: redactor.redact(result.text), structured: redactValue(result.structured) };
    } catch (cause) {
      // A JSON-RPC error (unknown tool, bad arguments) is something the model can read and react to.
      if (cause instanceof HttpError && cause.code === "mcp_error" && cause.cause instanceof ProtocolError) {
        record = { status: 200, error: { code: "tool_error" } };
        return { isError: true, text: safe(cause.cause.message), structured: null, truncated: false };
      }
      if (cause instanceof HttpError) record = { status: cause.status, error: { code: cause.code } };
      throw cause;
    } finally {
      const totalMs = Math.round(performance.now() - t0);
      try {
        deps.calls.insert({
          // Connectors are Rei's alone (admin scope), so the caller is always Rei.
          caller: "rei",
          provider: "mcp",
          stepId,
          model: `mcp:${id}/${input.tool.slice(0, 64)}`,
          startedAt,
          firstByteMs: null,
          totalMs,
          usage: null,
          limit: null,
          ...record,
        });
      } catch (cause) {
        deps.log.error("calllog.write_failed", classifyError(cause));
      }
      // Not the tool arguments.
      deps.log[record.error ? "info" : "debug"]("mcp.call", {
        stepId,
        connectorId: id,
        status: record.status,
        totalMs,
        errorCode: record.error?.code,
      });
    }
  }

  // ---- registry -----------------------------------------------------------------------------------------------------

  function cleanName(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim() || raw.trim().length > NAME_MAX)
      throw new HttpError(400, "bad_request", `name must be 1 to ${NAME_MAX} characters.`);
    return raw.trim();
  }
  function cleanToken(raw: unknown): string {
    if (typeof raw !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(raw.trim()))
      throw new HttpError(400, "bad_request", "token must be printable ASCII without spaces (up to 4096 characters).");
    return raw.trim();
  }

  function cleanTokenHeader(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string" || !/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/i.test(raw) || RESERVED_TOKEN_HEADER.test(raw))
      throw new HttpError(400, "bad_request", "Choose a valid HTTP header name for the token.");
    return raw.toLowerCase() === "authorization" ? undefined : raw;
  }

  async function create(input: {
    name: unknown;
    url: unknown;
    token?: unknown;
    tokenHeader?: unknown;
    ownerKey?: unknown;
    auth?: unknown;
  }): Promise<GatewayConnector> {
    const name = cleanName(input.name);
    if (typeof input.url !== "string") throw new HttpError(400, "bad_request", "url is required.");
    const url = requireFetchableUrl(input.url.trim(), deps.devHosts, "The server URL").href;
    const token =
      input.token === undefined || input.token === null || input.token === "" ? undefined : cleanToken(input.token);
    const tokenHeader = cleanTokenHeader(input.tokenHeader);
    if (tokenHeader && !token) throw new HttpError(400, "bad_request", "A custom token header needs a token.");
    redactor.add(token);
    const ownerKey = input.ownerKey;
    if (ownerKey !== undefined && (typeof ownerKey !== "string" || !ownerKey || ownerKey.length > 4096))
      throw new HttpError(400, "bad_request", "Invalid connector owner key.");
    if (typeof ownerKey === "string") {
      const saved = await deps.secrets.read<McpState>(STATE_KEY);
      const prior = Object.values(saved?.connectors ?? {}).find((r) => r.ownerKey === ownerKey);
      if (prior) {
        if (prior.url !== url)
          throw new HttpError(409, "connector_changed", "Connector owner key belongs to another URL.");
        return toPublic(prior);
      }
    }
    const found = await probe(url, token, tokenHeader);
    const auth: ConnectorAuth =
      token || input.auth === "token" ? "token" : found.unauthorized || input.auth === "oauth" ? "oauth" : "none";
    const rec: ConnectorRecord = {
      ...(typeof ownerKey === "string" ? { ownerKey } : {}),
      id: `con_${randomId(12)}`,
      name,
      url,
      auth,
      status: found.unauthorized ? "needs_auth" : "connected",
      error: found.unauthorized
        ? token
          ? "The server rejected the token: set a new one."
          : "Sign in to use this connector."
        : null,
      toolCount: null,
      createdAt: now(),
      ...(token ? { token } : {}),
      ...(tokenHeader ? { tokenHeader } : {}),
    };
    let actualId = rec.id;
    await deps.secrets.modify<McpState>(STATE_KEY, (cur) => {
      const prior = ownerKey && Object.values(cur?.connectors ?? {}).find((r) => r.ownerKey === ownerKey);
      if (prior) {
        actualId = prior.id;
        return cur!;
      }
      return { connectors: { ...(cur?.connectors ?? {}), [rec.id]: rec } };
    });
    if (actualId !== rec.id) return toPublic(await get(actualId));
    deps.log.info("mcp.connector_added", { connectorId: rec.id, auth, status: rec.status });
    if (!found.unauthorized) await tools(rec.id, true).catch(() => {}); // the status and error are kept on the record
    return toPublic(await get(rec.id));
  }

  async function patch(
    id: string,
    input: { name?: unknown; token?: unknown; tokenHeader?: unknown },
  ): Promise<GatewayConnector> {
    const rec = await get(id);
    const name = input.name === undefined ? undefined : cleanName(input.name);
    if (input.token === undefined && input.tokenHeader === undefined) {
      if (name !== undefined) await update(id, (r) => ({ ...r, name }));
      return toPublic(await get(id));
    }
    const token = input.token === undefined ? rec.token : input.token === null ? undefined : cleanToken(input.token);
    const tokenHeader =
      input.tokenHeader === undefined ? (token ? rec.tokenHeader : undefined) : cleanTokenHeader(input.tokenHeader);
    if (tokenHeader && !token) throw new HttpError(400, "bad_request", "A custom token header needs a token.");
    redactor.add(token);
    const found = await probe(rec.url, token, tokenHeader);
    toolCache.delete(id);
    await update(id, (r) => {
      if (!sameTokenAuthentication(r, rec))
        throw new HttpError(409, "connector_changed", "Authentication changed while saving. Reload and try again.");
      const { token: _old, tokenHeader: _oldHeader, oauth, ...rest } = r;
      const auth: ConnectorAuth = token ? "token" : found.unauthorized ? "oauth" : "none";
      // Dropping a token keeps an OAuth registration and sign-in the connector already had.
      return {
        ...rest,
        ...(name !== undefined ? { name } : {}),
        auth,
        status: found.unauthorized ? "needs_auth" : "connected",
        error: found.unauthorized
          ? token
            ? "The server rejected the token: set a new one."
            : "Sign in to use this connector."
          : null,
        toolCount: null,
        ...(token ? { token } : {}),
        ...(tokenHeader ? { tokenHeader } : {}),
        ...(!token && oauth ? { oauth } : {}),
      };
    });
    if (!found.unauthorized) await tools(id, true).catch(() => {});
    return toPublic(await get(id));
  }

  async function remove(id: string): Promise<void> {
    await get(id);
    await deps.secrets.modify<McpState>(STATE_KEY, (cur) => {
      const { [id]: _gone, ...rest } = cur?.connectors ?? {};
      return { connectors: rest };
    });
    toolCache.delete(id);
    deps.log.info("mcp.connector_removed", { connectorId: id });
  }

  return {
    list: async () =>
      Object.values((await load()).connectors)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(toPublic),
    create,
    patch,
    remove,
    oauthStart,
    oauthCallback,
    recover,
    tools,
    call,
  };
}

export type ConnectorService = ReturnType<typeof createConnectorService>;
