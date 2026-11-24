// A resilient wrapper around EventSource for the two SSE streams.
//
// - The browser reconnects by itself (and sends Last-Event-ID) while readyState is CONNECTING; we only report "reconnecting".
// - When the browser gives up (readyState CLOSED, e.g. a non-200 answer) we create a NEW EventSource after a backoff. That one
//   has no Last-Event-ID, so the server sends a fresh snapshot, which the reducers accept as authoritative.
// - The server pings every 15 s; if nothing at all arrives for `staleMs` we assume a dead connection (common on mobile) and reopen.
import { CLIENT_QUERY, clientIdHeader, PING_INTERVAL_MS } from "@rei/protocol";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

export interface EventSourceLike {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface ConnectionOptions {
  url: string;
  /** Event types that carry an `id:` cursor. */
  committedTypes: readonly string[];
  /** Event types without a cursor (message.delta). */
  ephemeralTypes?: readonly string[];
  /** `cursor` is the SSE id for committed events and undefined otherwise (lastEventId persists across events, so it must not be read for ephemeral ones). */
  onEvent: (type: string, data: unknown, cursor: string | undefined) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** The browser gave up on the connection. */
  onClosed?: () => void;
  createEventSource?: (url: string) => EventSourceLike;
  backoff?: (attempt: number) => number;
  staleMs?: number;
}

const CLOSED = 2;

export function defaultBackoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** An EventSource cannot send headers, so the stream names this client in its query instead. */
function withClient(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${CLIENT_QUERY}=${encodeURIComponent(clientIdHeader("web"))}`;
}

export function openStream(opts: ConnectionOptions): { close: () => void } {
  const create =
    opts.createEventSource ?? ((u: string) => new EventSource(withClient(u)) as unknown as EventSourceLike);
  const backoff = opts.backoff ?? defaultBackoff;
  const staleMs = opts.staleMs ?? PING_INTERVAL_MS * 3;
  let es: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;
  let status: ConnectionStatus = "connecting";

  const setStatus = (s: ConnectionStatus) => {
    if (s === status) return;
    status = s;
    opts.onStatus?.(s);
  };
  opts.onStatus?.(status);

  const clearWatchdog = () => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
  };
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (stopped) return;
      teardown();
      setStatus("reconnecting");
      start();
    }, staleMs);
  };
  const teardown = () => {
    clearWatchdog();
    if (es) {
      es.onopen = null;
      es.onerror = null;
      es.close();
      es = null;
    }
  };

  const handle = (type: string, committed: boolean) => (ev: MessageEvent) => {
    if (stopped) return;
    armWatchdog();
    if (type === "ping") return;
    let data: unknown;
    try {
      data = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    const id = committed && typeof ev.lastEventId === "string" && ev.lastEventId !== "" ? ev.lastEventId : undefined;
    opts.onEvent(type, data, id);
  };

  function start() {
    if (stopped) return;
    const source = create(opts.url);
    es = source;
    source.onopen = () => {
      attempt = 0;
      setStatus("connected");
      armWatchdog();
    };
    source.onerror = () => {
      if (stopped || es !== source) return;
      clearWatchdog();
      setStatus("reconnecting");
      if (source.readyState === CLOSED) {
        // The browser will not retry on its own.
        teardown();
        opts.onClosed?.();
        const delay = backoff(attempt++);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          start();
        }, delay);
      }
    };
    for (const t of opts.committedTypes) source.addEventListener(t, handle(t, true));
    for (const t of opts.ephemeralTypes ?? []) source.addEventListener(t, handle(t, false));
    source.addEventListener("ping", handle("ping", false));
  }

  // Coming back to the app (tab visible, network back): do not wait out a long backoff.
  const wake = () => {
    if (stopped || status === "connected") return;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      attempt = 0;
      start();
    }
  };
  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") wake();
  };
  if (typeof window !== "undefined") window.addEventListener("online", wake);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

  start();

  return {
    close() {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      teardown();
      if (typeof window !== "undefined") window.removeEventListener("online", wake);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
