import { readFileSync } from "node:fs";
import type { GatewayStatus } from "@rei/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanUrl, plainText, retryAfterSeconds } from "../src/core/search/common.ts";
import { parseExaText } from "../src/core/search/exa.ts";
import { searxng } from "../src/core/search/searxng.ts";
import { createSearchService, parseProviderList } from "../src/core/search/service.ts";
import { searchCheck } from "../src/node/diagnose.ts";
import type { FakeSearchRequest } from "./search-rig.ts";
import { type SearchRig, startSearchRig } from "./search-rig.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const BRAVE = fixture("brave-search.json");
const TAVILY = fixture("tavily-search.json");
const SEARXNG = fixture("searxng-search.json");
/** The probe's SSE replies carry id 3; a client picks its own, and the reply must echo it. */
const exaReply = (name: string, req: FakeSearchRequest) =>
  fixture(name).replace('"id":3', `"id":${(req.json as { id: number }).id}`);
const SSE = { "content-type": "text/event-stream" };
const KEYS = {
  brave: "brave-key-AAAA1111BBBB2222",
  tavily: "tvly-key-CCCC3333DDDD4444",
  exa: "exa-key-EEEE5555FFFF6666",
};

interface Ok {
  provider: string;
  results: { title: string; url: string; snippet: string; published?: string }[];
}
const okJson = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()) as Ok;
};
const errJson = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

