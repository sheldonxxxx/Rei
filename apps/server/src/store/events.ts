import type { Clock } from "../util/clock.ts";

/** One event on a stream as it goes on the wire: `cursor` is null for ephemeral events. */
export interface WireEvent {
  cursor: number | null;
  type: string;
  /** The event as JSON (it includes `type`). */
  data: string;
}

export const GLOBAL_STREAM = "global";
/** In-process notifications that a session's Conversation View may have changed (never sent to clients as-is). */
export const sessionStream = (sessionId: string): string => `session:${sessionId}`;

export type ResumePlan = { mode: "replay"; events: WireEvent[] } | { mode: "snapshot" };

/**
 * Per-stream event fan-out with increasing integer cursors and a bounded in-memory replay buffer (the last `keep`
 * events per stream). Nothing is stored: a client that reconnects after a restart, or that fell further behind than the
 * buffer, gets a fresh snapshot. Cursors start at the process's start time in microseconds, so they keep increasing
 * across restarts and a cursor from before one is always older than the buffer. `append` is called inside the caller's
 * transaction; `flush` publishes after the transaction commits.
 */
export class EventLog {
  readonly #keep: number;
  readonly #base: number;
  readonly #latest = new Map<string, number>();
  readonly #buffer = new Map<string, WireEvent[]>();
  readonly #subs = new Map<string, Set<(event: WireEvent) => void>>();
  #pending: { stream: string; event: WireEvent }[] = [];

  constructor(clock: Clock, keep = 1_000) {
    this.#keep = Math.max(1, keep);
    this.#base = clock.now() * 1_000;
  }

  append(stream: string, event: { type: string; [key: string]: unknown }): number {
    const cursor = this.latest(stream) + 1;
    this.#latest.set(stream, cursor);
    const wire: WireEvent = { cursor, type: event.type, data: JSON.stringify(event) };
    let buffer = this.#buffer.get(stream);
    if (!buffer) {
      buffer = [];
      this.#buffer.set(stream, buffer);
    }
    buffer.push(wire);
    if (buffer.length > this.#keep) buffer.splice(0, buffer.length - this.#keep);
    this.#pending.push({ stream, event: wire });
    return cursor;
  }

  /** Publishes the events appended since the last flush. Call right after the transaction commits. */
  flush(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const { stream, event } of pending) this.#publish(stream, event);
  }

  /** Drops events of a rolled-back transaction (their cursors stay used; clients only ever see gaps, never repeats). */
  discard(): void {
    const dropped = new Set(this.#pending.map((p) => p.event));
    this.#pending = [];
    for (const [stream, buffer] of this.#buffer) {
      const kept = buffer.filter((e) => !dropped.has(e));
      if (kept.length !== buffer.length) this.#buffer.set(stream, kept);
    }
  }

  /** Sends an event to connected clients only (no cursor, never replayed). */
  ephemeral(stream: string, event: { type: string; [key: string]: unknown }): void {
    this.#publish(stream, { cursor: null, type: event.type, data: JSON.stringify(event) });
  }

  #publish(stream: string, event: WireEvent): void {
    for (const fn of [...(this.#subs.get(stream) ?? [])]) {
      try {
        fn(event);
      } catch {
        // a broken subscriber must not stop the others
      }
    }
  }

  subscribe(stream: string, fn: (event: WireEvent) => void): () => void {
    let set = this.#subs.get(stream);
    if (!set) this.#subs.set(stream, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.#subs.delete(stream);
    };
  }

  /** How many live connections listen to a stream (tests use it to prove a dropped client is cleaned up). */
  subscriberCount(stream?: string): number {
    if (stream !== undefined) return this.#subs.get(stream)?.size ?? 0;
    let n = 0;
    for (const set of this.#subs.values()) n += set.size;
    return n;
  }

  latest(stream: string): number {
    return this.#latest.get(stream) ?? this.#base;
  }

  oldest(stream: string): number | undefined {
    return this.#buffer.get(stream)?.[0]?.cursor ?? undefined;
  }

  since(stream: string, cursor: number): WireEvent[] {
    return (this.#buffer.get(stream) ?? []).filter((e) => (e.cursor ?? 0) > cursor);
  }

  /** Replay when the buffer still holds every event after `lastEventId`; otherwise the client needs a fresh snapshot. */
  plan(stream: string, lastEventId: string | null | undefined): ResumePlan {
    if (lastEventId === null || lastEventId === undefined || !/^\d+$/.test(lastEventId)) return { mode: "snapshot" };
    const last = Number(lastEventId);
    const latest = this.latest(stream);
    if (last === latest) return { mode: "replay", events: [] };
    if (last > latest || last < this.#base) return { mode: "snapshot" };
    const oldest = this.oldest(stream);
    if (oldest === undefined || last < oldest - 1) return { mode: "snapshot" };
    return { mode: "replay", events: this.since(stream, last) };
  }
}
