// Event sources (ADR 0019): the named senders that may tell Rei something happened. A source is an id, a display name,
// a status and a secret. HMAC needs the secret itself, so it is kept, but encrypted with a key that lives outside the
// database (REI_EVENTS_KEY): a copy of the database alone reveals no secret. Secrets are never logged and never listed.
import type { Db } from "../db/db.ts";
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from "../util/encoding.ts";
import { Invalid, notFound } from "../util/errors.ts";

export const SOURCE_ID = /^[a-z][a-z0-9-]{1,31}$/;
export const DEFAULT_GRACE_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;

export interface EventSource {
  id: string;
  name: string;
  status: "active" | "disabled";
  createdAt: number;
}
export interface EventSourceSummary extends EventSource {
  /** When the newest event arrived, or null. */
  lastEventAt: number | null;
  /** The event types seen in the last 30 days. */
  types: string[];
  /** Whether an earlier secret still verifies (a rotation's grace period). */
  graceUntil: number | null;
}

interface SourceRow {
  id: string;
  name: string;
  status: "active" | "disabled";
  secret: string;
  previous_secret: string | null;
  previous_expires_at: number | null;
  created_at: number;
}

/** AES-256-GCM under the events key; the blob is bound to the source id, so a blob moved to another row does not open. */
export class SecretBox {
  readonly #key: Promise<CryptoKey>;
  constructor(key: Uint8Array<ArrayBuffer>) {
    if (key.length !== 32) throw new Error("REI_EVENTS_KEY must be 32 bytes (64 hex characters).");
    this.#key = crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async seal(plain: string, aad: string): Promise<string> {
    const iv = randomBytes(12);
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, await this.#key, utf8(plain)),
    );
    return `v1.${toBase64Url(iv)}.${toBase64Url(sealed)}`;
  }
  async open(blob: string, aad: string): Promise<string> {
    const [version, iv, sealed] = blob.split(".");
    if (version !== "v1" || !iv || !sealed) throw new Error("unreadable secret");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: utf8(aad) },
      await this.#key,
      fromBase64Url(sealed),
    );
    return new TextDecoder().decode(plain);
  }
}

