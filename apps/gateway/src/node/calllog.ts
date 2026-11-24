// The gateway's own call store (node:sqlite). Keeps rows for at most `maxAgeMs`, and at most `maxRows` per caller, so
// one busy caller cannot push another's rows out.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GatewayCallRecord, GatewayCallsSummary, GatewayLimitCode } from "@rei/protocol";
import type { CallLog } from "../core/types.ts";

export interface CallLogOptions {
  maxAgeMs?: number;
  maxRows?: number;
  now?: () => number;
}

interface Row {
  caller: string | null;
  provider: string | null;
  step_id: string | null;
  model: string | null;
  started_at: number;
  first_byte_ms: number | null;
  total_ms: number | null;
  status: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  limit_resets_s: number | null;
  limit_code: GatewayLimitCode | null;
  limit_headers: string | null;
  error_code: string | null;
}

export class SqliteCallLog implements CallLog {
  readonly #db: DatabaseSync;
  readonly #maxAgeMs: number;
  readonly #maxRows: number;
  readonly #now: () => number;
  #sincePrune = 0;

  constructor(file: string, options: CallLogOptions = {}) {
    mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#maxAgeMs = options.maxAgeMs ?? 30 * 24 * 3_600_000;
    this.#maxRows = options.maxRows ?? 100_000;
    this.#now = options.now ?? Date.now;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step_id TEXT, model TEXT, started_at INTEGER NOT NULL,
        first_byte_ms INTEGER, total_ms INTEGER, status INTEGER NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
        limit_resets_s INTEGER, limit_code TEXT, limit_headers TEXT,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS calls_step ON calls (step_id);
      CREATE INDEX IF NOT EXISTS calls_started ON calls (started_at);
    `);
    this.#migrate();
    this.prune();
  }

  /**
   * Version 1 adds the caller and the provider. Rows from before it were all Rei's (nothing else could reach the
   * gateway), so they are filled in as `rei`; their provider stays unknown. An older gateway still reads and writes this
   * table: it names its columns and ignores the new ones.
   */
  #migrate(): void {
    const columns = new Set(
      (this.#db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map((c) => c.name),
    );
    if (columns.has("caller") && columns.has("provider")) {
      this.#db.exec("CREATE INDEX IF NOT EXISTS calls_caller_started ON calls (caller, started_at)");
      return;
    }
    this.#db.exec("BEGIN");
    try {
      if (!columns.has("caller")) this.#db.exec("ALTER TABLE calls ADD COLUMN caller TEXT");
      if (!columns.has("provider")) this.#db.exec("ALTER TABLE calls ADD COLUMN provider TEXT");
      this.#db.exec(`
        UPDATE calls SET caller = 'rei' WHERE caller IS NULL;
        CREATE INDEX IF NOT EXISTS calls_caller_started ON calls (caller, started_at);
        PRAGMA user_version = 1;
        COMMIT;
      `);
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  insert(r: GatewayCallRecord): void {
    this.#db
      .prepare(
        `INSERT INTO calls (caller, provider, step_id, model, started_at, first_byte_ms, total_ms, status, input_tokens, output_tokens, cached_tokens, limit_resets_s, limit_code, limit_headers, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.caller,
        r.provider,
        r.stepId,
        r.model,
        r.startedAt,
        r.firstByteMs,
        r.totalMs,
        r.status,
        r.usage?.inputTokens ?? null,
        r.usage?.outputTokens ?? null,
        r.usage?.cachedInputTokens ?? null,
        r.limit?.resetsInSeconds ?? null,
        r.limit?.code ?? null,
        r.limit ? JSON.stringify(r.limit.headers) : null,
        r.error?.code ?? null,
      );
    if (++this.#sincePrune >= 1000) this.prune();
  }

  /** One caller's rows for a step: a step id is only a correlation id, and another caller could send the same one. */
  byStep(stepId: string, caller: string): GatewayCallRecord[] {
    return this.#rows(
      this.#db
        .prepare("SELECT * FROM calls WHERE step_id = ? AND COALESCE(caller, 'rei') = ? ORDER BY id")
        .all(stepId, caller),
    );
  }

