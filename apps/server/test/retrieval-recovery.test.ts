import { afterEach, describe, expect, it, vi } from "vitest";
import { denseCollectionFor } from "../src/retrieval/points.ts";
import { LEXICAL_COLLECTION, type RetrievalPoint } from "../src/retrieval/retrieval-store.ts";
import { MemoryFileObjectStore } from "../src/storage/file-object-store.ts";
import { FakeEmbedder, withEmbedder } from "./helpers/fake-embedder.ts";
import { historyState } from "./helpers/history.ts";
import { FakeRetrieval } from "./helpers/retrieval.ts";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";
import { chat, treeOf } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

function add(s: TestServer, sessionId: string, text: string, piEntryId = "1"): void {
  historyState(s.host.plane.memory).addToolResult({ sessionId, runId: null, piEntryId, toolName: "web_fetch", text });
  s.host.plane.memory.history.catchUp();
}

/** Pause a write before it reaches the service, to control the ordering with a purge. */
class PausedRetrieval extends FakeRetrieval {
  pauseCollection: string | undefined;
  readonly entered = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  rejectPaused = false;
  override async upsert(collection: string, points: RetrievalPoint[]): Promise<void> {
    if (collection === this.pauseCollection) {
      this.pauseCollection = undefined;
      this.entered.resolve();
      await this.release.promise;
      if (this.rejectPaused) throw new Error("the older write failed");
    }
    await super.upsert(collection, points);
  }
}

