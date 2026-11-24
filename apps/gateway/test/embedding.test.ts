import { nullLogger } from "@rei/logging";
import { describe, expect, it } from "vitest";
import { embeddingHandler, embeddingTarget } from "../src/core/embedding.ts";
import { createGatewayApp } from "../src/core/proxy.ts";
import { createRedactor } from "../src/core/redact.ts";

const request = (
  path = "/embedding/v1/embeddings",
  body: unknown = { model: "alias", input: ["private text"], encoding_format: "float" },
) => new Request("http://gateway" + path, { method: "POST", body: JSON.stringify(body) });
describe("fixed embedding gateway", () => {
  it("requires standin auth and never consults LLM credentials", async () => {
    let upstream = 0;
    const app = createGatewayApp({
      standin: "standin",
      tokens: {
        accessToken: async () => {
          throw Error("must not be called");
        },
        status: async () => ({ signedIn: false, accessExpiresInS: null }),
      },
      calls: { insert() {}, byStep: () => [], recent: () => [], summary: () => [], lastUsed: () => new Map() },
      models: () => [],
      version: "test",
      upstreams: [],
      redactor: createRedactor(),
      log: nullLogger,
      embedding: { baseUrl: "https://provider.test", apiModel: "alias", key: async () => "inference" },
      fetch: async () => {
        upstream++;
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
      },
    });
    expect((await app.request(request())).status).toBe(401);
    expect(upstream).toBe(0);
    const r = request();
    r.headers.set("authorization", "Bearer standin");
    expect((await app.request(r)).status).toBe(200);
    expect(upstream).toBe(1);
  });
  it("pins destination and model, strips headers, and refuses redirects", async () => {
    const handler = embeddingHandler(
      { baseUrl: "https://provider.test/v1", apiModel: "alias", key: async () => "inference" },
      async (url, init) => {
        expect(String(url)).toBe("https://provider.test/v1/embeddings");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer inference");
        expect(new Headers(init?.headers).get("x-rei-upstream")).toBeNull();
        return Response.json(
          { data: [{ index: 0, embedding: [1] }], admin_key: "secret" },
          { headers: { "set-cookie": "secret" } },
        );
      },
    );
    const r = request();
    r.headers.set("x-rei-upstream", "http://169.254.169.254/admin");
    const out = await handler(r);
    expect(out.headers.get("set-cookie")).toBeNull();
    expect(await out.text()).not.toContain("secret");
    for (const path of ["/embedding/admin/api/stats", "/embedding/v1/models/alias/load"])
      expect((await handler(request(path))).status).toBe(404);
    expect((await handler(request(undefined, { model: "other", input: ["x"], encoding_format: "float" }))).status).toBe(
      400,
    );
  });
  it.each([401, 403, 404, 429, 500])("sanitizes upstream error %s", async (status) => {
    const handler = embeddingHandler(
      { baseUrl: "https://provider.test", apiModel: "alias", key: async () => "inference" },
      async () => new Response("private text admin key", { status }),
    );
    const out = await handler(request());
    expect(out.status).toBe(status);
    expect(await out.text()).not.toMatch(/private text|admin key/);
  });
  it("routes an operator-chosen HTTP upstream to the same pinned path with the inference key", async () => {
    const seen: string[] = [];
    const handler = embeddingHandler(
      { baseUrl: "http://192.168.1.20:8000/v1", apiModel: "alias", key: async () => "inference" },
      async (url, init) => {
        seen.push(String(url));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer inference");
        expect(init?.redirect).toBe("error");
        return Response.json({ data: [{ index: 0, embedding: [1] }] });
      },
    );
    const r = request();
    r.headers.set("x-rei-upstream", "http://169.254.169.254/admin");
    expect((await handler(r)).status).toBe(200);
    expect(seen).toEqual(["http://192.168.1.20:8000/v1/embeddings"]);
  });
  it("refuses unsafe URLs, query targets and oversized bodies", async () => {
    for (const url of [
      "https://a/admin",
      "https://u:p@a",
      "https://a?target=x",
      "file:///x",
      "http://u:p@a",
      "http://a?target=x",
      "http://a/x",
      "http://a#y",
    ])
      expect(() => embeddingTarget(url), url).toThrow();
    // Any http(s) origin is the operator's choice now; the fixed paths, methods and sanitizing above still apply.
    for (const [url, origin] of [
      ["http://192.168.1.1", "http://192.168.1.1"],
      ["http://192.168.1.20:8000", "http://192.168.1.20:8000"],
      ["http://host.docker.internal:8000", "http://host.docker.internal:8000"],
      ["http://[fd00::5]:8123", "http://[fd00::5]:8123"],
      ["http://oMLX.example:8000/v1", "http://omlx.example:8000"],
      ["https://a/v1", "https://a"],
    ] as const)
      expect(embeddingTarget(url), url).toBe(origin);
    const handler = embeddingHandler({ baseUrl: "https://a", apiModel: "alias", key: async () => "key" }, async () => {
      throw Error("should not fetch");
    });
    expect((await handler(request("/embedding/v1/embeddings?url=http://b"))).status).toBe(400);
    expect(
      (await handler(request(undefined, { model: "alias", input: ["x".repeat(1048576)], encoding_format: "float" })))
        .status,
    ).toBe(413);
  });
});

