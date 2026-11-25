import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { SearchDeps } from "../src/core/search/service.ts";
import { createSearchService } from "../src/core/search/service.ts";

const brave = readFileSync(new URL("./fixtures/brave-search.json", import.meta.url), "utf8");
function setup(options: Partial<SearchDeps> = {}) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (url) =>
      String(url).includes("api.openai.com") ? new Response("denied", { status: 403 }) : new Response(brave),
    );
  const clock = { now: 1000 };
  const access = vi.fn().mockResolvedValue({ token: "test-access", model: "gpt-6-luna" });
  const deps: SearchDeps = {
    providers: ["codex-subscription", "brave"],
    keys: async () => "test-key",
    subscription: { configured: async () => true, access },
    ...options,
  };
  const service = createSearchService(deps, { fetch, now: () => clock.now, addSecret() {} });
  return { service, fetch, access, deps, clock };
}
const query = { query: "Vite", count: 1 };
it("falls back from subscription denial to Brave and records provenance", async () => {
  const r = setup();
  const out = await r.service.run(query, new AbortController().signal);
  expect(out).toMatchObject({
    ok: true,
    provider: "brave",
    trace: [
      { provider: "codex-subscription", status: "failed", reason: "subscription_denied" },
      { provider: "brave", status: "succeeded" },
    ],
  });
  expect(r.fetch.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
    "api.openai.com",
    "api.search.brave.com",
  ]);
});
it("skips unavailable subscription credentials without contacting OpenAI", async () => {
  const r = setup({ subscription: { configured: async () => false, access: vi.fn() } });
  expect(await r.service.run(query, new AbortController().signal)).toMatchObject({
    ok: true,
    provider: "brave",
    trace: [{ status: "skipped", reason: "not_configured" }, { status: "succeeded" }],
  });
  expect(r.fetch).toHaveBeenCalledOnce();
});
it("remembers subscription rate limits and retries it only after cooldown", async () => {
  const r = setup();
  r.fetch.mockImplementation(async (url) =>
    String(url).includes("api.openai.com")
      ? new Response("limited", { status: 429, headers: { "retry-after": "30" } })
      : new Response(brave),
  );
  await r.service.run(query, new AbortController().signal);
  expect(await r.service.status()).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "codex-subscription", limitedUntil: 31000 })]),
  );
  const next = await r.service.run(query, new AbortController().signal);
  expect(next.trace[0]).toMatchObject({ status: "skipped", reason: "rate_limited" });
  expect(r.access).toHaveBeenCalledOnce();
  r.clock.now = 32000;
  await r.service.run(query, new AbortController().signal);
  expect(r.access).toHaveBeenCalledTimes(2);
});
it("stops immediately on client cancellation instead of falling back", async () => {
  const r = setup();
  const abort = new AbortController();
  r.fetch.mockImplementation(async () => {
    abort.abort();
    throw new Error("cancelled");
  });
  expect(await r.service.run(query, abort.signal)).toMatchObject({ ok: false, code: "client_aborted" });
  expect(r.fetch).toHaveBeenCalledOnce();
});
it("uses the chain deadline and leaves later providers uncalled once exhausted", async () => {
  const r = setup({ providers: ["brave", "tavily"], totalTimeoutMs: 15, timeoutMs: 1000 });
  r.fetch.mockImplementation(
    async (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
      ),
  );
  expect(await r.service.run(query, new AbortController().signal)).toMatchObject({ ok: false, code: "search_timeout" });
  expect(r.fetch).toHaveBeenCalledOnce();
});
it("falls back after a per-provider timeout within the chain budget", async () => {
  const r = setup({ timeoutMs: 10 });
  r.fetch.mockImplementation(async (url, init) =>
    String(url).includes("api.openai.com")
      ? new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
        )
      : new Response(brave),
  );
  expect(await r.service.run(query, new AbortController().signal)).toMatchObject({ ok: true, provider: "brave" });
});
it("snapshots order for an in-flight query and reports disabled providers only in full readiness", async () => {
  const r = setup();
  r.fetch.mockImplementation(async (url) => {
    r.deps.providers = [];
    return String(url).includes("api.openai.com") ? new Response("denied", { status: 403 }) : new Response(brave);
  });
  expect(await r.service.run(query, new AbortController().signal)).toMatchObject({ ok: true, provider: "brave" });
  expect(await r.service.status()).toEqual([]);
  expect(await r.service.status(true)).toHaveLength(6);
  expect(await r.service.run(query, new AbortController().signal)).toMatchObject({
    ok: false,
    code: "search_unavailable",
  });
});
