import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@rei/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayApp } from "../src/core/proxy.ts";
import { createRedactor } from "../src/core/redact.ts";
import { createSearchService, parseProviderList } from "../src/core/search/service.ts";
import { FileCredentialStore } from "../src/node/credstore.ts";
import { subscriptionSearch } from "../src/node/subscription-search.ts";
import { noopCallLog } from "./noop-calls.ts";

const source = { url: "https://vite.dev/", title: "Vite" };
const search = {
  id: "ws",
  type: "web_search_call",
  status: "completed",
  action: { sources: [source, { url: "javascript:alert(1)" }] },
};
const message = {
  id: "msg",
  type: "message",
  role: "assistant",
  content: [
    {
      type: "output_text",
      text: "Vite is here.",
      annotations: [{ type: "url_citation", ...source, start_index: 0, end_index: 4 }],
    },
  ],
};
const completed = {
  type: "response.completed",
  response: { status: "completed", output: [], usage: { input_tokens: 20, output_tokens: 8 } },
};
const events = [
  { type: "response.output_item.done", output_index: 0, item: search },
  { type: "response.output_item.done", output_index: 1, item: message },
  completed,
];
const sse = (values: unknown[]) => values.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join("");
function rig(reply = new Response(sse(events)), timeoutMs = 1000) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply);
  const access = vi.fn().mockResolvedValue({ token: "subscription-test-token", model: "account-model" });
  const redactor = createRedactor();
  const calls: unknown[] = [];
  const keys = vi.fn().mockResolvedValue("unused-api-key");
  const deps = {
    providers: ["codex-subscription"] as const,
    keys,
    timeoutMs,
    subscription: { configured: async () => true, access },
  };
  const app = createGatewayApp({
    standin: "standin",
    tokens: { accessToken: async () => "unused", status: async () => ({ signedIn: true, accessExpiresInS: 300 }) },
    calls: noopCallLog({
      insert: (record) => {
        calls.push(record);
      },
    }),
    models: () => [],
    version: "test",
    upstreams: [],
    redactor,
    log: nullLogger,
    search: deps,
    fetch,
  });
  const run = () =>
    app.request("/search", {
      method: "POST",
      headers: { authorization: "Bearer standin", "content-type": "application/json" },
      body: JSON.stringify({ query: "official Vite site", count: 1, freshness: "week" }),
    });
  return { run, fetch, access, keys, calls, redactor, deps };
}
afterEach(() => vi.unstubAllGlobals());

