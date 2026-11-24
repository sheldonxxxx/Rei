// The Garage S3 adapter. Garage speaks S3, so this is a small AWS Signature V4 client — deliberately not the AWS SDK:
// the control image prunes @aws-sdk and @smithy (about 40 MB the server never used), the SDK now adds CRC32C request
// checksums that Garage does not implement, and the five operations Rei needs (PutObject, GetObject, HeadObject,
// DeleteObject, ListObjectsV2) fit in a file that is tested against the real service.
//
// Requests go over fetch, except a streamed put, which goes over node:http(s) with `pipeline`: fetch (undici 7) keeps
// every chunk of a streamed request body alive while a fast receiver keeps up, so a 1 GiB upload to Garage on the local
// network cost 1 GiB of memory. `pipeline` holds backpressure and lets each chunk go once the socket has taken it.
//
// Path-style addressing, SigV4, and cleartext only to a private network name (src/node/config.ts refuses the rest).
// S3's ETag is *not* Rei's content hash: the object key carries the SHA-256 Rei computed itself, `put` confirms the
// object is there with the expected size, and `get` re-checks the hash of the bytes that came back.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
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
import { measuring, verifiedStream } from "./object-streams.ts";

export interface GarageConfig {
  /** Absolute http(s) URL, e.g. http://garage:3900. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** One request's deadline; default 30 s. A put gets one more second per 8 MiB of body on top. */
  timeoutMs?: number;
  /** Extra attempts after the first one; default 2. */
  retries?: number;
  /** First backoff, doubled per attempt; default 200 ms. */
  backoffMs?: number;
  /** Tests: the fetch, so a failure can be provoked without a network. A streamed put never uses it (see above). */
  fetchImpl?: typeof fetch;
  /** Tests: the wait between attempts. */
  sleep?: (ms: number) => Promise<void>;
}

/** A request body: bytes in memory, or a stream of known length and hash that can be opened again for a retry. */
type RequestBody =
  | Uint8Array<ArrayBuffer>
  | { open: () => ReadableStream<Uint8Array>; byteLength: number; sha256: string };

interface SendOptions {
  /** This request's deadline instead of the configured one (a large put needs longer). */
  timeoutMs?: number;
  /** Time only the wait for the answer to start, not the reading of its body. */
  streamResponse?: boolean;
  signal?: AbortSignal;
}

/** The slowest a put may go before its deadline: far under Garage on a private network, generous for a slow disk. */
const PUT_FLOOR_BYTES_PER_SECOND = 8 * 1024 * 1024;

/** A bucket name, as S3 defines it. No dots: Garage takes them literally and Rei never needs them. */
export const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const MAX_PAGE = 1_000;
/** How much of an answer to a streamed put is kept: S3 answers a put with nothing, or a short XML error. */
const MAX_PUT_ANSWER_BYTES = 64 * 1024;
/**
 * The S3 codes for a body that is not the one its signature promised. Retrying sends the same wrong bytes again, so
 * these are integrity failures, not a busy service. Garage v2 answers a wrong SHA-256 with 400 InvalidDigest.
 */
const BODY_MISMATCH_CODES = new Set(["InvalidDigest", "BadDigest", "XAmzContentSHA256Mismatch", "IncompleteBody"]);

const hex = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};
/** S3's URI encoding: unreserved characters only, `/` left to the caller to separate segments. */
const encode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function hmac(key: Uint8Array<ArrayBuffer> | string, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const material: Uint8Array<ArrayBuffer> =
    typeof key === "string" ? new TextEncoder().encode(key) : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}

/** S3 error bodies are XML: `<Error><Code>NoSuchKey</Code>…`. The code is what the branches below are about. */
const s3Code = (text: string): string | undefined => /<Code>\s*([A-Za-z0-9_]+)\s*<\/Code>/.exec(text)?.[1];

const decodeXml = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");

