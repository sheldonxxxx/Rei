// What the file store's failure modes look like from the outside: an upload is only real when the bytes are there and
// hash to their key, a service that is not answering costs a retry rather than a leak, and nothing that SQLite still
// needs is ever deleted.
import type { LibraryFile } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileObjectStore, objectKey, StorageError, sha256Hex } from "../src/storage/file-object-store.ts";
import { ORPHAN_GRACE_MS } from "../src/storage/registry.ts";
import { startSignedIn, type TestServer, type TestServerOptions } from "./helpers/server.ts";
import { chat, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

/** The in-memory store, with the two failures a real object service can produce. */
class FaultyStore extends MemoryFileObjectStore {
  failNextPut = 0;
  blockDeletes = false;

  override async put(input: { key: string; bytes: Uint8Array<ArrayBuffer>; sha256: string }): Promise<void> {
    if (this.failNextPut > 0) {
      this.failNextPut--;
      throw new StorageError("unavailable", "The file service is not answering.", { retryable: true });
    }
    return super.put(input);
  }

  override async delete(key: string): Promise<void> {
    if (this.blockDeletes)
      throw new StorageError("unavailable", "The file service refused the delete.", { retryable: true });
    return super.delete(key);
  }
}

const withStore = async (store: FaultyStore, options: TestServerOptions = {}): Promise<TestServer> =>
  startSignedIn({ ...options, fileObjects: store });

const post = async (s: TestServer, path: string, content: string | Uint8Array<ArrayBuffer>, name = "notes.txt") => {
  const form = new FormData();
  form.append("file", new File([content], name, { type: "text/plain" }));
  const response = await s.client.fetcher(path, {
    method: "POST",
    body: form,
    headers: { cookie: `rei_session=${s.client.cookie}`, "x-rei": "1" },
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
};

const upload = async (s: TestServer, name = "notes.txt", content = "original bytes"): Promise<LibraryFile> => {
  const response = await post(s, "/api/files", content, name);
  expect(response.status).toBe(200);
  return response.body.file;
};

const url = (file: LibraryFile, version = file.current.versionId) =>
  `/api/files/${file.id}/versions/${version}/content`;
const storageOf = (s: TestServer) => s.host.plane.storage;
const objectFor = (s: TestServer, attachmentId: string) => {
  const objectId = s.host.plane.adapter.attachments!.row(attachmentId)!.object_id;
  return storageOf(s).registry.row(objectId)!;
};

describe("file objects through the real upload path", () => {
  it("reports an upload only once the bytes are in the store and hash to their own key", async () => {
    const store = new FaultyStore();
    const s = await withStore(store);
    const file = await upload(s);
    const object = objectFor(s, file.current.attachmentId);
    expect(object).toMatchObject({ state: "ready", bucket: store.bucket });
    const stored = (await store.get(object.object_key))!;
    // What the store holds is the whole object; its hash is the one the ledger carries and the key names.
    expect(await sha256Hex(stored)).toBe(object.content_sha256);
    expect(object.object_key.endsWith(object.content_sha256)).toBe(true);
    // The file's own bytes come back without the envelope Rei wraps them in.
    expect(await (await s.client.raw("GET", url(file))).text()).toBe("original bytes");
    expect(stored.byteLength).toBeGreaterThan(file.current.size);
  });

  it("fails an upload honestly when the store is not answering, and recovers without leaving a leak", async () => {
    const store = new FaultyStore();
    const s = await withStore(store);
    store.failNextPut = 1;
    const failed = await post(s, "/api/files", "half an upload");
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("file_storage_unavailable");
    // Nothing of it is visible, and nothing of it is left behind in the store.
    expect((await s.client.get("/api/files")).body.files).toHaveLength(0);
    expect(store.objects.size).toBe(0);
    expect(storageOf(s).registry.counts()).toMatchObject({ ready: 0, deletePending: 1 });
    // The ledger still says what has to be deleted, so the sweep finishes the job.
    expect((await storageOf(s).maintenance.drain()).deleted).toBe(1);
    expect(storageOf(s).registry.counts()).toMatchObject({ deletePending: 0 });
    // The user's retry works, and is the only thing in the Library.
    const file = await upload(s, "retry.txt", "the same file again");
    expect((await s.client.get("/api/files")).body.files.map((f: LibraryFile) => f.id)).toEqual([file.id]);
    expect(store.objects.size).toBe(1);
  });

  it("does not store a published file twice, whichever order the two calls arrive in", async () => {
    const store = new FaultyStore();
    const s = await withStore(store);
    const session = await chat(s);
    const attachments = s.host.plane.adapter.attachments!;
    const file = new File(["generated report"], "report.txt", { type: "text/plain" });
    const first = await attachments.upload(session, file, undefined, "Agent", "tool-call-1");
    const second = await attachments.upload(session, file, undefined, "Agent", "tool-call-1");
    expect(second.id).toBe(first.id);
    expect(store.puts).toBe(1);
    expect((await s.client.get("/api/files")).body.files).toHaveLength(1);
  });

  it("reclaims an object no row of SQLite points at, once the grace period has passed", async () => {
    const store = new FaultyStore();
    const s = await withStore(store);
    const storage = storageOf(s);
    // What a crash between "Garage took the bytes" and "SQLite committed the row" leaves behind: a written object, and
    // a ledger row nothing owns.
    const bytes = new TextEncoder().encode("orphan bytes") as Uint8Array<ArrayBuffer>;
    const sha256 = await sha256Hex(bytes);
    const row = storage.registry.begin({
      id: "obj_orphan",
      sha256,
      byteLength: bytes.byteLength,
      bucket: store.bucket,
    });
    await store.put({ key: row.object_key, bytes, sha256 });
    storage.registry.markReady("obj_orphan");
    expect(await store.head(row.object_key)).toBeDefined();
    // Not yet: an upload in flight is not an orphan.
    expect(storage.maintenance.reconcile()).toBe(0);
    s.clock.advance(ORPHAN_GRACE_MS + 1);
    expect(storage.maintenance.reconcile()).toBe(1);
    expect((await storage.maintenance.drain()).deleted).toBe(1);
    expect(await store.head(row.object_key)).toBeUndefined();
    expect(storage.registry.row("obj_orphan")!.state).toBe("deleted");
  });

  it("keeps the bytes of a file still in Trash, and of one restored from it", async () => {
    const store = new FaultyStore();
    const s = await withStore(store);
    const file = await upload(s);
    const object = objectFor(s, file.current.attachmentId);
    await s.client.call("PATCH", `/api/files/${file.id}`, { body: { trashed: true } });
    await s.host.plane.storage.maintenance.drain();
    expect(await store.head(object.object_key)).toBeDefined();
    await s.client.call("PATCH", `/api/files/${file.id}`, { body: { trashed: false } });
    expect(await (await s.client.raw("GET", url(file))).text()).toBe("original bytes");
  });

  it("retries a delete the service refused, and never reports the bytes gone while they are still there", async () => {
    const store = new FaultyStore();
    const s = await withStore(store);
    const file = await upload(s);
    const object = objectFor(s, file.current.attachmentId);
    const attachments = s.host.plane.adapter.attachments!;
    store.blockDeletes = true;
    await s.client.call("PATCH", `/api/files/${file.id}`, { body: { trashed: true } });
    expect((await s.client.raw("DELETE", `/api/files/${file.id}`, { body: { confirm: true } })).status).toBe(200);
    await attachments.sweep();
    // Purging already tried the delete; what the refused attempt leaves behind is the intent, with a backoff on it.
    expect(await storageOf(s).maintenance.drain()).toMatchObject({ attempted: 0 });
    // The file is gone from the user's view, but Rei has not told itself the bytes are gone.
    expect((await s.client.get(`/api/files/${file.id}`)).status).toBe(404);
    expect(await store.head(object.object_key)).toBeDefined();
    expect(storageOf(s).registry.row(object.id)).toMatchObject({ state: "delete_pending", attempts: 1 });
    expect(storageOf(s).registry.row(object.id)!.next_attempt_at).toBeGreaterThan(s.clock.now());
    expect(storageOf(s).registry.counts().lastError).toBeTruthy();
    // When the service answers again, the work that was owed gets done.
    store.blockDeletes = false;
    s.clock.advance(3_600_001);
    expect((await storageOf(s).maintenance.drain()).deleted).toBe(1);
    expect(await store.head(object.object_key)).toBeUndefined();
    expect(storageOf(s).registry.row(object.id)!.state).toBe("deleted");
  });

  it("keeps serving a file one chat pinned after another chat purged it from the Library", async () => {
    const store = new FaultyStore();
    const s = await withStore(store);
    const source = await chat(s);
    const target = await chat(s);
    const uploaded = await post(s, `/api/sessions/${source}/attachments`, "keep me", "keep.txt");
    expect(uploaded.status).toBe(200);
    const attachment = uploaded.body.attachment;
    const sent = await s.client.post(`/api/sessions/${target}/messages`, {
      requestId: "pin",
      text: "read",
      files: [{ fileId: attachment.fileId, versionId: attachment.versionId }],
    });
    expect(sent.status).toBe(200);
    await settled(s, target);
    const file = (await s.client.get(`/api/files/${attachment.fileId}`)).body.file as LibraryFile;
    const object = objectFor(s, file.current.attachmentId);
    // Purge the Library file, then delete the chat that uploaded it: the pinning chat still needs those bytes.
    await s.client.call("PATCH", `/api/files/${file.id}`, { body: { trashed: true } });
    await s.client.raw("DELETE", `/api/files/${file.id}`, { body: { confirm: true } });
    await s.client.raw("DELETE", `/api/sessions/${source}`);
    await s.host.plane.adapter.attachments!.sweep();
    s.clock.advance(3_600_001);
    await storageOf(s).maintenance.drain();
    expect(await store.head(object.object_key)).toBeDefined();
    expect(await (await s.client.raw("GET", `/api/sessions/${target}/attachments/${attachment.id}`)).text()).toBe(
      "keep me",
    );
    // Once the pinning chat goes too, the object becomes reclaimable and the next sweep takes it.
    await s.client.raw("DELETE", `/api/sessions/${target}`);
    await s.host.plane.adapter.attachments!.sweep();
    s.clock.advance(ORPHAN_GRACE_MS + 1);
    storageOf(s).maintenance.reconcile();
    await storageOf(s).maintenance.drain();
    expect(await store.head(object.object_key)).toBeUndefined();
    expect(objectKey(object.id, object.content_sha256)).toBe(object.object_key);
  });
});
