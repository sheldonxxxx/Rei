// The ledger of Rei's file bytes. Garage holds the bytes; this table holds what Rei knows about them: which key they
// are under, which hash they must have, whether they are ready to be read, and — the part that cannot be trusted to a
// try/catch — what still has to be deleted when the service does not answer.
//
// One row per object, and one place for the state machine:
//
//   pending ──put ok──▶ ready ──nothing owns it──▶ delete_pending ──DeleteObject ok──▶ deleted
//      │                                ▲                        │
//      └── put failed (bytes may exist) ┴────────────── retry ────┘  (attempts, backoff)
//
// An object is owned while some `attachments` row names it. That is the whole ownership rule, and it is what makes a
// Library file survive the chat that uploaded it (its attachment row survives) while an abandoned upload does not.
import type { Db } from "../db/db.ts";
import type { Clock } from "../util/clock.ts";
import { objectKey } from "./file-object-store.ts";

export type ObjectState = "pending" | "ready" | "delete_pending" | "deleted" | "failed";

export interface StorageObjectRow {
  id: string;
  bucket: string;
  object_key: string;
  content_sha256: string;
  byte_length: number;
  state: ObjectState;
  created_at: number;
  verified_at: number | null;
  delete_after: number | null;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
}

/** Waits before the first orphan sweep: an upload in flight is not an orphan. */
export const ORPHAN_GRACE_MS = 60 * 60_000;
/** Deletion retries, in ms, then flat at the last step: a delete that keeps failing stays visible, never forgotten. */
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000];
/** How long one worker may hold an object while the service call is in flight. */
const LEASE_MS = 5 * 60_000;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 400);

export class ObjectRegistry {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** The intent to store: the row exists before the bytes do, so a crash mid-upload leaves something to clean up. */
  begin(input: { id: string; sha256: string; byteLength: number; bucket: string }): StorageObjectRow {
    const now = this.#clock.now();
    const key = objectKey(input.id, input.sha256);
    this.#db.run(
      `INSERT INTO storage_objects (id, bucket, object_key, content_sha256, byte_length, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      input.id,
      input.bucket,
      key,
      input.sha256,
      input.byteLength,
      now,
    );
    return this.row(input.id)!;
  }

  row(id: string): StorageObjectRow | undefined {
    return this.#db.get<StorageObjectRow>("SELECT * FROM storage_objects WHERE id = ?", id);
  }

  /** The object is in the service with the size it promised. A row already marked for deletion is never reused. */
  markReady(id: string): StorageObjectRow {
    const row = this.row(id);
    if (!row) throw new Error(`The storage object ${id} is not in the ledger.`);
    if (row.state === "delete_pending" || row.state === "deleted")
      throw new Error(`The storage object ${id} was already scheduled for deletion; it cannot be reused.`);
    this.#db.run(
      "UPDATE storage_objects SET state = 'ready', verified_at = ?, last_error = NULL WHERE id = ?",
      this.#clock.now(),
      id,
    );
    return this.row(id)!;
  }

  /** The logical decision is made (the file is gone); the bytes may still be in the service, so the ledger says what to do. */
  scheduleDelete(id: string, options: { deleteAfter?: number } = {}): void {
    this.#db.run(
      "UPDATE storage_objects SET state = 'delete_pending', next_attempt_at = ?, delete_after = ?, last_error = NULL WHERE id = ? AND state <> 'deleted'",
      this.#clock.now(),
      options.deleteAfter ?? null,
      id,
    );
  }

  /** Takes an object for one attempt. False when someone else holds it or it is no longer due. */
  claim(id: string): boolean {
    const now = this.#clock.now();
    return (
      this.#db.run(
        "UPDATE storage_objects SET next_attempt_at = ?, attempts = attempts + 1 WHERE id = ? AND state = 'delete_pending' AND next_attempt_at <= ?",
        now + LEASE_MS,
        id,
        now,
      ).changes === 1
    );
  }

  /** The attempt failed: back off, keep the intent, stay countable. */
  requeue(id: string, error: unknown): void {
    const row = this.row(id);
    // `claim` already counted this attempt, so the first failure waits one step, not nothing.
    const attempt = Math.max(1, row?.attempts ?? 1);
    const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!;
    this.#db.run(
      "UPDATE storage_objects SET state = 'delete_pending', next_attempt_at = ?, last_error = ? WHERE id = ? AND state <> 'deleted'",
      this.#clock.now() + delay,
      errorText(error),
      id,
    );
  }

  markDeleted(id: string): void {
    this.#db.run(
      "UPDATE storage_objects SET state = 'deleted', verified_at = NULL, next_attempt_at = 0, last_error = NULL WHERE id = ?",
      id,
    );
  }

  /** Objects whose deletion is due (the grace period passed and the backoff expired). */
  due(limit: number): StorageObjectRow[] {
    return this.#db.all<StorageObjectRow>(
      "SELECT * FROM storage_objects WHERE state = 'delete_pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, created_at LIMIT ?",
      this.#clock.now(),
      limit,
    );
  }

  /**
   * Objects nobody owns any more: a row still marked pending or ready after the grace period means the upload was
   * abandoned (the process died, or SQLite refused the transaction after Garage took the bytes). Marking them is the
   * only thing standing between a crash and bytes that no row of SQLite points at.
   */
  reclaimOrphans(graceMs = ORPHAN_GRACE_MS, limit = 200): number {
    const cutoff = this.#clock.now() - graceMs;
    const rows = this.#db.all<{ id: string }>(
      `SELECT o.id FROM storage_objects o
       WHERE o.state IN ('pending','ready') AND o.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.object_id = o.id)
       ORDER BY o.created_at LIMIT ?`,
      cutoff,
      limit,
    );
    for (const row of rows) this.scheduleDelete(row.id);
    return rows.length;
  }

  /** What `rei doctor` and the settings page report. Counts only: never a key, never a filename. */
  counts(): {
    pending: number;
    ready: number;
    deletePending: number;
    failed: number;
    readyBytes: number;
    lastError: string | null;
  } {
    const by = new Map(
      this.#db
        .all<{ state: ObjectState; n: number; bytes: number }>(
          "SELECT state, COUNT(*) AS n, COALESCE(SUM(byte_length), 0) AS bytes FROM storage_objects GROUP BY state",
        )
        .map((r) => [r.state, r] as const),
    );
    const n = (state: ObjectState) => by.get(state)?.n ?? 0;
    const failing = this.#db.get<{ last_error: string }>(
      "SELECT last_error FROM storage_objects WHERE state = 'delete_pending' AND last_error IS NOT NULL ORDER BY next_attempt_at DESC LIMIT 1",
    );
    return {
      pending: n("pending"),
      ready: n("ready"),
      deletePending: n("delete_pending"),
      failed: n("failed"),
      readyBytes: by.get("ready")?.bytes ?? 0,
      lastError: failing?.last_error ?? null,
    };
  }
}
