// Contract between a caller and the policy gateway (D30, docs/adr/0018). The gateway is the only holder of provider
// credentials. It serves several callers: the control plane is the caller `rei`, and other services can be given
// their own caller token (docs/gateway-callers.md). A caller token is a credential: it is what authorizes a call, not
// the network the call arrives on.
//
// LLM proxy: `${GATEWAY_URL}/v1/...` mirrors the upstream OpenAI API path for path (pi-ai's openai provider calls
// https://api.openai.com/v1 for both API keys and a ChatGPT sign-in). The control plane keeps the model's catalogue base URL
// and redirects requests with pi-ai's `fetch` option (changing baseUrl breaks ChatGPT sign-in). Requests carry:
//   Authorization: Bearer <caller token> replaced by the real token; an unknown token gets 401 "bad_token", a token
//                                        without the route's scope 403 "route_not_allowed"
//   x-rei-step-id: <step id>          links the gateway's call record to the trace step
//   x-rei-upstream: <original URL>    the URL pi-ai meant to call; the gateway only forwards to allowlisted hosts.
//                                     Optional: without it the gateway derives the URL from the provider and the path
//   x-rei-provider-id: <provider id>  which connected provider to use (default openai)
// The response body is passed through unchanged (SSE included). Gateway errors are JSON `{ error: ErrorInfo }`.
export const STEP_ID_HEADER = "x-rei-step-id";
export const UPSTREAM_HEADER = "x-rei-upstream";
export const PROVIDER_HEADER = "x-rei-provider-id";

/** GET /status (open, on the internal listener only; never returns a token or account secret). */
export interface GatewayStatus {
  /** True when a ChatGPT credential is stored. */
  signedIn: boolean;
  /** Seconds until the access token expires; refresh happens automatically before that. */
  accessExpiresInS: number | null;
  /** Model providers with a usable connection: a custom OpenAI-compatible endpoint, or a saved key or sign-in. Never a key. Omitted by older gateways. */
  providers?: { id: string; name: string; kind: ProviderConnection["kind"] }[];
  /** Models this login can use, as found by a probe (the models endpoint is empty for ChatGPT tokens). */
  models: string[];
  version: string;
  /** Web search (POST /search), for the onboarding CLI. Never a key; `configured` is whether the provider could answer now. */
  search: {
    /** In the order the gateway tries them. */
    providers: {
      id: "brave" | "tavily" | "searxng" | "exa" | "codex-subscription";
      configured: boolean;
      limitedUntil: number | null;
    }[];
    /** The SearXNG base URL in use (bundled or external; it never holds credentials), or null when SearXNG is off. */
    searxngUrl: string | null;
  };
}

/** The non-secret web-search setup state exposed to the signed-in control plane. */
export type GatewaySearchStatus = GatewayStatus["search"];

/** Search readiness safe to show in the signed-in Rei interface. */
export interface WebSearchSetupStatus {
  providers: Pick<GatewaySearchStatus["providers"][number], "id" | "configured">[];
}

/**
 * Context and output limits for one model, as the provider reported them in its model list. Absent means the provider
 * did not say; the user can still enter a value in Settings → Models.
 */
export interface ModelLimits {
  contextWindow?: number;
  maxTokens?: number;
}

/** Provider credentials never leave the gateway; this is the redacted summary exposed to Settings. */
export interface ProviderConnection {
  id: string;
  name: string;
  kind: "openai" | "openai-compatible";
  auth: "oauth" | "api_key";
  connected: boolean;
  baseUrl?: string;
  /** Which OpenAI wire API a custom endpoint speaks. Omitted means Chat Completions. */
  api?: CustomEndpointApi;
  models: string[];
  /** Limits the provider reported per model id (detected by the last scan). */
  modelInfo?: Record<string, ModelLimits>;
  /** Set on a save response: model IDs that were dropped while in use, and the ID that now stands in for each. */
  replacedModels?: { from: string; to: string }[];
}

/** The OpenAI-compatible API a custom endpoint is called with. */
export type CustomEndpointApi = "chat" | "responses";

export interface ProviderConnectionsResponse {
  connections: ProviderConnection[];
}
export interface ScanProviderModelsRequest {
  id?: string;
  baseUrl: string;
  apiKey?: string;
}
export interface ScanProviderModelsResponse {
  models: string[];
  /** Limits the endpoint reported, keyed by model id. Only models that reported a limit appear. */
  modelInfo?: Record<string, ModelLimits>;
}

