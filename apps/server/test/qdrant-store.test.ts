// The Qdrant client's requests and answers. The shapes here are what the live check (containers/smoke-storage.sh)
// proves against a real Qdrant; these tests are what keep them from drifting when nobody is looking.
import { afterEach, describe, expect, it } from "vitest";
import { QdrantStore, qdrantPointId, RetrievalError } from "../src/node/qdrant-store.ts";
import type { RetrievalPoint } from "../src/retrieval/retrieval-store.ts";
import { LEXICAL_COLLECTION } from "../src/retrieval/retrieval-store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

interface Sent {
  method: string;
  path: string;
  apiKey: string | null;
  body?: unknown;
}

class FakeQdrant {
  readonly sent: Sent[] = [];
  status = 200;
  body = '{"result":{}}';
  /** Per-call statuses (the last one repeats): an existence check answers 404, the rest succeed. */
  statuses: number[] = [];

  fetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const where = new URL(String(url));
    this.sent.push({
      method: String(init?.method ?? "GET"),
      path: `${where.pathname}${where.search}`,
      apiKey: new Headers(init?.headers).get("api-key"),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const status = this.statuses[this.sent.length - 1] ?? this.status;
    return new Response(this.body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  store(overrides: { apiKey?: string; retries?: number } = {}): QdrantStore {
    return new QdrantStore({
      url: "http://qdrant:6333",
      apiKey: overrides.apiKey ?? "test-key",
      retries: overrides.retries ?? 0,
      fetchImpl: this.fetch,
      sleep: async () => {},
    });
  }
}

const point = (pointId: string): RetrievalPoint => ({
  pointId,
  payload: {
    entryId: 7,
    sourceType: "message",
    sourceId: "msg_1",
    chunkId: pointId,
    sessionId: "ses_1",
    agentId: "agent_1",
    kind: "user",
    toolName: null,
    createdAt: 1_000,
    text: "hello",
    tokens: "hello",
    writtenBy: "test",
  },
});

describe("the Qdrant client's requests", () => {
  it("carries the API key on every call, and refuses to be configured without one", async () => {
    const fake = new FakeQdrant();
    await fake.store().count(LEXICAL_COLLECTION);
    expect(fake.sent[0]!.apiKey).toBe("test-key");
    expect(() => new QdrantStore({ url: "http://qdrant:6333", apiKey: "" })).toThrow(/API key/);
    expect(() => new QdrantStore({ url: "ftp://qdrant:6333", apiKey: "k" })).toThrow(/http/);
  });

  it("creates the lexical collection payload-only, with a BM25 text index and the fields it filters on", async () => {
    const fake = new FakeQdrant();
    fake.statuses = [404]; // the collection does not exist yet
    await fake.store().ensureLexical();
    const [, create, ...indexes] = fake.sent; // the first call asks whether the collection is already there
    expect(create).toMatchObject({ method: "PUT", path: `/collections/${LEXICAL_COLLECTION}` });
    expect(create!.body).toEqual({ vectors: {} });
    expect(indexes.map((s) => (s.body as { field_name: string }).field_name)).toEqual(
      expect.arrayContaining(["tokens", "source_type", "source_id", "session_id", "agent_id", "kind", "created_at"]),
    );
    const text = indexes.find((s) => (s.body as { field_name: string }).field_name === "tokens")!;
    expect(text.body).toMatchObject({
      field_schema: { type: "text", tokenizer: "word", lowercase: true, scoring: true },
    });
  });

  it("does not recreate what already exists", async () => {
    const exists = new FakeQdrant();
    exists.body = '{"result":{"status":"green"}}';
    await exists.store().ensureLexical();
    expect(exists.sent.filter((s) => s.path === `/collections/${LEXICAL_COLLECTION}`)).toHaveLength(1);
    expect(exists.sent.filter((s) => s.path.endsWith("/index?wait=true"))).toHaveLength(7);
  });

  it.each(["lexical", "dense"])("repairs payload indexes after interrupted %s initialization", async (kind) => {
    const fake = new FakeQdrant();
    fake.statuses = [404, 200, 503];
    const store = fake.store();
    const collection = kind === "lexical" ? LEXICAL_COLLECTION : "rei_history_dense_v1";
    const ensure = () => (kind === "lexical" ? store.ensureLexical() : store.ensureDense(collection, 3));
    await expect(ensure()).rejects.toThrow(/503/);
    fake.statuses = [];
    fake.sent.length = 0;
    await ensure();
    expect(fake.sent.filter((s) => s.path === `/collections/${collection}`)).toHaveLength(1);
    expect(fake.sent.filter((s) => s.path.endsWith("/index?wait=true"))).toHaveLength(kind === "lexical" ? 7 : 6);
  });

  it("names points by a UUID it derives from the chunk's identity, so a re-index replaces them", async () => {
    const first = new FakeQdrant();
    await first.store().upsert(LEXICAL_COLLECTION, [point("m:msg_1:0"), point("m:msg_1:1")]);
    const written = (first.sent[0]!.body as { points: { id: string; payload: Record<string, unknown> }[] }).points;
    expect(written).toHaveLength(2);
    for (const p of written)
      expect(p.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(written.map((p) => p.id)).size).toBe(2);
    // The same chunk, asked again (another store, another start), is the same point: not a second copy of it.
    const again = new FakeQdrant();
    await again.store().upsert(LEXICAL_COLLECTION, [point("m:msg_1:0")]);
    expect((again.sent[0]!.body as { points: { id: string }[] }).points[0]!.id).toBe(written[0]!.id);
    // And the payload keeps the identity a human (or a test) can read.
    expect(written[0]!.payload.chunk_id).toBe("m:msg_1:0");
    expect(await qdrantPointId("m:msg_1:0")).toBe(await qdrantPointId("m:msg_1:0"));
    expect(await qdrantPointId("m:msg_1:0")).not.toBe(await qdrantPointId("m:msg_2:0"));
  });

  it("sends the caller's filters to the service, in both search and delete-by-source", async () => {
    const fake = new FakeQdrant();
    const store = fake.store();
    await store.searchLexical("deposit", { filters: { agentId: "agent_1", from: 10, to: 20 }, limit: 5 });
    expect(fake.sent[0]!.body).toMatchObject({
      query: { text: "deposit" },
      using: "tokens",
      limit: 5,
      filter: {
        must: [
          { key: "agent_id", match: { any: ["agent_1"] } },
          { key: "created_at", range: { gte: 10, lte: 20 } },
        ],
      },
    });
    fake.sent.length = 0;
    await store.removeWhere(["rei_history_x"], { sessionIds: ["ses_1"], sourceIds: ["msg_1"] });
    expect(fake.sent[0]!.path).toBe("/collections/rei_history_x/points/delete?wait=true");
    expect(fake.sent[0]!.body).toMatchObject({
      filter: {
        must: [
          { key: "source_id", match: { any: ["msg_1"] } },
          { key: "session_id", match: { any: ["ses_1"] } },
        ],
      },
      wait: true,
    });
  });

  it("refuses a delete that would clear everything, and a drop of a collection that is not Rei's", async () => {
    const fake = new FakeQdrant();
    const store = fake.store();
    await expect(store.removeWhere(["rei_history_x"], {})).rejects.toThrow(/Refusing to delete every point/);
    await expect(store.dropCollection("history")).rejects.toThrow(/not a Rei collection/);
    expect(fake.sent).toEqual([]);
    await store.dropCollection("rei_history_old");
    expect(fake.sent[0]).toMatchObject({ method: "DELETE", path: "/collections/rei_history_old?wait=true" });
  });

  it("batches a large upsert, and follows the search answer back into Rei's own shape", async () => {
    const fake = new FakeQdrant();
    const store = fake.store();
    const many = Array.from({ length: 300 }, (_, i) => point(`m:msg_${i}:0`));
    await store.upsert(LEXICAL_COLLECTION, many);
    expect(fake.sent.map((s) => s.method)).toEqual(["PUT", "PUT"]);
    expect((fake.sent[0]!.body as { points: unknown[] }).points).toHaveLength(256);

    fake.body = JSON.stringify({
      result: { points: [{ id: "uuid-1", score: 0.9, payload: { entry_id: 42, text: "a passage", agent_id: "a1" } }] },
    });
    const hits = await store.searchLexical("passage", { filters: {}, limit: 3 });
    expect(hits).toEqual([
      {
        pointId: "uuid-1",
        score: 0.9,
        payload: expect.objectContaining({ entryId: 42, text: "a passage", agentId: "a1" }),
      },
    ]);
  });
});

describe("the Qdrant client's answers", () => {
  it("keeps a refusal distinct from a service that is only busy", async () => {
    const refused = new FakeQdrant();
    refused.status = 403;
    refused.body = '{"status":{"error":"Forbidden"}}';
    const error = (await refused
      .store()
      .count(LEXICAL_COLLECTION)
      .catch((e) => e)) as RetrievalError;
    expect(error).toBeInstanceOf(RetrievalError);
    expect(error.status).toBe(403);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("403");

    const busy = new FakeQdrant();
    busy.status = 503;
    busy.body = '{"status":{"error":"overloaded"}}';
    const retried = (await busy
      .store({ retries: 2 })
      .count(LEXICAL_COLLECTION)
      .catch((e) => e)) as RetrievalError;
    expect(retried.retryable).toBe(true);
    expect(busy.sent).toHaveLength(3);
  });

  it("says unreachable when the service does not answer at all, and never pretends to be ok", async () => {
    const store = new QdrantStore({
      url: "http://qdrant:6333",
      apiKey: "k",
      retries: 0,
      sleep: async () => {},
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const status = await store.status();
    expect(status).toMatchObject({ ok: false, lexicalCollection: null, lexicalPoints: null, dense: [] });
    expect(status.detail).toContain("fetch failed");
  });

  it("lists only Rei's own collections", async () => {
    const fake = new FakeQdrant();
    fake.body = JSON.stringify({
      result: { collections: [{ name: "rei_history_lexical_v1" }, { name: "someone_elses" }] },
    });
    expect(await fake.store().collections()).toEqual(["rei_history_lexical_v1"]);
  });
});
