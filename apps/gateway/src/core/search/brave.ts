// Brave Search API: GET /res/v1/web/search with the key in X-Subscription-Token.

import type { Freshness, SearchProvider } from "./common.ts";
import { asRecord, parseJson, readLimited, throwForStatus, toResults } from "./common.ts";

const FRESHNESS: Record<Freshness, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

export const brave: SearchProvider = {
  id: "brave",
  needsKey: true,
  defaultBaseUrl: "https://api.search.brave.com",
  async search(q, ctx) {
    const url = new URL("/res/v1/web/search", ctx.baseUrl);
    url.searchParams.set("q", q.query);
    url.searchParams.set("count", String(q.count));
    if (q.freshness) url.searchParams.set("freshness", FRESHNESS[q.freshness]);
    const res = await ctx.fetch(url, {
      headers: { accept: "application/json", "x-subscription-token": ctx.key ?? "" },
      signal: ctx.signal,
      redirect: "manual",
    });
    throwForStatus(res, "Brave");
    const body = asRecord(parseJson(await readLimited(res), "Brave"));
    const rows = asRecord(body?.web)?.results;
    if (!Array.isArray(rows)) return [];
    return toResults(
      rows.map((r) => {
        const row = asRecord(r) ?? {};
        return { title: row.title, url: row.url, snippet: row.description, published: row.page_age };
      }),
      q.count,
    );
  },
};
