// The one file of a multipart upload, read as a stream. Nothing here holds the file: its bytes are handed on as they
// arrive, and the size limit is enforced while they do, so a request over the limit is refused without being read.
//
// Only what Rei's upload routes accept is understood: `multipart/form-data` with exactly one part named `file` that
// carries a filename. Other fields are skipped, within a small allowance for everything that is not the file.
import { ATTACHMENT_MAX_BYTES } from "@rei/protocol";
import type { Context } from "hono";
import type { UploadStream } from "../attachments/service.ts";
import { badRequest, HttpError } from "../util/errors.ts";

export interface MultipartFile {
  /** The filename the client sent, unsanitized (the attachment service cleans it). */
  name: string;
  /** The part's Content-Type, or "" when it had none. */
  type: string;
  /**
   * The file's bytes, as they arrive. It finishes only after the rest of the request has been read and checked, so a
   * consumer that reaches the end has a whole, valid upload.
   */
  chunks: AsyncGenerator<Uint8Array, void, undefined>;
  /** Stops reading the request, for a caller that will not consume `chunks` after all. Safe to call twice. */
  cancel(): Promise<void>;
}

export interface MultipartLimits {
  /** The most the file may hold. */
  maxFileBytes: number;
  /** The most everything else may add: boundaries, part headers and other fields. */
  maxOverheadBytes: number;
  /** What a client is told when the file is over the limit. */
  tooLargeMessage: string;
}

