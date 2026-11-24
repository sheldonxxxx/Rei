import { ATTACHMENT_MAX_BYTES } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import { type MultipartLimits, multipartBoundary, multipartFile } from "../src/http/multipart.ts";
import { HttpError } from "../src/util/errors.ts";

const BOUNDARY = "----rei-test-boundary";
const encoder = new TextEncoder();

/** A request whose body is `parts`, handed out one at a time as the reader pulls; `pulled` counts what was taken. */
function streamed(parts: Iterable<Uint8Array | string>, headers: Record<string, string> = {}) {
  const iterator = parts[Symbol.iterator]();
  const counter = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = iterator.next();
        if (next.done) return controller.close();
        const chunk = typeof next.value === "string" ? encoder.encode(next.value) : next.value;
        counter.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        counter.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request("http://rei.test/upload", {
    method: "POST",
    body,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
    duplex: "half",
  } as RequestInit);
  return { request, counter };
}

const head = (name = "file", filename: string | null = "a.txt", type = "text/plain") =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"${filename === null ? "" : `; filename="${filename}"`}\r\nContent-Type: ${type}\r\n\r\n`;
const tail = `\r\n--${BOUNDARY}--\r\n`;

const limits = (maxFileBytes = 64, maxOverheadBytes = 1024): MultipartLimits => ({
  maxFileBytes,
  maxOverheadBytes,
  tooLargeMessage: "Too large.",
});

async function drain(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  let out = "";
  const decoder = new TextDecoder();
  for await (const chunk of chunks) out += decoder.decode(chunk, { stream: true });
  return out;
}

async function failure(run: () => Promise<unknown>): Promise<HttpError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected a failure");
}

describe("multipart uploads", () => {
  it("reads the boundary of a form-data content type only", () => {
    expect(multipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
    expect(multipartBoundary('multipart/form-data; boundary="quoted value"')).toBe("quoted value");
    expect(multipartBoundary("multipart/mixed; boundary=x")).toBeUndefined();
    expect(multipartBoundary(undefined)).toBeUndefined();
  });

  it("streams the file part, byte for byte, split across reads at any point", async () => {
    const body = `preamble\r\n${head("note", null)}hello\r\n${head("file", 'r\\"e.txt')}line one\r\n--not a boundary\r\nend${tail}`;
    const bytes = encoder.encode(body);
    for (const size of [1, 2, 7, 64, bytes.length]) {
      const pieces: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.subarray(i, i + size));
      const { request } = streamed(pieces);
      const file = await multipartFile(request, limits(1024));
      expect(file.name).toBe('r"e.txt');
      expect(file.type).toBe("text/plain");
      expect(await drain(file.chunks)).toBe("line one\r\n--not a boundary\r\nend");
    }
  });

  it("reads an RFC 5987 filename", async () => {
    const part = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="x.txt"; filename*=UTF-8''%E5%B1%8B%E6%95%B7.txt\r\n\r\n`;
    const { request } = streamed([part, "x", tail]);
    const file = await multipartFile(request, limits());
    expect(file.name).toBe("屋敷.txt");
    expect(await drain(file.chunks)).toBe("x");
  });

  it("refuses a declared length over the limit before reading a byte", async () => {
    const { request, counter } = streamed([head(), "x", tail], { "content-length": String(64 + 1024 + 1) });
    const error = await failure(() => multipartFile(request, limits()));
    expect(error.status).toBe(413);
    expect(error.message).toBe("Too large.");
    expect(counter.pulled).toBe(0);
  });

  it("refuses a file over the limit while it is still arriving and stops reading", async () => {
    const chunk = new Uint8Array(16).fill(120);
    function* parts() {
      yield head();
      for (let i = 0; i < 1000; i++) yield chunk;
      yield tail;
    }
    const { request, counter } = streamed(parts());
    const file = await multipartFile(request, limits(64));
    const error = await failure(() => drain(file.chunks));
    expect(error.status).toBe(413);
    expect(counter.pulled).toBeLessThan(head().length + 64 + 3 * 16 + 64);
    expect(counter.cancelled).toBe(true);
  });

  it("refuses a body that is too large in total even when the file is small", async () => {
    const { request } = streamed([head("note", null), "x".repeat(2000), "\r\n", head(), "x", tail]);
    const error = await failure(() => multipartFile(request, limits(64, 1024)));
    expect(error.status).toBe(413);
  });

  it("accepts one file only, and only a part that is a file", async () => {
    const two = streamed([head(), "a", `\r\n${head("file", "b.txt")}b`, tail]);
    const first = await multipartFile(two.request, limits());
    const error = await failure(() => drain(first.chunks));
    expect([error.status, error.message]).toEqual([400, "Choose one file per upload."]);

    const field = streamed([head("file", null), "not a file", tail]);
    expect((await failure(() => multipartFile(field.request, limits()))).message).toBe("Choose one file per upload.");

    const none = streamed([head("note", null), "x", tail]);
    expect((await failure(() => multipartFile(none.request, limits()))).message).toBe("Choose one file per upload.");
  });

  it("refuses a body that ends before the closing boundary", async () => {
    const { request } = streamed([head(), "half a file"]);
    const file = await multipartFile(request, limits());
    const error = await failure(() => drain(file.chunks));
    expect([error.status, error.message]).toEqual([400, "The upload arrived incomplete. Try again."]);
  });

  it("refuses what is not a multipart form", async () => {
    const plain = new Request("http://rei.test/upload", { method: "POST", body: "x" });
    expect((await failure(() => multipartFile(plain, limits()))).status).toBe(400);
    const { request } = streamed([`--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nx`, tail]);
    expect((await failure(() => multipartFile(request, limits()))).message).toBe("Upload a multipart file.");
  });

  it("stops reading the request when the caller cancels", async () => {
    const { request, counter } = streamed([head(), "x", "y", "z", tail]);
    const file = await multipartFile(request, limits());
    await file.cancel();
    await file.cancel();
    expect(counter.cancelled).toBe(true);
  });

  it("refuses a file just over 1 GiB as it streams, without holding it", async () => {
    // The real limit, with no Content-Length: the bytes are generated as they are pulled and dropped as they are read.
    const chunk = new Uint8Array(1024 * 1024);
    const chunks = ATTACHMENT_MAX_BYTES / chunk.byteLength + 1;
    function* parts() {
      yield head("file", "big.bin", "application/octet-stream");
      for (let i = 0; i < chunks; i++) yield chunk;
      yield tail;
    }
    const { request, counter } = streamed(parts());
    const file = await multipartFile(request, {
      maxFileBytes: ATTACHMENT_MAX_BYTES,
      maxOverheadBytes: 65_536,
      tooLargeMessage: "Files can be at most 1 GiB.",
    });
    let seen = 0;
    let peak = 0;
    const error = await failure(async () => {
      for await (const piece of file.chunks) {
        seen += piece.byteLength;
        peak = Math.max(peak, process.memoryUsage().arrayBuffers);
      }
    });
    expect([error.status, error.message]).toEqual([413, "Files can be at most 1 GiB."]);
    expect(seen).toBeLessThanOrEqual(ATTACHMENT_MAX_BYTES);
    expect(seen).toBeGreaterThan(ATTACHMENT_MAX_BYTES - 2 * chunk.byteLength);
    expect(counter.pulled).toBeLessThan(ATTACHMENT_MAX_BYTES + 2 * chunk.byteLength + 1024);
    expect(counter.cancelled).toBe(true);
    // Nothing near the file's size was ever held (allow for the runtime's own buffers).
    expect(peak).toBeLessThan(256 * 1024 * 1024);
  }, 60_000);
});
