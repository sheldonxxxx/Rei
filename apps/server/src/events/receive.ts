// Receiving an outside event (ADR 0019): `POST /api/events/<source>`. The route is open to the network, so every request
// is checked in a fixed order, the signature before the body is parsed, and each refusal is a status code and a short
// code with no detail. Nothing here logs a secret, a signature or a body.
import type { Db } from "../db/db.ts";
import { fromBase64Url, timingSafeEqual, utf8 } from "../util/encoding.ts";
import { newId } from "../util/ids.ts";
import type { Logger } from "../util/log.ts";
import type { EventSources } from "./sources.ts";

export const EVENT_LIMITS = {
  bodyBytes: 2048,
  timestampSkewMs: 5 * 60_000,
  /** Also the duplicate window. */
  keepMs: 7 * 86_400_000,
  keepPerSource: 10_000,
  perMinute: 120,
  /** At most this many signatures in a header are looked at. */
  signatures: 4,
  types: 64,
} as const;

const WEBHOOK_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
export const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
export const EVENT_REF = /^[A-Za-z0-9_.:/-]{1,128}$/;
const OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** An accepted event, as the trigger code receives it. */
export interface AcceptedEvent {
  id: string;
  source: string;
  type: string;
  ref: string;
  occurredAt: string | null;
  receivedAt: number;
}

export interface EventAnswer {
  status: 200 | 202 | 400 | 401 | 404 | 413 | 429;
  code?: "unknown_source" | "bad_signature" | "stale_timestamp" | "bad_event" | "too_many" | "too_large";
  body?: { accepted?: true; duplicate?: true };
  retryAfterSeconds?: number;
}

export interface EventReceiverDeps {
  db: Db;
  sources: EventSources;
  now: () => number;
  log: Logger;
  /** Called inside the transaction that records the event: starts or joins runs and returns how many. */
  onAccepted?: (event: AcceptedEvent) => number;
  /** Called once the transaction has committed and the event was accepted (runs that were made can start now). */
  afterAccepted?: () => void;
}

export interface EventRequest {
  source: string;
  webhookId: string | null;
  timestamp: string | null;
  signature: string | null;
  /** The raw body, or null when it is over the limit. */
  body: Uint8Array | null;
}

const refuse = (status: EventAnswer["status"], code: NonNullable<EventAnswer["code"]>): EventAnswer => ({
  status,
  code,
});

/** Whether any of the header's `v1,<base64>` signatures equals one of the expected MACs. Looks at all of them, every time. */
export async function signatureMatches(
  secrets: string[],
  id: string,
  timestamp: string,
  body: Uint8Array,
  header: string,
): Promise<boolean> {
  const given = header
    .split(" ")
    .filter((part) => part.startsWith("v1,"))
    .slice(0, EVENT_LIMITS.signatures)
    .flatMap((part) => {
      try {
        return [fromBase64Url(part.slice(3).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""))];
      } catch {
        return [];
      }
    });
  const head = utf8(`${id}.${timestamp}.`);
  const message = new Uint8Array(head.length + body.length);
  message.set(head);
  message.set(body, head.length);
  let ok = false;
  for (const secret of secrets) {
    let key: Uint8Array<ArrayBuffer>;
    try {
      key = fromBase64Url(secret.slice("whsec_".length).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""));
    } catch {
      continue;
    }
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        message,
      ),
    );
    for (const candidate of given) if (timingSafeEqual(mac, candidate)) ok = true;
  }
  return ok;
}

export class EventReceiver {
  readonly #d: EventReceiverDeps;
  constructor(deps: EventReceiverDeps) {
    this.#d = deps;
  }

