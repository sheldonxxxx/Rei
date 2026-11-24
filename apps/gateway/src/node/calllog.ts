// The gateway's own call store (node:sqlite). Keeps rows for at most `maxAgeMs`, and at most `maxRows` per caller, so
// one busy caller cannot push another's rows out.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type {
  GatewayCallRecord,
  GatewayCallsSummary,
  GatewayLimitCode,
  GatewayModelUsage,
  GatewayUsageCallerRow,
  GatewayUsageModelRow,
  GatewayUsageResponse,
} from "@rei/protocol";
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

type DailyKind = "model" | "search" | "embedding" | "read" | "mcp";

interface DailyRow {
  caller: string;
  kind: DailyKind;
  provider: string;
  model: string;
  calls: number;
  ok: number;
  errors: number;
  upstream_limited: number;
  calls_reported: number;
  calls_unreported: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  total_ms: number;
  timed_calls: number;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function classifyCall(
  provider: string | null,
  model: string | null,
): { kind: DailyKind; provider: string; model: string } {
  if (provider === "search") {
    return { kind: "search", provider: model?.startsWith("search:") ? model.slice(7) : "", model: "" };
  }
  if (provider === "embedding") return { kind: "embedding", provider: "embedding", model: model ?? "" };
  if (provider === "read") return { kind: "read", provider: "read", model: "" };
  if (provider === "mcp") return { kind: "mcp", provider: "mcp", model: "" };
  return { kind: "model", provider: provider ?? "unknown", model: model ?? "unknown" };
}

function summarizeModels(rows: readonly DailyRow[]): GatewayModelUsage {
  let calls = 0;
  let ok = 0;
  let errors = 0;
  let upstreamLimited = 0;
  let callsReported = 0;
  let callsUnreported = 0;
  let inputSum = 0;
  let cachedSum = 0;
  let outputSum = 0;
  for (const r of rows) {
    calls += Number(r.calls);
    ok += Number(r.ok);
    errors += Number(r.errors);
    upstreamLimited += Number(r.upstream_limited);
    callsReported += Number(r.calls_reported);
    callsUnreported += Number(r.calls_unreported);
    inputSum += Number(r.input_tokens);
    cachedSum += Number(r.cached_tokens);
    outputSum += Number(r.output_tokens);
  }
  const hasTokens = calls === 0 || callsReported > 0;
  const inputTotal = hasTokens ? inputSum : null;
  const inputCached = hasTokens ? cachedSum : null;
  const inputUncached = hasTokens ? Math.max(0, inputSum - cachedSum) : null;
  const outputTotal = hasTokens ? outputSum : null;
  const totalProcessed = hasTokens ? inputSum + outputSum : null;
  const cacheHitPercent = callsReported > 0 && inputSum > 0 ? (cachedSum / inputSum) * 100 : null;
  return {
    inputTotal,
    inputCached,
    inputUncached,
    outputTotal,
    totalProcessed,
    cacheHitPercent,
    calls,
    callsReported,
    callsUnreported,
    ok,
    errors,
    upstreamLimited,
  };
}

function avgMs(totalMs: number, timedCalls: number): number | null {
  return timedCalls > 0 ? Math.round(totalMs / timedCalls) : null;
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
   * Version 1 adds caller and provider to `calls`.
   * Version 2 adds permanent daily rollups (`usage_daily`, `refusals_daily`, `meta`) backfilled from `calls`.
   */
  #migrate(): void {
    const columns = new Set(
      (this.#db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map((c) => c.name),
    );
    if (columns.has("caller") && columns.has("provider")) {
      this.#db.exec("CREATE INDEX IF NOT EXISTS calls_caller_started ON calls (caller, started_at)");
    } else {
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

    const version = Number(
      (this.#db.prepare("PRAGMA user_version").get() as { user_version: number | bigint }).user_version,
    );
    if (version < 2) {
      this.#db.exec("BEGIN");
      try {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS usage_daily (
            day TEXT NOT NULL,
            caller TEXT NOT NULL,
            kind TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            calls INTEGER NOT NULL DEFAULT 0,
            ok INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            upstream_limited INTEGER NOT NULL DEFAULT 0,
            calls_reported INTEGER NOT NULL DEFAULT 0,
            calls_unreported INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            cached_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            total_ms INTEGER NOT NULL DEFAULT 0,
            timed_calls INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (day, caller, kind, provider, model)
          );
          CREATE INDEX IF NOT EXISTS usage_daily_caller_day ON usage_daily (caller, day);
          CREATE TABLE IF NOT EXISTS refusals_daily (
            day TEXT NOT NULL,
            caller TEXT NOT NULL,
            code TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (day, caller, code)
          );
          CREATE INDEX IF NOT EXISTS refusals_daily_caller_day ON refusals_daily (caller, day);
        `);
        const existing = this.#db
          .prepare(
            `SELECT caller, provider, model, started_at, total_ms, status,
                    input_tokens, output_tokens, cached_tokens, limit_code, error_code
             FROM calls`,
          )
          .all() as unknown as Row[];
        let earliest: number | null = null;
        for (const row of existing) {
          if (earliest === null || row.started_at < earliest) earliest = row.started_at;
          this.#upsertDaily({
            caller: row.caller ?? "rei",
            provider: row.provider ?? null,
            stepId: null,
            model: row.model,
            startedAt: row.started_at,
            firstByteMs: null,
            totalMs: row.total_ms,
            status: row.status,
            usage:
              row.input_tokens === null
                ? null
                : {
                    inputTokens: row.input_tokens,
                    outputTokens: row.output_tokens ?? 0,
                    cachedInputTokens: row.cached_tokens ?? 0,
                  },
            limit: row.limit_code === null ? null : { resetsInSeconds: null, code: row.limit_code, headers: {} },
            error: row.error_code === null ? null : { code: row.error_code },
          });
        }
        const since = new Date(earliest ?? this.#now()).toISOString();
        this.#db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('usage_tracking_since', ?)").run(since);
        this.#db.exec("PRAGMA user_version = 2; COMMIT;");
      } catch (cause) {
        this.#db.exec("ROLLBACK");
        throw cause;
      }
    }

    const afterV2 = Number(
      (this.#db.prepare("PRAGMA user_version").get() as { user_version: number | bigint }).user_version,
    );
    if (afterV2 < 3) {
      this.#db.exec("BEGIN");
      try {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS errors_daily (
            day TEXT NOT NULL,
            caller TEXT NOT NULL,
            code TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (day, caller, code)
          );
          CREATE INDEX IF NOT EXISTS errors_daily_caller_day ON errors_daily (caller, day);
        `);
        const failed = this.#db
          .prepare(
            `SELECT caller, provider, started_at, status, error_code
             FROM calls
             WHERE (status >= 400 OR error_code IS NOT NULL) AND COALESCE(provider, '') != 'mcp'`,
          )
          .all() as unknown as {
          caller: string | null;
          provider: string | null;
          started_at: number;
          status: number;
          error_code: string | null;
        }[];
        for (const row of failed) {
          this.#upsertErrorDaily(row.caller ?? "rei", row.error_code ?? `http_${row.status}`, row.started_at);
        }
        this.#db.exec("PRAGMA user_version = 3; COMMIT;");
      } catch (cause) {
        this.#db.exec("ROLLBACK");
        throw cause;
      }
    }
  }

  #upsertErrorDaily(caller: string, code: string, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO errors_daily (day, caller, code, count, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (day, caller, code) DO UPDATE SET
           count = count + 1,
           updated_at = MAX(updated_at, excluded.updated_at)`,
      )
      .run(utcDay(at), caller, code, at);
  }

  #upsertDaily(r: GatewayCallRecord): void {
    const { kind, provider, model } = classifyCall(r.provider, r.model);
    const day = utcDay(r.startedAt);
    const ok = r.status < 400 && r.error === null ? 1 : 0;
    const errors = r.status >= 400 || r.error !== null ? 1 : 0;
    const limited = r.limit !== null || r.status === 429 ? 1 : 0;
    const reported = r.usage !== null ? 1 : 0;
    const unreported = r.usage === null ? 1 : 0;
    const input = Math.max(0, r.usage?.inputTokens ?? 0);
    const cached = Math.min(input, Math.max(0, r.usage?.cachedInputTokens ?? 0));
    const output = Math.max(0, r.usage?.outputTokens ?? 0);
    const hasMs = r.totalMs !== null && r.totalMs >= 0;
    const ms = hasMs ? Math.round(r.totalMs!) : 0;
    const timed = hasMs ? 1 : 0;
    this.#db
      .prepare(
        `INSERT INTO usage_daily (
           day, caller, kind, provider, model,
           calls, ok, errors, upstream_limited, calls_reported, calls_unreported,
           input_tokens, cached_tokens, output_tokens, total_ms, timed_calls, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day, caller, kind, provider, model) DO UPDATE SET
           calls = calls + 1,
           ok = ok + excluded.ok,
           errors = errors + excluded.errors,
           upstream_limited = upstream_limited + excluded.upstream_limited,
           calls_reported = calls_reported + excluded.calls_reported,
           calls_unreported = calls_unreported + excluded.calls_unreported,
           input_tokens = input_tokens + excluded.input_tokens,
           cached_tokens = cached_tokens + excluded.cached_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           total_ms = total_ms + excluded.total_ms,
           timed_calls = timed_calls + excluded.timed_calls,
           updated_at = MAX(updated_at, excluded.updated_at)`,
      )
      .run(
        day,
        r.caller,
        kind,
        provider,
        model,
        ok,
        errors,
        limited,
        reported,
        unreported,
        input,
        cached,
        output,
        ms,
        timed,
        r.startedAt,
      );
  }

  insert(r: GatewayCallRecord): void {
    this.#db.exec("BEGIN");
    try {
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
      this.#upsertDaily(r);
      if ((r.status >= 400 || r.error !== null) && r.provider !== "mcp") {
        this.#upsertErrorDaily(r.caller, r.error?.code ?? `http_${r.status}`, r.startedAt);
      }
      this.#db.exec("COMMIT");
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
    if (++this.#sincePrune >= 1000) this.prune();
  }

  recordRefusal(caller: string, code: string, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO refusals_daily (day, caller, code, count, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (day, caller, code) DO UPDATE SET
           count = count + 1,
           updated_at = MAX(updated_at, excluded.updated_at)`,
      )
      .run(utcDay(at), caller, code, at);
  }

