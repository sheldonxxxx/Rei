// What every search provider shares: the result shape, the failure kinds the fallback logic cares about, and the text
// and URL clean-up that turns whatever an upstream sent into plain, bounded strings.

export type Freshness = "day" | "week" | "month" | "year";

export interface SearchQuery {
  query: string;
  count: number;
  freshness?: Freshness | undefined;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}

export const PROVIDER_IDS = ["brave", "tavily", "searxng", "exa", "codex-subscription"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const MAX_TITLE = 300;
export const MAX_SNIPPET = 1_000;
/** A search reply is a few dozen KB; anything beyond this is not a search reply. */
export const MAX_REPLY_BYTES = 2 * 1024 * 1024;

/**
 * `rate_limited` is remembered for a while; `failed` (network, 5xx, unparseable) only skips to the next provider.
 * `reason` is a stable code for the service log (ADR 0003); the message, our own and key-free, is for the CLI check.
 */
export class ProviderError extends Error {
  readonly kind: "rate_limited" | "failed";
  readonly reason: string;
  readonly retryAfterS: number;
  constructor(kind: ProviderError["kind"], reason: string, message: string, retryAfterS = 60) {
    super(message);
    this.kind = kind;
    this.reason = reason;
    this.retryAfterS = retryAfterS;
  }
}

export interface ProviderContext {
  fetch: typeof fetch;
  signal: AbortSignal;
  /** The provider's key; null when there is none (only searxng and exa work without one). */
  key: string | null;
  /** Origin (searxng: its internal URL). Fixed per provider; tests point it at a fake. */
  baseUrl: string;
}

export interface SearchProvider {
  id: ProviderId;
  needsKey: boolean;
  /** The origin used when none is configured; null for searxng, which has to be configured. */
  defaultBaseUrl: string | null;
  search(query: SearchQuery, ctx: ProviderContext): Promise<SearchResult[]>;
}

/** Seconds from a Retry-After header (delta-seconds or an HTTP date), else the default; at most an hour. */
export function retryAfterSeconds(headers: Headers, fallback = 60, now = Date.now()): number {
  const raw = headers.get("retry-after");
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(3_600, Math.max(1, Math.ceil(n)));
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.min(3_600, Math.max(1, Math.ceil((at - now) / 1000)));
  }
  return fallback;
}

/** Reads the body as text and stops (with an error) beyond the limit, so a hostile or broken upstream cannot fill memory. */
export async function readLimited(res: Response, max = MAX_REPLY_BYTES): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ProviderError("failed", "too_large", "The search reply was too large.");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all);
}

/** Status handling shared by the providers that answer with plain HTTP errors. Throws on anything but 2xx. */
export function throwForStatus(res: Response, provider: string, rateLimited: readonly number[] = [429]): void {
  if (res.ok) return;
  if (rateLimited.includes(res.status))
    throw new ProviderError(
      "rate_limited",
      "rate_limited",
      `${provider} is rate limited.`,
      retryAfterSeconds(res.headers),
    );
  throw new ProviderError("failed", `http_${res.status}`, `${provider} answered ${res.status}.`);
}

/** JSON.parse that reports an unparseable reply as a provider failure, never with the body in the message. */
export function parseJson(text: string, provider: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("failed", "not_json", `${provider} sent a reply that is not JSON.`);
  }
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

/**
 * Plain text from a snippet that may contain HTML: tags dropped, entities decoded once, invisible and control characters
 * removed, white space collapsed, and cut at `max` characters (with an ellipsis).
 */
export function plainText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let text = value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(?:br|p|div|li|tr|h[1-6])\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  text = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
  text = text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** http(s) URL without credentials, as a normalised string; null for anything else. */
export function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  return url.href;
}

/** An ISO-ish date from an upstream, or undefined. Offset-less values (searxng) are kept as sent. */
export function cleanDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(v) ? v : undefined;
}

/** Builds the final, bounded list: invalid URLs dropped, duplicates dropped, at most `count`. */
export function toResults(
  rows: { title: unknown; url: unknown; snippet: unknown; published?: unknown }[],
  count: number,
): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const url = cleanUrl(row.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const published = cleanDate(row.published);
    out.push({
      title: plainText(row.title, MAX_TITLE) || new URL(url).hostname,
      url,
      snippet: plainText(row.snippet, MAX_SNIPPET),
      ...(published ? { published } : {}),
    });
    if (out.length >= count) break;
  }
  return out;
}

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
