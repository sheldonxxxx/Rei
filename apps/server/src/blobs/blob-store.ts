import { sha256Hex } from "../util/encoding.ts";

/** Content-addressed blobs. A folder today, R2 later. A ref is `sha256:<hex>`. */
export interface BlobStore {
  put(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  get(ref: string): Promise<Uint8Array<ArrayBuffer> | undefined>;
  has(ref: string): Promise<boolean>;
  /** Removes a blob; a missing one is not an error. */
  delete(ref: string): Promise<void>;
}

export async function blobRefFor(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`;
}

export function parseBlobRef(ref: string): string {
  const m = /^sha256:([0-9a-f]{64})$/.exec(ref);
  if (!m) throw new Error("invalid blob ref");
  return m[1]!;
}

/** In-memory store for tests of code that only needs the interface. */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  async put(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const ref = await blobRefFor(bytes);
    this.blobs.set(ref, bytes);
    return ref;
  }
  async get(ref: string) {
    return this.blobs.get(ref);
  }
  async has(ref: string) {
    return this.blobs.has(ref);
  }
  async delete(ref: string) {
    this.blobs.delete(ref);
  }
}