it("sanitizes connection failures and refuses redirect responses", async () => {
  for (const fetcher of [
    async () => {
      throw new DOMException("secret endpoint", "TimeoutError");
    },
    async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/admin" } }),
  ]) {
    const handler = embeddingHandler(
      { baseUrl: "https://provider.test", apiModel: "alias", key: async () => "inference" },
      fetcher,
    );
    const out = await handler(request());
    expect(out.status).toBe(502);
    expect(await out.text()).not.toMatch(/secret endpoint|169.254/);
  }
});

it("persists write-only embedding keys, retains a key for the same URL, and drops it when changing endpoints", async () => {
  const { FileSecretStore } = await import("../src/node/secretstore.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "rei-embedding-settings-"));
  const secrets = new FileSecretStore(join(dir, "secret", "settings.json"));
  const headers = { authorization: "Bearer standin", "content-type": "application/json" };
  const seen: (string | null)[] = [];
  const app = createGatewayApp({
    standin: "standin",
    secrets,
    embedding: { baseUrl: "https://embedding.test", apiModel: "alias" },
    tokens: { accessToken: async () => "", status: async () => ({ signedIn: false, accessExpiresInS: null }) },
    calls: { insert() {}, byStep: () => [], recent: () => [], summary: () => [], lastUsed: () => new Map() },
    models: () => [],
    version: "test",
    upstreams: [],
    redactor: createRedactor(),
    log: nullLogger,
    fetch: async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    },
  });
  const save = (body: unknown) =>
    app.request("/setup/embedding", { method: "POST", headers, body: JSON.stringify(body) });
  const connection = { provider: "openai", baseUrl: "https://embedding.test", apiModel: "alias", profile: null };
  const infer = () =>
    app.request("/embedding/v1/embeddings", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "alias", input: ["test"], encoding_format: "float" }),
    });
  try {
    expect((await app.request("/setup/embedding")).status).toBe(401);
    const detect = (body: unknown) =>
      app.request("/setup/embedding/detect", { method: "POST", headers, body: JSON.stringify(body) });
    expect((await app.request("/setup/embedding/detect", { method: "POST", body: "{}" })).status).toBe(401);
    expect(await (await detect({ ...connection, apiKey: "probe-key" })).json()).toEqual({ dims: 2 });
    expect(seen.at(-1)).toBe("Bearer probe-key");
    expect(await secrets.read("setup-embedding")).toBeUndefined();
    expect((await detect({ ...connection, baseUrl: "https://provider.test/admin" })).status).toBe(400);

    expect(
      (
        await save({
          ...connection,
          baseUrl: new URL("https://example.com").href.replace("//", "//" + "user" + ":" + "secret" + "@"),
        })
      ).status,
    ).toBe(400);
    expect((await save({ ...connection, apiKey: "bad\nkey" })).status).toBe(400);
    await save(connection);
    await infer();
    // No key is inherited from any file: without a saved or typed key, nothing is sent as a bearer.
    expect(seen.at(-1)).toBeNull();
    expect(await (await save({ ...connection, apiKey: "private-key" })).json()).toEqual(connection);
    await save(connection);
    await infer();
    expect(seen.at(-1)).toBe("Bearer private-key");
    expect(await (await app.request("/setup/embedding", { headers })).json()).toEqual(connection);
    const restored = await new FileSecretStore(join(dir, "secret", "settings.json")).read<{ apiKey: string }>(
      "setup-embedding",
    );
    expect(restored?.apiKey).toBe("private-key");
    await save({ ...connection, baseUrl: "https://replacement.test" });
    await infer();
    expect(seen.at(-1)).toBeNull();
    await save({ ...connection, provider: "off" });
    expect((await infer()).status).toBe(503);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reports why an upstream failed to the log without the key, request text or response body", async () => {
  const reports: unknown[] = [];
  const handler = embeddingHandler(
    { baseUrl: "https://provider.test", apiModel: "alias", key: async () => "inference-secret" },
    async () => new Response("upstream says inference-secret private text", { status: 401 }),
    (reason) => reports.push(reason),
  );
  expect((await handler(request())).status).toBe(401);
  expect(reports).toEqual([{ stage: "upstream_status", status: 401 }]);
  expect(JSON.stringify(reports)).not.toContain("inference-secret");
  expect(JSON.stringify(reports)).not.toContain("private text");

  const thrown = embeddingHandler(
    { baseUrl: "https://provider.test", apiModel: "alias", key: async () => "" },
    async () => {
      throw new TypeError("fetch failed at private text");
    },
    (reason) => reports.push(reason),
  );
  expect((await thrown(request())).status).toBe(502);
  expect(reports[1]).toEqual({ stage: "upstream_error", errorClass: "TypeError" });
  expect(JSON.stringify(reports)).not.toContain("private text");
});

