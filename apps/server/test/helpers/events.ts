import { createHmac } from "node:crypto";
import type { TestServer } from "./server.ts";

export interface SendOptions {
  id?: string;
  /** Unix seconds as text; default: the server clock's now. */
  timestamp?: string;
  /** Extra seconds to add to the clock's now. */
  skew?: number;
  body?: string;
  secrets?: string[];
  /** Replaces the computed signature header. */
  signature?: string;
  headers?: Record<string, string>;
}

let counter = 0;
export const eventBody = (type = "items.new", ref = "item_1", extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, ref, ...extra });

/** The Standard Webhooks signature of one request with one secret. */
export const sign = (secret: string, id: string, timestamp: string, body: string): string =>
  `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")}`;

/** Makes a source and returns a function that sends signed events to it, through the app (no network). */
export async function eventSender(server: TestServer, sourceId = "my-service") {
  const sources = server.host.plane.events!.sources;
  const { secret } = await sources.add(sourceId);
  const send = (options: SendOptions = {}, path = `/api/events/${sourceId}`) => {
    const id = options.id ?? `evt-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = options.timestamp ?? String(Math.floor(server.clock.now() / 1000) + (options.skew ?? 0));
    const body = options.body ?? eventBody();
    const signature =
      options.signature ?? (options.secrets ?? [secret]).map((s) => sign(s, id, timestamp, body)).join(" ");
    return Promise.resolve(
      server.host.plane.app.request(path, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signature,
          ...options.headers,
        },
      }),
    );
  };
  return { secret, send, sources };
}
