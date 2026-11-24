import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BlobStore, blobRefFor, parseBlobRef } from "../blobs/blob-store.ts";
import { randomBytes, toHex } from "../util/encoding.ts";

/** Blobs as files under `<root>/<first two hex>/<hex>`, written once (content-addressed, so rewrites are no-ops). */
export class FolderBlobStore implements BlobStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }
  #path(ref: string): string {
    const hex = parseBlobRef(ref);
    return join(this.root, hex.slice(0, 2), hex);
  }
  async put(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const ref = await blobRefFor(bytes);
    const path = this.#path(ref);
    if (existsSync(path)) return ref;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${toHex(randomBytes(4))}.tmp`;
    try {
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    return ref;
  }
  async get(ref: string) {
    const path = this.#path(ref);
    if (!existsSync(path)) return undefined;
    const data = readFileSync(path);
    return new Uint8Array(data);
  }
  async has(ref: string) {
    return existsSync(this.#path(ref));
  }
  async delete(ref: string) {
    rmSync(this.#path(ref), { force: true });
  }
}
