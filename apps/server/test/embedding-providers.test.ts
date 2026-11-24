import { describe, expect, it } from "vitest";
import {
  Embedder,
  identityKey,
  l2normalise,
  MODEL_PROFILES,
  OMLX_MODEL,
  validateProfile,
} from "../src/memory/embedder.ts";

const profile = MODEL_PROFILES[OMLX_MODEL]!;
const priorProfile = {
  id: "prior-custom-profile",
  repository: "owner/prior-model",
  revision: "prior-revision",
  dims: 768,
  quant: "Q8_0",
  pooling: "mean" as const,
  docTemplate: "title: none | text: ${t}",
  queryTemplate: "task: search result | query: ${q}",
  maxInputTokens: 2_048,
  contextTokens: 1_000,
};
const vector = (n = 768) => Array.from({ length: n }, (_, i) => (i === 0 ? 2 : 0));
const config = {
  url: "https://provider.test/v1/",
  model: OMLX_MODEL,
  provider: "omlx" as const,
  apiModel: "served-alias",
};

describe("provider-neutral embedding transport", () => {
  it("uses exact API aliases, float batches, prefixes, /v1 normalization and input order", async () => {
    const seen: string[] = [];
    const e = new Embedder(config, {
      fetch: async (url, init) => {
        seen.push(String(url));
        const b = JSON.parse(String(init?.body));
        expect(b.model).toBe("served-alias");
        expect(b.encoding_format).toBe("float");
        expect(b.input[0]).toBe("title: none | text: 中文");
        expect(b.input[1]).toBe("title: none | text: 日本語");
        expect(b.input[2].length).toBeGreaterThan(512 * 4);
        return Response.json({
          model: "served-alias",
          data: b.input.map((_: string, index: number) => ({ index, embedding: vector() })).reverse(),
        });
      },
    });
    const out = await e.embedDocuments(["中文", "日本語", "word ".repeat(700)]);
    expect(seen).toEqual(["https://provider.test/v1/embeddings"]);
    expect(out).toHaveLength(3);
    expect(out[0]![0]).toBe(1);
  });
  it.each([undefined, -1, 1, 0.5, "0"])("rejects invalid index %s", async (index) => {
    const e = new Embedder(config, { fetch: async () => Response.json({ data: [{ index, embedding: vector() }] }) });
    await expect(e.embedQuery("x")).rejects.toMatchObject({ kind: "server" });
  });
  it("rejects duplicates, zero vectors, wrong dims and model mismatch", async () => {
    for (const data of [
      [
        { index: 0, embedding: vector() },
        { index: 0, embedding: vector() },
      ],
      [
        { index: 0, embedding: Array(768).fill(0) },
        { index: 1, embedding: vector() },
      ],
      [
        { index: 0, embedding: vector(2) },
        { index: 1, embedding: vector() },
      ],
    ]) {
      const e = new Embedder(config, { fetch: async () => Response.json({ data }) });
      await expect(e.embedDocuments(["a", "b"])).rejects.toMatchObject({ kind: "server" });
    }
    const e = new Embedder(config, {
      fetch: async () => Response.json({ model: "other", data: [{ index: 0, embedding: vector() }] }),
    });
    await expect(e.embedQuery("x")).rejects.toThrow(/another API model/);
  });
  it.each([401, 403, 404, 429])("preserves HTTP error %s", async (status) => {
    const e = new Embedder(config, { fetch: async () => new Response(null, { status }) });
    await expect(e.embedQuery("x")).rejects.toMatchObject({ status, kind: status === 429 ? "server" : "client" });
  });
  it("probes inference without requiring discovery or /props on oMLX", async () => {
    const paths: string[] = [];
    const e = new Embedder(config, {
      fetch: async (url) => {
        paths.push(String(url));
        return Response.json(
          String(url).endsWith("/models")
            ? { data: [{ id: "served-alias" }] }
            : { data: [{ index: 0, embedding: vector() }] },
        );
      },
    });
    expect(await e.probe()).toEqual({ build: "omlx", quant: profile.quant });
    expect(paths).toEqual(["https://provider.test/v1/embeddings"]);
  });
  it("requires explicit semantic profiles and API models", () => {
    expect(Object.keys(MODEL_PROFILES)).toEqual([OMLX_MODEL]);
    expect(() => validateProfile({ ...profile, revision: "" })).toThrow();
    expect(() => new Embedder({ ...config, apiModel: "" })).toThrow();
    expect(() => new Embedder({ ...config, model: "arbitrary" })).toThrow();
  });
  it("isolates equal dimensional models and revisions, templates, quant, pooling, context; supports rollback", () => {
    const old = new Embedder({
      url: "https://prior.example",
      model: priorProfile.id,
      provider: "openai",
      apiModel: "prior-api",
      profile: priorProfile,
    });
    const e = new Embedder(config);
    const current = e.identity({ build: "v1", quant: profile.quant });
    const prior = old.identity({ build: "openai", quant: "Q8_0" });
    expect(e.compatible(prior)).toBe(false);
    expect(old.compatible(current)).toBe(false);
    expect(old.compatible(prior)).toBe(true);
    for (const change of [
      { revision: "other" },
      { quant: "4bit" },
      { pooling: "cls" },
      { queryTemplate: "${q}" },
      { docTemplate: "${t}" },
      { contextTokens: 512 },
    ])
      expect(e.compatible({ ...current, ...change })).toBe(false);
    expect(identityKey(current)).toBe(identityKey({ ...current, endpoint: "elsewhere", build: "v2" }));
  });
});