const HEADER_BLOCK_MAX = 16 * 1024;
const CRLF = new Uint8Array([13, 10]);
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0]!;
  const last = haystack.length - needle.length;
  for (let i = haystack.indexOf(first, from); i !== -1 && i <= last; i = haystack.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The boundary of a `multipart/form-data` Content-Type, or undefined for anything else. */
export function multipartBoundary(contentType: string | undefined): string | undefined {
  if (!contentType || !/^multipart\/form-data\s*(;|$)/i.test(contentType)) return undefined;
  const match = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

/** A `name="value"` parameter of a Content-Disposition header, quoted or not; `filename*` is RFC 5987. */
function dispositionParameter(header: string, name: string): string | undefined {
  const extended = new RegExp(`;\\s*${name}\\*\\s*=\\s*([^;]*)`, "i").exec(header);
  if (extended) {
    const value = /^([\w-]+)'[^']*'(.*)$/.exec(extended[1]!.trim());
    if (value && value[1]!.toLowerCase() === "utf-8")
      try {
        return decodeURIComponent(value[2]!);
      } catch {
        // Fall through to the plain parameter.
      }
  }
  const quoted = new RegExp(`;\\s*${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i").exec(header);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, "$1");
  const token = new RegExp(`;\\s*${name}\\s*=\\s*([^;\\s]+)`, "i").exec(header);
  return token?.[1];
}

interface PartHeaders {
  name: string | undefined;
  filename: string | undefined;
  type: string;
}

function parseHeaders(block: Uint8Array): PartHeaders {
  const lines = new TextDecoder().decode(block).split("\r\n");
  let disposition: string | undefined;
  let type = "";
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "content-disposition") disposition = value;
    else if (field === "content-type") type = value;
  }
  if (!disposition || !/^form-data\s*(;|$)/i.test(disposition))
    throw badRequest("bad_request", "Upload a multipart file.");
  return {
    name: dispositionParameter(disposition, "name"),
    filename: dispositionParameter(disposition, "filename"),
    type,
  };
}

/**
 * Reads a multipart request up to its `file` part and answers that part's name, type and a stream of its bytes. Fails
 * with 400 for anything that is not one file in a well-formed form, and with 413 as soon as the file (or the request as
 * a whole, from its Content-Length or as it arrives) passes the limit.
 */
export async function multipartFile(request: Request, limits: MultipartLimits): Promise<MultipartFile> {
  const boundary = multipartBoundary(request.headers.get("content-type") ?? undefined);
  if (!boundary) throw badRequest("bad_request", "Upload a multipart file.");
  const tooLarge = () => new HttpError(413, "attachment_too_large", limits.tooLargeMessage);
  const maxTotal = limits.maxFileBytes + limits.maxOverheadBytes;
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxTotal) throw tooLarge();
  if (!request.body) throw badRequest("bad_request", "Choose a file.");

  const reader = request.body.getReader();
  const delimiter = new TextEncoder().encode(`\r\n--${boundary}`);
  // The first boundary has no line break before it; starting the buffer with one makes every boundary look the same.
  let buffer: Uint8Array = CRLF;
  let total = 0;
  let ended = false;
  let fileBytes = 0;
  let overhead = 0;

  let released = false;
  const release = async (cancel: boolean) => {
    if (released) return;
    released = true;
    if (cancel && !ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  };
  /** Reads one more chunk into the buffer; false at the end of the body. */
  const fill = async (): Promise<boolean> => {
    if (ended) return false;
    const next = await reader.read();
    if (next.done) {
      ended = true;
      return false;
    }
    total += next.value.byteLength;
    if (total > maxTotal) throw tooLarge();
    buffer = concat(buffer, next.value);
    return true;
  };
  const incomplete = () => badRequest("bad_request", "The upload arrived incomplete. Try again.");
  const spend = (bytes: number) => {
    overhead += bytes;
    if (overhead > limits.maxOverheadBytes)
      throw badRequest("bad_request", "Upload one file without other large fields.");
  };
  /** Consumes through the next delimiter, counting what it skipped as overhead. */
  const skipToDelimiter = async (): Promise<void> => {
    for (;;) {
      const at = indexOf(buffer, delimiter);
      if (at !== -1) {
        spend(at);
        buffer = buffer.subarray(at + delimiter.length);
        return;
      }
      const keep = Math.min(buffer.length, delimiter.length - 1);
      spend(buffer.length - keep);
      buffer = buffer.subarray(buffer.length - keep);
      if (!(await fill())) throw incomplete();
    }
  };
  /** After a delimiter: the headers of the next part, or undefined when it was the closing one. */
  const nextPart = async (): Promise<PartHeaders | undefined> => {
    while (buffer.length < 2) if (!(await fill())) throw incomplete();
    if (buffer[0] === 45 && buffer[1] === 45) return undefined; // "--": the closing delimiter; the epilogue is ignored
    if (buffer[0] !== 13 || buffer[1] !== 10) throw badRequest("bad_request", "Upload a multipart file.");
    buffer = buffer.subarray(2);
    for (;;) {
      const end = indexOf(buffer, HEADER_END);
      if (end !== -1) {
        spend(end + HEADER_END.length);
        const headers = parseHeaders(buffer.subarray(0, end));
        buffer = buffer.subarray(end + HEADER_END.length);
        return headers;
      }
      if (buffer.length > HEADER_BLOCK_MAX) throw badRequest("bad_request", "Upload a multipart file.");
      if (!(await fill())) throw incomplete();
    }
  };
  const isFile = (part: PartHeaders) => {
    if (part.name !== "file") return false;
    if (part.filename === undefined) throw badRequest("bad_request", "Choose one file per upload.");
    return true;
  };

  let file: PartHeaders | undefined;
  try {
    await skipToDelimiter(); // the preamble
    for (;;) {
      const part = await nextPart();
      if (!part) throw badRequest("bad_request", "Choose one file per upload.");
      if (isFile(part)) {
        file = part;
        break;
      }
      await skipToDelimiter();
    }
  } catch (error) {
    await release(true);
    throw error;
  }

  async function* chunks(): AsyncGenerator<Uint8Array, void, undefined> {
    let finished = false;
    try {
      for (;;) {
        const at = indexOf(buffer, delimiter);
        const end = at === -1 ? Math.max(0, buffer.length - (delimiter.length - 1)) : at;
        if (end > 0) {
          fileBytes += end;
          if (fileBytes > limits.maxFileBytes) throw tooLarge();
          const out = buffer.subarray(0, end);
          buffer = buffer.subarray(end);
          yield out;
        }
        if (at !== -1) {
          buffer = buffer.subarray(delimiter.length);
          break;
        }
        if (!(await fill())) throw incomplete();
      }
      // The file has ended; the request has not. Only other fields may follow, then the closing delimiter.
      for (;;) {
        const part = await nextPart();
        if (!part) break;
        if (isFile(part)) throw badRequest("bad_request", "Choose one file per upload.");
        await skipToDelimiter();
      }
      // Read the epilogue (usually a line break) so the connection is left clean for its next request.
      while (await fill()) {
        spend(buffer.length);
        buffer = new Uint8Array(0);
      }
      finished = true;
    } finally {
      await release(!finished);
    }
  }
  const stream = chunks();
  return {
    name: file.filename!,
    type: file.type,
    chunks: stream,
    cancel: async () => {
      await stream.return();
      await release(true);
    },
  };
}

/**
 * The one `file` of an upload route's multipart request, as a stream bounded to Rei's file limit as it arrives (also
 * when there is no Content-Length), handed to `use`. If `use` fails before reading it, the rest of the request is not.
 */
export async function withUpload<T>(c: Context, use: (file: UploadStream) => Promise<T>): Promise<T> {
  const file = await multipartFile(c.req.raw, {
    maxFileBytes: ATTACHMENT_MAX_BYTES,
    maxOverheadBytes: 65_536,
    tooLargeMessage: "Files can be at most 1 GiB.",
  });
  try {
    return await use({ name: file.name, type: file.type, chunks: file.chunks });
  } finally {
    await file.cancel();
  }
}