describe("retrieval recovery and concurrent deletion", () => {
  it("keeps independent tool counters separate through indexing and purge", async () => {
    const fake = new FakeRetrieval();
    const embedder = new FakeEmbedder();
    const s = await startSignedIn(withEmbedder(embedder, { retrieval: fake }));
    server = s;
    const kept = await chat(s);
    const gone = await chat(s);
    add(s, kept, "surviving otter record");
    add(s, gone, "purged badger record");
    await s.host.plane.memory.history.settle();
    const dense = denseCollectionFor(historyState(s.host.plane.memory).activeSet()!.id);
    for (const collection of [LEXICAL_COLLECTION, dense])
      expect(fake.stored(collection).filter((p) => p.payload.entryId)).toHaveLength(2);
    const job = s.host.plane.store.beginDeletion({ sessionIds: [gone], treeId: treeOf(s, gone), removeTree: true });
    s.host.plane.store.purgeSessions(job);
    await s.host.plane.memory.history.settle();
    for (const collection of [LEXICAL_COLLECTION, dense])
      expect(
        fake
          .stored(collection)
          .filter((p) => p.payload.entryId)
          .map((p) => p.payload.text),
      ).toEqual(["surviving otter record"]);
  });

  it("restores lexical points and dense coverage from SQLite without a Qdrant backup", async () => {
    const fake = new FakeRetrieval();
    const embedder = new FakeEmbedder();
    const options = withEmbedder(embedder, { retrieval: fake });
    const s = await startSignedIn(options);
    server = s;
    const id = await chat(s);
    add(s, id, "recovery otter record");
    await s.host.plane.memory.history.settle();
    const set = historyState(s.host.plane.memory).activeSet()!;
    expect(historyState(s.host.plane.memory).coverage(set.id).embedded).toBe(1);
    await s.stop();
    fake.points.clear();
    const restarted = await startTestServer({ ...options, dir: s.dir });
    server = restarted;
    await restarted.host.plane.memory.history.settle();
    expect(fake.stored().map((p) => p.payload.text)).toEqual(["recovery otter record"]);
    expect(fake.stored(denseCollectionFor(set.id)).filter((p) => p.vector)).toHaveLength(1);
    expect(historyState(restarted.host.plane.memory).coverage(set.id).embedded).toBe(1);
    expect(restarted.host.plane.memory.history.status().indexing?.pending).toBe(0);
  });

  it("replaces legacy colliding tool IDs and resets their dense coverage on upgrade", async () => {
    const fake = new FakeRetrieval();
    const options = withEmbedder(new FakeEmbedder(), { retrieval: fake });
    const s = await startSignedIn(options);
    server = s;
    const first = await chat(s);
    const second = await chat(s);
    add(s, first, "legacy otter record");
    add(s, second, "legacy badger record");
    await s.host.plane.memory.history.settle();
    const set = historyState(s.host.plane.memory).activeSet()!;
    for (const collection of [LEXICAL_COLLECTION, denseCollectionFor(set.id)]) {
      const map = fake.points.get(collection)!;
      const entries = [...map.values()].filter((p) => p.payload.entryId);
      for (const entry of entries) map.delete(entry.pointId);
      map.set("t:1:0", { ...entries[0]!, pointId: "t:1:0" });
    }
    s.host.plane.store.db.run("DELETE FROM meta WHERE key = 'retrieval_tool_namespace'");
    await s.stop();
    const restarted = await startTestServer({ ...options, dir: s.dir });
    server = restarted;
    await restarted.host.plane.memory.history.settle();
    for (const collection of [LEXICAL_COLLECTION, denseCollectionFor(set.id)]) {
      expect(fake.points.get(collection)!.has("t:1:0")).toBe(false);
      expect(fake.stored(collection).filter((p) => p.payload.entryId)).toHaveLength(2);
    }
    expect(historyState(restarted.host.plane.memory).coverage(set.id).embedded).toBe(2);
  });

  it("repairs only the missing dense generation during an ordinary catch-up", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn(withEmbedder(new FakeEmbedder(), { retrieval: fake }));
    server = s;
    const id = await chat(s);
    add(s, id, "dense recovery record");
    await s.host.plane.memory.history.settle();
    const set = historyState(s.host.plane.memory).activeSet()!;
    await fake.dropCollection(denseCollectionFor(set.id));
    s.host.plane.memory.history.catchUp();
    await s.host.plane.memory.history.settle();
    expect(fake.stored(denseCollectionFor(set.id)).filter((p) => p.vector)).toHaveLength(1);
  });

  it("retries initialization even when startup failed with an empty outbox", async () => {
    const fake = new FakeRetrieval();
    fake.failEnsure = 1;
    const s = await startSignedIn({ retrieval: fake });
    server = s;
    await s.host.plane.memory.history.settleRunning();
    expect(fake.points.has(LEXICAL_COLLECTION)).toBe(false);
    await vi.waitFor(() => expect(fake.points.has(LEXICAL_COLLECTION)).toBe(true), { timeout: 3_000 });
    const id = await chat(s);
    add(s, id, "indexed after initialization recovered");
    await s.host.plane.memory.history.settle();
    expect(fake.stored()).toHaveLength(1);
    expect(s.host.plane.memory.history.status().indexing?.pending).toBe(0);
  });

  it.each([false, true])(
    "preserves a newer purge intent when an older upsert finishes (failure=%s)",
    async (reject) => {
      const fake = new PausedRetrieval();
      const s = await startSignedIn({ retrieval: fake });
      server = s;
      const id = await chat(s);
      fake.pauseCollection = LEXICAL_COLLECTION;
      add(s, id, "text purged during upsert");
      await fake.entered.promise;
      const job = s.host.plane.store.beginDeletion({ sessionIds: [id], treeId: treeOf(s, id), removeTree: true });
      s.host.plane.store.purgeSessions(job);
      const intent = s.host.plane.store.db.get<{ seq: number }>(
        "SELECT seq FROM retrieval_outbox WHERE op = 'delete'",
      )!;
      fake.rejectPaused = reject;
      fake.release.resolve();
      await s.host.plane.memory.history.settleRunning();
      if (reject) {
        expect(
          s.host.plane.store.db.get("SELECT seq, attempts, next_attempt_at, last_error FROM retrieval_outbox"),
        ).toMatchObject({ seq: intent.seq, attempts: 0, next_attempt_at: 0, last_error: null });
      }
      await s.host.plane.memory.history.settle();
      expect(fake.stored()).toEqual([]);
      expect(s.host.plane.memory.history.status().indexing?.pending).toBe(0);
    },
  );

  it("reclaims abandoned objects during the normal attachment sweep", async () => {
    const objects = new MemoryFileObjectStore();
    const s = await startSignedIn({ fileObjects: objects });
    server = s;
    const registry = s.host.plane.storage.registry;
    const object = registry.begin({
      id: "obj_abandoned",
      sha256: "a".repeat(64),
      byteLength: 3,
      bucket: objects.bucket,
    });
    registry.markReady(object.id);
    s.clock.advance(2 * 86_400_000);
    await s.host.plane.adapter.attachments!.sweep();
    expect(registry.row(object.id)?.state).toBe("deleted");
  });
});