describe("providers: request and mapping", () => {
  let rig: SearchRig;
  afterEach(() => rig.stop());

  it("brave: key header, count and freshness, HTML and entities stripped, bad urls dropped, published kept", async () => {
    rig = await startSearchRig({ providers: ["brave"], keys: KEYS });
    rig.on("brave", { body: BRAVE });
    const out = await okJson(await rig.search({ query: "node 24 release", count: 3, freshness: "week" }));
    expect(out.provider).toBe("brave");
    expect(out.results).toEqual([
      {
        title: "Node.js 24.0.0 & npm 11 released",
        url: "https://nodejs.org/en/blog/release/v24.0.0",
        snippet: "We're excited to announce Node.js 24. V8 13.6 and npm 11 <3",
        published: "2025-05-06T12:00:00",
      },
      { title: "github.com", url: "https://github.com/nodejs/node/releases", snippet: "Release list" },
    ]);
    const req = rig.forProvider("brave")[0]!;
    const url = new URL(req.path, "http://x");
    expect(url.pathname).toBe("/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("node 24 release");
    expect(url.searchParams.get("count")).toBe("3");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect(req.headers["x-subscription-token"]).toBe(KEYS.brave);
  });

  it("tavily: POST body, bearer key, time_range, published_date", async () => {
    rig = await startSearchRig({ providers: ["tavily"], keys: KEYS });
    rig.on("tavily", { body: TAVILY });
    const out = await okJson(await rig.search({ query: "node 24 release", count: 2, freshness: "month" }));
    expect(out.provider).toBe("tavily");
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toEqual({
      title: "Node.js 24 is here",
      url: "https://nodejs.org/en/blog/release/v24.0.0",
      snippet: "V8 13.6, npm 11, URLPattern global.",
      published: "2025-05-06",
    });
    expect(out.results[1]!.published).toBeUndefined();
    const req = rig.forProvider("tavily")[0]!;
    expect(req.headers.authorization).toBe(`Bearer ${KEYS.tavily}`);
    expect(req.json).toEqual({
      query: "node 24 release",
      max_results: 2,
      search_depth: "basic",
      topic: "general",
      time_range: "month",
    });
  });

  it("searxng (real response): format=json, time_range, content as snippet, publishedDate, count applied", async () => {
    rig = await startSearchRig({ providers: ["searxng"] });
    rig.on("searxng", { body: SEARXNG });
    const out = await okJson(await rig.search({ query: "latest openai news", count: 2, freshness: "week" }));
    expect(out.provider).toBe("searxng");
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({
      title: "OpenAI News | OpenAI",
      url: "https://openai.com/news/",
      published: "2026-10-29T06:48:27",
    });
    // zero-width characters in the real snippet are gone
    expect(out.results[1]!.snippet).not.toMatch(
      new RegExp(`[${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}]`),
    );
    const url = new URL(rig.forProvider("searxng")[0]!.path, "http://x");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("q")).toBe("latest openai news");
    expect(url.searchParams.get("time_range")).toBe("week");
  });

  it("exa (real SSE response): bare tools/call, no key header, titles urls and highlights mapped, N/A published dropped", async () => {
    rig = await startSearchRig({ providers: ["exa"] });
    rig.on("exa", (req) => ({ headers: SSE, body: exaReply("exa-search.sse", req) }));
    const out = await okJson(
      await rig.search({ query: "latest news about OpenAI this week", count: 3, freshness: "week" }),
    );
    expect(out.provider).toBe("exa");
    expect(out.results.map((r) => r.url)).toEqual([
      "https://www.reuters.com/technology/openai/",
      "https://ailately.com/rn",
      "https://www.investing.com/news/stock-market-news/openai-says-human-intent-at-center-of-updated-ai-model-guidelines-4984893",
    ]);
    expect(out.results[0]).not.toHaveProperty("published");
    expect(out.results[1]!.published).toBe("2026-10-30T04:07:00.000Z");
    expect(out.results[0]!.snippet.startsWith("- Technology category")).toBe(true);
    expect(out.results[0]!.title).toBe("OpenAI News | Today's Latest Stories | Reuters");
    const reqs = rig.forProvider("exa");
    expect(reqs).toHaveLength(1); // no initialize round trip
    const call = reqs[0]!.json as { method: string; params: { name: string; arguments: Record<string, unknown> } };
    expect(call.method).toBe("tools/call");
    expect(call.params.name).toBe("web_search_exa");
    expect(call.params.arguments).toMatchObject({ query: "latest news about OpenAI this week", numResults: 3 });
    expect(String(call.params.arguments.objective)).toContain("latest news about OpenAI this week");
    expect(String(call.params.arguments.objective)).toContain("last week");
    expect(reqs[0]!.headers.accept).toBe("application/json, text/event-stream");
    expect(reqs[0]!.headers["x-api-key"]).toBeUndefined();
    expect(reqs[0]!.headers["mcp-session-id"]).toBeUndefined();
  });

  it("exa: a key goes in x-api-key; a plain JSON reply works too", async () => {
    rig = await startSearchRig({ providers: ["exa-api"], keys: KEYS });
    rig.on("exa-api", (req) => {
      const sse = exaReply("exa-search.sse", req);
      return {
        body: sse
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      };
    });
    const out = await okJson(await rig.search({ query: "q" }));
    expect(out.results).toHaveLength(3);
    expect(rig.forProvider("exa-api")[0]!.headers["x-api-key"]).toBe(KEYS.exa);
  });

  it("exa: does the initialize handshake when the server insists on a session", async () => {
    rig = await startSearchRig({ providers: ["exa"] });
    rig.on("exa", (req) => {
      const msg = req.json as { id?: number; method: string };
      if (msg.method === "initialize")
        return {
          headers: { ...SSE, "mcp-session-id": "sess-123" },
          body: `event: message\ndata: {"result":{"protocolVersion":"2025-03-26","capabilities":{}},"jsonrpc":"2.0","id":${msg.id}}\n\n`,
        };
      if (msg.method === "notifications/initialized") return { status: 202, body: "" };
      if (req.headers["mcp-session-id"] !== "sess-123")
        return {
          status: 400,
          body: JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: null,
          }),
        };
      return { headers: SSE, body: exaReply("exa-search.sse", req) };
    });
    const out = await okJson(await rig.search({ query: "q" }));
    expect(out.results).toHaveLength(3);
    expect(rig.forProvider("exa").map((r) => (r.json as { method: string }).method)).toEqual([
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("caps at count, honours the 1,000 / 300 character limits and drops duplicates", async () => {
    rig = await startSearchRig({ providers: ["tavily"], keys: KEYS });
    const rows = Array.from({ length: 12 }, (_, i) => ({
      title: "T".repeat(500),
      url: `https://example.com/${i}`,
      content: `<b>${"x".repeat(2000)}</b>`,
    }));
    rig.on("tavily", { body: JSON.stringify({ results: [rows[0], ...rows] }) });
    const out = await okJson(await rig.search({ query: "q", count: 10 }));
    expect(out.results).toHaveLength(10);
    expect(new Set(out.results.map((r) => r.url)).size).toBe(10);
    expect(out.results[0]!.title.length).toBeLessThanOrEqual(300);
    expect(out.results[0]!.snippet.length).toBeLessThanOrEqual(1000);
    expect(out.results[0]!.snippet.endsWith("…")).toBe(true);
  });
});

describe("order, fallback and rate-limit memory", () => {
  let rig: SearchRig;
  afterEach(() => rig.stop());

  it("skips providers without a key without calling them; tries the rest in the configured order", async () => {
    rig = await startSearchRig({ keys: { exa: KEYS.exa } }); // default order brave,tavily,searxng,exa
    rig.on("brave", { body: BRAVE });
    rig.on("tavily", { body: TAVILY });
    rig.on("searxng", { status: 500 });
    rig.on("exa", (req) => ({ headers: SSE, body: exaReply("exa-search.sse", req) }));
    const out = await okJson(await rig.search({ query: "q" }));
    expect(out.provider).toBe("exa");
    expect(rig.requests.map((r) => r.provider)).toEqual(["searxng", "exa"]);
  });

  it("falls through on a 5xx, a broken body, a network failure and an empty-with-failed-engines SearXNG", async () => {
    rig = await startSearchRig({ keys: KEYS });
    rig.on("brave", { status: 502, body: "bad gateway" });
    rig.on("tavily", { body: "<html>not json</html>" });
    rig.on("searxng", { body: JSON.stringify({ results: [], unresponsive_engines: [["duckduckgo", "CAPTCHA"]] }) });
    rig.on("exa", (req) => ({ headers: SSE, body: exaReply("exa-search.sse", req) }));
    const out = await okJson(await rig.search({ query: "q" }));
    expect(out.provider).toBe("exa");
    expect(rig.requests.map((r) => r.provider)).toEqual(["brave", "tavily", "searxng", "exa"]);
  });

  it("an empty answer lets the next provider try; if nobody finds anything the empty answer stands", async () => {
    rig = await startSearchRig({ providers: ["tavily", "searxng", "exa"], keys: KEYS });
    rig.on("tavily", { body: JSON.stringify({ results: [] }) });
    rig.on("searxng", { body: SEARXNG });
    rig.on("exa", (req) => ({ headers: SSE, body: exaReply("exa-search.sse", req) }));
    expect((await okJson(await rig.search({ query: "q" }))).provider).toBe("searxng");
    rig.on("searxng", { status: 500 });
    rig.on("exa", (req) => ({ headers: SSE, body: exaReply("exa-ratelimited.sse", req) }));
    const out = await okJson(await rig.search({ query: "q" }));
    expect(out).toMatchObject({
      provider: "tavily",
      results: [],
      attempts: [
        expect.objectContaining({ status: "empty" }),
        expect.objectContaining({ status: "failed" }),
        expect.objectContaining({ status: "failed" }),
      ],
    });
  });

  it("the provider order comes from the configuration", async () => {
    rig = await startSearchRig({ providers: ["exa", "brave"], keys: KEYS });
    rig.on("brave", { body: BRAVE });
    rig.on("exa", (req) => ({ headers: SSE, body: exaReply("exa-search.sse", req) }));
    expect((await okJson(await rig.search({ query: "q" }))).provider).toBe("exa");
    expect(rig.forProvider("brave")).toHaveLength(0);
  });

  it("a 429 is remembered for its Retry-After: the provider is not called again until it has passed", async () => {
    rig = await startSearchRig({ providers: ["brave", "tavily"], keys: KEYS });
    rig.on("brave", { status: 429, headers: { "retry-after": "30" }, body: "slow down" });
    rig.on("tavily", { body: TAVILY });
    expect((await okJson(await rig.search({ query: "q" }))).provider).toBe("tavily");
    expect((await okJson(await rig.search({ query: "q" }))).provider).toBe("tavily");
    expect(rig.forProvider("brave")).toHaveLength(1);
    rig.clock.t += 31_000;
    await okJson(await rig.search({ query: "q" }));
    expect(rig.forProvider("brave")).toHaveLength(2);
  });

  it("defaults the memory to 60 s without Retry-After, and treats Exa's soft rate limit as a 429", async () => {
    rig = await startSearchRig({ providers: ["exa", "searxng"] });
    rig.on("exa", (req) => ({ headers: SSE, body: exaReply("exa-ratelimited.sse", req) }));
    rig.on("searxng", { body: SEARXNG });
    expect((await okJson(await rig.search({ query: "q" }))).provider).toBe("searxng");
    rig.clock.t += 59_000;
    await rig.search({ query: "q" });
    expect(rig.forProvider("exa")).toHaveLength(1);
    rig.clock.t += 2_000;
    await rig.search({ query: "q" });
    expect(rig.forProvider("exa")).toHaveLength(2);
  });

  it("429 search_rate_limited (with retry-after) when every provider that could answer is rate limited; 503 when any other failure is mixed in", async () => {
    rig = await startSearchRig({ providers: ["brave", "tavily"], keys: KEYS });
    rig.on("brave", { status: 429, headers: { "retry-after": "20" } });
    rig.on("tavily", { status: 432 });
    const res = await rig.search({ query: "q" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("20");
    expect((await errJson(res)).code).toBe("search_rate_limited");
    // remembered: no upstream traffic, same answer
    const before = rig.requests.length;
    expect((await rig.search({ query: "q" })).status).toBe(429);
    expect(rig.requests.length).toBe(before);
    rig.clock.t += 61_000;
    rig.on("tavily", { status: 500 });
    const mixed = await rig.search({ query: "q" });
    expect(mixed.status).toBe(503);
    expect((await errJson(mixed)).code).toBe("search_unavailable");
  });

  it("503 search_unavailable with nothing configured, and when search is not wired at all", async () => {
    rig = await startSearchRig({ providers: ["brave", "tavily"], searxng: false });
    const res = await rig.search({ query: "q" });
    expect(res.status).toBe(503);
    expect(await errJson(res)).toEqual({ code: "search_unavailable", message: "No search provider is configured." });
    expect(rig.requests).toHaveLength(0);
    await rig.stop();
    rig = await startSearchRig({ noSearch: true });
    expect((await errJson(await rig.search({ query: "q" }))).code).toBe("search_unavailable");
  });

  it("gives up on a provider that hangs after the per-provider timeout and moves on", async () => {
    rig = await startSearchRig({ providers: ["brave", "tavily"], keys: KEYS, timeoutMs: 200 });
    rig.on("brave", { delayMs: Number.POSITIVE_INFINITY });
    rig.on("tavily", { body: TAVILY });
    const t0 = Date.now();
    const out = await okJson(await rig.search({ query: "q" }, { step: "step-timeout" }));
    expect(out.provider).toBe("tavily");
    expect(Date.now() - t0).toBeLessThan(5_000);
    const rows = await rig.getCalls("step-timeout");
    expect(rows.map((r) => [r.model, r.status, r.error?.code ?? null])).toEqual([
      ["search:brave", 504, "search_timeout"],
      ["search:tavily", 200, null],
    ]);
  });
});

describe("endpoint: auth, validation, logging", () => {
  let rig: SearchRig;
  beforeEach(async () => {
    rig = await startSearchRig({ providers: ["brave", "searxng"], keys: KEYS });
    rig.on("brave", { body: BRAVE });
    rig.on("searxng", { body: SEARXNG });
  });
  afterEach(() => rig.stop());

  it("needs the stand-in token", async () => {
    for (const token of [null, "standin-not-issued", `${rig.standin}x`]) {
      const res = await rig.search({ query: "q" }, { token });
      expect(res.status).toBe(401);
      expect((await errJson(res)).code).toBe("bad_token");
    }
    expect(rig.requests).toHaveLength(0);
  });

  it.each([
    ["not json", undefined, "{nope"],
    ["an array", [], undefined],
    ["no query", {}, undefined],
    ["empty query", { query: "   " }, undefined],
    ["query too long", { query: "x".repeat(401) }, undefined],
    ["query not a string", { query: 5 }, undefined],
    ["count 0", { query: "q", count: 0 }, undefined],
    ["count 11", { query: "q", count: 11 }, undefined],
    ["count 2.5", { query: "q", count: 2.5 }, undefined],
    ["count a string", { query: "q", count: "3" }, undefined],
    ["bad freshness", { query: "q", freshness: "hour" }, undefined],
    ["huge body", { query: "q", pad: "x".repeat(20_000) }, undefined],
  ])("400 bad_request: %s", async (_name, body, raw) => {
    const res = await rig.search(body, raw ? { raw } : {});
    expect(res.status).toBe(400);
    expect((await errJson(res)).code).toBe("bad_request");
    expect(rig.requests).toHaveLength(0);
  });

  it("accepts 400 characters, defaults count to 5 and passes freshness only when asked", async () => {
    await okJson(await rig.search({ query: "q".repeat(400) }));
    const url = new URL(rig.forProvider("brave")[0]!.path, "http://x");
    expect(url.searchParams.get("count")).toBe("5");
    expect(url.searchParams.has("freshness")).toBe(false);
  });

  it("records one call-log row per provider attempt under the step id, with no query text anywhere", async () => {
    rig.on("brave", { status: 500, body: "broken" });
    const secretQuery = "needle-query-7f3a9c";
    const out = await okJson(await rig.search({ query: secretQuery }, { step: "step-log" }));
    expect(out.provider).toBe("searxng");
    const rows = await rig.getCalls("step-log");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      stepId: "step-log",
      model: "search:brave",
      status: 502,
      usage: null,
      error: { code: "search_failed" },
    });
    expect(rows[1]).toMatchObject({ stepId: "step-log", model: "search:searxng", status: 200, error: null });
    expect(rows[1]!.totalMs).not.toBeNull();
    expect(rig.logs.join("\n")).toContain('"provider":"searxng","results":4');
    expect(rig.logs.join("\n")).not.toContain(secretQuery);
    for (const bytes of rig.files()) expect(bytes.includes(secretQuery)).toBe(false);
  });

  it("never lets a key reach an error, a log line or a stored row, even when the upstream echoes it", async () => {
    rig.on("brave", (req) => ({
      status: 500,
      headers: { "x-echo": String(req.headers["x-subscription-token"]) },
      body: `denied for ${String(req.headers["x-subscription-token"])}`,
    }));
    rig.on("searxng", { status: 503, body: `also ${KEYS.brave}` });
    const res = await rig.search({ query: "q" }, { step: "step-leak" });
    expect(res.status).toBe(503);
    const text =
      JSON.stringify(await res.json()) +
      [...res.headers].join("\n") +
      rig.logs.join("\n") +
      JSON.stringify(await rig.getCalls("step-leak"));
    for (const secret of [KEYS.brave, KEYS.tavily, KEYS.exa, rig.standin]) {
      expect(text).not.toContain(secret);
      for (const bytes of rig.files()) expect(bytes.includes(secret)).toBe(false);
    }
    expect(text).not.toContain("denied for");
    expect(text).not.toContain("also ");
  });

  it("does not follow redirects from a provider", async () => {
    rig.on("brave", { status: 302, headers: { location: "http://127.0.0.1:9/" } });
    expect((await okJson(await rig.search({ query: "q" }))).provider).toBe("searxng");
  });
});

describe("searxng: external instances", () => {
  let rig: SearchRig | undefined; // the stub-fetch tests start none
  afterEach(async () => {
    await rig?.stop();
    rig = undefined;
  });
  const ask = async () => (await rig!.search({ query: "q" }, { step: "step-sx" })).status;

  it.each(["/searx", "/searx/"])("an instance under a path prefix (%s) is queried below it", async (searxngPath) => {
    rig = await startSearchRig({ providers: ["searxng"], searxngPath });
    rig!.on("searxng", { body: SEARXNG });
    expect((await okJson(await rig!.search({ query: "q" }))).provider).toBe("searxng");
    const url = new URL(rig!.forProvider("searxng")[0]!.path, "http://x");
    expect(url.pathname).toBe("/searx/search");
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("basic auth from a user:password key file; the key and its encodings never reach a response, log or call row", async () => {
    const line = "alice:s3cret-pass-word";
    rig = await startSearchRig({ providers: ["searxng"], keys: { searxng: line } });
    rig!.on("searxng", (req) => ({ status: 500, body: `denied ${String(req.headers.authorization)}` }));
    expect(await ask()).toBe(503);
    expect(rig!.forProvider("searxng")[0]!.headers.authorization).toBe(`Basic ${btoa(line)}`);
    const text =
      JSON.stringify(await (await rig!.search({ query: "q" }, { step: "step-sx2" })).json()) +
      rig!.logs.join("\n") +
      JSON.stringify(await rig!.getCalls("step-sx")) +
      JSON.stringify(await rig!.getCalls("step-sx2"));
    for (const secret of [line, btoa(line), "s3cret-pass-word"]) {
      expect(text).not.toContain(secret);
      for (const bytes of rig!.files()) expect(bytes.includes(secret)).toBe(false);
    }
  });

  it.each([
    [
      "Authorization: Bearer tok-1234567890abcdef",
      "authorization",
      "Bearer tok-1234567890abcdef",
      "tok-1234567890abcdef",
    ],
    ["X-API-Key: key-1234567890abcdef", "x-api-key", "key-1234567890abcdef", "key-1234567890abcdef"],
  ])("a header-line key file (%s) is sent as that header and redacted", async (line, name, value, secret) => {
    rig = await startSearchRig({ providers: ["searxng"], keys: { searxng: line } });
    rig!.on("searxng", (req) => ({ status: 500, body: `echo ${String(req.headers[name])}` }));
    expect(await ask()).toBe(503);
    expect(rig!.forProvider("searxng")[0]!.headers[name]).toBe(value);
    expect(rig!.logs.join("\n")).not.toContain(secret);
    expect(JSON.stringify(await rig!.getCalls("step-sx"))).not.toContain(secret);
  });

  it("no key file, no credentials header; a malformed key file fails the provider without echoing it", async () => {
    rig = await startSearchRig({ providers: ["searxng"] });
    rig!.on("searxng", { body: SEARXNG });
    await ask();
    expect(rig!.forProvider("searxng")[0]!.headers.authorization).toBeUndefined();
    await rig!.stop();
    rig = await startSearchRig({ providers: ["searxng"], keys: { searxng: "no-colon-here-at-all" } });
    rig!.on("searxng", { body: SEARXNG });
    const res = await rig!.search({ query: "q" });
    expect(res.status).toBe(503);
    expect(rig!.requests).toHaveLength(0);
    expect(rig!.logs.join("\n")).toContain('"errorCode":"search_failed","reason":"bad_key_file"');
    expect(rig!.logs.join("\n")).not.toContain("no-colon-here-at-all");
  });

  it("does not invent a forwarded client address for any external instance", async () => {
    const sent: Record<string, string>[] = [];
    const fetch = (async (_url: URL, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return new Response(SEARXNG);
    }) as unknown as typeof globalThis.fetch;
    const ctx = (baseUrl: string) => ({ fetch, signal: new AbortController().signal, key: null, baseUrl });
    await searxng.search({ query: "q", count: 1 }, ctx("http://searxng:8080"));
    await searxng.search({ query: "q", count: 1 }, ctx("https://search.example.org/searx"));
    await searxng.search({ query: "q", count: 1 }, ctx("http://127.0.0.1:8080"));
    expect(sent[0]).not.toHaveProperty("x-forwarded-for");
    expect(sent[1]).not.toHaveProperty("x-forwarded-for");
    expect(sent[2]).not.toHaveProperty("x-forwarded-for");
  });

  it("a 403 says the JSON format is probably disabled, a 401 the credentials, and the next provider still runs", async () => {
    rig = await startSearchRig({ providers: ["searxng", "exa"] });
    rig!.on("searxng", { status: 403, body: "<html>Forbidden</html>" });
    rig!.on("exa", (req) => ({ headers: SSE, body: exaReply("exa-search.sse", req) }));
    expect((await okJson(await rig!.search({ query: "q" }))).provider).toBe("exa");
    expect(rig!.logs.join("\n")).toContain(
      '"provider":"searxng","results":null,"errorCode":"search_failed","reason":"json_disabled"',
    );
    await expect(
      searxng.search(
        { query: "q", count: 1 },
        {
          fetch: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
          signal: new AbortController().signal,
          key: null,
          baseUrl: "http://x",
        },
      ),
    ).rejects.toThrow(/credentials \(401\)/);
  });

  it("a redirect (a login page) is a failure with a clear message, and is not followed", async () => {
    rig = await startSearchRig({ providers: ["searxng"] });
    rig!.on("searxng", { status: 302, headers: { location: "http://127.0.0.1:9/login" } });
    expect(await ask()).toBe(503);
    expect(rig!.logs.join("\n")).toContain('"reason":"redirected"');
    expect(rig!.requests).toHaveLength(1);
  });

  it("a 200 HTML page (a bot check in front of a public instance) is a failure with a clear message", async () => {
    rig = await startSearchRig({ providers: ["searxng"] });
    rig!.on("searxng", {
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<!doctype html><title>Security check</title>",
    });
    expect(await ask()).toBe(503);
    expect(rig!.logs.join("\n")).toContain('"reason":"html_page"');
  });
});

describe("/status search field and search-check", () => {
  let rig: SearchRig;
  afterEach(() => rig.stop());
  const status = async () => ((await (await fetch(`${rig.base}/status`)).json()) as GatewayStatus).search;

  it("lists the providers in order with whether each is configured, and the SearXNG URL; never a key", async () => {
    rig = await startSearchRig({ keys: { brave: KEYS.brave } });
    const s = await status();
    expect(s.searxngUrl).toBe(rig.fakeUrl);
    expect(s.providers).toEqual([
      { id: "brave", configured: true, limitedUntil: null },
      { id: "tavily", configured: false, limitedUntil: null },
      { id: "searxng", configured: true, limitedUntil: null },
      { id: "exa", configured: true, limitedUntil: null },
    ]);
    expect(JSON.stringify(s)).not.toContain(KEYS.brave);
  });

  it("shows a remembered 429 as limitedUntil until it has passed", async () => {
    rig = await startSearchRig({ providers: ["brave", "searxng"], keys: KEYS });
    rig.on("brave", { status: 429, headers: { "retry-after": "30" } });
    await rig.search({ query: "q" });
    expect((await status()).providers).toEqual([
      { id: "brave", configured: true, limitedUntil: rig.clock.t + 30_000, lastError: "search_rate_limited" },
      { id: "searxng", configured: true, limitedUntil: null, lastError: "search_failed" },
    ]);
    rig.clock.t += 31_000;
    expect((await status()).providers[0]!.limitedUntil).toBeNull();
  });

  it("search is off without deps: empty providers", async () => {
    rig = await startSearchRig({ noSearch: true });
    expect(await status()).toEqual({ providers: [], searxngUrl: null });
  });

  it("search-check: one line per provider in order: ok, skipped (no key), rate_limited, failed; the keys appear nowhere", async () => {
    rig = await startSearchRig({
      providers: ["brave", "tavily", "searxng", "exa"],
      keys: { brave: KEYS.brave, exa: KEYS.exa },
    });
    rig.on("brave", { body: BRAVE });
    rig.on("searxng", { status: 500, body: `boom ${KEYS.brave}` });
    rig.on("exa", { status: 429, headers: { "retry-after": "5" } });
    const lines = await searchCheck(rig.searchDeps, { now: () => rig.clock.t });
    expect(lines).toEqual([
      { provider: "brave", status: "ok", results: 1, message: null },
      { provider: "tavily", status: "skipped", results: null, message: null },
      { provider: "searxng", status: "failed", results: null, message: "SearXNG answered 500." },
      { provider: "exa", status: "rate_limited", results: null, message: expect.any(String) },
    ]);
    expect(rig.forProvider("brave")[0]!.path).toContain("count=1");
    expect(JSON.stringify(lines)).not.toContain(KEYS.brave);
  });

  it("search-check: an answer with no results is a failure; a provider that cannot be reached is a failure with a key-free message", async () => {
    rig = await startSearchRig({ providers: ["brave", "tavily"], keys: KEYS });
    rig.on("brave", { body: JSON.stringify({ web: { results: [] } }) });
    const lines = await searchCheck({
      ...rig.searchDeps,
      endpoints: { ...rig.searchDeps.endpoints, tavily: "http://127.0.0.1:1" },
    });
    expect(lines.map((l) => [l.provider, l.status])).toEqual([
      ["brave", "failed"],
      ["tavily", "failed"],
    ]);
    expect(lines[0]!.message).toBe("answered with no results");
    expect(JSON.stringify(lines)).not.toContain(KEYS.tavily);
  });
});

describe("units", () => {
  it("searxng without a URL is not configured", async () => {
    const service = createSearchService(
      { providers: ["searxng"], keys: async () => null },
      { fetch, now: Date.now, addSecret: () => {} },
    );
    expect(await service.status()).toEqual([{ id: "searxng", configured: false, limitedUntil: null }]);
  });
  it("plainText strips tags and entities once, collapses space, removes invisible characters and truncates", () => {
    expect(plainText("<p>Hello&nbsp;<b>world</b></p><script>alert(1)</script>&amp;lt; &#65;&#x42; &bogus;", 100)).toBe(
      "Hello world &lt; AB &bogus;",
    );
    expect(plainText(`a${String.fromCharCode(0x200b)}b${String.fromCharCode(7)}c\n\n d`, 10)).toBe("abc d");
    expect(plainText("x".repeat(20), 10)).toBe("xxxxxxxxx…");
    expect(plainText(undefined, 10)).toBe("");
  });

  it("cleanUrl accepts only http(s) without credentials", () => {
    expect(cleanUrl("https://a.example/x?y=1")).toBe("https://a.example/x?y=1");
    for (const bad of [
      "ftp://a.example",
      "javascript:alert(1)",
      "data:text/html,x",
      "https://u:p@a.example/",
      "not a url",
      "",
      5,
      null,
    ])
      expect(cleanUrl(bad)).toBeNull();
  });

  it("retryAfterSeconds reads seconds or a date, bounded, with a default", () => {
    expect(retryAfterSeconds(new Headers({ "retry-after": "17" }))).toBe(17);
    expect(retryAfterSeconds(new Headers({ "retry-after": "999999" }))).toBe(3600);
    expect(
      retryAfterSeconds(new Headers({ "retry-after": new Date(1_000_000 + 45_000).toUTCString() }), 60, 1_000_000),
    ).toBe(45);
    expect(retryAfterSeconds(new Headers())).toBe(60);
    expect(retryAfterSeconds(new Headers({ "retry-after": "soon" }))).toBe(60);
  });

  it("parseExaText reads the block format and rejects other text", () => {
    const text =
      "Title: A\nURL: https://a.example/\nPublished: 2026-01-02T03:04:05.000Z\nAuthor: N/A\nHighlights:\nfirst\n\nTitle: B\nURL: https://b.example/\nPublished: N/A\nAuthor: Zed\nHighlights:\nsecond line\nTitle: not a header";
    expect(parseExaText(text, 5)).toEqual([
      { title: "A", url: "https://a.example/", snippet: "first", published: "2026-01-02T03:04:05.000Z" },
      { title: "B", url: "https://b.example/", snippet: "second line Title: not a header" },
    ]);
    expect(parseExaText("No results found.", 5)).toEqual([]);
    expect(parseExaText("something else entirely", 5)).toBeNull();
  });

  it("parseProviderList validates names and drops duplicates", () => {
    expect(parseProviderList(" Exa , brave,exa")).toEqual(["exa", "brave"]);
    expect(() => parseProviderList("brave,bing")).toThrow(/unknown provider "bing"/);
  });
});

describe("explicit Exa authentication modes", () => {
  it("falls back from rate-limited keyless Exa to authenticated Exa independently", async () => {
    const rig = await startSearchRig({ providers: ["exa", "exa-api"], keys: { exa: KEYS.exa } });
    try {
      rig.on("exa", (req) => ({ headers: SSE, body: exaReply("exa-ratelimited.sse", req) }));
      rig.on("exa-api", (req) => ({ headers: SSE, body: exaReply("exa-search.sse", req) }));

      expect((await okJson(await rig.search({ query: "wikipedia" }))).provider).toBe("exa-api");
      expect(rig.requests.map(({ provider, headers }) => [provider, headers["x-api-key"]])).toEqual([
        ["exa", undefined],
        ["exa-api", KEYS.exa],
      ]);
      expect((await okJson(await rig.search({ query: "wikipedia" }))).provider).toBe("exa-api");
      expect(rig.forProvider("exa")).toHaveLength(1);
      expect(rig.forProvider("exa-api")).toHaveLength(2);
    } finally {
      await rig.stop();
    }
  });
  it("paid Exa is unavailable without a key", async () => {
    const service = createSearchService(
      { providers: ["exa-api"], keys: async () => null },
      {
        fetch: async () => {
          throw new Error("must not call the provider");
        },
        now: Date.now,
        addSecret() {},
      },
    );
    expect(await service.status()).toEqual([{ id: "exa-api", configured: false, limitedUntil: null }]);
  });
});
