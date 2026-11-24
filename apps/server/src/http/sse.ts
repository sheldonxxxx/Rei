import { PING_INTERVAL_MS, type SessionEvent } from "@rei/protocol";
import type { EventLog, WireEvent } from "../store/events.ts";

export interface SseSource {
  events: EventLog;
  stream: string;
  /** Builds the snapshot JSON (without `cursor`) from current state; called in the same tick as the cursor is read. */
  snapshot(): Record<string, unknown>;
  lastEventId: string | null | undefined;
  /** Test hook: shorter ping interval. */
  pingMs?: number;
  onClose?: () => void;
  /** Ends the response after sending an event for which this is true (a deleted session's stream ends with `session.removed`). */
  endAfter?(event: WireEvent): boolean;
}

const encoder = new TextEncoder();
/** A client this far behind is dropped; it reconnects with Last-Event-ID and gets a replay or a fresh snapshot. */
const MAX_BACKLOG_CHUNKS = 2000;

const frame = (type: string, data: string, id?: number | string): Uint8Array =>
  encoder.encode(`${id !== undefined ? `id: ${id}\n` : ""}event: ${type}\ndata: ${data}\n\n`);

/**
 * One SSE response for a stream: subscribe, then in the same tick read the resume plan or the
 * snapshot, so nothing committed in between can be missed or doubled. Committed events carry `id:`; ephemeral ones do not.
 */
export function sseResponse(source: SseSource): Response {
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        const write = (chunk: Uint8Array) => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) < -MAX_BACKLOG_CHUNKS) {
            close();
            return;
          }
          try {
            controller.enqueue(chunk);
          } catch {
            close();
          }
        };
        const send = (event: WireEvent) => {
          write(frame(event.type, event.data, event.cursor ?? undefined));
          if (source.endAfter?.(event)) close();
        };

        const unsubscribe = source.events.subscribe(source.stream, send);
        const ping = setInterval(() => write(frame("ping", "{}")), source.pingMs ?? PING_INTERVAL_MS);
        (ping as { unref?: () => void }).unref?.();
        cleanup = () => {
          unsubscribe();
          clearInterval(ping);
          source.onClose?.();
        };

        write(encoder.encode("retry: 3000\n\n"));
        const plan = source.events.plan(source.stream, source.lastEventId);
        if (plan.mode === "replay") {
          for (const event of plan.events) send(event);
        } else {
          const cursor = source.events.latest(source.stream);
          const snapshot = { type: "snapshot", cursor: String(cursor), ...source.snapshot() };
          write(frame("snapshot", JSON.stringify(snapshot), cursor));
        }
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: 64 },
  );
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

/**
 * The session stream: one Conversation View watch (a snapshot, then patches, `{epoch, rev}` ordered, no `id:`). A
 * client that falls too far behind is sent `resync_required` and dropped; it reconnects for a fresh snapshot.
 */
export function viewSseResponse(source: {
  subscribe(listener: (event: SessionEvent) => void): Promise<() => void>;
  pingMs?: number;
}): Response {
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        let closed = false;
        let unsubscribe: (() => void) | undefined;
        const close = () => {
          if (closed) return;
          closed = true;
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        const write = (chunk: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            close();
          }
        };
        const send = (event: SessionEvent) => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) < -MAX_BACKLOG_CHUNKS && event.type === "patch") {
            write(
              frame("resync_required", JSON.stringify({ type: "resync_required", epoch: event.epoch, rev: event.rev })),
            );
            close();
            return;
          }
          write(frame(event.type, JSON.stringify(event)));
          if (event.type === "session.removed") close();
        };
        const ping = setInterval(() => write(frame("ping", "{}")), source.pingMs ?? PING_INTERVAL_MS);
        (ping as { unref?: () => void }).unref?.();
        cleanup = () => {
          unsubscribe?.();
          clearInterval(ping);
        };
        write(encoder.encode("retry: 3000\n\n"));
        try {
          unsubscribe = await source.subscribe(send);
          if (closed) unsubscribe();
        } catch {
          write(frame("resync_required", JSON.stringify({ type: "resync_required", epoch: "", rev: 0 })));
          close();
        }
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: 64 },
  );
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
