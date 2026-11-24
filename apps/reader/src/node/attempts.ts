// The reader's own attempt store (node:sqlite): one row per render attempt, kept for 180 days. The URL is the full URL
// as requested (decision 7 of the spec), so a rescued or failed page can be opened again when deciding about the
// fallback; it never goes to the service log.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AttemptRow, AttemptSink } from "../core/render.ts";
import type { StatRow } from "../core/stats.ts";

export const ATTEMPT_RETENTION_MS = 180 * 24 * 3_600_000;

export class SqliteAttempts implements AttemptSink {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #maxAgeMs: number;

  constructor(file: string, options: { now?: () => number; maxAgeMs?: number } = {}) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#now = options.now ?? Date.now;
    this.#maxAgeMs = options.maxAgeMs ?? ATTEMPT_RETENTION_MS;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS render_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        read_id TEXT NOT NULL, attempt INTEGER NOT NULL, caller TEXT NOT NULL, step_id TEXT,
        engine TEXT NOT NULL, engine_version TEXT NOT NULL, role TEXT NOT NULL, trigger TEXT NOT NULL,
        outcome TEXT NOT NULL, error_detail TEXT,
        quality TEXT, text_chars INTEGER, sections INTEGER, ended TEXT,
        render_ms INTEGER, slot_wait_ms INTEGER, connections INTEGER NOT NULL, bytes INTEGER,
        refused INTEGER NOT NULL, blocked_media INTEGER,
        url TEXT NOT NULL, host TEXT NOT NULL, fallback_reason TEXT, used INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS render_attempts_ts ON render_attempts (ts);
      CREATE INDEX IF NOT EXISTS render_attempts_read ON render_attempts (read_id);
    `);
    this.prune();
  }

  record(row: AttemptRow): void {
    try {
      this.#db
        .prepare(
          `INSERT INTO render_attempts (ts, read_id, attempt, caller, step_id, engine, engine_version, role, trigger,
             outcome, error_detail, quality, text_chars, sections, ended, render_ms, slot_wait_ms, connections, bytes,
             refused, blocked_media, url, host, fallback_reason, used)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#now(),
          row.readId,
          row.attempt,
          row.caller,
          row.stepId ?? null,
          row.engine,
          row.engineVersion,
          row.role,
          row.trigger,
          row.outcome,
          row.errorDetail ?? null,
          row.quality ?? null,
          row.textChars ?? null,
          row.sections ?? null,
          row.ended ?? null,
          row.renderMs ?? null,
          row.slotWaitMs ?? null,
          row.connections,
          row.bytes ?? null,
          row.refused,
          row.blockedMedia ?? null,
          row.url,
          row.host,
          row.fallbackReason ?? null,
          row.used ? 1 : 0,
        );
    } catch {
      // The record is for the owner's decision; a full disk must not fail a read.
    }
  }

  prune(): void {
    this.#db.prepare("DELETE FROM render_attempts WHERE ts < ?").run(this.#now() - this.#maxAgeMs);
  }

  /** The rows of the window, oldest first, in the shape the statistics read. */
  rows(sinceMs: number): StatRow[] {
    const found = this.#db
      .prepare(
        `SELECT ts, read_id, attempt, engine, engine_version, role, outcome, quality, text_chars, render_ms, host, fallback_reason
         FROM render_attempts WHERE ts >= ? ORDER BY id`,
      )
      .all(this.#now() - sinceMs) as Record<string, string | number | null>[];
    return found.map((r) => ({
      ts: r.ts as number,
      readId: r.read_id as string,
      attempt: r.attempt as number,
      engine: r.engine as string,
      engineVersion: r.engine_version as string,
      role: r.role as string,
      outcome: r.outcome as string,
      quality: r.quality as string | null,
      textChars: r.text_chars as number | null,
      renderMs: r.render_ms as number | null,
      host: r.host as string,
      fallbackReason: r.fallback_reason as string | null,
    }));
  }

  /** Every column of the rows, newest first (tests and manual digging). */
  all(limit = 100): Record<string, unknown>[] {
    return this.#db.prepare("SELECT * FROM render_attempts ORDER BY id DESC LIMIT ?").all(limit) as Record<
      string,
      unknown
    >[];
  }

  close(): void {
    this.#db.close();
  }
}
