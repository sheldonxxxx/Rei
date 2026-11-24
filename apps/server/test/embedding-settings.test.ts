import type { EmbeddingSetupSettings } from "@rei/protocol";
import { expect, it } from "vitest";
import { startSignedIn, startTestServer } from "./helpers/server.ts";

const settings: EmbeddingSetupSettings = {
  provider: "openai",
  baseUrl: "https://embedding.test",
  apiModel: "test-model",
  profile: {
    id: "test",
    repository: "test",
    revision: "one",
    quant: "float32",
    dims: 2,
    pooling: "mean",
    docTemplate: "$" + "{t}",
    queryTemplate: "$" + "{q}",
    maxInputTokens: 1024,
    contextTokens: 900,
  },
};
it("validates, applies and restores web embedding settings without putting keys in the control database", async () => {
  let saved: EmbeddingSetupSettings | null = null;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/setup/embedding/detect") return Response.json({ dims: 2 });
    if (path === "/setup/embedding") {
      if (init?.method === "POST") {
        const { apiKey: _key, ...value } = JSON.parse(String(init.body));
        saved = value;
      }
      return Response.json(saved);
    }
    if (path.endsWith("/models")) return Response.json({ data: [{ id: "test-model" }] });
    if (path.endsWith("/embeddings"))
      return Response.json({ model: "test-model", data: [{ index: 0, embedding: [1, 0] }] });
    return Response.json({ connections: [] });
  };
  const server = await startSignedIn({ gatewayUrl: "http://gateway", fetchImpl });
  let restored: Awaited<ReturnType<typeof startTestServer>> | undefined;
  try {
    expect((await server.client.get("/api/embedding/setup")).body).toBeNull();
    expect((await server.client.post("/api/embedding/setup", { ...settings, profile: {} })).status).toBe(400);
    expect((await server.client.post("/api/embedding/setup", { ...settings, apiKey: "private-key" })).body).toEqual(
      settings,
    );
    expect(server.host.plane.memory.history.embeddingInfo()?.apiModel).toBe("test-model");
    expect(server.host.plane.store.metaGet("embedding_setup")).not.toContain("private-key");
    await server.stop();
    restored = await startTestServer({ dir: server.dir, gatewayUrl: "http://gateway", fetchImpl });
    expect(restored.host.plane.memory.history.embeddingInfo()?.profile.dims).toBe(2);
  } finally {
    await restored?.stop();
    await server.destroy();
  }
});

it("detects custom dimensions, validates advanced inputs and preserves settings on failed tests", async () => {
  let saved: EmbeddingSetupSettings | null = null;
  let fail = false;
  let saves = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/setup/embedding/detect")
      return fail
        ? Response.json({ error: { code: "embedding_failed", message: "Connection test failed" } }, { status: 400 })
        : Response.json({ dims: 3 });
    if (path === "/setup/embedding") {
      if (init?.method === "POST") {
        saves++;
        const { apiKey: _key, advanced: _advanced, ...value } = JSON.parse(String(init.body));
        saved = value;
      }
      return Response.json(saved);
    }
    if (path.endsWith("/embeddings")) return Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }] });
    return Response.json({ connections: [] });
  };
  const server = await startSignedIn({ gatewayUrl: "http://gateway", fetchImpl });
  const input = { provider: "openai", baseUrl: "https://embedding.test", apiModel: "custom", profile: null };
  try {
    const result = await server.client.post("/api/embedding/setup", input);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      profile: { dims: 3, pooling: "provider", contextTokens: 512, revision: "api-managed" },
    });
    expect(
      (await server.client.post("/api/embedding/setup", { ...input, advanced: { contextTokens: 0 } })).status,
    ).toBe(400);
    fail = true;
    expect((await server.client.post("/api/embedding/setup", { ...input, baseUrl: "https://bad.test" })).status).toBe(
      400,
    );
    expect(saves).toBe(1);
    expect((await server.client.get("/api/embedding/setup")).body).toMatchObject({ baseUrl: input.baseUrl });
  } finally {
    await server.destroy();
  }
});

it("tests the entered embedding values without saving them and refuses a vector size the profile does not expect", async () => {
  let detectBody: Record<string, unknown> | undefined;
  let detectFails = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/setup/embedding/detect") {
      detectBody = JSON.parse(String(init?.body));
      return detectFails
        ? Response.json({ error: { code: "embedding_failed", message: "Connection test failed" } }, { status: 400 })
        : Response.json({ dims: 2 });
    }
    if (path === "/setup/embedding") return Response.json(null);
    return Response.json({ connections: [] });
  };
  const server = await startSignedIn({ gatewayUrl: "http://gateway", fetchImpl });
  const typed = { provider: "openai", baseUrl: "https://embedding.test", apiModel: "text-embedding", profile: null };
  try {
    const ok = await server.client.post("/api/embedding/check", { ...typed, apiKey: "typed-key" });
    expect(ok.body).toEqual({ ok: true, dims: 2 });
    expect(detectBody).toMatchObject({
      baseUrl: "https://embedding.test",
      apiModel: "text-embedding",
      apiKey: "typed-key",
    });
    expect((await server.client.get("/api/embedding/setup")).body).toBeNull();

    const omlx = {
      provider: "omlx",
      baseUrl: "https://embedding.test",
      apiModel: "mlx-community/embeddinggemma-2-6bit",
      profile: {
        id: "mlx-community/embeddinggemma-2-6bit",
        repository: "mlx-community/embeddinggemma-2-6bit",
        revision: "a61f0b6dcee35cf68475e91b8b28ed830057d7c4",
        quant: "affine-6bit-g64-bf16",
        dims: 768,
        pooling: "mean",
        docTemplate: "$" + "{t}",
        queryTemplate: "$" + "{q}",
        maxInputTokens: 2048,
        contextTokens: 2048,
      },
    };
    const mismatch = await server.client.post("/api/embedding/check", omlx);
    expect(mismatch.status).toBe(400);
    expect(JSON.stringify(mismatch.body)).toContain("returned 2 dimensions, but this profile expects 768");

    detectFails = true;
    const failed = await server.client.post("/api/embedding/check", typed);
    expect(failed.status).toBe(400);
    expect((await server.client.get("/api/embedding/setup")).body).toBeNull();
  } finally {
    await server.destroy();
  }
});
