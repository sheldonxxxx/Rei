import { compile, type Validator } from "@earendil-works/pi-schema";
import {
  applySessionEvent,
  CONTRACT_STREAMS,
  CSRF_HEADER,
  type ReiConversationViewV2,
  SESSION_COOKIE,
  type SessionEvent,
  type StreamContract,
  type ViewState,
} from "@rei/protocol";

export interface Reply<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

/** A tiny API client with a cookie jar and the CSRF header, over `app.request` or a real URL. */
export class Client {
  cookie: string | undefined;
  readonly fetcher: Fetcher;
  constructor(fetcher: Fetcher) {
    this.fetcher = fetcher;
  }

  async raw(
    method: string,
    path: string,
    options: { body?: unknown; csrf?: boolean; cookie?: boolean; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.csrf !== false && method !== "GET") headers[CSRF_HEADER] = "1";
    if (options.cookie !== false && this.cookie) headers.cookie = `${SESSION_COOKIE}=${this.cookie}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }
    const res = await this.fetcher(path, { method, headers, ...(body !== undefined ? { body } : {}) });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(setCookie);
      if (m) this.cookie = m[1] === "" ? undefined : m[1];
    }
    return res;
  }

  async call<T = any>(method: string, path: string, options: Parameters<Client["raw"]>[2] = {}): Promise<Reply<T>> {
    const res = await this.raw(method, path, options);
    const text = await res.text();
    let body: any = text;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, body };
  }

  get<T = any>(path: string, options: Parameters<Client["raw"]>[2] = {}) {
    return this.call<T>("GET", path, options);
  }
  post<T = any>(path: string, body?: unknown, options: Parameters<Client["raw"]>[2] = {}) {
    return this.call<T>("POST", path, { ...options, ...(body !== undefined ? { body } : {}) });
  }
}

export interface SseEvent {
  id: string | undefined;
  event: string;
  data: any;
}

const frameValidators = new Map<object, Validator>();
const frameValidator = (schema: object): Validator => {
  let v = frameValidators.get(schema);
  if (!v) {
    v = compile(schema as Parameters<typeof compile>[0]);
    frameValidators.set(schema, v);
  }
  return v;
};

/** The streams a path may open: the one whose route matches it, or every stream when the path is not known. */
function streamsFor(path: string | undefined): readonly StreamContract[] {
  if (path === undefined) return CONTRACT_STREAMS;
  const bare = new URL(path, "http://x").pathname;
  const match = CONTRACT_STREAMS.filter((s) => new RegExp(`^${s.path.replace(/:[^/]+/g, "[^/]+")}$`).test(bare));
  if (match.length === 0) throw new Error(`${path} is not a stream of the contract (CONTRACT_STREAMS).`);
  return match;
}

/** Why a frame does not match the stream contract, or undefined when it does (ADR 0008: tests check every frame). */
export function frameViolation(streams: readonly StreamContract[], event: string, data: unknown): string | undefined {
  const candidates = streams.map((s) => s.events[event]).filter((s) => s !== undefined);
  if (candidates.length === 0)
    return `event "${event}" is not in the ${streams.map((s) => s.name).join("/")} stream contract`;
  const errors: string[] = [];
  for (const schema of candidates) {
    const v = frameValidator(schema);
    if (v.check(data)) return undefined;
    errors.push(
      v
        .errors(data)
        .slice(0, 5)
        .map((e) => `${e.path || "(root)"} ${e.message}`)
        .join("; "),
    );
  }
  return `event "${event}" breaks its schema: ${errors.join(" | ")}`;
}

/**
 * Reads an SSE response and keeps every event; `waitFor` resolves on the first matching one (already seen counts).
 * Every frame is checked against the stream contract; a frame outside it fails the next wait and `close()`.
 */
export class SseReader {
  readonly events: SseEvent[] = [];
  readonly violations: string[] = [];
  readonly response: Response;
  readonly #streams: readonly StreamContract[];
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #waiters: { match: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }[] = [];
  #buf = "";
  ended = false;
  readonly done: Promise<void>;

  /** `path` is the stream's request path; it picks the stream contract the frames are checked against. */
  constructor(response: Response, path?: string) {
    this.response = response;
    this.#streams = streamsFor(path);
    this.#reader = response.body!.getReader();
    this.done = this.#pump();
  }

  async #pump(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await this.#reader.read();
        if (done) break;
        this.#buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = this.#buf.indexOf("\n\n")) >= 0) {
          const frame = this.#buf.slice(0, idx);
          this.#buf = this.#buf.slice(idx + 2);
          this.#frame(frame);
        }
      }
    } catch {
      // cancelled
    }
    this.ended = true;
  }

  #frame(frame: string): void {
    let id: string | undefined;
    let event = "";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (event === "") return; // retry hints and comments
    let parsed: any = data.join("\n");
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // keep text
    }
    const e: SseEvent = { id, event, data: parsed };
    const violation = frameViolation(this.#streams, event, parsed);
    if (violation) this.violations.push(violation);
    this.events.push(e);
    this.#waiters = this.#waiters.filter((w) => !(w.match(e) && (w.resolve(e), true)));
  }

  #checked(): void {
    if (this.violations.length > 0) throw new Error(`SSE frame outside the contract: ${this.violations[0]}`);
  }

  waitFor(match: (e: SseEvent) => boolean, timeoutMs = 10_000): Promise<SseEvent> {
    try {
      this.#checked();
    } catch (error) {
      return Promise.reject(error);
    }
    const seen = this.events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for an SSE event; saw ${this.events.map((e) => e.event).join(",")}`)),
        timeoutMs,
      );
      this.#waiters.push({ match, resolve: (e) => (clearTimeout(timer), resolve(e)) });
    });
  }

  async close(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
    await this.done;
    this.#checked();
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until<T>(
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 10_000,
  what = "condition",
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * A session stream folded into its Conversation View with the shared reducer: `waitForView` resolves on the first view
 * (after any frame) that matches. A gap in the frames fails the wait (the server must never send one).
 */
export class ViewReader {
  readonly sse: SseReader;
  state: ViewState | undefined;
  readonly views: ReiConversationViewV2[] = [];
  removed = false;
  error: string | undefined;
  #applied = 0;

  constructor(sse: SseReader) {
    this.sse = sse;
  }

  #fold(): void {
    for (; this.#applied < this.sse.events.length; this.#applied++) {
      const e = this.sse.events[this.#applied]!;
      if (
        e.event !== "snapshot" &&
        e.event !== "patch" &&
        e.event !== "resync_required" &&
        e.event !== "session.removed"
      )
        continue;
      const step = applySessionEvent(this.state, e.data as SessionEvent);
      if (step.kind === "removed") this.removed = true;
      else if (step.kind === "resync") this.error = `resync at frame ${this.#applied} (${e.event})`;
      else {
        this.state = step.state;
        this.views.push(step.state.view);
      }
    }
  }

  get view(): ReiConversationViewV2 | undefined {
    this.#fold();
    return this.state?.view;
  }

  async waitForView(
    match: (view: ReiConversationViewV2) => boolean,
    timeoutMs = 10_000,
    what = "a matching view",
  ): Promise<ReiConversationViewV2> {
    return until(
      () => {
        this.#fold();
        if (this.error) throw new Error(this.error);
        return this.views.find(match);
      },
      timeoutMs,
      what,
    );
  }

  close(): Promise<void> {
    return this.sse.close();
  }
}