describe("subscription search through the gateway", () => {
  it("preserves streamed items when final output is empty, citations, all sources and actual usage", async () => {
    const r = rig();
    const response = await r.run();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      provider: "codex-subscription",
      results: [],
      answer: {
        text: "Vite is here.",
        model: "account-model",
        searchCalls: 1,
        sources: [source],
        citations: [{ ...source, start: 0, end: 4 }],
        freshness: "research_preference",
      },
    });
    expect(body.answer).not.toHaveProperty("published");
    expect(r.access).toHaveBeenCalledWith(expect.any(AbortSignal), "gpt-6-luna");
    expect(r.fetch).toHaveBeenCalledOnce();
    const [url, init] = r.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "account-model",
      stream: true,
      store: false,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
    });
    expect(r.keys).not.toHaveBeenCalled();
    expect(r.calls).toEqual([
      expect.objectContaining({
        model: "search:codex-subscription",
        status: 200,
        usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 0 },
      }),
    ]);
    expect(JSON.stringify(r.calls)).not.toContain("official Vite site");
    expect(r.redactor.redact("subscription-test-token")).not.toContain("subscription-test-token");
  });
  it("accepts a terminal response carrying all output without item-done events", async () => {
    const response = await rig(
      new Response(sse([{ type: "response.completed", response: { status: "completed", output: [search, message] } }])),
    ).run();
    expect(response.status).toBe(200);
  });
  it.each([401, 403, 429, 500])("fails visibly on HTTP %i without fallback", async (status) => {
    const r = rig(new Response("private error", { status }));
    const res = await r.run();
    expect(res.status).toBe(status === 429 ? 429 : 503);
    expect(r.fetch).toHaveBeenCalledOnce();
    expect(await res.text()).not.toContain("private error");
  });
  it.each([
    ["stream drop", events.slice(0, 2)],
    ["failure", [...events, { type: "response.failed", response: { error: { message: "secret" } } }]],
    ["incomplete", [{ type: "response.incomplete" }]],
    ["no search", [{ type: "response.completed", response: { status: "completed", output: [message] } }]],
    ["no citations", [{ type: "response.completed", response: { status: "completed", output: [search] } }]],
  ])("rejects %s", async (_name, values) => {
    const r = rig(new Response(sse(values)));
    expect((await r.run()).status).toBe(503);
    expect(r.fetch).toHaveBeenCalledOnce();
  });
  it("times out a stalled request and never attempts a fallback", async () => {
    const r = rig(undefined, 10);
    r.fetch.mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")))),
    );
    const response = await r.run();
    expect(await response.json()).toMatchObject({ error: { code: "search_timeout" } });
    expect(r.fetch).toHaveBeenCalledOnce();
  });
  it("fails without subscription credentials when no fallback is enabled", async () => {
    const r = rig();
    delete (r.deps as { subscription?: unknown }).subscription;
    expect((await r.run()).status).toBe(503);
    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.keys).not.toHaveBeenCalled();
  });
  it("reports unavailable credentials without trying to refresh for status", async () => {
    const access = vi.fn();
    const service = createSearchService(
      {
        providers: ["codex-subscription"],
        keys: async () => null,
        subscription: { configured: async () => false, access },
      },
      { fetch: globalThis.fetch, now: Date.now, addSecret() {} },
    );
    expect(await service.status()).toEqual([{ id: "codex-subscription", configured: false, limitedUntil: null }]);
    expect(access).not.toHaveBeenCalled();
    expect(parseProviderList("codex-subscription,exa")).toEqual(["codex-subscription", "exa"]);
  });
});

it("rejects an API key before token resolution and discovers a model only from an OAuth account catalog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rei-subscription-"));
  try {
    const store = new FileCredentialStore(join(dir, "credentials.json"));
    await store.modify("openai", async () => ({ type: "api_key", key: "test-api-key" }));
    const accessToken = vi.fn().mockResolvedValue("test-oauth-access");
    const auth = subscriptionSearch(
      store,
      { accessToken, status: async () => ({ signedIn: true, accessExpiresInS: 300 }) },
      () => {},
    );
    await expect(auth.access(new AbortController().signal)).rejects.toMatchObject({ reason: "subscription_required" });
    expect(accessToken).not.toHaveBeenCalled();
    await store.modify("openai", async () => ({
      type: "oauth",
      access: "test-oauth-access",
      refresh: "test-refresh",
      expires: Date.now() + 3600000,
    }));
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        models: [
          { slug: "no-search", supported_in_api: true },
          { slug: "gpt-6-luna", supported_in_api: true, web_search_tool_type: "text_and_image" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(auth.access(new AbortController().signal)).resolves.toEqual({
      token: "test-oauth-access",
      model: "gpt-6-luna",
    });
    fetch.mockResolvedValue(
      Response.json({
        models: [{ slug: "other-model", supported_in_api: true, web_search_tool_type: "text_and_image" }],
      }),
    );
    await expect(auth.access(new AbortController().signal, "missing-model")).rejects.toMatchObject({
      reason: "subscription_model_unavailable",
    });
    fetch.mockResolvedValue(
      Response.json({
        models: [{ slug: "chosen-model", supported_in_api: true, web_search_tool_type: "text_and_image" }],
      }),
    );
    await expect(auth.access(new AbortController().signal, "chosen-model")).resolves.toMatchObject({
      model: "chosen-model",
    });
    fetch.mockResolvedValue(Response.json({ models: [] }));
    await expect(auth.access(new AbortController().signal)).rejects.toMatchObject({
      reason: "subscription_model_unavailable",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
