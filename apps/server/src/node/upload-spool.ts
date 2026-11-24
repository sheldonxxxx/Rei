// The upload spool on disk: one private file per upload in progress, under the data directory (in the stack, the
// control-data volume; /tmp there is a small tmpfs, which is memory). Files are hashed as they are written, read back
// in large chunks for the put, and removed when the upload ends. Whatever a crash left behind is removed at start.
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { bounded, type StagedFile, streamOf, type UploadSpool } from "../storage/upload-spool.ts";
import { randomBytes, toHex } from "../util/encoding.ts";

/** How much one read of a staged file hands the object store at a time. */
const READ_CHUNK = 1024 * 1024;

export class FolderUploadSpool implements UploadSpool {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // Nothing in here outlives the process that wrote it: an upload interrupted by a restart is simply gone.
    for (const name of readdirSync(root)) if (name.endsWith(".part")) rmSync(join(root, name), { force: true });
  }

  async stage(
    chunks: AsyncIterable<Uint8Array>,
    options: { prefix: Uint8Array; maxBytes: number },
  ): Promise<StagedFile> {
    const path = join(this.root, `${toHex(randomBytes(12))}.part`);
    const hash = createHash("sha256").update(options.prefix);
    const file = await open(path, "wx", 0o600);
    let size = 0;
    try {
      for await (const chunk of bounded(chunks, options.maxBytes)) {
        hash.update(chunk);
        await file.write(chunk);
        size += chunk.byteLength;
      }
      await file.close();
    } catch (error) {
      await file.close().catch(() => {});
      await rm(path, { force: true });
      throw error;
    }
    const prefix = options.prefix.slice();
    let disposed = false;
    return {
      size,
      sha256: hash.digest("hex"),
      stream: () =>
        streamOf(
          (async function* () {
            if (disposed) throw new Error("The staged upload was already removed.");
            if (prefix.byteLength) yield prefix;
            for await (const chunk of createReadStream(path, { highWaterMark: READ_CHUNK }) as AsyncIterable<Buffer>)
              yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          })(),
        ),
      dispose: async () => {
        disposed = true;
        await rm(path, { force: true });
      },
    };
  }
}
