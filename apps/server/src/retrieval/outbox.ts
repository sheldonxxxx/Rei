// The queue between "SQLite decided what is searchable" and "the search service knows it".
//
// A row here is written in the same transaction as the entry it is about, so the two can never disagree about what
// *should* be indexed: if the transaction rolls back, the intent goes with it; if it commits, the intent survives a
// crash and the search service catches up when it is next reachable.
//
// One row per entry, keyed by the entry id, holding only the latest intent. That is what stops a chunk that was hidden
// a moment ago from being indexed again by an older op that was still sitting in the queue.
import type { Db } from "../db/db.ts";
import type { Clock } from "../util/clock.ts";

export type OutboxOp = "upsert" | "delete";

export interface OutboxRow {
  entry_id: number;
  point_id: string | null;
  op: OutboxOp;
  seq: number;
  queued_at: number;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
}

/** How long one entry may be held while the search call is in flight. */
const LEASE_MS = 5 * 60_000;
/** Retry waits, in ms, then flat: a backlog is a delay, never a loss. */
const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 400);

/** One entry's intent, with the point it refers to: by the time a delete is worked off, the entry row may be gone. */
export interface OutboxIntent {
  entryId: number;
  pointId?: string;
}

export class RetrievalOutbox {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** The entry should be searchable with the text it has now. */
  enqueueUpsert(intents: readonly OutboxIntent[]): void {
    this.#enqueue(intents, "upsert");
  }

  /** The entry's points must come out of every collection, and stay out. */
  enqueueDelete(intents: readonly OutboxIntent[]): void {
    this.#enqueue(intents, "delete");
  }

  #enqueue(intents: readonly OutboxIntent[], op: OutboxOp): void {
    if (intents.length === 0) return;
    const now = this.#clock.now();
    for (const intent of intents)
      this.#db.run(
        `INSERT INTO retrieval_outbox (entry_id, point_id, op, seq, queued_at)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM retrieval_outbox), ?)
         ON CONFLICT(entry_id) DO UPDATE SET
           op = excluded.op,
           point_id = COALESCE(excluded.point_id, retrieval_outbox.point_id),
           seq = retrieval_outbox.seq + 1,
           queued_at = excluded.queued_at,
           attempts = 0,
           next_attempt_at = 0,
           last_error = NULL`,
        intent.entryId,
        intent.pointId ?? null,
        op,
        now,
      );
  }

  /** Entries whose op is due (the backoff has expired and no worker holds it). */
  due(limit: number): OutboxRow[] {
    return this.#db.all<OutboxRow>(
      "SELECT * FROM retrieval_outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at, entry_id LIMIT ?",
      this.#clock.now(),
      limit,
    );
  }

  claim(entryId: number, seq: number): boolean {
    const now = this.#clock.now();
    return (
      this.#db.run(
        "UPDATE retrieval_outbox SET next_attempt_at = ?, attempts = attempts + 1 WHERE entry_id = ? AND seq = ? AND next_attempt_at <= ?",
        now + LEASE_MS,
        entryId,
        seq,
        now,
      ).changes === 1
    );
  }

  /** The search service has the entry's current state; the intent is spent. */
  succeed(entryId: number, seq: number): void {
    this.#db.run("DELETE FROM retrieval_outbox WHERE entry_id = ? AND seq = ?", entryId, seq);
  }

  /** Not this time. Keep the intent, back off, stay countable. */
  requeue(entryId: number, seq: number, error: unknown): void {
    const row = this.#db.get<{ attempts: number }>("SELECT attempts FROM retrieval_outbox WHERE entry_id = ?", entryId);
    const attempt = Math.max(1, row?.attempts ?? 1);
    const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!;
    this.#db.run(
      "UPDATE retrieval_outbox SET next_attempt_at = ?, last_error = ? WHERE entry_id = ? AND seq = ?",
      this.#clock.now() + delay,
      errorText(error),
      entryId,
      seq,
    );
  }

  /** What `rei doctor` and the memory settings report: how far behind Rei is, and the last thing that went wrong. */
  counts(): { pending: number; oldestAgeMs: number | null; lastError: string | null } {
    const totals = this.#db.get<{ n: number; oldest: number | null }>(
      "SELECT COUNT(*) AS n, MIN(queued_at) AS oldest FROM retrieval_outbox",
    );
    const failing = this.#db.get<{ last_error: string }>(
      "SELECT last_error FROM retrieval_outbox WHERE last_error IS NOT NULL ORDER BY next_attempt_at DESC LIMIT 1",
    );
    const now = this.#clock.now();
    return {
      pending: totals?.n ?? 0,
      oldestAgeMs: totals?.oldest === null || totals?.oldest === undefined ? null : Math.max(0, now - totals.oldest),
      lastError: failing?.last_error ?? null,
    };
  }

  /** Every entry still waiting, for a test or a rebuild that wants to know it started empty. */
  has(entryId: number): boolean {
    return this.#db.get("SELECT 1 AS x FROM retrieval_outbox WHERE entry_id = ?", entryId) !== undefined;
  }
}