  trackingSince(): string {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'usage_tracking_since'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? new Date(this.#now()).toISOString();
  }

  usage(from: string, to: string, caller?: string): GatewayUsageResponse {
    const dailyRows = (caller === undefined
      ? this.#db
          .prepare(
            `SELECT caller, kind, provider, model,
                      SUM(calls) AS calls, SUM(ok) AS ok, SUM(errors) AS errors,
                      SUM(upstream_limited) AS upstream_limited,
                      SUM(calls_reported) AS calls_reported, SUM(calls_unreported) AS calls_unreported,
                      SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens,
                      SUM(output_tokens) AS output_tokens, SUM(total_ms) AS total_ms, SUM(timed_calls) AS timed_calls
               FROM usage_daily
               WHERE day >= ? AND day <= ? AND kind != 'mcp'
               GROUP BY caller, kind, provider, model`,
          )
          .all(from, to)
      : this.#db
          .prepare(
            `SELECT caller, kind, provider, model,
                      SUM(calls) AS calls, SUM(ok) AS ok, SUM(errors) AS errors,
                      SUM(upstream_limited) AS upstream_limited,
                      SUM(calls_reported) AS calls_reported, SUM(calls_unreported) AS calls_unreported,
                      SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens,
                      SUM(output_tokens) AS output_tokens, SUM(total_ms) AS total_ms, SUM(timed_calls) AS timed_calls
               FROM usage_daily
               WHERE day >= ? AND day <= ? AND caller = ? AND kind != 'mcp'
               GROUP BY caller, kind, provider, model`,
          )
          .all(from, to, caller)) as unknown as DailyRow[];

    const refusalRows = (caller === undefined
      ? this.#db
          .prepare(
            `SELECT caller, code, SUM(count) AS count
               FROM refusals_daily WHERE day >= ? AND day <= ?
               GROUP BY caller, code`,
          )
          .all(from, to)
      : this.#db
          .prepare(
            `SELECT caller, code, SUM(count) AS count
               FROM refusals_daily WHERE day >= ? AND day <= ? AND caller = ?
               GROUP BY caller, code`,
          )
          .all(from, to, caller)) as unknown as { caller: string; code: string; count: number }[];

    const errorRows = (caller === undefined
      ? this.#db
          .prepare(
            `SELECT code, SUM(count) AS count
               FROM errors_daily WHERE day >= ? AND day <= ?
               GROUP BY code`,
          )
          .all(from, to)
      : this.#db
          .prepare(
            `SELECT code, SUM(count) AS count
               FROM errors_daily WHERE day >= ? AND day <= ? AND caller = ?
               GROUP BY code`,
          )
          .all(from, to, caller)) as unknown as { code: string; count: number }[];

    const modelRows = dailyRows.filter((r) => r.kind === "model");
    const byModelBuckets = new Map<string, DailyRow[]>();
    for (const r of modelRows) {
      const k = `${r.provider}\0${r.model}`;
      const list = byModelBuckets.get(k) ?? [];
      list.push(r);
      byModelBuckets.set(k, list);
    }
    const byModel: GatewayUsageModelRow[] = [...byModelBuckets.values()]
      .map((rs) => ({
        provider: rs[0]!.provider,
        model: rs[0]!.model,
        ...summarizeModels(rs),
      }))
      .sort(
        (a, b) =>
          b.calls - a.calls ||
          (b.inputTotal ?? -1) - (a.inputTotal ?? -1) ||
          a.provider.localeCompare(b.provider) ||
          a.model.localeCompare(b.model),
      );

    const searchRows = dailyRows.filter((r) => r.kind === "search");
    const searchProviders = new Map<
      string,
      { calls: number; ok: number; errors: number; totalMs: number; timedCalls: number }
    >();
    let searchCalls = 0;
    let searchOk = 0;
    let searchErrors = 0;
    let searchMs = 0;
    let searchTimed = 0;
    for (const r of searchRows) {
      const c = Number(r.calls);
      const o = Number(r.ok);
      const e = Number(r.errors);
      const ms = Number(r.total_ms);
      const tc = Number(r.timed_calls);
      searchCalls += c;
      searchOk += o;
      searchErrors += e;
      searchMs += ms;
      searchTimed += tc;
      if (r.provider) {
        const cur = searchProviders.get(r.provider) ?? { calls: 0, ok: 0, errors: 0, totalMs: 0, timedCalls: 0 };
        cur.calls += c;
        cur.ok += o;
        cur.errors += e;
        cur.totalMs += ms;
        cur.timedCalls += tc;
        searchProviders.set(r.provider, cur);
      }
    }

    const embedRows = dailyRows.filter((r) => r.kind === "embedding");
    const embedCalls = embedRows.reduce((n, r) => n + Number(r.calls), 0);
    const embedReported = embedRows.reduce((n, r) => n + Number(r.calls_reported), 0);
    const embedTokens = embedRows.reduce((n, r) => n + Number(r.input_tokens), 0);
    const embedMs = embedRows.reduce((n, r) => n + Number(r.total_ms), 0);
    const embedTimed = embedRows.reduce((n, r) => n + Number(r.timed_calls), 0);

    const readRows = dailyRows.filter((r) => r.kind === "read");
    const readCalls = readRows.reduce((n, r) => n + Number(r.calls), 0);
    const readMs = readRows.reduce((n, r) => n + Number(r.total_ms), 0);
    const readTimed = readRows.reduce((n, r) => n + Number(r.timed_calls), 0);

    const refusalTotals = new Map<string, number>();
    for (const r of refusalRows) {
      refusalTotals.set(r.code, (refusalTotals.get(r.code) ?? 0) + Number(r.count));
    }
    const refusals = [...refusalTotals.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

    let byCaller: GatewayUsageCallerRow[] = [];
    if (caller === undefined) {
      const callerIds = new Set<string>([...dailyRows.map((r) => r.caller), ...refusalRows.map((r) => r.caller)]);
      byCaller = [...callerIds]
        .map((id) => {
          const mine = dailyRows.filter((r) => r.caller === id);
          const myModels = summarizeModels(mine.filter((r) => r.kind === "model"));
          const myRefusals = refusalRows.filter((r) => r.caller === id).reduce((n, r) => n + Number(r.count), 0);
          return {
            caller: id,
            inputTotal: myModels.inputTotal,
            inputCached: myModels.inputCached,
            outputTotal: myModels.outputTotal,
            modelCalls: myModels.calls,
            searchCalls: mine.filter((r) => r.kind === "search").reduce((n, r) => n + Number(r.calls), 0),
            embeddingCalls: mine.filter((r) => r.kind === "embedding").reduce((n, r) => n + Number(r.calls), 0),
            readCalls: mine.filter((r) => r.kind === "read").reduce((n, r) => n + Number(r.calls), 0),
            errors: mine.reduce((n, r) => n + Number(r.errors), 0),
            upstreamLimited: mine.reduce((n, r) => n + Number(r.upstream_limited), 0),
            refusals: myRefusals,
          };
        })
        .sort(
          (a, b) =>
            b.modelCalls - a.modelCalls ||
            b.searchCalls + b.embeddingCalls + b.readCalls - (a.searchCalls + a.embeddingCalls + a.readCalls) ||
            a.caller.localeCompare(b.caller),
        );
    }

    return {
      trackingSince: this.trackingSince(),
      from,
      to,
      caller: caller ?? null,
      models: {
        summary: summarizeModels(modelRows),
        byModel,
      },
      byCaller,
      search: {
        calls: searchCalls,
        ok: searchOk,
        errors: searchErrors,
        averageMs: avgMs(searchMs, searchTimed),
        byProvider: [...searchProviders.entries()]
          .map(([provider, s]) => ({
            provider,
            calls: s.calls,
            ok: s.ok,
            errors: s.errors,
            averageMs: avgMs(s.totalMs, s.timedCalls),
          }))
          .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider)),
      },
      embeddings: {
        calls: embedCalls,
        ok: embedRows.reduce((n, r) => n + Number(r.ok), 0),
        errors: embedRows.reduce((n, r) => n + Number(r.errors), 0),
        inputTokens: embedCalls === 0 || embedReported > 0 ? embedTokens : null,
        averageMs: avgMs(embedMs, embedTimed),
      },
      reads: {
        calls: readCalls,
        ok: readRows.reduce((n, r) => n + Number(r.ok), 0),
        errors: readRows.reduce((n, r) => n + Number(r.errors), 0),
        averageMs: avgMs(readMs, readTimed),
      },
      refusals,
      errorBreakdown: errorRows
        .map((r) => ({ code: r.code, count: Number(r.count) }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    };
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

  /** When each caller's newest call started (survives pruning via daily rollups). */
  lastUsed(): Map<string, number> {
    const out = new Map<string, number>();
    const rows = this.#db
      .prepare(
        `SELECT caller, MAX(at) AS at FROM (
           SELECT COALESCE(caller, 'rei') AS caller, MAX(started_at) AS at FROM calls GROUP BY 1
           UNION ALL
           SELECT caller, MAX(updated_at) AS at FROM usage_daily GROUP BY 1
         ) GROUP BY caller`,
      )
      .all() as unknown as { caller: string; at: number }[];
    for (const r of rows) out.set(r.caller, Number(r.at));
    return out;
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

  /** An online, consistent copy of the database in `file` (SQLite's backup API), while the gateway keeps writing. */
  async backupTo(file: string): Promise<void> {
    await backup(this.#db, file);
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
