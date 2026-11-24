import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@rei/logging";
import { expect, it } from "vitest";
import { createGatewayApp } from "../src/core/proxy.ts";
import { createRedactor } from "../src/core/redact.ts";
import { SearchSetup } from "../src/node/search-setup.ts";
import { FileSecretStore } from "../src/node/secretstore.ts";
import { noopCallLog } from "./noop-calls.ts";

it("authenticates and validates setup, persists write-only keys, and isolates SearXNG credentials by URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rei-search-setup-"));
  try {
    const file = join(dir, "secret", "settings.json");
    const secrets = new FileSecretStore(file);
    const defaults = {
      providers: ["searxng" as const],
      searxngUrl: "https://original.example",
      exaAuth: "keyless" as const,
      keys: async () => "original-key",
    };
    const setup = await SearchSetup.load(secrets, defaults);
    const redactor = createRedactor();
    const app = createGatewayApp({
      standin: "standin",
      setupSearch: setup,
      search: setup.config,
      tokens: { accessToken: async () => "", status: async () => ({ signedIn: false, accessExpiresInS: null }) },
      calls: noopCallLog(),
      models: () => [],
      version: "test",
      upstreams: [],
      redactor,
      log: nullLogger,
    });
    const save = (body: unknown) =>
      app.request("/setup/search", {
        method: "POST",
        headers: { authorization: "Bearer standin", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await app.request("/setup/search")).status).toBe(401);
    expect((await save({ providers: ["bad"], searxngUrl: "", exaAuth: "keyless" })).status).toBe(400);
    expect(
      (await save({ providers: ["brave"], searxngUrl: "", exaAuth: "keyless", apiKeys: { brave: "bad\nheader" } }))
        .status,
    ).toBe(400);
    const credentialUrl = new URL("https://example.com");
    credentialUrl.username = "test-user";
    credentialUrl.password = "test-password";
    expect((await save({ providers: ["searxng"], searxngUrl: credentialUrl.href, exaAuth: "keyless" })).status).toBe(
      400,
    );
    const result = await save({
      providers: ["brave"],
      searxngUrl: defaults.searxngUrl,
      exaAuth: "keyless",
      apiKeys: { brave: "test-brave-key" },
    });
    expect(await result.json()).toMatchObject({
      providers: ["brave"],
      searxngUrl: defaults.searxngUrl,
      exaAuth: "keyless",
      codexModel: "gpt-6-luna",
    });
    expect(redactor.redact("test-brave-key")).not.toContain("test-brave-key");
    const restored = await SearchSetup.load(new FileSecretStore(file), defaults);
    expect(await restored.config.keys("brave")).toBe("test-brave-key");
    await restored.save({ providers: ["brave"], searxngUrl: defaults.searxngUrl, exaAuth: "keyless", apiKeys: {} });
    expect(await restored.config.keys("brave")).toBe("test-brave-key");
    expect(readFileSync(file, "utf8")).toContain("test-brave-key");
    await restored.save({ providers: ["searxng"], searxngUrl: "https://replacement.example", exaAuth: "keyless" });
    expect(await restored.config.keys("searxng")).toBeNull();
    expect(await restored.read()).not.toHaveProperty("apiKeys");
    await restored.save({
      providers: ["codex-subscription"],
      searxngUrl: "",
      exaAuth: "keyless",
      codexModel: "gpt-6.1-sol",
    });
    const reloaded = await SearchSetup.load(new FileSecretStore(file), defaults);
    expect((await reloaded.read()).codexModel).toBe("gpt-6.1-sol");
    expect(reloaded.config.codexModel).toBe("gpt-6.1-sol");
    expect((await save({ providers: ["codex-subscription"], searxngUrl: "", codexModel: "bad model" })).status).toBe(
      400,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("preserves enabled-but-unconfigured providers so the runtime can skip them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rei-search-choice-"));
  try {
    const setup = await SearchSetup.load(new FileSecretStore(join(dir, "secret", "settings.json")), {
      providers: ["brave", "tavily", "searxng", "exa"],
      searxngUrl: "http://searxng:8080",
      exaAuth: "keyless",
      keys: async () => null,
    });
    await expect(setup.save({ providers: ["brave"], searxngUrl: "", exaAuth: "keyless" })).resolves.toMatchObject({
      providers: ["brave"],
    });
    await expect(setup.save({ providers: ["searxng"], searxngUrl: "", exaAuth: "keyless" })).resolves.toMatchObject({
      providers: ["searxng"],
    });
    await setup.save({
      providers: ["brave", "tavily", "searxng", "exa"],
      searxngUrl: "http://searxng:8080",
      exaAuth: "keyless",
    });
    expect((await setup.read()).providers).toHaveLength(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("migrates the retired bundled defaults to keyless Exa and retains paid keys for explicit selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rei-search-migrate-"));
  try {
    const secrets = new FileSecretStore(join(dir, "secret", "settings.json"));
    await secrets.modify("setup-search", () => ({
      providers: ["brave", "tavily", "searxng", "exa"],
      searxngUrl: "http://searxng:8080",
      apiKeys: { exa: "saved-exa-test-key" },
    }));
    const setup = await SearchSetup.load(secrets, { providers: ["exa"], keys: async () => null });
    expect(await setup.read()).toMatchObject({
      providers: ["exa"],
      searxngUrl: "",
      exaAuth: "keyless",
      codexModel: "gpt-6-luna",
    });
    await setup.save({ providers: ["exa"], searxngUrl: "", exaAuth: "api_key" });
    expect(setup.config.exaAuth).toBe("api_key");
    expect(await setup.config.keys("exa")).toBe("saved-exa-test-key");
    await setup.save({ providers: ["exa"], searxngUrl: "", exaAuth: "keyless" });
    expect(setup.config.exaAuth).toBe("keyless");
    expect(await setup.read()).not.toHaveProperty("apiKeys");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("migrates enabled order, persists disabled positions and never enables a configured provider automatically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rei-search-order-"));
  try {
    const secrets = new FileSecretStore(join(dir, "settings.json"));
    const defaults = { providers: ["exa" as const], keys: async () => null };
    await secrets.modify("setup-search", () => ({
      providers: ["codex-subscription"],
      searxngUrl: "",
      exaAuth: "keyless",
    }));
    const setup = await SearchSetup.load(secrets, defaults);
    expect((await setup.read()).providerOrder?.[0]).toBe("codex-subscription");
    const order = ["brave", "exa", "codex-subscription", "searxng", "tavily"] as const;
    await setup.save({
      providers: ["codex-subscription", "exa"],
      providerOrder: [...order],
      searxngUrl: "",
      exaAuth: "keyless",
      apiKeys: { brave: "test-brave-key" },
    });
    const restored = await SearchSetup.load(secrets, defaults);
    expect(await restored.read()).toMatchObject({
      providerOrder: [...order],
      providers: ["exa", "codex-subscription"],
    });
    await expect(
      restored.save({ providers: [], providerOrder: ["exa"], searxngUrl: "", exaAuth: "keyless" }),
    ).rejects.toMatchObject({ code: "search_order_invalid" });
    await restored.save({ providers: [], providerOrder: [...order], searxngUrl: "", exaAuth: "keyless" });
    expect((await SearchSetup.load(secrets, defaults)).config.providers).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