  async receive(req: EventRequest): Promise<EventAnswer> {
    const { sources, now, log } = this.#d;
    const secrets = await sources.validSecrets(req.source);
    if (!secrets) return refuse(404, "unknown_source");
    const reject = (answer: EventAnswer): EventAnswer => {
      log.info("events.rejected", { source: req.source, status: answer.status, code: answer.code ?? "" });
      return answer;
    };
    if (req.body === null) return reject(refuse(413, "too_large"));
    if (!req.webhookId || !req.timestamp || !req.signature || req.signature.length > 1024)
      return reject(refuse(401, "bad_signature"));
    if (!(await signatureMatches(secrets, req.webhookId, req.timestamp, req.body, req.signature)))
      return reject(refuse(401, "bad_signature"));
    const at = /^\d{1,12}$/.test(req.timestamp) ? Number(req.timestamp) * 1000 : Number.NaN;
    if (!(Math.abs(now() - at) <= EVENT_LIMITS.timestampSkewMs)) return reject(refuse(401, "stale_timestamp"));
    const parsed = parseBody(req.body);
    if (!parsed || !WEBHOOK_ID.test(req.webhookId)) return reject(refuse(400, "bad_event"));
    const answer = this.#record(req.source, req.webhookId, parsed, reject);
    if (answer.status === 202) this.#d.afterAccepted?.();
    return answer;
  }

  #record(
    source: string,
    webhookId: string,
    body: { type: string; ref: string; occurredAt: string | null },
    reject: (a: EventAnswer) => EventAnswer,
  ): EventAnswer {
    const { db, now, log, onAccepted } = this.#d;
    return db.transaction((): EventAnswer => {
      const t = now();
      db.run("DELETE FROM events WHERE source = ? AND received_at < ?", source, t - EVENT_LIMITS.keepMs);
      if (db.get("SELECT 1 AS x FROM events WHERE source = ? AND webhook_id = ?", source, webhookId))
        return { status: 200, body: { duplicate: true } };
      const recent = db.all<{ received_at: number }>(
        "SELECT received_at FROM events WHERE source = ? AND received_at > ? ORDER BY received_at LIMIT ?",
        source,
        t - 60_000,
        EVENT_LIMITS.perMinute,
      );
      if (recent.length >= EVENT_LIMITS.perMinute) {
        const wait = Math.ceil(((recent[0]?.received_at ?? t) + 60_000 - t) / 1000);
        return reject({ status: 429, code: "too_many", retryAfterSeconds: Math.max(1, wait) });
      }
      const id = newId("evt", t);
      db.run(
        "INSERT INTO events (id, source, webhook_id, type, ref, occurred_at, received_at, runs) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        id,
        source,
        webhookId,
        body.type,
        body.ref,
        body.occurredAt,
        t,
      );
      db.run(
        "DELETE FROM events WHERE source = ? AND id IN (SELECT id FROM events WHERE source = ? ORDER BY received_at DESC, id DESC LIMIT -1 OFFSET ?)",
        source,
        source,
        EVENT_LIMITS.keepPerSource,
      );
      const runs =
        onAccepted?.({ id, source, type: body.type, ref: body.ref, occurredAt: body.occurredAt, receivedAt: t }) ?? 0;
      if (runs > 0) db.run("UPDATE events SET runs = ? WHERE id = ?", runs, id);
      log.debug("events.accepted", { source, runs });
      return { status: 202, body: { accepted: true } };
    });
  }
}

/** The body, if it is exactly `{ type, ref, occurredAt? }` with every field in its strict character set. */
export function parseBody(bytes: Uint8Array): { type: string; ref: string; occurredAt: string | null } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "type" && k !== "ref" && k !== "occurredAt")) return undefined;
  const { type, ref, occurredAt } = o;
  if (typeof type !== "string" || type.length > EVENT_LIMITS.types || !EVENT_TYPE.test(type)) return undefined;
  if (typeof ref !== "string" || !EVENT_REF.test(ref)) return undefined;
  if (
    occurredAt !== undefined &&
    (typeof occurredAt !== "string" || !OCCURRED_AT.test(occurredAt) || Number.isNaN(Date.parse(occurredAt)))
  )
    return undefined;
  return { type, ref, occurredAt: occurredAt ?? null };
}

/** Reads a request body, giving up (null) once it is over the limit, whatever its declared length. */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