export interface SaveProviderConnectionRequest {
  id?: string;
  name: string;
  kind: "openai" | "openai-compatible";
  auth?: "oauth" | "api_key";
  apiKey?: string;
  baseUrl?: string;
  /** Only used for custom endpoints; omitted or "chat" means Chat Completions. */
  api?: CustomEndpointApi;
  models?: string[];
  /** The limits from the last scan. Omitted: the stored limits are kept for models that are still listed. */
  modelInfo?: Record<string, ModelLimits>;
}

/**
 * One record per proxied call, kept in the gateway's own store. GET /calls?stepId=... (admin scope) returns a bare
 * JSON array of the requesting caller's records, oldest first; without stepId it returns the newest (?limit=, default
 * 100; ?caller= filters).
 */
export interface GatewayCallRecord {
  /** The caller that made the call. Records written before callers existed read back as `rei`. */
  caller: string;
  /** What the call counted against: a model provider id, `search`, `embedding` or `mcp`. Null on older records. */
  provider: string | null;
  stepId: string | null;
  model: string | null;
  startedAt: number;
  firstByteMs: number | null;
  totalMs: number | null;
  status: number;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
  /**
   * Rate-limit or usage-limit details the upstream reported, if any (pi-ai never surfaces response headers). Only
   * allowlisted limit headers with short values are kept; the response body never is (ADR 0003).
   */
  limit: { resetsInSeconds: number | null; code: GatewayLimitCode; headers: Record<string, string> } | null;
  /** What failed, as a code only: messages are not stored (ADR 0003). */
  error: { code: string } | null;
}

/** Which kind of limit the upstream reported. */
export type GatewayLimitCode = "usage_limit" | "rate_limit";

// ---- Callers (admin scope; docs/gateway-callers.md) ---------------------------------------------------------------

export const GATEWAY_CALLER_SCOPES = ["models", "search", "embeddings", "read", "read-local", "admin"] as const;
export type GatewayCallerScope = (typeof GATEWAY_CALLER_SCOPES)[number];

/** A caller's budget: how many calls it may have in flight at once. A cap is a whole number, or null for no cap. */
export interface CallerBudget {
  /** Model calls per provider id. 0 means the caller may not use that provider. */
  providers: Record<string, number | null>;
  /** Model calls to a provider that `providers` does not list. */
  defaultProvider: number | null;
  /** POST /search. */
  search: number | null;
  /** /embedding/*. */
  embeddings: number | null;
  /** POST /read. */
  reads: number | null;
}

/** GET /callers → `{ callers }`. Never a token or a hash. */
export interface GatewayCaller {
  id: string;
  /** A label for people; never logged. */
  note: string;
  scopes: GatewayCallerScope[];
  budget: CallerBudget;
  /** `environment`: Rei's own caller, whose token is REI_STANDIN. `store`: created through POST /callers. */
  source: "environment" | "store";
  /** The first 12 hex characters of each working token's SHA-256. Empty for `rei` and for a revoked caller. */
  fingerprints: string[];
  createdAt: number | null;
  rotatedAt: number | null;
  revokedAt: number | null;
  /** When the token from before the last rotation stops working; null when there is none. */
  graceUntil: number | null;
  /** Start of the caller's newest call record; null when it has none. */
  lastUsedAt: number | null;
}
/** POST /callers. `budget` may hold any subset of the fields. */
export interface GatewayCallerCreate {
  id: string;
  note?: string;
  scopes?: Exclude<GatewayCallerScope, "admin">[];
  budget?: Partial<CallerBudget>;
}
/** POST /callers (201) and POST /callers/:id/rotate (`{ graceSeconds? }`). The only responses that carry a token. */
export interface GatewayCallerCreated {
  caller: GatewayCaller;
  token: string;
}
/** GET /calls/summary?since=<ms> (default: the last 24 hours). */
export interface GatewayCallsSummary {
  since: number;
  rows: {
    caller: string;
    provider: string | null;
    calls: number;
    ok: number;
    /** Calls the upstream answered with a rate or usage limit. */
    upstreamLimited: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  }[];
  /** Calls the gateway refused because of a budget. Counted in memory since `refusalsSince`; never call records. */
  refusals: { caller: string; code: string; count: number }[];
  refusalsSince: number;
}

