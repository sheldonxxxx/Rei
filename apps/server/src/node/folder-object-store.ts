// A FileObjectStore backed by the local filesystem, for the one place there is no object service: `REI_MODEL_MODE=faux`
// (tests, and the control image's offline smoke test). It exists so the upload state machine, the ledger and the
// garbage collector are the same code with and without Garage; a deployment with a real user in it always uses Garage
// (src/node/config.ts refuses to start without it).
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type FileObjectStore,
  type ObjectHead,
  type ObjectRange,
  type ObjectStream,
  type PutInput,
  parseObjectKey,
  StorageError,
  sha256Hex,
} from "../storage/file-object-store.ts";
import { randomBytes, toHex } from "../util/encoding.ts";
import { verifiedStream } from "./object-streams.ts";

export class FolderFileObjectStore implements FileObjectStore {
  /** Not a bucket: the ledger records where an object came from, and faux-mode objects did not come from one. */
  readonly bucket = "local";
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  #path(key: string): string {
    parseObjectKey(key); // the key decides the layout, so a caller cannot walk outside the store
    const path = join(this.root, key);
    if (!path.startsWith(this.root)) throw new StorageError("invalid", "Invalid object key.");
    return path;
  }

  async put(input: PutInput): Promise<void> {
    const parsed = parseObjectKey(input.key);
    if (input.sha256 !== parsed.sha256)
      throw new StorageError("integrity", "The bytes do not match the hash in the object key.");
    const path = this.#path(input.key);
    if (statSync(path, { throwIfNoEntry: false })?.isFile()) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${toHex(randomBytes(4))}.tmp`;
    const source = "bytes" in input ? new Blob([input.bytes]).stream() : input.stream();
    const expectedLength = "bytes" in input ? input.bytes.byteLength : input.byteLength;
    const hash = createHash("sha256");
    let length = 0;
    try {
      // Hash what is written as it is written: the file only takes the key's name once it is known to be those bytes.
      await pipeline(
        Readable.fromWeb(source as import("node:stream/web").ReadableStream<Uint8Array>),
        new Transform({
          transform(chunk: Uint8Array, _encoding, done) {
            hash.update(chunk);
            length += chunk.byteLength;
            done(null, chunk);
          },
        }),
        createWriteStream(temporary, { mode: 0o600 }),
        ...(input.signal ? [{ signal: input.signal }] : []),
      );
      const actual = hash.digest("hex");
      if (actual !== parsed.sha256 || length !== expectedLength)
        throw new StorageError("integrity", "The bytes do not match the hash in the object key.");
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        "unavailable",
        `Could not write ${input.key}: ${error instanceof Error ? error.message : "error"}`,
      );
    }
  }

  async open(key: string): Promise<ObjectStream | undefined> {
    const path = this.#path(key);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile()) return undefined;
    const file = createReadStream(path, { highWaterMark: 1024 * 1024 });
    // Opened now, so a delete between here and the first read still serves the bytes that were asked for.
    await new Promise<void>((resolve, reject) => {
      file.once("open", () => resolve());
      file.once("error", reject);
    }).catch(() => undefined);
    if (file.destroyed) return undefined;
    return {
      byteLength: stat.size,
      body: verifiedStream(file as AsyncIterable<Buffer>, parseObjectKey(key).sha256, key, () => file.destroy()),
    };
  }

  async get(key: string, range?: ObjectRange): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const path = this.#path(key);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(readFileSync(path)) as Uint8Array<ArrayBuffer>;
    } catch {
      return undefined;
    }
    if (!range) {
      const actual = await sha256Hex(bytes);
      const expected = parseObjectKey(key).sha256;
      if (actual !== expected)
        throw new StorageError("integrity", `The bytes at ${key} hash to ${actual}, not ${expected}.`);
      return bytes;
    }
    const end = range.end === undefined ? bytes.length - 1 : Math.min(range.end, bytes.length - 1);
    return bytes.slice(range.start, end + 1);
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    const stat = statSync(this.#path(key), { throwIfNoEntry: false });
    return stat?.isFile() ? { byteLength: stat.size } : undefined;
  }

  async delete(key: string): Promise<void> {
    rmSync(this.#path(key), { force: true });
  }

  async list(prefix: string, limit = 5_000): Promise<string[]> {
    const keys: string[] = [];
    const walk = (directory: string, relative: string): void => {
      if (keys.length >= limit) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(path, name);
        else if (name.startsWith(prefix)) keys.push(name);
        if (keys.length >= limit) return;
      }
    };
    walk(this.root, "");
    return keys.sort();
  }
}