  /** Newest first. */
  recent(limit: number, caller?: string): GatewayCallRecord[] {
    return this.#rows(
      caller === undefined
        ? this.#db.prepare("SELECT * FROM calls ORDER BY id DESC LIMIT ?").all(limit)
        : this.#db
            .prepare("SELECT * FROM calls WHERE COALESCE(caller, 'rei') = ? ORDER BY id DESC LIMIT ?")
            .all(caller, limit),
    );
  }

  /** Calls and tokens per caller and provider since `sinceMs`. */
  summary(sinceMs: number): GatewayCallsSummary["rows"] {
    const rows = this.#db
      .prepare(
        `SELECT COALESCE(caller, 'rei') AS caller, provider,
                COUNT(*) AS calls,
                SUM(CASE WHEN status < 400 AND error_code IS NULL THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN limit_code IS NOT NULL OR status = 429 THEN 1 ELSE 0 END) AS limited,
                SUM(CASE WHEN status >= 400 OR error_code IS NOT NULL THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cached_tokens), 0) AS cached_tokens
         FROM calls WHERE started_at >= ?
         GROUP BY COALESCE(caller, 'rei'), provider
         ORDER BY 1, 2`,
      )
      .all(sinceMs) as unknown as {
      caller: string;
      provider: string | null;
      calls: number;
      ok: number;
      limited: number;
      errors: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
    }[];
    return rows.map((r) => ({
      caller: r.caller,
      provider: r.provider,
      calls: Number(r.calls),
      ok: Number(r.ok),
      upstreamLimited: Number(r.limited),
      errors: Number(r.errors),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cachedInputTokens: Number(r.cached_tokens),
    }));
  }

  /** When each caller's newest row started. */
  lastUsed(): Map<string, number> {
    const rows = this.#db
      .prepare("SELECT COALESCE(caller, 'rei') AS caller, MAX(started_at) AS at FROM calls GROUP BY 1")
      .all() as unknown as { caller: string; at: number }[];
    return new Map(rows.map((r) => [r.caller, Number(r.at)]));
  }

  count(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM calls").get() as { n: number | bigint }).n);
  }

  /** Drops rows older than the age limit, and each caller's rows beyond the row limit (oldest first). */
  prune(): void {
    this.#sincePrune = 0;
    this.#db.prepare("DELETE FROM calls WHERE started_at < ?").run(this.#now() - this.#maxAgeMs);
    const callers = this.#db
      .prepare("SELECT COALESCE(caller, 'rei') AS caller, COUNT(*) AS n FROM calls GROUP BY 1")
      .all() as unknown as { caller: string; n: number | bigint }[];
    for (const { caller, n } of callers) {
      if (Number(n) <= this.#maxRows) continue;
      this.#db
        .prepare(
          `DELETE FROM calls WHERE COALESCE(caller, 'rei') = ? AND id <= (
             SELECT id FROM calls WHERE COALESCE(caller, 'rei') = ? ORDER BY id DESC LIMIT 1 OFFSET ?
           )`,
        )
        .run(caller, caller, this.#maxRows);
    }
  }

  close(): void {
    this.#db.close();
  }

  #rows(rows: unknown[]): GatewayCallRecord[] {
    return (rows as unknown as Row[]).map((r) => ({
      caller: r.caller ?? "rei",
      provider: r.provider ?? null,
      stepId: r.step_id,
      model: r.model,
      startedAt: r.started_at,
      firstByteMs: r.first_byte_ms,
      totalMs: r.total_ms,
      status: r.status,
      usage:
        r.input_tokens === null
          ? null
          : {
              inputTokens: r.input_tokens,
              outputTokens: r.output_tokens ?? 0,
              cachedInputTokens: r.cached_tokens ?? 0,
            },
      limit:
        r.limit_code === null
          ? null
          : {
              resetsInSeconds: r.limit_resets_s,
              code: r.limit_code,
              headers: JSON.parse(r.limit_headers ?? "{}") as Record<string, string>,
            },
      error: r.error_code === null ? null : { code: r.error_code },
    }));
  }
}