// Persist through the real SQLite adapter, then reconstruct the index (the worker does this after restart).
it("reloads SQLite semantic identities without mixing 768d vector spaces", async () => {
  const { openSqliteDb } = await import("../src/node/sqlite-db.ts");
  const { initializeDatabase } = await import("../src/db/schema.ts");
  const { HistoryIndex } = await import("../src/memory/index.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "embedding-reload-"));
  const file = join(dir, "index.sqlite");
  let db = openSqliteDb(file);
  try {
    initializeDatabase(db);
    const clock = { now: () => 1 };
    const index = new HistoryIndex(db, clock);
    const old = new Embedder({
      url: "https://prior.example",
      model: priorProfile.id,
      provider: "openai",
      apiModel: "prior-api",
      profile: priorProfile,
    });
    const next = new Embedder(config);
    const prior = old.identity({ build: "openai", quant: "Q8_0" });
    const current = next.identity({ build: "omlx", quant: profile.quant });
    const original = index.createSet(prior, "active", false);
    const building = index.createSet(current, "building", false);
    db.close();
    db = openSqliteDb(file);
    const reload = new HistoryIndex(db, clock);
    expect(reload.activeSet()!.identity).toEqual(prior);
    expect(reload.buildingSet()!.identity).toEqual(current);
    expect(next.compatible(reload.activeSet()!.identity)).toBe(false);
    expect(old.compatible(reload.activeSet()!.identity)).toBe(true);
    expect(identityKey(reload.buildingSet()!.identity)).toBe(identityKey(current));
    reload.promote(building.id);
    expect(next.compatible(new HistoryIndex(db, clock).activeSet()!.identity)).toBe(true);
    // Reverting configuration cannot query the new model's active vectors.
    expect(old.compatible(reload.activeSet()!.identity)).toBe(false);
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM memory_vector_sets")!.n).toBe(2);
    expect(reload.retainedSet(prior)?.id).toBe(original.id);
    reload.stageRetained(original.id);
    reload.promote(original.id);
    expect(old.compatible(new HistoryIndex(db, clock).activeSet()!.identity)).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("normalizes extreme finite floats before float32 conversion, and rejects nonfinite values", () => {
  for (const x of [1e-300, 1e39, 1e300])
    expect(Array.from(l2normalise([x, x]))).toEqual([expect.closeTo(Math.SQRT1_2, 5), expect.closeTo(Math.SQRT1_2, 5)]);
  for (const x of [NaN, Infinity, -Infinity]) expect(() => l2normalise([x, 1])).toThrow();
});
it.each([false, true])(
  "checks semantic compatibility through history lookup before calling the provider (retrieval=%s)",
  async (remote) => {
    const { HistoryIndexing } = await import("../src/memory/history-indexing.ts");
    const { vectorToBlob } = await import("../src/memory/embedder.ts");
    const { nullLogger } = await import("../src/util/log.ts");
    const { startSignedIn } = await import("./helpers/server.ts");
    const { chat } = await import("./helpers/sessions.ts");
    const { historyState } = await import("./helpers/history.ts");
    const { FakeRetrieval } = await import("./helpers/retrieval.ts");
    let requests = 0;
    const e = new Embedder(config, {
      fetch: async () => {
        requests++;
        return Response.json({ data: [{ index: 0, embedding: vector() }] });
      },
    });
    const server = await startSignedIn();
    try {
      const store = server.host.plane.store;
      const sessionId = await chat(server);
      const index = historyState(server.host.plane.memory);
      index.addToolResult({
        sessionId,
        runId: null,
        piEntryId: "semantic-check",
        toolName: "web_fetch",
        text: "Mars semantic compatibility record",
      });
      const entryId = index.entriesContaining("Mars")[0]!;
      const current = e.identity({ build: "omlx", quant: profile.quant });
      for (const change of [
        { revision: "old" },
        { quant: "Q8_0" },
        { pooling: "last" as const },
        { docTemplate: "$" + "{t}" },
        { queryTemplate: "$" + "{q}" },
        { contextTokens: 512 },
      ]) {
        const set = index.createSet({ ...current, ...change }, "active", false);
        index.storeVectors(set.id, [{ entryId, vec: vectorToBlob(new Float32Array(vector())) }]);
        const history = new HistoryIndexing({
          store,
          clock: store.clock,
          log: nullLogger,
          embedder: e,
          onPurgeSession: () => {},
          ...(remote ? { retrieval: new FakeRetrieval() } : {}),
        });
        expect(await history.vectorSearch("Mars", {})).toEqual([]);
      }
      expect(requests).toBe(0);
    } finally {
      await server.destroy();
    }
  },
);

it("preserves remote locality detection with empty Compose overrides and validates external API aliases", async () => {
  const { readConfig } = await import("../src/node/config.ts");
  const configured = readConfig({
    REI_MODEL_MODE: "faux",
    REI_EMBEDDER_URL: "https://provider.test",
    REI_EMBEDDER_PROVIDER: "omlx",
    REI_EMBEDDER_MODEL: OMLX_MODEL,
    REI_EMBEDDER_API_MODEL: OMLX_MODEL,
    REI_EMBEDDER_REMOTE: "",
  }).control.embedder!;
  expect(new Embedder(configured).remote).toBe(true);
  expect(new Embedder(configured).profile.id).toBe(OMLX_MODEL);
  expect(
    readConfig({ REI_MODEL_MODE: "faux", REI_EMBEDDER_URL: "http://embedder:8080", REI_EMBEDDER_PROVIDER: "bundled" })
      .control.embedder,
  ).toBeUndefined();
  expect(() =>
    readConfig({ REI_MODEL_MODE: "faux", REI_EMBEDDER_URL: "https://provider.test", REI_EMBEDDER_PROVIDER: "openai" }),
  ).toThrow(/PROFILE/);
  const next = readConfig({
    REI_MODEL_MODE: "faux",
    REI_EMBEDDER_URL: "http://gateway:8780/embedding",
    REI_EMBEDDER_PROVIDER: "omlx",
    REI_EMBEDDER_MODEL: OMLX_MODEL,
    REI_EMBEDDER_API_MODEL: "served-alias",
    REI_EMBEDDER_REMOTE: "1",
  }).control.embedder!;
  expect(new Embedder(next).remote).toBe(true);
  expect(new Embedder(next).apiModel).toBe("served-alias");
});

it("the worker automatically reuses a retained set when configuration rolls back", async () => {
  const { openSqliteDb } = await import("../src/node/sqlite-db.ts");
  const { initializeDatabase } = await import("../src/db/schema.ts");
  const { HistoryIndex } = await import("../src/memory/index.ts");
  const { IndexWorker } = await import("../src/memory/worker.ts");
  const { nullLogger } = await import("../src/util/log.ts");
  const { FakeEmbedder } = await import("./helpers/fake-embedder.ts");
  const db = openSqliteDb(":memory:");
  try {
    initializeDatabase(db);
    const clock = { now: () => 1 };
    const index = new HistoryIndex(db, clock);
    const fakePrior = new FakeEmbedder();
    const priorFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "prior-api" }] });
      return fakePrior.fetch(input, init);
    };
    const prior = new Embedder(
      {
        url: "http://prior:8000",
        model: priorProfile.id,
        provider: "openai",
        apiModel: "prior-api",
        profile: priorProfile,
      },
      { fetch: priorFetch },
    );
    const next = new Embedder(config, {
      fetch: async (url) =>
        Response.json(
          String(url).endsWith("/models")
            ? { data: [{ id: "served-alias" }] }
            : { data: [{ index: 0, embedding: vector() }] },
        ),
    });
    const run = async (embedder: Embedder) => {
      const w = new IndexWorker({ index, embedder, clock, log: nullLogger, changed: () => {} });
      w.kick();
      await w.settle();
      w.stop();
    };
    await run(prior);
    const first = index.activeSet()!;
    await run(next);
    const second = index.activeSet()!;
    expect(second.id).not.toBe(first.id);
    expect(index.setById(first.id)!.status).toBe("retired");
    await run(prior);
    expect(index.activeSet()!.id).toBe(first.id);
    expect(index.setById(second.id)!.status).toBe("retired");
    expect(index.buildingSet()).toBeUndefined();
  } finally {
    db.close();
  }
});
