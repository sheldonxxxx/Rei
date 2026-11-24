// How search behaves when the retrieval service is the one answering: what it is asked, what it is allowed to decide,
// and what Rei does when it is not there. The service proposes; SQLite disposes.
import { afterEach, describe, expect, it } from "vitest";
import { denseCollectionFor } from "../src/retrieval/points.ts";
import { LEXICAL_COLLECTION } from "../src/retrieval/retrieval-store.ts";
import { FakeEmbedder, withEmbedder } from "./helpers/fake-embedder.ts";
import { historyState } from "./helpers/history.ts";
import { FakeRetrieval } from "./helpers/retrieval.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const memory = (s: TestServer) => s.host.plane.memory;

describe("search through the retrieval service", () => {
  it("asks the service, and only SQLite decides which candidates become hits", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const id = await chat(s);
    await say(s, id, "the deposit was refunded after the tenant complained");
    await settled(s, id);
    await memory(s).history.settle();
    const real = fake.stored().find((p) => p.payload.text.includes("deposit"))!;
    expect(real).toBeTruthy();

    // A service that hands back a stale point (an entry SQLite no longer has) gets no answer out of Rei.
    fake.forced = [
      {
        pointId: "m:msg_ghost:0",
        score: 100,
        payload: { ...real.payload, entryId: 987_654, pointId: undefined as never },
      } as never,
      { pointId: real.pointId, score: 5, payload: real.payload },
    ];
    const hits = await memory(s).search({ query: "deposit refund", mode: { kind: "keyword" } });
    expect(hits.map((h) => h.chunkId)).toEqual([`h${real.payload.entryId}`]);
    expect(fake.lexicalQueries.at(-1)).toMatchObject({ query: "deposit refund", limit: expect.any(Number) });
    fake.forced = undefined;
  });

  it("passes the caller's filters to the service, and applies them again itself", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const id = await chat(s);
    await say(s, id, "the plumbing quote from last spring");
    await settled(s, id);
    await memory(s).history.settle();
    const session = (await detail(s, id)).session;
    const from = session.createdAt - 1;
    const to = session.createdAt + 10_000;
    expect((await memory(s).search({ query: "plumbing", agentId: session.agentId, from, to })).length).toBeGreaterThan(
      0,
    );
    expect(fake.lexicalQueries.at(-1)!.filters).toEqual({ agentId: session.agentId, from, to });
    // A window that excludes the chat finds nothing, even though the service was asked and could have answered.
    expect(await memory(s).search({ query: "plumbing", from: to + 1, to: to + 2 })).toEqual([]);
  });

  it("asks the active dense generation for meaning, and takes the ranking from it", async () => {
    const embedder = new FakeEmbedder();
    const fake = new FakeRetrieval();
    const s = await startSignedIn(withEmbedder(embedder, { retrieval: fake }));

    server = s;
    const id = await chat(s);
    await say(s, id, "my car will not start this morning");
    await settled(s, id);
    await memory(s).history.settle();
    const set = historyState(memory(s)).activeSet();
    expect(set).toBeTruthy();
    const dense = denseCollectionFor(set!.id);
    expect(fake.stored(dense).length).toBeGreaterThan(0);

    // "vehicle" shares a dimension with "car" in the fake model, and does not share a word: only meaning finds it.
    const hits = await memory(s).search({ query: "vehicle trouble", mode: { kind: "vector" } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain("car");
    expect(fake.denseQueries.at(-1)!.collection).toBe(dense);
    expect(hits.every((h) => h.cosine !== null)).toBe(true);
    // The lexical collection carries no vectors, and the dense one is not asked for words.
    expect(fake.stored(LEXICAL_COLLECTION).every((p) => p.vector === undefined)).toBe(true);
  });

  it("still answers when the service refuses to search, from Rei's own index", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const id = await chat(s);
    await say(s, id, "the lease renewal needs a signature before Friday");
    await settled(s, id);
    await memory(s).history.settle();
    fake.failSearch = 10;
    const hits = await memory(s).search({ query: "lease renewal signature" });
    expect(hits.map((h) => h.snippet).join(" ")).toContain("lease renewal");
    // Meaning search has no local copy when the service holds the vectors: that half is simply absent.
    expect(hits.every((h) => h.vectorRank === null)).toBe(true);
  });

  it("finds the same text for a Chinese query, whether the service or SQLite answered", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const id = await chat(s);
    await say(s, id, "予約の確認をありがとう");
    await settled(s, id);
    await memory(s).history.settle();
    const viaService = await memory(s).search({ query: "予約", mode: { kind: "keyword" } });
    fake.failSearch = 1;
    const viaSqlite = await memory(s).search({ query: "予約", mode: { kind: "keyword" } });
    expect(viaService.map((h) => h.chunkId)).toEqual(viaSqlite.map((h) => h.chunkId));
    expect(viaService.length).toBeGreaterThan(0);
  });

  it("counts the backlog it is holding, and clears it when the service comes back", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const id = await chat(s);
    fake.failEnsure = 3;
    fake.failUpsert = 2;
    await say(s, id, "a backlog the status has to admit to");
    await settled(s, id);
    await expect(memory(s).history.settle()).rejects.toThrow(/search service/);
    const behind = memory(s).history.status().indexing!;
    expect(behind.pending).toBeGreaterThan(0);
    expect(behind.lastError).toBeTruthy();
    fake.failEnsure = 0;
    fake.failUpsert = 0;
    s.clock.advance(600_000);
    await memory(s).history.settle();
    expect(memory(s).history.status().indexing!.pending).toBe(0);
    expect((await s.client.get("/api/memory/index")).body.index.indexing).toMatchObject({
      pending: 0,
      lastError: null,
    });
  });
});