/** Aggregated model usage counters from the gateway's permanent daily rollups. */
export interface GatewayModelUsage {
  /** Sums over calls with token reports. Null if calls exist but none reported tokens; zero for an empty bucket. */
  inputTotal: number | null;
  inputCached: number | null;
  inputUncached: number | null;
  outputTotal: number | null;
  totalProcessed: number | null;
  /** Cached share of input over calls with token reports; null when inputTotal is null or 0. */
  cacheHitPercent: number | null;
  calls: number;
  callsReported: number;
  callsUnreported: number;
  ok: number;
  errors: number;
  upstreamLimited: number;
}

export interface GatewayUsageModelRow extends GatewayModelUsage {
  provider: string;
  model: string;
}

export interface GatewayUsageCallerRow {
  caller: string;
  inputTotal: number | null;
  inputCached: number | null;
  outputTotal: number | null;
  modelCalls: number;
  searchCalls: number;
  embeddingCalls: number;
  readCalls: number;
  errors: number;
  upstreamLimited: number;
  refusals: number;
}

export interface GatewayUsageServiceRow {
  provider: string;
  calls: number;
  ok: number;
  errors: number;
  averageMs: number | null;
}

export interface GatewayUsageRefusal {
  code: string;
  count: number;
}

export interface GatewayUsageError {
  code: string;
  count: number;
}

export interface GatewayEmbeddingsUsage {
  calls: number;
  ok: number;
  errors: number;
  inputTokens: number | null;
  averageMs: number | null;
}

export interface GatewayReadsUsage {
  calls: number;
  ok: number;
  errors: number;
  averageMs: number | null;
}

/** GET /usage?from=YYYY-MM-DD&to=YYYY-MM-DD[&caller=<id>] (admin scope). Days are UTC. */
export interface GatewayUsageResponse {
  trackingSince: string;
  from: string;
  to: string;
  caller: string | null;
  models: {
    summary: GatewayModelUsage;
    byModel: GatewayUsageModelRow[];
  };
  /** Per-caller rows when caller is null (All view); empty otherwise. */
  byCaller: GatewayUsageCallerRow[];
  search: {
    calls: number;
    ok: number;
    errors: number;
    averageMs: number | null;
    byProvider: GatewayUsageServiceRow[];
  };
  embeddings: GatewayEmbeddingsUsage;
  reads: GatewayReadsUsage;
  refusals: GatewayUsageRefusal[];
  errorBreakdown: GatewayUsageError[];
}

// ---- MCP connectors and notification senders. All routes need the admin scope (Rei's
// token); errors are `{ error: { code, message } }`. The gateway holds MCP tokens, OAuth client registrations and VAPID
// keys; none of them is ever returned.

export type ConnectorAuth = "oauth" | "token" | "none";
export type ConnectorStatus = "connected" | "needs_auth" | "error";

/** GET /mcp/connectors → `{ connectors }`; POST (`{ name, url, token? }`) and PATCH (`{ name?, token?: string | null }`) → `{ connector }`. */
export interface GatewayConnector {
  /** `con_` + random. */
  id: string;
  name: string;
  /** The MCP server's Streamable HTTP endpoint; https (http only for hosts in the gateway's dev allowlist). */
  url: string;
  auth: ConnectorAuth;
  tokenHeader?: string;
  status: ConnectorStatus;
  /** Why `status` is not `connected` (already redacted); null otherwise. */
  error: string | null;
  /** From the last tool listing; null until there was one. */
  toolCount: number | null;
  createdAt: number;
}

/** POST /mcp/connectors/:id/oauth/start `{ redirectUri, clientId?, clientSecret? }` → `{ authorizationUrl }`. The client ID fields are for servers without Dynamic Client Registration. */
export interface McpOAuthStartRequest {
  redirectUri: string;
  clientId?: string;
  clientSecret?: string;
}
export interface McpOAuthStartResponse {
  authorizationUrl: string;
}
/** POST /mcp/oauth/callback `{ state, code, iss? }` → `{ connector }`. */
export interface McpOAuthCallbackRequest {
  state: string;
  code: string;
  iss?: string;
}

export interface McpToolInfo {
  name: string;
  title: string | null;
  description: string;
  inputSchema: object;
  outputSchema?: object;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}