export class GarageFileObjectStore implements FileObjectStore {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly backoffMs: number;
  readonly #host: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(config: GarageConfig) {
    if (!BUCKET_PATTERN.test(config.bucket))
      throw new StorageError("invalid", `Invalid bucket name "${config.bucket}".`);
    let url: URL;
    try {
      url = new URL(config.endpoint);
    } catch {
      throw new StorageError("invalid", `Invalid Garage endpoint "${config.endpoint}".`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new StorageError("invalid", "Garage's endpoint must be an http(s) URL.");
    if (!config.accessKeyId || !config.secretAccessKey)
      throw new StorageError("invalid", "Garage needs an access key and a secret key.");
    this.#host = url.host;
    this.endpoint = url.origin;
    this.region = config.region;
    this.bucket = config.bucket;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.retries = config.retries ?? 2;
    this.backoffMs = config.backoffMs ?? 200;
    this.#accessKeyId = config.accessKeyId;
    this.#secretAccessKey = config.secretAccessKey;
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
    this.#sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
  }

  /** One request, signed. Retries the failures worth retrying, then hands the caller a StorageError. */
  async #request(
    method: "GET" | "PUT" | "HEAD" | "DELETE",
    key: string,
    query: Map<string, string>,
    headers: Record<string, string>,
    body?: RequestBody,
    options: SendOptions = {},
  ): Promise<Response> {
    const where = `${method} ${this.bucket}/${key}`;
    let last: StorageError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.#sleep(this.backoffMs * 2 ** (attempt - 1));
      try {
        const response = await this.#send(method, key, query, headers, body, options);
        if (response.ok) return response;
        const text = await response.text();
        const code = s3Code(text);
        const detail = `${where} → ${response.status}${code ? ` ${code}` : ""}`;
        if (response.status === 404 && code !== "NoSuchBucket")
          // The caller decides what a missing object means: a fact for a read, nothing at all for a delete.
          throw new StorageError("missing", detail, { retryable: false, code });
        if (response.status === 403) throw new StorageError("invalid", detail, { retryable: false, code });
        if (response.status === 400 && code !== undefined && BODY_MISMATCH_CODES.has(code))
          throw new StorageError("integrity", detail, { retryable: false, code });
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        last = new StorageError("unavailable", detail, { retryable, code });
        if (!retryable) throw last;
      } catch (error) {
        if (error instanceof StorageError) {
          if (error.kind !== "unavailable" || !error.retryable) throw error;
          last = error;
          continue;
        }
        const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
        last = new StorageError(
          aborted ? "aborted" : "unavailable",
          `${where} → ${error instanceof Error ? error.message : String(error)}`,
          { retryable: !aborted },
        );
        if (aborted) throw last;
      }
    }
    throw last ?? new StorageError("unavailable", `${where} failed.`);
  }

  async #send(
    method: "GET" | "PUT" | "HEAD" | "DELETE",
    key: string,
    query: Map<string, string>,
    headers: Record<string, string>,
    body: RequestBody | undefined,
    options: SendOptions,
  ): Promise<Response> {
    // A streamed body is signed with the hash its caller already knows, so Garage checks the bytes it receives too.
    const payloadHash =
      body && !(body instanceof Uint8Array) ? body.sha256 : await sha256Hex(body ?? new Uint8Array(0));
    if (body && !(body instanceof Uint8Array)) headers = { ...headers, "content-length": String(body.byteLength) };
    // "YYYYMMDDTHHMMSSZ", exactly: Garage answers 400 InvalidRequest ("Invalid date: premature end of input") for
    // anything else, and the milliseconds have to go with the dashes and the colons.
    const amzDate = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const dateStamp = amzDate.slice(0, 8);
    const all: Record<string, string> = {
      host: this.#host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...headers,
    };
    const names = Object.keys(all).sort();
    const canonicalHeaders = names.map((name) => `${name.toLowerCase()}:${all[name]!.trim()}\n`).join("");
    const signedHeaders = names.map((name) => name.toLowerCase()).join(";");
    const canonicalQuery = [...query.entries()]
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
      .map(([name, value]) => `${encode(name)}=${encode(value)}`)
      .join("&");
    const canonicalUri = `/${encode(this.bucket)}${key === "" ? "" : `/${key.split("/").map(encode).join("/")}`}`;
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join(
      "\n",
    );
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest));
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(new Uint8Array(digest))].join("\n");
    let signingKey: Uint8Array<ArrayBuffer> | string = `AWS4${this.#secretAccessKey}`;
    for (const part of [dateStamp, this.region, "s3", "aws4_request"]) signingKey = await hmac(signingKey, part);
    const signature = hex(await hmac(signingKey, stringToSign));
    // The deadline covers a whole request, scaled for a large body; a streamed answer is only timed until it starts,
    // because its reader (a person downloading a file) sets the pace after that.
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException("The request took too long.", "TimeoutError")),
      options.timeoutMs ?? this.timeoutMs,
    );
    timer.unref?.();
    const signal = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;
    const url = `${this.endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    const sent = {
      ...all,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
    let response: Response;
    try {
      response =
        body && !(body instanceof Uint8Array)
          ? await sendStreamed(new URL(url), method, sent, body.open(), signal)
          : await this.#fetch(url, { method, headers: sent, ...(body ? { body } : {}), signal });
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    // Otherwise the deadline goes on to cover reading the answer, as a whole request's should.
    if (options.streamResponse) clearTimeout(timer);
    return response;
  }

  async put(input: PutInput): Promise<void> {
    const parsed = parseObjectKey(input.key);
    if (input.sha256 !== parsed.sha256)
      throw new StorageError("integrity", "The bytes do not match the hash in the object key.");
    const byteLength = "bytes" in input ? input.bytes.byteLength : input.byteLength;
    const timeoutMs = this.timeoutMs + Math.ceil((byteLength / PUT_FLOOR_BYTES_PER_SECOND) * 1000);
    if ("bytes" in input) {
      if ((await sha256Hex(input.bytes)) !== parsed.sha256)
        throw new StorageError("integrity", "The bytes do not match the hash in the object key.");
      await this.#request("PUT", input.key, new Map(), {}, input.bytes, {
        timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } else {
      // Each attempt reads the source again, and the last one's hash and length are checked against the promise.
      let sent: ReturnType<typeof measuring> | undefined;
      const body = {
        byteLength,
        sha256: input.sha256,
        open: () => {
          sent = measuring(input.stream(), byteLength);
          return sent.stream;
        },
      };
      await this.#request("PUT", input.key, new Map(), {}, body, {
        timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!sent || sent.bytes() !== byteLength || sent.hash.digest("hex") !== parsed.sha256)
        throw new StorageError("integrity", "The bytes sent do not match the hash in the object key.");
    }
    // The service said yes; only say it back once the object is there with the size it promised.
    const head = await this.head(input.key);
    if (head === undefined)
      throw new StorageError("unavailable", `The object is absent after the upload: ${input.key}.`, {
        retryable: true,
      });
    if (head.byteLength !== byteLength)
      throw new StorageError("integrity", `The object holds ${head.byteLength} bytes, not ${byteLength}.`);
  }

  async open(key: string): Promise<ObjectStream | undefined> {
    const { sha256 } = parseObjectKey(key);
    let response: Response;
    try {
      response = await this.#request("GET", key, new Map(), {}, undefined, { streamResponse: true });
    } catch (error) {
      if (error instanceof StorageError && error.kind === "missing") return undefined;
      throw error;
    }
    const length = Number(response.headers.get("content-length"));
    if (response.status !== 200 || !response.body || !Number.isSafeInteger(length) || length < 0) {
      await response.body?.cancel();
      throw new StorageError("unavailable", `Garage did not serve the whole object at ${key}.`, { retryable: true });
    }
    return { byteLength: length, body: verifiedStream(response.body, sha256, key) };
  }

  async get(key: string, range?: ObjectRange): Promise<Uint8Array<ArrayBuffer> | undefined> {
    parseObjectKey(key);
    const headers: Record<string, string> = range ? { range: `bytes=${range.start}-${range.end ?? ""}` } : {};
    let response: Response;
    try {
      response = await this.#request("GET", key, new Map(), headers);
    } catch (error) {
      if (error instanceof StorageError && error.kind === "missing") return undefined;
      throw error;
    }
    if (response.status !== (range ? 206 : 200))
      // Answering a range request with the whole object would hand back the wrong bytes without a word.
      throw new StorageError(
        "unavailable",
        `Garage did not serve the byte range asked for at ${key} (answered ${response.status}).`,
        {
          retryable: true,
        },
      );
    const bytes = new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>;
    // A range is a slice of the object, so only a whole object can carry the key's hash.
    if (!range) {
      const actual = await sha256Hex(bytes);
      const expected = parseObjectKey(key).sha256;
      if (actual !== expected)
        throw new StorageError("integrity", `The bytes at ${key} hash to ${actual}, not ${expected}.`);
    }
    return bytes;
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    parseObjectKey(key);
    try {
      const response = await this.#request("HEAD", key, new Map(), {});
      const length = Number(response.headers.get("content-length"));
      return { byteLength: Number.isSafeInteger(length) && length >= 0 ? length : 0 };
    } catch (error) {
      if (error instanceof StorageError && error.kind === "missing") return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    parseObjectKey(key);
    try {
      await this.#request("DELETE", key, new Map(), {});
    } catch (error) {
      // Deleting what is already gone is success: that was the goal.
      if (error instanceof StorageError && error.kind === "missing") return;
      throw error;
    }
  }

  /** Keys under a prefix, for reconciliation only. Garage's ListObjectsV2 answers a page at a time. */
  async list(prefix: string, limit = 5_000): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query = new Map<string, string>([
        ["list-type", "2"],
        ["prefix", prefix],
        ["max-keys", String(Math.min(MAX_PAGE, limit - keys.length))],
      ]);
      if (token !== undefined) query.set("continuation-token", token);
      const page = await (await this.#request("GET", "", query, {})).text();
      for (const match of page.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(match[1]!));
      token = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(page)
        ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(page)?.[1]
        : undefined;
    } while (token !== undefined && keys.length < limit);
    return keys.slice(0, limit);
  }
}

/**
 * One request whose body is a stream, over node:http(s), answered with the whole (small) answer as a Response. The body
 * goes through `pipeline`, so it is read no faster than the socket takes it and no chunk outlives its write. An answer
 * that arrives before the body is done (a refusal) ends the upload. On an abort it throws the signal's reason, as fetch
 * does, and either way it leaves no socket open behind it.
 */
async function sendStreamed(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Response> {
  const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method, headers, signal });
  const answered = new Promise<Response>((resolve, reject) => {
    request.on("error", reject);
    request.once("response", (answer: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let kept = 0;
      answer.on("data", (chunk: Buffer) => {
        if (kept >= MAX_PUT_ANSWER_BYTES) return;
        chunks.push(chunk);
        kept += chunk.byteLength;
      });
      answer.on("error", reject);
      answer.once("end", () => {
        const answerHeaders = new Headers();
        for (const [name, value] of Object.entries(answer.headers))
          if (value !== undefined) answerHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        const status = answer.statusCode ?? 0;
        const text = status === 204 || status === 304 ? null : Buffer.concat(chunks).toString("utf8");
        resolve(new Response(text, { status, headers: answerHeaders }));
      });
    });
  });
  const uploaded = pipeline(source, request);
  try {
    // Whichever fails first is the failure; otherwise the answer, once the body is out (or once it is refused).
    return await Promise.race([answered, uploaded.then(() => answered)]);
  } catch (error) {
    throw signal.aborted ? signal.reason : error;
  } finally {
    // Done or not, nothing about this request is wanted any more: ending it frees the socket and stops the source.
    request.destroy();
    source.destroy();
    uploaded.catch(() => undefined);
    answered.catch(() => undefined);
  }
}