it("names the cause of a failed connection test without echoing upstream text or keys", async () => {
  const { FileSecretStore } = await import("../src/node/secretstore.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const secrets = new FileSecretStore(join(mkdtempSync(join(tmpdir(), "rei-detect-")), "secret", "settings.json"));
  const headers = { authorization: "Bearer standin", "content-type": "application/json" };
  let reply = (): Response => Response.json({ data: [{ index: 0, embedding: [1, 0] }], model: "alias" });
  const app = createGatewayApp({
    standin: "standin",
    secrets,
    embedding: { baseUrl: "http://host.docker.internal:18000", apiModel: "alias" },
    tokens: { accessToken: async () => "", status: async () => ({ signedIn: false, accessExpiresInS: null }) },
    calls: { insert() {}, byStep: () => [], recent: () => [], summary: () => [], lastUsed: () => new Map() },
    models: () => [],
    version: "test",
    upstreams: [],
    redactor: createRedactor(),
    log: nullLogger,
    fetch: async () => reply(),
  });
  const detect = (body: unknown) =>
    app.request("/setup/embedding/detect", { method: "POST", headers, body: JSON.stringify(body) });
  const base = { baseUrl: "http://host.docker.internal:18000", apiModel: "alias", provider: "omlx", profile: null };

  // With no key typed and none saved, oMLX refuses the anonymous call; the message says to enter the key.
  reply = () => new Response("private body", { status: 401 });
  const missing = await detect(base);
  expect(missing.status).toBe(400);
  expect((await missing.json()).error.message).toMatch(/rejected this API key \(HTTP 401\)/);

  const unauthorized = await detect({ ...base, apiKey: "wrong-key-value" });
  const unauthorizedText = JSON.stringify(await unauthorized.json());
  expect(unauthorizedText).toMatch(/rejected this API key \(HTTP 401\)/);
  expect(unauthorizedText).not.toContain("wrong-key-value");
  expect(unauthorizedText).not.toContain("private body");

  reply = () => new Response("nope", { status: 404 });
  const notFound = await detect({ ...base, apiKey: "k" });
  expect((await notFound.json()).error.message).toMatch(/does not serve the embeddings API/);

  reply = () =>
    Response.json({ data: [{ index: 0, embedding: [1, 0] }], model: "mlx-community/embeddinggemma-2-6bit" });
  const mismatch = await detect({ ...base, apiKey: "k" });
  expect((await mismatch.json()).error.message).toMatch(/serves this model as "mlx-community\/embeddinggemma-2-6bit"/);
});

it("explains a memory-limited oMLX refusal instead of a generic failure", async () => {
  const { FileSecretStore } = await import("../src/node/secretstore.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const secrets = new FileSecretStore(join(mkdtempSync(join(tmpdir(), "rei-507-")), "secret", "settings.json"));
  const app = createGatewayApp({
    standin: "standin",
    secrets,
    tokens: { accessToken: async () => "", status: async () => ({ signedIn: false, accessExpiresInS: null }) },
    calls: { insert() {}, byStep: () => [], recent: () => [], summary: () => [], lastUsed: () => new Map() },
    models: () => [],
    version: "test",
    upstreams: [],
    redactor: createRedactor(),
    log: nullLogger,
    fetch: async () => new Response("does not fit", { status: 507 }),
  });
  const response = await app.request("/setup/embedding/detect", {
    method: "POST",
    headers: { authorization: "Bearer standin", "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: "http://host.docker.internal:18000", apiModel: "alias", apiKey: "k" }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.message).toMatch(/not have enough free memory/);
});
