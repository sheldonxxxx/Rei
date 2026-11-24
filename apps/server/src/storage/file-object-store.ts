// The file store, as the rest of the server sees it: immutable objects addressed by a server-generated key, with the
// bytes' SHA-256 kept beside them. Garage in the deployed stack (src/node/garage-object-store.ts); the fakes here in
// tests. Nothing in this file knows what an attachment, a Library version or a trace payload is — that is SQLite's job.
//
// Objects are immutable: put writes a key once and never overwrites it, so a version pinned to an old message can never
// quietly change bytes. Deleting is a separate decision from deleting the *file*, which is why the state machine and the
// retry bookkeeping live in src/storage/registry.ts and not here.

/** What can go wrong with an object operation. The kind is what callers branch on; the message is for the log. */
export type StorageErrorKind =
  /** The object is not there. `get`/`head` answer with undefined instead of throwing it. */
  | "missing"
  /** The service did not answer, or answered too late, or said it is busy. Worth retrying. */
  | "unavailable"
  /** The request was refused or malformed: a wrong key, a bad range, a bucket that is not ours. */
  | "invalid"
  /** The bytes that came back are not the bytes the key promises. */
  | "integrity"
  /** The caller went away (a cancelled request, a shutting-down server). */
  | "aborted";

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  readonly retryable: boolean;
  /** The service's own code, when it gave one (S3's `<Code>NoSuchKey</Code>`), for the log line. */
  readonly code?: string;

  constructor(kind: StorageErrorKind, message: string, options: { retryable?: boolean; code?: string } = {}) {
    super(message);
    this.name = "StorageError";
    this.kind = kind;
    this.retryable = options.retryable ?? kind === "unavailable";
    if (options.code !== undefined) this.code = options.code;
  }
}

export interface ObjectRange {
  start: number;
  /** Inclusive, as HTTP's Range is. Omit it to read to the end of the object. */
  end?: number;
}

export interface ObjectHead {
  byteLength: number;
}

/**
 * What `put` writes: bytes already in memory, or a stream of a known length that can be opened again (a retried request
 * reads it from the start). A stream is how a large file reaches the store without the server holding it whole.
 */
export type PutInput = { key: string; sha256: string; signal?: AbortSignal } & (
  | { bytes: Uint8Array<ArrayBuffer> }
  | { byteLength: number; stream: () => ReadableStream<Uint8Array> }
);

/** A whole object, as a stream that is checked against the key's hash as it flows. */
export interface ObjectStream {
  byteLength: number;
  /**
   * The object's bytes. The last chunk is held back until the hash is confirmed, and a mismatch errors the stream
   * instead: a reader never sees a complete object whose bytes are not the ones the key promises.
   */
  body: ReadableStream<Uint8Array<ArrayBuffer>>;
}

/**
 * The put/get/head/delete contract every file store implements. Keys are opaque, server-generated and never contain a
 * user's filename; see `objectKey`.
 */
export interface FileObjectStore {
  /** Where its objects live, recorded on every ledger row so a bucket change is visible in SQLite. */
  readonly bucket: string;
  /** Writes the object and only reports success once the service has it with the expected size and hash. */
  put(input: PutInput): Promise<void>;
  /**
   * The bytes, or undefined when the object is gone. Verifies the hash the key carries. Holds the whole object (or the
   * range) in memory: for bounded reads only. Use `open` for anything a user may have uploaded at full size.
   */
  get(key: string, range?: ObjectRange): Promise<Uint8Array<ArrayBuffer> | undefined>;
  /** The whole object as a verified stream, or undefined when the object is gone. */
  open(key: string): Promise<ObjectStream | undefined>;
  /** Whether the object is there and how big it is, or undefined when it is not. */
  head(key: string): Promise<ObjectHead | undefined>;
  /** Removes it. An object that is already gone is not an error. */
  delete(key: string): Promise<void>;
  /** Keys under a prefix, for reconciliation only (never for a user-facing listing). */
  list(prefix: string, limit?: number): Promise<string[]>;
}

/** `files/v1/<object id>/<sha256>`: a private, immutable key. Never shown to a browser or a model. */
export const objectKey = (objectId: string, sha256: string): string => `files/v1/${objectId}/${sha256}`;

/** The object key's shape, so a bad key can never escape the bucket's prefix. */
export function parseObjectKey(key: string): { objectId: string; sha256: string } {
  const m = /^files\/v1\/([a-z0-9_]+)\/([0-9a-f]{64})$/.exec(key);
  if (!m || m[1]!.length > 64) throw new StorageError("invalid", "Invalid object key.");
  return { objectId: m[1]!, sha256: m[2]! };
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Reads a stream into one array. For bounded streams only: tests, and objects small enough to hold. */
export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A file store that keeps objects in a Map, for tests of the code above the store. */
export class MemoryFileObjectStore implements FileObjectStore {
  readonly bucket = "memory";
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
  /** Keys a test wants to fail (once each, then the store forgets them). */
  readonly failPut = new Map<string, Error>();
  readonly failDelete = new Map<string, Error>();
  puts = 0;
  deletes = 0;

  async put(input: PutInput): Promise<void> {
    const parsed = parseObjectKey(input.key);
    const bytes = "bytes" in input ? input.bytes : await collect(input.stream());
    if ("byteLength" in input && bytes.byteLength !== input.byteLength)
      throw new StorageError("integrity", `The stream held ${bytes.byteLength} bytes, not ${input.byteLength}.`);
    const actual = await sha256Hex(bytes);
    if (actual !== parsed.sha256 || actual !== input.sha256)
      throw new StorageError("integrity", "The bytes do not match the hash in the object key.");
    const failure = this.failPut.get(input.key);
    if (failure) {
      this.failPut.delete(input.key);
      throw failure;
    }
    this.puts++;
    this.objects.set(input.key, bytes);
  }

  async open(key: string): Promise<ObjectStream | undefined> {
    const bytes = await this.get(key);
    if (!bytes) return undefined;
    return {
      byteLength: bytes.byteLength,
      body: new Blob([bytes]).stream() as ReadableStream<Uint8Array<ArrayBuffer>>,
    };
  }

  async get(key: string, range?: ObjectRange): Promise<Uint8Array<ArrayBuffer> | undefined> {
    parseObjectKey(key);
    const bytes = this.objects.get(key);
    if (!bytes) return undefined;
    if (!range) return bytes;
    const end = range.end === undefined ? bytes.length - 1 : Math.min(range.end, bytes.length - 1);
    return bytes.slice(range.start, end + 1);
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    parseObjectKey(key);
    const bytes = this.objects.get(key);
    return bytes ? { byteLength: bytes.length } : undefined;
  }

  async delete(key: string): Promise<void> {
    parseObjectKey(key);
    const failure = this.failDelete.get(key);
    if (failure) {
      this.failDelete.delete(key);
      throw failure;
    }
    this.deletes++;
    this.objects.delete(key);
  }

  async list(prefix: string, limit = 1_000): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit);
  }
}
