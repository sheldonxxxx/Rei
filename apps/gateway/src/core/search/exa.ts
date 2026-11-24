// Exa's hosted MCP server (streamable HTTP, JSON-RPC 2.0), tool web_search_exa. Probed live (Oct 2026): it answers a bare
// tools/call with no initialize and no Mcp-Session-Id, as text/event-stream (one `event: message` carrying the JSON-RPC
// reply) as soon as the Accept header lists both JSON and SSE; with only application/json it answers 406. Without a key it
// is rate limited at random: HTTP 200 with `_meta["ai.exa/rateLimited"]` and a text result, not an HTTP or JSON-RPC error.
// The reply text is blocks of `Title:`, `URL:`, `Published:` (ISO date or N/A), `Author:`, `Highlights:` and the excerpt.
// Should the server one day insist on a session, the handshake (initialize, notifications/initialized) is done lazily.

import type { ProviderContext, SearchProvider } from "./common.ts";
import { asRecord, ProviderError, parseJson, readLimited, throwForStatus, toResults } from "./common.ts";

const PROTOCOL_VERSION = "2025-03-26";
const FRESHNESS_HINT = {
  day: "the last day",
  week: "the last week",
  month: "the last month",
  year: "the last year",
} as const;

class SessionRequired extends Error {}

interface Reply {
  message: Record<string, unknown> | null;
  sessionId: string | null;
}

/** The JSON-RPC message with the given id out of a JSON or SSE body. */
function messageFrom(text: string, contentType: string, id: number): Record<string, unknown> | null {
  if (!contentType.includes("text/event-stream")) return asRecord(parseJson(text, "Exa"));
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    const message = asRecord(parsed);
    if (message && message.id === id) return message;
  }
  return null;
}

async function rpc(
  ctx: ProviderContext,
  body: { id?: number; method: string; params?: unknown },
  session: string | null,
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (ctx.key) headers["x-api-key"] = ctx.key;
  if (session) {
    headers["mcp-session-id"] = session;
    headers["mcp-protocol-version"] = PROTOCOL_VERSION;
  }
  const res = await ctx.fetch(new URL("/mcp", ctx.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    signal: ctx.signal,
    redirect: "manual",
  });
  const sessionId = res.headers.get("mcp-session-id");
  if (body.id === undefined) {
    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw new ProviderError("failed", `http_${res.status}`, `Exa answered ${res.status}.`);
    return { message: null, sessionId };
  }
  if (!session && (res.status === 400 || res.status === 404 || res.status === 409)) {
    const text = await readLimited(res).catch(() => "");
    if (/session|initiali[sz]/i.test(text)) throw new SessionRequired();
    throw new ProviderError("failed", `http_${res.status}`, `Exa answered ${res.status}.`);
  }
  throwForStatus(res, "Exa");
  const message = messageFrom(await readLimited(res), res.headers.get("content-type") ?? "", body.id);
  const error = asRecord(message?.error);
  if (error) {
    if (!session && /session|initiali[sz]/i.test(String(error.message ?? ""))) throw new SessionRequired();
    throw new ProviderError(
      "failed",
      "jsonrpc_error",
      `Exa answered with a JSON-RPC error (${String(error.code ?? "?")}).`,
    );
  }
  return { message, sessionId };
}

async function handshake(ctx: ProviderContext): Promise<string | null> {
  const init = await rpc(
    ctx,
    {
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "rei-gateway", version: "0.1.0" },
      },
    },
    null,
  );
  await rpc(ctx, { method: "notifications/initialized" }, init.sessionId);
  return init.sessionId;
}

const BLOCK = /^Title: ([^\n]*)\nURL: ([^\n]*)\nPublished: ([^\n]*)\n(?:Author: [^\n]*\n)?Highlights:\n?([\s\S]*)$/;

/** Results out of the tool's text; null when the text is not in the expected shape. */
export function parseExaText(text: string, count: number) {
  const blocks = text.split(/\n(?=Title: [^\n]*\nURL: )/);
  const rows: { title: string; url: string; snippet: string; published: string }[] = [];
  for (const block of blocks) {
    const m = BLOCK.exec(block.trim());
    if (m) rows.push({ title: m[1]!, url: m[2]!, published: m[3]!, snippet: m[4]! });
  }
  if (rows.length === 0) return /no (?:search )?results|nothing found/i.test(text) ? [] : null;
  return toResults(
    rows.map((r) => ({ ...r, published: r.published === "N/A" ? undefined : r.published })),
    count,
  );
}

export const exa: SearchProvider = {
  id: "exa",
  needsKey: false,
  defaultBaseUrl: "https://mcp.exa.ai",
  async search(q, ctx) {
    // `objective` is required by the tool's schema (the server also accepts a call without it).
    const objective =
      `Find web pages that answer: ${q.query}${q.freshness ? `. Prefer pages published in ${FRESHNESS_HINT[q.freshness]}.` : ""}`.slice(
        0,
        4_096,
      );
    const call = {
      id: 2,
      method: "tools/call",
      params: { name: "web_search_exa", arguments: { query: q.query, objective, numResults: q.count } },
    };
    let reply: Reply;
    try {
      reply = await rpc(ctx, call, null);
    } catch (cause) {
      if (!(cause instanceof SessionRequired)) throw cause;
      const session = await handshake(ctx);
      reply = await rpc(ctx, call, session);
    }
    const result = asRecord(reply.message?.result);
    if (!result) throw new ProviderError("failed", "no_result", "Exa sent no result.");
    if (asRecord(result._meta)?.["ai.exa/rateLimited"] === true)
      throw new ProviderError("rate_limited", "rate_limited", "Exa's free tier is rate limited.");
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((c) => asRecord(c))
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c!.text as string)
      .join("\n\n");
    if (result.isError === true)
      throw new ProviderError("failed", "error_result", "Exa reported an error for the search.");
    const results = parseExaText(text, q.count);
    if (!results) throw new ProviderError("failed", "bad_format", "Exa sent a result in an unexpected format.");
    return results;
  },
};
