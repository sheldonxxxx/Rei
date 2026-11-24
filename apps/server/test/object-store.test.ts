// The file store's contract, tested against every implementation: a put is not a put until the object is there, the
// bytes must match the hash the key carries, and a delete of something already gone is not an error.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderFileObjectStore } from "../src/node/folder-object-store.ts";
import {
  collect,
  type FileObjectStore,
  MemoryFileObjectStore,
  objectKey,
  parseObjectKey,
  StorageError,
  sha256Hex,
} from "../src/storage/file-object-store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

const stores: Record<string, () => FileObjectStore> = {
  memory: () => new MemoryFileObjectStore(),
  folder: () => {
    const dir = mkdtempSync(join(tmpdir(), "rei-objects-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return new FolderFileObjectStore(join(dir, "files"));
  },
};

for (const [name, make] of Object.entries(stores)) {
  describe(`FileObjectStore (${name})`, () => {
    it("writes an object once and reads back exactly the bytes it was given", async () => {
      const store = make();
      const content = bytes("hello 你好 — a file with some bytes\n");
      const sha256 = await sha256Hex(content);
      const key = objectKey("obj_1", sha256);
      await store.put({ key, bytes: content, sha256 });
      expect(await store.get(key)).toEqual(content);
      expect((await store.head(key))?.byteLength).toBe(content.byteLength);
      // Writing the same key again is a no-op, not a rewrite and not an error.
      await store.put({ key, bytes: content, sha256 });
      expect(await store.get(key)).toEqual(content);
    });

    it("serves a byte range without pretending it is the whole object", async () => {
      const store = make();
      const content = bytes("0123456789");
      const sha = await sha256Hex(content);
      const key = objectKey("obj_range", sha);
      await store.put({ key, bytes: content, sha256: sha });
      expect(new TextDecoder().decode((await store.get(key, { start: 3, end: 5 }))!)).toBe("345");
      expect(new TextDecoder().decode((await store.get(key, { start: 7 }))!)).toBe("789");
    });

    it("answers undefined, not an error, for an object that is not there", async () => {
      const store = make();
      const key = objectKey("obj_gone", "a".repeat(64));
      expect(await store.get(key)).toBeUndefined();
      expect(await store.head(key)).toBeUndefined();
      await expect(store.delete(key)).resolves.toBeUndefined();
    });

    it("refuses bytes that do not match the hash in their own key", async () => {
      const store = make();
      const key = objectKey("obj_lie", "b".repeat(64));
      const content = bytes("not what the key says");
      await expect(store.put({ key, bytes: content, sha256: await sha256Hex(content) })).rejects.toThrow(StorageError);
      await expect(store.put({ key, bytes: content, sha256: "b".repeat(64) })).rejects.toThrow(/hash/);
      expect(await store.head(key)).toBeUndefined();
    });

    it("keeps a file whose bytes were changed on the side from being read as the right ones", async () => {
      if (name !== "folder") return; // only a store with bytes on disk can be tampered with
      const store = make() as FolderFileObjectStore;
      const content = bytes("the real bytes");
      const key = objectKey("obj_tampered", await sha256Hex(content));
      await store.put({ key, bytes: content, sha256: await sha256Hex(content) });
      const path = join(store.root, key);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, "different bytes");
      await expect(store.get(key)).rejects.toThrow(/hash/);
    });

    it("takes a stream of known length and serves the object back as a stream", async () => {
      const store = make();
      const parts = ["first part, ", "second part, ", "and the last"].map(bytes);
      const content = bytes(parts.map((part) => new TextDecoder().decode(part)).join(""));
      const sha256 = await sha256Hex(content);
      const key = objectKey("obj_stream", sha256);
      let opened = 0;
      const stream = () => {
        opened++;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        });
      };
      await store.put({ key, sha256, byteLength: content.byteLength, stream });
      expect(opened).toBe(1);
      expect(await store.get(key)).toEqual(content);
      const object = (await store.open(key))!;
      expect(object.byteLength).toBe(content.byteLength);
      expect(await collect(object.body)).toEqual(content);
      expect(await store.open(objectKey("obj_none", "d".repeat(64)))).toBeUndefined();
    });

    it("refuses a stream whose bytes or length do not match what it promised", async () => {
      const store = make();
      const content = bytes("the promised bytes");
      const sha256 = await sha256Hex(content);
      const key = objectKey("obj_stream_lie", sha256);
      const of = (value: Uint8Array) => () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(value);
            controller.close();
          },
        });
      await expect(
        store.put({ key, sha256, byteLength: content.byteLength, stream: of(bytes("other bytes, same size")) }),
      ).rejects.toThrow(StorageError);
      await expect(store.put({ key, sha256, byteLength: content.byteLength + 1, stream: of(content) })).rejects.toThrow(
        StorageError,
      );
      expect(await store.head(key)).toBeUndefined();
    });

    it("holds back the end of a streamed read whose bytes were changed on the side", async () => {
      if (name !== "folder") return; // only a store with bytes on disk can be tampered with
      const store = make() as FolderFileObjectStore;
      const content = new Uint8Array(3 * 1024 * 1024).fill(7) as Uint8Array<ArrayBuffer>;
      const key = objectKey("obj_stream_tampered", await sha256Hex(content));
      await store.put({ key, bytes: content, sha256: await sha256Hex(content) });
      const { writeFileSync } = await import("node:fs");
      const changed = content.slice();
      changed[changed.length - 1] = 8;
      writeFileSync(join(store.root, key), changed);
      const object = (await store.open(key))!;
      const reader = object.body.getReader();
      let delivered = 0;
      const error = await (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) return undefined;
          delivered += next.value.byteLength;
        }
      })().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).kind).toBe("integrity");
      // The reader never received the whole object: the last chunk waits for the hash and is dropped when it fails.
      expect(delivered).toBeLessThan(content.byteLength);
    });

    it("lists keys under a prefix, for reconciliation", async () => {
      const store = make();
      for (const id of ["obj_a", "obj_b"]) {
        const content = bytes(id);
        await store.put({
          key: objectKey(id, await sha256Hex(content)),
          bytes: content,
          sha256: await sha256Hex(content),
        });
      }
      const keys = await store.list("files/v1/");
      expect(keys).toHaveLength(2);
      expect(keys.every((key) => key.startsWith("files/v1/"))).toBe(true);
      expect(await store.list("files/v1/obj_a/")).toHaveLength(1);
    });

    it("refuses a key outside its own layout, so a caller cannot walk the filesystem", async () => {
      const store = make();
      for (const key of [
        "../../etc/passwd",
        "files/v2/obj/x",
        "files/v1/obj/notahash",
        "files/v1/obj/" + "c".repeat(63),
      ]) {
        await expect(store.get(key)).rejects.toThrow(/object key/);
        await expect(store.delete(key)).rejects.toThrow(/object key/);
      }
    });
  });
}

describe("object keys", () => {
  it("carry the object's id and the hash of its bytes, and nothing else", () => {
    const sha = "d".repeat(64);
    expect(parseObjectKey(objectKey("obj_12", sha))).toEqual({ objectId: "obj_12", sha256: sha });
  });

  it("never contain a filename, however the caller spells it", () => {
    const sha = "e".repeat(64);
    for (const name of ["../../etc/passwd", "a b.txt", "日本 語.txt"]) {
      const key = objectKey(`obj_${name.length}`, sha);
      expect(key).not.toContain(name);
      expect(key).toMatch(/^files\/v1\/[a-z0-9_]+\/[0-9a-f]{64}$/);
    }
  });
});
