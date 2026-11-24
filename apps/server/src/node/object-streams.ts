// Streams in and out of a file store, checked against the SHA-256 an object key carries, without holding the object.
import { createHash, type Hash } from "node:crypto";
import { StorageError } from "../storage/file-object-store.ts";

/**
 * Passes `source` on while hashing it. The last chunk waits until the source has ended and the hash matches `expected`;
 * a mismatch errors the stream instead, so a reader never receives a complete object with the wrong bytes.
 */
export function verifiedStream(
  source: AsyncIterable<Uint8Array>,
  expected: string,
  key: string,
  onCancel?: () => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const hash = createHash("sha256");
  const iterator = source[Symbol.asyncIterator]();
  let held: Uint8Array<ArrayBuffer> | undefined;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            const actual = hash.digest("hex");
            if (actual !== expected)
              throw new StorageError("integrity", `The bytes at ${key} hash to ${actual}, not ${expected}.`);
            if (held) controller.enqueue(held);
            controller.close();
            return;
          }
          if (next.value.byteLength === 0) continue;
          hash.update(next.value);
          const previous = held;
          held = new Uint8Array(next.value.buffer as ArrayBuffer, next.value.byteOffset, next.value.byteLength);
          if (previous) {
            controller.enqueue(previous);
            return;
          }
        }
      } catch (error) {
        controller.error(error);
        await iterator.return?.();
      }
    },
    async cancel() {
      onCancel?.();
      await iterator.return?.();
    },
  });
}

/**
 * A stream that hashes and counts what passes through it, for checking a put against what it promised. It errors (an
 * integrity StorageError) instead of passing on more than `byteLength` bytes or ending with fewer, so a request never
 * sends a body that disagrees with the length it declared.
 */
export function measuring(
  source: ReadableStream<Uint8Array>,
  byteLength: number,
): {
  stream: ReadableStream<Uint8Array>;
  hash: Hash;
  bytes: () => number;
} {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (bytes + chunk.byteLength > byteLength)
          throw new StorageError("integrity", `The stream is longer than the ${byteLength} bytes it promised.`);
        hash.update(chunk);
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        if (bytes !== byteLength)
          throw new StorageError(
            "integrity",
            `The stream ended after ${bytes} of the ${byteLength} bytes it promised.`,
          );
      },
    }),
  );
  return { stream, hash, bytes: () => bytes };
}
