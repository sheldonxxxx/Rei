// The queue between SQLite and the search service: what gets indexed, what must come back out of the index, and what
// happens when the service is not answering. Everything here runs against `FakeRetrieval`, so the timing is the code's
// and the assertions are about intent; `test/retrieval-integration.test.ts` runs the same interface against the real
// Qdrant container.
import type { LibraryFile } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { LEXICAL_COLLECTION } from "../src/retrieval/retrieval-store.ts";
import { FakeRetrieval } from "./helpers/retrieval.ts";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";
import { chat, say, settled, treeOf } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const memory = (s: TestServer) => s.host.plane.memory;
const points = (fake: FakeRetrieval, collection = LEXICAL_COLLECTION) => fake.stored(collection);

describe("what the search service is told", () => {
  it("indexes a chat's messages as one point per chunk, with Rei's own tokens", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const id = await chat(s);
    await say(s, id, "The booking code is QX7 予約の確認");
    await settled(s, id);
    await memory(s).history.settle();

    const stored = points(fake);
    expect(stored.length).toBeGreaterThan(0);
    const point = stored[0]!;
    expect(point.pointId).toMatch(/^m:u:run_[0-9a-f]+:0$/);
    expect(point.payload).toMatchObject({
      sessionId: id,
      sourceType: "message",
      kind: "user",
      writtenBy: expect.stringMatching(/^outbox:\d+$/),
    });
    expect(point.payload.agentId).toBeTruthy();
    expect(point.payload.createdAt).toBeGreaterThan(0);
    // Rei's tokenising, not Qdrant's: the CJK bigrams the old FTS index held, so keyword results do not change.
    expect(point.payload.tokens.split(" ")).toEqual(expect.arrayContaining(["予約", "約の", "の確", "確認"]));
    expect(point.payload.tokens).toContain("qx7");
    expect(point.vector).toBeUndefined();
  });

  it("indexes a tool result too, named by the source that produced it", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const id = await chat(s);
    memory(s).history.indexToolResult({
      sessionId: id,
      runId: null,
      piEntryId: "pi_entry_1",
      toolName: "web_fetch",
      parts: [{ type: "text", text: "Fetched: the tenant complained about the deposit twice in the thread." }],
    });
    await memory(s).history.settle();
    const stored = points(fake);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.pointId).toBe(`t:${id}:pi_entry_1:0`);
    expect(stored[0]!.payload).toMatchObject({ sourceType: "tool", toolName: "web_fetch", kind: "tool" });
  });

  it("removes everything a purged chat produced from the index", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const kept = await chat(s);
    const gone = await chat(s);
    await say(s, kept, "this chat stays");
    await say(s, gone, "this chat is purged completely");
    await settled(s, kept);
    await settled(s, gone);
    await memory(s).history.settle();
    expect(new Set(points(fake).map((p) => p.payload.sessionId))).toEqual(new Set([kept, gone]));

    // The same two steps the delete flow takes: mark it for deletion, then purge the rows (which fires the memory hook).
    const jobId = s.host.plane.store.beginDeletion({
      sessionIds: [gone],
      treeId: treeOf(s, gone),
      removeTree: true,
    });
    s.host.plane.store.purgeSessions(jobId);
    await memory(s).history.settle();
    expect([...new Set(points(fake).map((p) => p.payload.sessionId))]).toEqual([kept]);
  });

  it("works the queue off after a restart, with the entries it was told about before", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const id = await chat(s);
    fake.failUpsert = 1_000; // nothing reaches the service in this lifetime
    await say(s, id, "a message whose indexing has not run yet");
    await settled(s, id);
    await memory(s).history.settle();
    expect(points(fake)).toHaveLength(0);
    const pending = memory(s).history.status().indexing?.pending ?? 0;
    expect(pending).toBeGreaterThan(0);

    // Same data directory, same search service: the queue is SQLite's, so the next process inherits the work.
    const dir = s.dir;
    await s.stop();
    const restarted = await startTestServer({ dir, retrieval: fake });

    server = restarted;
    fake.failUpsert = 0;
    restarted.clock.advance(600_000); // the queue is holding its backoff from before the restart
    restarted.host.plane.memory.history.catchUp();
    await memory(restarted).history.settle();
    expect(points(fake).length).toBeGreaterThanOrEqual(pending);
    expect(memory(restarted).history.status().indexing?.pending).toBe(0);
  });
});

