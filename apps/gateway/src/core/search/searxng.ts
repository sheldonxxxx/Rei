// An explicitly configured external SearXNG instance: GET <base>/search?format=json. Its engines run behind it, so an
// answer with no results and engines that failed (captcha, timeout) counts as a failure and the next provider is tried.
//
// The optional `searxng` key file (for an instance behind a reverse proxy) is one line, either
//   user:password            sent as `Authorization: Basic ...`
//   Header-Name: value       (a colon then a space) sent as that header, e.g. `Authorization: Bearer x` or `X-API-Key: x`

import type { SearchProvider } from "./common.ts";
import { asRecord, ProviderError, parseJson, readLimited, throwForStatus, toResults } from "./common.ts";

const HEADER_LINE = /^([A-Za-z][A-Za-z0-9-]*): (\S.*)$/;

/** The header a searxng key line stands for, plus every secret form of it to redact; null when it is neither format. */
export function parseSearxngAuth(line: string): { name: string; value: string; secrets: string[] } | null {
  const header = HEADER_LINE.exec(line);
  if (header) return { name: header[1]!, value: header[2]!, secrets: [line, header[2]!] };
  const colon = line.indexOf(":");
  if (colon < 1) return null;
  const basic = btoa(line);
  return { name: "authorization", value: `Basic ${basic}`, secrets: [line, basic, line.slice(colon + 1)] };
}

export const searxng: SearchProvider = {
  id: "searxng",
  needsKey: false,
  defaultBaseUrl: null,
  async search(q, ctx) {
    // Appended, not resolved: new URL("/search", base) would drop the path of an instance at https://host/searx/.
    const url = new URL(`${ctx.baseUrl.replace(/\/+$/, "")}/search`);
    url.searchParams.set("q", q.query);
    url.searchParams.set("format", "json");
    if (q.freshness) url.searchParams.set("time_range", q.freshness);
    const headers: Record<string, string> = { accept: "application/json" };
    if (ctx.key) {
      const auth = parseSearxngAuth(ctx.key);
      if (!auth)
        throw new ProviderError(
          "failed",
          "bad_key_file",
          "The searxng key file is neither user:password nor Header-Name: value.",
        );
      headers[auth.name] = auth.value;
    }
    const res = await ctx.fetch(url, { headers, signal: ctx.signal, redirect: "manual" });
    if (res.status >= 300 && res.status < 400)
      throw new ProviderError(
        "failed",
        "redirected",
        `SearXNG redirected (${res.status}), most likely to a login page: check the URL and the searxng key file.`,
      );
    if (res.status === 401)
      throw new ProviderError(
        "failed",
        "credentials_refused",
        "SearXNG refused the credentials (401): check the searxng key file.",
      );
    if (res.status === 403)
      throw new ProviderError(
        "failed",
        "json_disabled",
        "SearXNG refused JSON (format disabled on that instance?). Add json to search.formats in its settings.yml.",
      );
    throwForStatus(res, "SearXNG");
    // Public instances often put a bot check (Anubis and the like) in front, which answers 200 with an HTML page.
    if (/^text\/html\b/i.test(res.headers.get("content-type") ?? ""))
      throw new ProviderError(
        "failed",
        "html_page",
        "SearXNG answered with a web page, not JSON (a bot check or login in front of it, or JSON disabled).",
      );
    const body = asRecord(parseJson(await readLimited(res), "SearXNG"));
    const rows = body?.results;
    if (!Array.isArray(rows))
      throw new ProviderError("failed", "no_results_field", "SearXNG sent a reply without results.");
    const results = toResults(
      rows.map((r) => {
        const row = asRecord(r) ?? {};
        return { title: row.title, url: row.url, snippet: row.content, published: row.publishedDate };
      }),
      q.count,
    );
    if (results.length === 0 && Array.isArray(body?.unresponsive_engines) && body.unresponsive_engines.length > 0)
      throw new ProviderError("failed", "engines_down", "SearXNG's engines did not answer.");
    return results;
  },
};