/** The key as the environment gives it: 64 hex characters. */
export function parseEventsKey(hex: string | undefined): Uint8Array<ArrayBuffer> | undefined {
  if (!hex) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("REI_EVENTS_KEY must be 64 hex characters.");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** `whsec_` + 32 random bytes in base64 (the Standard Webhooks format). */
export function newSecret(): string {
  return `whsec_${btoa(String.fromCharCode(...randomBytes(32)))}`;
}

export class EventSources {
  readonly #db: Db;
  readonly #box: SecretBox;
  readonly #now: () => number;

  constructor(db: Db, key: Uint8Array<ArrayBuffer>, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#box = new SecretBox(key);
    this.#now = now;
  }

  #row(id: string): SourceRow | undefined {
    return this.#db.get<SourceRow>("SELECT * FROM event_sources WHERE id = ?", id);
  }
  #view(r: SourceRow): EventSource {
    return { id: r.id, name: r.name, status: r.status, createdAt: r.created_at };
  }

  /** Makes a source. The secret is returned here and nowhere else. */
  async add(id: string, name?: string): Promise<{ source: EventSource; secret: string }> {
    if (!SOURCE_ID.test(id))
      throw new Invalid(
        "A source id is 2 to 32 characters: a lowercase letter, then lowercase letters, digits or dashes.",
      );
    if (this.#row(id)) throw new Invalid(`A source named "${id}" already exists.`);
    const label = (name ?? id).trim();
    if (label === "" || label.length > 80) throw new Invalid("The name must be 1 to 80 characters.");
    const secret = newSecret();
    this.#db.run(
      "INSERT INTO event_sources (id, name, status, secret, created_at) VALUES (?, ?, 'active', ?, ?)",
      id,
      label,
      await this.#box.seal(secret, id),
      this.#now(),
    );
    return { source: this.#view(this.#row(id)!), secret };
  }

  /** Drops a previous secret whose grace has ended. */
  #expire(id: string): void {
    this.#db.run(
      "UPDATE event_sources SET previous_secret = NULL, previous_expires_at = NULL WHERE id = ? AND previous_expires_at IS NOT NULL AND previous_expires_at <= ?",
      id,
      this.#now(),
    );
  }

  get(id: string): EventSource | undefined {
    const r = this.#row(id);
    return r ? this.#view(r) : undefined;
  }

  list(): EventSourceSummary[] {
    const since = this.#now() - 30 * DAY_MS;
    return this.#db.all<SourceRow>("SELECT * FROM event_sources ORDER BY created_at, id").map((r) => {
      this.#expire(r.id);
      const fresh = this.#row(r.id) ?? r;
      return {
        ...this.#view(fresh),
        lastEventAt:
          this.#db.get<{ at: number | null }>("SELECT MAX(received_at) AS at FROM events WHERE source = ?", r.id)?.at ??
          null,
        types: this.#db
          .all<{ type: string }>(
            "SELECT DISTINCT type FROM events WHERE source = ? AND received_at >= ? ORDER BY type",
            r.id,
            since,
          )
          .map((t) => t.type),
        graceUntil: fresh.previous_secret ? fresh.previous_expires_at : null,
      };
    });
  }

  /**
   * A new secret; the old one keeps verifying for `graceMs` (0 ends it at once). Rotating again during a grace replaces the
   * earlier secret, so at most two are valid at a time.
   */
  async rotate(id: string, graceMs: number = DEFAULT_GRACE_MS): Promise<{ secret: string; graceUntil: number | null }> {
    const r = this.#row(id);
    if (!r) throw notFound(`There is no source named "${id}".`);
    const secret = newSecret();
    const now = this.#now();
    const keep = graceMs > 0;
    this.#db.run(
      "UPDATE event_sources SET secret = ?, previous_secret = ?, previous_expires_at = ? WHERE id = ?",
      await this.#box.seal(secret, id),
      keep ? r.secret : null,
      keep ? now + graceMs : null,
      id,
    );
    return { secret, graceUntil: keep ? now + graceMs : null };
  }

  setStatus(id: string, status: "active" | "disabled"): void {
    const done = this.#db.run("UPDATE event_sources SET status = ? WHERE id = ?", status, id);
    if (done.changes === 0) throw notFound(`There is no source named "${id}".`);
  }

  /** Triggers that start on events from this source. */
  listeners(id: string): { id: string; name: string }[] {
    return this.#db.all<{ id: string; name: string }>(
      "SELECT id, name FROM triggers WHERE start_kind = 'event' AND json_extract(event_json, '$.source') = ? ORDER BY created_at",
      id,
    );
  }

  /** Removes a source and its events. While triggers listen to it this refuses, unless `force`, which pauses them. */
  remove(id: string, force: boolean): { paused: number } {
    if (!this.#row(id)) throw notFound(`There is no source named "${id}".`);
    return this.#db.transaction(() => {
      const listening = this.listeners(id);
      if (listening.length > 0 && !force)
        throw new Invalid(
          `${listening.length} trigger${listening.length === 1 ? " listens" : "s listen"} to "${id}": ${listening.map((t) => t.name).join(", ")}. Remove or change them, or use --force to pause them.`,
        );
      const now = this.#now();
      for (const t of listening)
        this.#db.run(
          "UPDATE triggers SET status = 'paused', paused_reason = 'user', next_fire_at = NULL, updated_at = ? WHERE id = ? AND status = 'active'",
          now,
          t.id,
        );
      this.#db.run("DELETE FROM events WHERE source = ?", id);
      this.#db.run("DELETE FROM event_sources WHERE id = ?", id);
      return { paused: listening.length };
    });
  }

  /**
   * The secrets that verify a request for this source right now, or undefined when the source is unknown or disabled (the
   * route answers both the same). A secret that cannot be opened (the key changed) is left out, so the request fails as a
   * bad signature would.
   */
  async validSecrets(id: string): Promise<string[] | undefined> {
    this.#expire(id);
    const r = this.#row(id);
    if (r?.status !== "active") return undefined;
    const blobs = [r.secret, ...(r.previous_secret ? [r.previous_secret] : [])];
    const out: string[] = [];
    for (const blob of blobs) {
      try {
        out.push(await this.#box.open(blob, id));
      } catch {
        // unreadable: skipped
      }
    }
    return out;
  }
}