describe("when the search service is not answering", () => {
  it("keeps the intent, says so, and catches up when the service comes back", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const id = await chat(s);
    fake.failUpsert = 10;
    await say(s, id, "an indexed message during an outage");
    await settled(s, id);
    await memory(s).history.settle();
    expect(points(fake)).toHaveLength(0);
    const status = memory(s).history.status();
    expect(status.indexing?.pending).toBeGreaterThan(0);
    expect(status.indexing?.lastError).toBeTruthy();
    // The service is reachable, so it decides what is findable: text it has not been told about yet is not found.
    expect(await memory(s).search({ query: "an indexed message during an outage" })).toEqual([]);
    // A service that does not answer at all is different: search falls back to Rei's own index and still works.
    fake.failSearch = 2;
    expect((await memory(s).search({ query: "outage" })).length).toBeGreaterThan(0);

    fake.failUpsert = 0;
    s.clock.advance(60_000); // past the backoff the queue is holding
    await memory(s).history.settle();
    expect(points(fake).map((p) => p.payload.text)).toContain("an indexed message during an outage");
    expect(memory(s).history.status().indexing?.pending).toBe(0);
    expect(memory(s).history.status().indexing?.lastError).toBeNull();
  });

  it("keeps a refused purge delete in the queue and finishes it later", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    const id = await chat(s);
    await say(s, id, "a phrase whose removal will be retried");
    await settled(s, id);
    await memory(s).history.settle();
    const target = points(fake).find((p) => p.payload.text.includes("retried"))!;
    expect(target).toBeTruthy();

    fake.failRemove = 5;
    const jobId = s.host.plane.store.beginDeletion({ sessionIds: [id], treeId: treeOf(s, id), removeTree: true });
    s.host.plane.store.purgeSessions(jobId);
    await memory(s).history.settle();
    // The service refused; the queue still owes the removal, so the point is still there.
    expect(memory(s).history.status().indexing?.pending).toBeGreaterThan(0);
    expect(points(fake).map((p) => p.pointId)).toContain(target.pointId);
    fake.failRemove = 0;
    s.clock.advance(600_000);
    await memory(s).history.settle();
    expect(points(fake).map((p) => p.pointId)).not.toContain(target.pointId);
  });
});

/** A Library file, so the type import is not decorative: the queue must not be the only thing indexing content. */
it("indexes a Library upload's chat copy through the same path", async () => {
  const fake = new FakeRetrieval();
  const s = await startSignedIn({ retrieval: fake });

  server = s;
  const id = await chat(s);
  const form = new FormData();
  form.append("file", new File(["an uploaded report about otters"], "otters.txt", { type: "text/plain" }));
  const uploaded = await s.client.fetcher(`/api/sessions/${id}/attachments`, {
    method: "POST",
    body: form,
    headers: { cookie: `rei_session=${s.client.cookie}`, "x-rei": "1" },
  });
  const attachment = (await uploaded.json()).attachment as { fileId?: string };
  expect(attachment.fileId).toBeTruthy();
  const file = (await s.client.get(`/api/files/${attachment.fileId}`)).body.file as LibraryFile;
  expect(file.origin).toBe("upload");
  // The upload's bytes are a file, not a message: only what was said in the chat is searchable.
  await memory(s).history.settle();
  expect(points(fake)).toHaveLength(0);
  await say(s, id, "the otters report is attached");
  await settled(s, id);
  await memory(s).history.settle();
  expect(points(fake).map((p) => p.payload.text)).toContain("the otters report is attached");
  expect(points(fake).some((p) => p.payload.text.includes("otters.txt"))).toBe(false);
});
