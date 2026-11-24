// The durable record of manual compaction (`/compact`) requests, one row per request (see conversation/compaction.ts).
import { MANUAL_COMPACTION_TERMINAL, type ManualCompactionStatus } from "@rei/protocol";
import type { Db } from "../db/db.ts";
import type { Clock } from "../util/clock.ts";

export interface ManualCompactionRow {
  session_id: string;
  request_id: string;
  instructions_digest: string;
  task_id: string | null;
  submission_id: string | null;
  status: ManualCompactionStatus;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export const isTerminalCompaction = (status: ManualCompactionStatus): boolean =>
  MANUAL_COMPACTION_TERMINAL.includes(status);

export class ManualCompactionStore {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #changed: (sessionId: string) => void;

  constructor(db: Db, clock: Clock, changed: (sessionId: string) => void) {
    this.#db = db;
    this.#clock = clock;
    this.#changed = changed;
  }

  get(sessionId: string, requestId: string): ManualCompactionRow | undefined {
    return this.#db.get<ManualCompactionRow>(
      "SELECT * FROM manual_compactions WHERE session_id = ? AND request_id = ?",
      sessionId,
      requestId,
    );
  }

  /** Requests that have not ended, oldest first. */
  open(sessionId?: string): ManualCompactionRow[] {
    const ended = MANUAL_COMPACTION_TERMINAL.map(() => "?").join(", ");
    return this.#db.all<ManualCompactionRow>(
      `SELECT * FROM manual_compactions WHERE status NOT IN (${ended})${sessionId ? " AND session_id = ?" : ""} ORDER BY created_at`,
      ...MANUAL_COMPACTION_TERMINAL,
      ...(sessionId ? [sessionId] : []),
    );
  }

  /** Writes the intent, before Pi is asked. False when this request already has a row (a repeat). */
  insert(sessionId: string, requestId: string, instructionsDigest: string): boolean {
    const now = this.#clock.now();
    const done = this.#db.run(
      "INSERT OR IGNORE INTO manual_compactions (session_id, request_id, instructions_digest, status, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?)",
      sessionId,
      requestId,
      instructionsDigest,
      now,
      now,
    );
    if (done.changes > 0) this.#changed(sessionId);
    return done.changes > 0;
  }

  update(
    sessionId: string,
    requestId: string,
    patch: {
      status?: ManualCompactionStatus;
      taskId?: string;
      submissionId?: string;
      error?: { code: string; message: string };
    },
  ): void {
    this.#db.run(
      `UPDATE manual_compactions SET
         status = COALESCE(?, status), task_id = COALESCE(?, task_id), submission_id = COALESCE(?, submission_id),
         error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message), updated_at = ?
       WHERE session_id = ? AND request_id = ?`,
      patch.status ?? null,
      patch.taskId ?? null,
      patch.submissionId ?? null,
      patch.error?.code ?? null,
      patch.error?.message ?? null,
      this.#clock.now(),
      sessionId,
      requestId,
    );
    this.#changed(sessionId);
  }
}
