// What the reader's core needs from the outside world. The HTTP client through the reader's own proxy is Node-only
// (src/node/proxy-fetch.ts) and is handed in as a `FetchViaProxy`.
import type { ReadQuality } from "@rei/protocol";

export interface FetchOptions {
  /** Aborts the request (the 15 s deadline, or the caller going away). */
  signal: AbortSignal;
  /** Stop reading beyond this many (decoded) bytes and report `truncated`. */
  maxBytes: number;
  /** Request headers; the client adds the ones that belong to the connection (Host, Accept-Encoding, ...). */
  headers: Record<string, string>;
  /** The caller's step, sent to the proxy (never to the site) so its log line joins that step's. */
  stepId?: string | undefined;
}

export interface FetchResponse {
  status: number;
  /** Lower-case names; repeated headers are joined with ", ". */
  headers: Record<string, string>;
  body: Uint8Array;
  /** The body was cut at `maxBytes`. */
  truncated: boolean;
}

/** One GET through the reader's proxy, authenticated by a job token. Never follows redirects. */
export type FetchViaProxy = (url: string, token: string, options: FetchOptions) => Promise<FetchResponse>;

/** The proxy (or its decision) refused the connection; `message` is what it said. */
export class ProxyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyRefused";
  }
}

/** An error whose message is meant for the model as it stands (no URLs with queries, no tokens). */
export class ReaderError extends Error {
  /** What the page turned out to be, when that is why there is nothing to read. */
  readonly quality: ReadQuality | undefined;
  constructor(message: string, quality?: ReadQuality) {
    super(message);
    this.name = "ReaderError";
    this.quality = quality;
  }
}
