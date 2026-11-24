// Tavily: POST /search with the key as a bearer token.

import type { SearchProvider } from "./common.ts";
import { asRecord, parseJson, readLimited, throwForStatus, toResults } from "./common.ts";

export const tavily: SearchProvider = {
  id: "tavily",
  needsKey: true,
  defaultBaseUrl: "https://api.tavily.com",
  async search(q, ctx) {
    const body = {
      query: q.query,
      max_results: q.count,
      search_depth: "basic",
      topic: "general",
      ...(q.freshness ? { time_range: q.freshness } : {}),
    };
    const res = await ctx.fetch(new URL("/search", ctx.baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${ctx.key ?? ""}`,
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
      redirect: "manual",
    });
    // 432 and 433 are Tavily's plan and pay-as-you-go limits: out of quota is "rate limited" for our purposes.
    throwForStatus(res, "Tavily", [429, 432, 433]);
    const rows = asRecord(parseJson(await readLimited(res), "Tavily"))?.results;
    if (!Array.isArray(rows)) return [];
    return toResults(
      rows.map((r) => {
        const row = asRecord(r) ?? {};
        return { title: row.title, url: row.url, snippet: row.content, published: row.published_date };
      }),
      q.count,
    );
  },
};
