// The upload spool: an upload is staged whole, hashed with its envelope as it is written, refused as soon as it passes
// its limit, read back as many times as a retried put needs, and leaves nothing behind.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderUploadSpool } from "../src/node/upload-spool.ts";
import { collect } from "../src/storage/file-object-store.ts";
import { MemoryUploadSpool, type UploadSpool, UploadTooLargeError } from "../src/storage/upload-spool.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "rei-spool-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "uploads");
};

async function* chunksOf(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

const spools: Record<string, () => UploadSpool> = {
  memory: () => new MemoryUploadSpool(),
  folder: () => new FolderUploadSpool(folder()),
};

for (const [name, make] of Object.entries(spools)) {
  describe(`upload spool (${name})`, () => {
    it("stages an upload with its envelope, hashes both, and reads it back more than once", async () => {
      const spool = make();
      const prefix = new TextEncoder().encode("ENV:");
      const staged = await spool.stage(chunksOf("hello ", "world"), { prefix, maxBytes: 64 });
      expect(staged.size).toBe(11);
      expect(staged.sha256).toBe(createHash("sha256").update("ENV:hello world").digest("hex"));
      for (let i = 0; i < 2; i++)
        expect(new TextDecoder().decode(await collect(staged.stream()))).toBe("ENV:hello world");
      await staged.dispose();
    });

    it("refuses an upload as soon as it passes the limit", async () => {
      const spool = make();
      let pulled = 0;
      async function* endless(): AsyncGenerator<Uint8Array> {
        for (;;) {
          pulled++;
          yield new Uint8Array(10);
        }
      }
      await expect(spool.stage(endless(), { prefix: new Uint8Array(), maxBytes: 25 })).rejects.toThrow(
        UploadTooLargeError,
      );
      expect(pulled).toBe(3);
    });
  });
}

describe("upload spool on disk", () => {
  it("keeps staged files private, removes them when done or refused, and clears leftovers at start", async () => {
    const root = folder();
    const spool = new FolderUploadSpool(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    const staged = await spool.stage(chunksOf("bytes"), { prefix: new Uint8Array(), maxBytes: 64 });
    const [file] = readdirSync(root);
    expect(file).toMatch(/\.part$/);
    expect(statSync(join(root, file!)).mode & 0o777).toBe(0o600);
    await staged.dispose();
    expect(readdirSync(root)).toEqual([]);
    await expect(collect(staged.stream())).rejects.toThrow(/removed/);

    await expect(spool.stage(chunksOf("x".repeat(100)), { prefix: new Uint8Array(), maxBytes: 10 })).rejects.toThrow(
      UploadTooLargeError,
    );
    expect(readdirSync(root)).toEqual([]);

    writeFileSync(join(root, "interrupted.part"), "left by a crash");
    writeFileSync(join(root, "keep.txt"), "not the spool's");
    new FolderUploadSpool(root);
    expect(readdirSync(root)).toEqual(["keep.txt"]);
  });
});