/** GET /mcp/connectors/:id/tools[?refresh=1]. Cached per connector (the server's `ttlMs`, else 10 minutes). */
export interface McpToolsResponse {
  tools: McpToolInfo[];
  fetchedAt: number;
}
/** POST /mcp/connectors/:id/call `{ tool, arguments, expected, stepId? }`. A tool that failed answers 200 with `isError: true`. */
export interface McpCallRequest {
  expected: {
    connector: Pick<GatewayConnector, "id" | "name" | "url" | "auth" | "tokenHeader" | "status" | "createdAt">;
    tool: McpToolInfo;
  };
  tool: string;
  arguments?: Record<string, unknown>;
  stepId?: string;
}
export interface McpResultMedia {
  type: "image" | "audio" | "resource";
  mimeType: string;
  data?: string;
  text?: string;
  uri?: string;
}
export interface McpCallResult {
  /** Bounded inline media; resource links alone are never fetched automatically. */
  media?: McpResultMedia[];
  isError: boolean;
  /** Text blocks joined, with placeholders for media carried separately; at most 100 KB. */
  text: string;
  structured: unknown | null;
  truncated: boolean;
}

/** Web Push subscription as the browser reports it (`PushSubscription.toJSON()`). */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
/** GET /notify/webpush/key → `{ publicKey }` (base64url, uncompressed P-256; generated on first use). */
export interface WebPushKeyResponse {
  publicKey: string;
}
/** POST /notify/webpush/send. `payload` is at most 3 KB before encryption. */
export interface WebPushSendRequest {
  subscription: WebPushSubscription;
  payload: string;
  ttl?: number;
  urgency?: "normal" | "high";
  topic?: string;
}
/** `gone` means the push service said 404 or 410: the subscription must be dropped. `status` is 0 when the service was unreachable. */
export type WebPushSendResponse = { ok: true } | { ok: false; gone: boolean; status: number; retryAfterMs?: number };

export const SEARCH_PROVIDER_IDS = ["codex-subscription", "exa", "brave", "tavily", "searxng"] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];
export interface SearchProviderReadiness {
  id: SearchProviderId;
  configured: boolean;
  limitedUntil: number | null;
  lastError?: string;
}
export interface SearchAttemptSummary {
  provider: SearchProviderId;
  status: "skipped" | "failed" | "empty" | "succeeded";
  reason?: string;
  totalMs: number;
}
export const DEFAULT_SEARCH_MODEL = "gpt-6-luna";

/** Search credentials are write-only; blank keys retain the stored credential. */
export interface SearchSetupSettings {
  providers: ("brave" | "tavily" | "searxng" | "exa" | "codex-subscription")[];
  searxngUrl: string;
  exaAuth: "keyless" | "api_key";
  /** Subscription search model; absent in older settings means gpt-6-luna. */
  codexModel?: string;
  /** All rows, including disabled providers, in presentation/priority order. */
  providerOrder?: SearchProviderId[];
  /** Read-only gateway readiness. Credentials and query text are never returned. */
  providerStatus?: SearchProviderReadiness[];
}
export interface SaveSearchSetupSettings extends SearchSetupSettings {
  apiKeys?: Partial<Record<"brave" | "tavily" | "searxng" | "exa", string>>;
}
export interface MemorySetupSettings {
  enabled: boolean;
  available: boolean;
  model: string | null;
}

/** Gateway-owned embedding connection. Credentials are write-only. */
export interface EmbeddingSetupSettings {
  provider: "off" | "omlx" | "openai";
  baseUrl: string;
  apiModel: string;
  profile: {
    id: string;
    repository: string;
    revision: string;
    quant: string;
    dims: number;
    pooling: "mean" | "cls" | "last" | "provider";
    docTemplate: string;
    queryTemplate: string;
    maxInputTokens: number;
    contextTokens: number;
  } | null;
}
export interface SaveEmbeddingSetupSettings extends EmbeddingSetupSettings {
  advanced?: { docTemplate?: string; queryTemplate?: string; contextTokens?: number };
  apiKey?: string;
}
/** A passing connection test on the entered values; nothing is saved by it. */
export interface CheckEmbeddingSetupResponse {
  ok: true;
  dims: number;
}

/** A generated cited answer, distinct from search-engine snippets. Indices address text before rendering. */
export interface SearchAnswer {
  text: string;
  citations: { title: string; url: string; start: number; end: number }[];
  sources: { title: string; url: string }[];
  model: string;
  searchCalls: number;
  freshness: "research_preference";
}
