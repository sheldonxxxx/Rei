// Which upstream URLs the gateway may forward to, and which headers cross the gateway in each direction.
//
// Default allowlist: api.openai.com under /v1/. Verified in pi-ai 1.4.0 (dist/providers/openai.js): the `openai` provider's
// baseUrl is https://api.openai.com/v1 for both an API key and a Sign in with ChatGPT token (the OAuth grant's resource is
// https://api.openai.com/v1, dist/auth/oauth/openai-chatgpt.js). GATEWAY_ALLOWED_UPSTREAMS can add explicit endpoint rules.

export interface UpstreamRule {
  protocol: "https:" | "http:";
  /** Exact hostname, lower case. */
  host: string;
  /** Exact port; empty for the protocol's default. */
  port: string;
  /** The URL path must start with this. */
  pathPrefix: string;
}

export const DEFAULT_UPSTREAMS: readonly UpstreamRule[] = [
  { protocol: "https:", host: "api.openai.com", port: "", pathPrefix: "/v1/" },
];

/**
 * Parses extra rules from a comma-separated list of origins with an optional path prefix, e.g.
 * `https://chatgpt.com/backend-api/,http://127.0.0.1:9000` (test use). Throws on a malformed entry.
 */
export function parseUpstreamRules(list: string): UpstreamRule[] {
  const rules: UpstreamRule[] = [];
  for (const entry of list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const url = new URL(entry);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error(`upstream rule must be http(s): ${entry}`);
    rules.push({
      protocol: url.protocol,
      host: url.hostname,
      port: url.port,
      pathPrefix: url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`,
    });
  }
  return rules;
}

/** Returns the parsed URL when `raw` is allowed, otherwise null. No credentials in the URL, no fragments, exact host match. */
export function checkUpstream(raw: string | null, rules: readonly UpstreamRule[]): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  const ok = rules.some(
    (r) =>
      url.protocol === r.protocol &&
      url.hostname === r.host &&
      url.port === r.port &&
      (url.pathname + "/").startsWith(r.pathPrefix),
  );
  return ok ? url : null;
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** Names listed in the Connection header are hop-by-hop too. */
function connectionTokens(headers: Headers): string[] {
  return (headers.get("connection") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const DROP_FROM_REQUEST = new Set([
  ...HOP_BY_HOP,
  "host",
  "content-length", // recomputed from the buffered body
  "accept-encoding", // forced to identity so the passthrough is byte-exact and the stream stays parseable
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

/** Headers for the upstream request: hop-by-hop, credential-bearing and our own x-rei-* headers removed. */
export function upstreamRequestHeaders(incoming: Headers, bearer: string): Headers {
  const extra = new Set(connectionTokens(incoming));
  const out = new Headers();
  for (const [name, value] of incoming) {
    if (DROP_FROM_REQUEST.has(name) || extra.has(name) || name.startsWith("x-rei-")) continue;
    out.append(name, value);
  }
  if (bearer) out.set("authorization", `Bearer ${bearer}`);
  out.set("accept-encoding", "identity");
  return out;
}

/** Headers for the response to the control plane: hop-by-hop and anything carrying a known secret removed. */
export function downstreamResponseHeaders(upstream: Headers, redact: (text: string) => string): Headers {
  const extra = new Set(connectionTokens(upstream));
  const dropLength = upstream.has("content-encoding"); // fetch already decoded the body
  const out = new Headers();
  for (const [name, value] of upstream) {
    if (HOP_BY_HOP.includes(name) || extra.has(name) || name === "set-cookie" || name === "authorization") continue;
    if (dropLength && (name === "content-length" || name === "content-encoding")) continue;
    if (redact(value) !== value) continue; // would have leaked a token (e.g. an echoed Authorization header)
    out.append(name, value);
  }
  return out;
}
