import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { nullLogger } from "@rei/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayApp } from "../src/core/proxy.ts";
import { createRedactor } from "../src/core/redact.ts";
import { FileCredentialStore } from "../src/node/credstore.ts";
import { FileProviderManager } from "../src/node/providers.ts";
import { noopCallLog } from "./noop-calls.ts";

let dir: string;
let credentials: FileCredentialStore;
let providers: FileProviderManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rei-providers-"));
  credentials = new FileCredentialStore(join(dir, "secret", "credentials.json"));
  providers = new FileProviderManager(join(dir, "secret", "providers.json"), credentials);
});
afterEach(() => {
  vi.restoreAllMocks();
  providers.cancelOpenAiOAuth();
  rmSync(dir, { recursive: true, force: true });
});

function providerApp() {
  return createGatewayApp({
    standin: "test-standin",
    providers,
    tokens: { accessToken: async () => "", status: async () => ({ signedIn: false, accessExpiresInS: null }) },
    calls: noopCallLog(),
    models: () => [],
    version: "test",
    upstreams: [],
    redactor: createRedactor(),
    log: nullLogger,
  });
}

describe("provider route authentication", () => {
  it.each([
    ["GET", "/providers"],
    ["POST", "/providers"],
    ["POST", "/providers/scan"],
    ["DELETE", "/providers/custom"],
    ["POST", "/providers/openai/oauth/start"],
    ["GET", "/providers/openai/oauth/status"],
    ["POST", "/providers/openai/oauth/callback"],
    ["DELETE", "/providers/openai/oauth"],
  ])("requires the server token for %s %s", async (method, path) => {
    const app = providerApp();
    for (const token of ["", "wrong-standin"]) {
      const response = await app.request(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "bad_token" } });
    }
  });

  it("accepts an authenticated request to a provider subroute", async () => {
    const response = await providerApp().request("/providers/openai/oauth/status", {
      headers: { authorization: "Bearer test-standin" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pending: false });
  });
});

