// Where a file waits between arriving and being put in the object store. The object key carries the SHA-256 of the
// bytes and the ledger row is written before the put, so the hash must be known before the first byte reaches the
// store: a file that arrives as a stream is written somewhere first. On a server that somewhere is a private folder on
// disk (src/node/upload-spool.ts), so a 1 GiB upload costs a chunk of memory, not a gigabyte.
import { collect, sha256Hex } from "./file-object-store.ts";

/** A file written down and hashed, readable from the start as often as a put needs it, until it is disposed. */
export interface StagedFile {
  /** The bytes that came in, not counting the prefix. */
  readonly size: number;
  /** SHA-256 of the prefix followed by the bytes, hex. */
  readonly sha256: string;
  /** The prefix followed by the bytes. */
  stream(): ReadableStream<Uint8Array>;
  /** Removes what was written. Safe to call twice. */
  dispose(): Promise<void>;
}

export interface UploadSpool {
  /**
   * Writes `chunks` down while hashing `prefix` and then them, and refuses with `UploadTooLargeError` as soon as they
   * pass `maxBytes`. A source that fails or is too large leaves nothing behind.
   */
  stage(chunks: AsyncIterable<Uint8Array>, options: { prefix: Uint8Array; maxBytes: number }): Promise<StagedFile>;
}

/** The source passed the size it is allowed. Thrown while it is still arriving, so the rest is never read. */
export class UploadTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`The file is larger than ${maxBytes} bytes.`);
    this.name = "UploadTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/** Counts the bytes of a source as they pass, and stops it at the limit. */
export async function* bounded(chunks: AsyncIterable<Uint8Array>, maxBytes: number): AsyncGenerator<Uint8Array> {
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new UploadTooLargeError(maxBytes);
    yield chunk;
  }
}

/** A web stream over an async iterable, pulled one chunk at a time; cancelling it ends the iterable. */
export function streamOf(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** Keeps staged files in memory. For tests and for code above the spool; a server stages on disk. */
export class MemoryUploadSpool implements UploadSpool {
  staged = 0;
  async stage(chunks: AsyncIterable<Uint8Array>, options: { prefix: Uint8Array; maxBytes: number }) {
    const parts: Uint8Array[] = [options.prefix];
    for await (const chunk of bounded(chunks, options.maxBytes)) parts.push(chunk);
    const bytes = await collect(new Blob(parts as BlobPart[]).stream());
    this.staged++;
    return {
      size: bytes.byteLength - options.prefix.byteLength,
      sha256: await sha256Hex(bytes),
      stream: () => new Blob([bytes]).stream(),
      dispose: async () => {},
    } satisfies StagedFile;
  }
}
