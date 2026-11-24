import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSourceLike } from "./connection.ts";
import { openStream } from "./connection.ts";

class FakeES implements EventSourceLike {
  static all: FakeES[] = [];
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  listeners = new Map<string, (ev: MessageEvent) => void>();
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeES.all.push(this);
  }
  addEventListener(t: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(t, l);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  emit(type: string, data: unknown, lastEventId = "") {
    this.listeners.get(type)?.({ data: JSON.stringify(data), lastEventId } as MessageEvent);
  }
}

beforeEach(() => {
  FakeES.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const make = (extra: Partial<Parameters<typeof openStream>[0]> = {}) => {
  const events: [string, unknown, string | undefined][] = [];
  const statuses: string[] = [];
  const conn = openStream({
    url: "/api/stream",
    committedTypes: ["snapshot", "session.upserted"],
    ephemeralTypes: ["message.delta"],
    onEvent: (t, d, c) => events.push([t, d, c]),
    onStatus: (s) => statuses.push(s),
    createEventSource: (u) => new FakeES(u),
    backoff: (n) => 1000 * 2 ** n,
    ...extra,
  });
  return { conn, events, statuses };
};

describe("openStream", () => {
  it("passes the cursor for committed events only, and swallows pings", () => {
    const { events } = make();
    const es = FakeES.all[0]!;
    es.open();
    es.emit("snapshot", { cursor: "1" }, "1");
    es.emit("message.delta", { offset: 0 }, "1"); // lastEventId persists in browsers; must not be read for ephemeral events
    es.emit("ping", {}, "1");
    expect(events.map((e) => [e[0], e[2]])).toEqual([
      ["snapshot", "1"],
      ["message.delta", undefined],
    ]);
  });

  it("reports reconnecting while the browser retries by itself, then connected", () => {
    const { statuses } = make();
    const es = FakeES.all[0]!;
    es.open();
    es.readyState = 0;
    es.onerror?.(new Event("error"));
    es.open();
    expect(statuses).toEqual(["connecting", "connected", "reconnecting", "connected"]);
    expect(FakeES.all).toHaveLength(1);
  });

  it("creates a new EventSource with backoff after the browser gives up", () => {
    const onClosed = vi.fn();
    const { statuses } = make({ onClosed });
    const es = FakeES.all[0]!;
    es.readyState = 2;
    es.onerror?.(new Event("error"));
    expect(onClosed).toHaveBeenCalled();
    expect(FakeES.all).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeES.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeES.all).toHaveLength(2);
    // second failure waits longer
    const es2 = FakeES.all[1]!;
    es2.readyState = 2;
    es2.onerror?.(new Event("error"));
    vi.advanceTimersByTime(1999);
    expect(FakeES.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeES.all).toHaveLength(3);
    FakeES.all[2]!.open();
    expect(statuses.at(-1)).toBe("connected");
  });

  it("reopens a silent connection after staleMs, and ping keeps it alive", () => {
    make({ staleMs: 45_000 });
    const es = FakeES.all[0]!;
    es.open();
    vi.advanceTimersByTime(40_000);
    es.emit("ping", {});
    vi.advanceTimersByTime(40_000);
    expect(FakeES.all).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    expect(FakeES.all).toHaveLength(2);
    expect(es.closed).toBe(true);
  });

  it("close() stops everything", () => {
    const { conn } = make();
    const es = FakeES.all[0]!;
    es.readyState = 2;
    es.onerror?.(new Event("error"));
    conn.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeES.all).toHaveLength(1);
  });
});
