// web_search: one POST to the gateway's /search, with the stand-in token and the step id of the model call that asked.
// The search keys live in the gateway only; the control plane never sees one.
import type { SearchAnswer, SearchAttemptSummary } from "@rei/protocol";
import { SEARCH_PROVIDER_IDS, STEP_ID_HEADER } from "@rei/protocol";
import { redact } from "../util/log.ts";
import { WebError } from "./types.ts";

export const SEARCH_TIMEOUT_MS = 100_000;
export const FRESHNESS = ["day", "week", "month", "year"] as const;
export type Freshness = (typeof FRESHNESS)[number];
export const MAX_QUERY_CHARS = 400;

export interface SearchRequest {
  query: string;
  count?: number;
  freshness?: Freshness;
}
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}
export interface SearchResponse {
  provider: string;
  results: SearchResult[];
  answer?: SearchAnswer;
  attempts?: SearchAttemptSummary[];
}

export interface SearchClientOptions {
  /** The gateway's base URL (`/search` is added). */
  gatewayUrl: string;
  token: string;
  stepId?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
}

const str = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

function parseResponse(body: unknown): SearchResponse {
  const b = body as { provider?: unknown; results?: unknown; answer?: unknown; attempts?: unknown } | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.results))
    throw new WebError("Web search returned an answer this tool cannot read.");
  const results: SearchResult[] = [];
  for (const item of b.results as unknown[]) {
    const r = item as { title?: unknown; url?: unknown; snippet?: unknown; published?: unknown } | null;
    const url = str(r?.url, 2_000);
    if (!/^https?:\/\//i.test(url)) continue;
    const published = str(r?.published, 60);
    results.push({
      title: str(r?.title, 300) || url,
      url,
      snippet: str(r?.snippet, 1_000),
      ...(published ? { published } : {}),
    });
  }
  let answer: SearchAnswer | undefined;
  if (b.answer !== undefined) {
    const a = b.answer as SearchAnswer;
    const validUrl = (value: unknown): value is string => {
      if (typeof value !== "string" || value.length > 2048) return false;
      try {
        const u = new URL(value);
        return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password;
      } catch {
        return false;
      }
    };
    if (
      !a ||
      typeof a.text !== "string" ||
      !a.text.trim() ||
      a.text.length > 32000 ||
      typeof a.model !== "string" ||
      !Number.isInteger(a.searchCalls) ||
      a.searchCalls < 1 ||
      a.freshness !== "research_preference" ||
      !Array.isArray(a.sources) ||
      a.sources.length > 200 ||
      !Array.isArray(a.citations) ||
      a.citations.length < 1 ||
      a.citations.length > 200 ||
      !a.sources.every((source) => source && validUrl(source.url) && typeof source.title === "string") ||
      !a.citations.every(
        (c) =>
          c &&
          validUrl(c.url) &&
          typeof c.title === "string" &&
          Number.isInteger(c.start) &&
          Number.isInteger(c.end) &&
          c.start >= 0 &&
          c.end > c.start &&
          c.end <= a.text.length,
      )
    )
      throw new WebError("Web search returned an invalid cited answer.");
    answer = a;
  }
  const attempts = parseAttempts(b.attempts);
  return {
    provider: str(b.provider, 40) || "search",
    results,
    ...(answer ? { answer } : {}),
    ...(attempts.length ? { attempts } : {}),
  };
}

function parseAttempts(value: unknown): SearchAttemptSummary[] {
  return Array.isArray(value)
    ? value
        .slice(0, 5)
        .filter(
          (item): item is SearchAttemptSummary =>
            item &&
            SEARCH_PROVIDER_IDS.includes(item.provider) &&
            ["skipped", "failed", "empty", "succeeded"].includes(item.status) &&
            Number.isFinite(item.totalMs) &&
            (item.reason === undefined || /^[a-z0-9_]{1,64}$/.test(item.reason)),
        )
    : [];
}
function formatAttempts(attempts: SearchAttemptSummary[]): string {
  return attempts.length
    ? `\n\nSearch attempts:\n${attempts.map((a) => `- ${a.provider}: ${a.status}${a.reason ? ` (${a.reason})` : ""}, ${a.totalMs} ms`).join("\n")}`
    : "";
}

export async function searchWeb(request: SearchRequest, options: SearchClientOptions): Promise<SearchResponse> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await doFetch(`${options.gatewayUrl.replace(/\/+$/, "")}/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        ...(options.stepId ? { [STEP_ID_HEADER]: options.stepId } : {}),
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch {
    if (options.signal?.aborted) throw new WebError("Web search was cancelled.");
    throw new WebError(
      timeout.aborted
        ? "Web search timed out."
        : "Web search is not available right now: the gateway could not be reached.",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
    const text =
      typeof message === "string" && message.trim() !== ""
        ? redact(message).slice(0, 300)
        : `Web search failed (HTTP ${response.status}).`;
    const attempts = parseAttempts((body as { attempts?: unknown } | undefined)?.attempts);
    const error = new WebError(text + formatAttempts(attempts));
    error.attempts = attempts;
    throw error;
  }
  return parseResponse(body);
}

/**
 * Characters of each result's snippet the model sees. Providers often return page dumps; the model is told to fetch a
 * result rather than rely on its snippet, so a short one is enough to choose what to read.
 */
export const SNIPPET_SHOWN = 300;

/** `N. Title — url` with the snippet under it, then which provider answered. */
export function formatResults(query: string, response: SearchResponse): string {
  const text = formatSearchContent(query, response);
  if (!response.attempts || response.attempts.length < 2) return text;
  return text + formatAttempts(response.attempts);
}
function formatSearchContent(query: string, response: SearchResponse): string {
  if (response.answer) {
    const a = response.answer;
    const link = (title: string, url: string) =>
      `[${title.replace(/[\[\]\\]/g, " ")}](${url.replace(/[()<>\s]/g, (char) => encodeURIComponent(char))})`;
    let end = 0;
    let text = "";
    for (const c of [...a.citations].sort((x, y) => x.start - y.start)) {
      if (c.start < end) continue;
      text += a.text.slice(end, c.start) + link(c.title, c.url);
      end = c.end;
    }
    text += a.text.slice(end);
    return `${text}\n\nSources consulted:\n${a.sources.map((s) => `- ${link(s.title, s.url)}`).join("\n")}\n\n(via ${response.provider}; ${a.searchCalls} search calls; model ${a.model}). Source count is a target; freshness is a research preference, not a strict date filter.`;
  }
  if (response.results.length === 0) return `No results for "${query}". (via ${response.provider})`;
  const lines = response.results.map((r, i) => {
    const head = `${i + 1}. ${r.title} — ${r.url}`;
    const parts = [head];
    if (r.snippet)
      parts.push(`   ${r.snippet.length > SNIPPET_SHOWN ? `${r.snippet.slice(0, SNIPPET_SHOWN - 1)}…` : r.snippet}`);
    if (r.published) parts.push(`   (published ${r.published})`);
    return parts.join("\n");
  });
  return `${lines.join("\n")}\n\n(via ${response.provider})`;
}