describe("gateway provider settings", () => {
  it("reports only connected providers in public status, without private connection data", async () => {
    await providers.save({
      id: "local",
      kind: "openai-compatible",
      name: "Local model",
      baseUrl: "https://private-provider.example/v1",
      apiKey: "test-private-local-key",
      models: ["private-model"],
    });
    await providers.save({ kind: "openai", name: "Disconnected OpenAI", apiKey: "test-disconnected-key" });
    await credentials.delete("openai");
    await providers.save({
      id: "other",
      kind: "openai-compatible",
      name: "Other",
      baseUrl: "https://other-provider.example/v1",
      apiKey: "test-private-other-key",
      models: ["other-model"],
    });

    const response = await providerApp().request("/status");
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status.providers).toEqual([
      { id: "local", name: "Local model", kind: "openai-compatible" },
      { id: "other", name: "Other", kind: "openai-compatible" },
    ]);
    for (const privateValue of [
      "test-private-local-key",
      "test-private-other-key",
      "test-disconnected-key",
      "https://private-provider.example/v1",
      "private-model",
    ])
      expect(JSON.stringify(status)).not.toContain(privateValue);
  });

  it("scans the container host endpoint and reuses keys only for the saved URL", async () => {
    const saved = await providers.save({
      kind: "openai-compatible",
      name: "oMLX",
      baseUrl: "http://host.docker.internal:18000/v1",
      apiKey: "local-test-key",
      models: ["small-model"],
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: [{ id: "small-model" }, { id: "small-model" }, { id: 23 }] }));
    expect(await providers.scanModels({ id: saved.id, baseUrl: saved.baseUrl! })).toEqual({ models: ["small-model"] });
    expect(fetch).toHaveBeenLastCalledWith(
      `${saved.baseUrl}/models`,
      expect.objectContaining({ headers: { authorization: "Bearer local-test-key" }, redirect: "error" }),
    );
    fetch.mockResolvedValueOnce(Response.json({ data: [] }));
    await providers.scanModels({ id: saved.id, baseUrl: "https://another.example/v1" });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://another.example/v1/models",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("reads each model's context and output limits from the endpoint and keeps only the saved, valid ones", async () => {
    const saved = await providers.save({
      kind: "openai-compatible",
      name: "limits",
      baseUrl: "https://limits.example/v1",
      apiKey: "local-test-key",
      models: ["sized", "unsized"],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [
          { id: "sized", context_length: 32768, max_completion_tokens: 4096 },
          { id: "unsized", owned_by: "x" },
          { id: "unlisted", context_length: 1024 },
          { id: "bad", context_length: -5 },
        ],
      }),
    );
    expect(await providers.scanModels({ id: saved.id, baseUrl: saved.baseUrl! })).toEqual({
      models: ["sized", "unsized", "unlisted", "bad"],
      modelInfo: { sized: { contextWindow: 32768, maxTokens: 4096 }, unlisted: { contextWindow: 1024 } },
    });
    // Limits are saved only for models in the connection's list; invalid numbers never reach the store.
    const stored = await providers.save({
      id: saved.id,
      kind: "openai-compatible",
      name: "limits",
      baseUrl: "https://limits.example/v1",
      models: ["sized"],
      modelInfo: { sized: { contextWindow: 8192, maxTokens: 0 }, other: { contextWindow: 9 } },
    });
    expect(stored.modelInfo).toEqual({ sized: { contextWindow: 8192 } });
  });

  it("rejects unsafe scan URLs and hides upstream authentication error bodies", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret-detail", { status: 401 }));
    for (const baseUrl of [
      "http://192.168.1.5/v1",
      "https://user:password@example.com/v1",
      "https://example.com/v1?api_key=secret",
    ])
      await expect(providers.scanModels({ baseUrl })).rejects.toThrow("Use HTTPS");
    expect(fetch).not.toHaveBeenCalled();
    await expect(providers.scanModels({ baseUrl: "https://example.com/v1" })).rejects.toThrow("HTTP 401");
    fetch.mockResolvedValueOnce(Response.json({ wrong: [] }));
    await expect(providers.scanModels({ baseUrl: "https://example.com/v1" })).rejects.toThrow(
      "OpenAI-compatible model list",
    );
  });

  it("keeps every connection when saves arrive concurrently", async () => {
    const inputs = ["first", "second", "third"].map((id) => ({
      id,
      kind: "openai-compatible" as const,
      name: id,
      baseUrl: "https://llm.example/v1",
      models: ["model-a"],
      apiKey: `test-key-${id}`,
    }));
    await Promise.all(inputs.map((input) => providers.save(input)));
    expect((await providers.list()).map((row) => row.id).sort()).toEqual(["first", "second", "third"]);
    for (const input of inputs) expect(await providers.token(input.id)).toBe(input.apiKey);
  });

  it("keeps accepting mutations after an earlier save fails", async () => {
    const rejected = providers.save({ kind: "openai", name: "Missing key" });
    const accepted = providers.save({ kind: "openai", name: "Valid", apiKey: "test-key" });
    await expect(rejected).rejects.toThrow("API key is required");
    await expect(accepted).resolves.toMatchObject({ id: "openai" });
    await providers.remove("openai");
    expect(await providers.list()).toEqual([]);
  });

  it("stores API keys privately and returns only redacted connection metadata", async () => {
    const openai = await providers.save({ kind: "openai", name: "OpenAI", apiKey: "sk-private-openai" });
    const custom = await providers.save({
      kind: "openai-compatible",
      name: "Local model service",
      baseUrl: "https://llm.example/v1/",
      models: ["model-a"],
      apiKey: "sk-private-custom",
    });

    expect(await providers.list()).toEqual([openai, custom]);
    expect(JSON.stringify(await providers.list())).not.toContain("sk-private");
    expect(await providers.token("openai")).toBe("sk-private-openai");
    expect(await providers.token(custom.id)).toBe("sk-private-custom");
    expect(await providers.upstreams()).toContainEqual({
      protocol: "https:",
      host: "llm.example",
      port: "",
      pathPrefix: "/v1/",
    });
    expect(statSync(credentials.file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "secret", "providers.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "secret", "providers.json"), "utf8")).not.toContain("sk-private");
  });

  it("accepts keyless HTTPS endpoints and checks endpoint and ID validation", async () => {
    const row = await providers.save({
      kind: "openai-compatible",
      name: "No key",
      baseUrl: "https://llm.example/v1",
      models: ["model-a"],
    });
    expect(row.connected).toBe(true);
    expect(await providers.token(row.id)).toBe("");
    await expect(
      providers.save({ kind: "openai-compatible", name: "Bad", baseUrl: "https://llm.example/v1", models: [] }),
    ).rejects.toThrow("at least one model ID");
    await expect(
      providers.save({ kind: "openai-compatible", name: "Bad", baseUrl: "http://192.168.1.5/v1", models: ["model-a"] }),
    ).rejects.toThrow("Use HTTPS");
    await expect(
      providers.save({
        kind: "openai-compatible",
        id: "openai",
        name: "Collision",
        baseUrl: "https://llm.example/v1",
        models: ["model-a"],
      }),
    ).rejects.toThrow("reserved");
  });

  it("stores the Responses API choice only for custom endpoints and defaults to Chat Completions", async () => {
    const responses = await providers.save({
      kind: "openai-compatible",
      id: "resp-1",
      name: "Responses",
      baseUrl: "https://llm.example/v1",
      api: "responses",
      models: ["model-a"],
    });
    expect(responses.api).toBe("responses");
    const chat = await providers.save({
      kind: "openai-compatible",
      id: "chat-1",
      name: "Chat",
      baseUrl: "https://llm.example/v1",
      models: ["model-a"],
    });
    expect(chat.api).toBeUndefined();
    // Switching an existing endpoint back to Chat Completions clears the stored choice.
    const switched = await providers.save({
      kind: "openai-compatible",
      id: "resp-1",
      name: "Responses",
      baseUrl: "https://llm.example/v1",
      api: "chat",
      models: ["model-a"],
    });
    expect(switched.api).toBeUndefined();
    expect((await providers.list()).find((row) => row.id === "resp-1")?.api).toBeUndefined();
    await expect(
      providers.save({
        kind: "openai-compatible",
        name: "Bad",
        baseUrl: "https://llm.example/v1",
        models: ["model-a"],
        api: "anthropic" as never,
      }),
    ).rejects.toThrow("Chat Completions or Responses");
  });

  it("requires a new API key before changing an OpenAI OAuth connection to API-key auth", async () => {
    await credentials.modify(
      "openai",
      async () =>
        ({
          type: "oauth",
          access: "previous-access",
          refresh: "previous-refresh",
          expires: Date.now() + 3_600_000,
          clientId: "issued-client",
          scopes: ["openid", "chatgpt.tokens.use.direct"],
        }) as Credential,
    );
    await expect(providers.save({ kind: "openai", name: "OpenAI", auth: "api_key" })).rejects.toThrow(
      "API key is required",
    );
    expect(await credentials.read("openai")).toMatchObject({ type: "oauth", access: "previous-access" });
  });

  it("completes OpenAI OAuth with PKCE, callback state and verified ID token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "test-key";
    const jwk = { ...publicKey.export({ format: "jwk" }), kid };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/api/accounts/oauth/token") {
        const form = new URLSearchParams(String(init?.body ?? ""));
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("client_id")).toBe("issued-client");
        expect(form.get("code")).toBe("code");
        expect(
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(authorization.searchParams.get("code_challenge"));
        return Response.json({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          id_token: idToken(),
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [jwk] });
      throw new Error(`Unexpected test request: ${url.pathname}`);
    }) as typeof fetch;
    const start = await providers.startOpenAiOAuth();
    const authorization = new URL(start.authorizationUrl);
    const state = authorization.searchParams.get("state")!;
    const nonce = authorization.searchParams.get("nonce")!;
    function idToken() {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: "https://auth.openai.com",
          aud: "issued-client",
          exp: Date.now() / 1000 + 3600,
          iat: Date.now() / 1000,
          nonce,
          sub: "user-1",
        }),
      ).toString("base64url");
      const unsigned = `${header}.${payload}`;
      return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
    }
    try {
      await expect(
        providers.submitOpenAiOAuthCallback(
          `http://127.0.0.1:1455/auth/callback?code=code&client_id=issued-client&state=wrong`,
        ),
      ).rejects.toThrow("state did not match");
      await providers.submitOpenAiOAuthCallback(
        `http://127.0.0.1:1455/auth/callback?code=code&client_id=issued-client&state=${state}`,
      );
      expect(providers.openAiOAuthStatus()).toMatchObject({ pending: false });
      expect(await providers.list()).toMatchObject([{ id: "openai", auth: "oauth", connected: true }]);
      expect(await credentials.read("openai")).toMatchObject({
        type: "oauth",
        access: "access-secret",
        refresh: "refresh-secret",
        clientId: "issued-client",
      });
    } finally {
      globalThis.fetch = originalFetch;
      providers.cancelOpenAiOAuth();
    }
  });

  it("reuses a ChatGPT registration for reauthorization when the callback omits client_id", async () => {
    await credentials.modify(
      "openai",
      async () =>
        ({
          type: "oauth",
          access: "previous-access",
          refresh: "previous-refresh",
          expires: Date.now() + 3_600_000,
          clientId: "issued-client",
          idToken: "previous-id-token",
          subject: "user-1",
          scopes: ["openid", "chatgpt.tokens.use.direct"],
        }) as Credential,
    );
    const originalFetch = globalThis.fetch;
    let exchangeClientId: string | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname !== "/api/accounts/oauth/token") throw new Error(`Unexpected test request: ${url.pathname}`);
      exchangeClientId = new URLSearchParams(String(init?.body ?? "")).get("client_id");
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }) as typeof fetch;
    try {
      const start = await providers.startOpenAiOAuth();
      const authorization = new URL(start.authorizationUrl);
      expect(authorization.searchParams.get("client_id")).toBe("issued-client");
      expect(authorization.searchParams.get("id_token_hint")).toBe("previous-id-token");
      expect(authorization.searchParams.has("agent_name_hint")).toBe(false);
      const state = authorization.searchParams.get("state")!;
      await expect(
        providers.submitOpenAiOAuthCallback(`http://127.0.0.1:1455/auth/callback?code=code&state=${state}`),
      ).rejects.toThrow("could not complete sign-in");
      expect(exchangeClientId).toBe("issued-client");
      expect(await credentials.read("openai")).toMatchObject({ access: "previous-access", clientId: "issued-client" });
    } finally {
      globalThis.fetch = originalFetch;
      providers.cancelOpenAiOAuth();
    }
  });
});
