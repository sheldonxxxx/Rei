import {
  USAGE_METRICS,
  USAGE_PERIODS,
  USAGE_PURPOSES,
  type UsagePeriod,
  type UsageResponse,
  type UsageTotals,
} from "@rei/protocol";
import type { Db } from "../db/db.ts";
import { providerDisplayName } from "../providers/names.ts";
import { badRequest } from "../util/errors.ts";
import { COLUMNS } from "./accounting.ts";
import { readImageUsage } from "./images.ts";
import { readSearchUsage } from "./search.ts";

type Row = {
  day: string;
  purpose: string;
  provider: string;
  model: string;
  agent_id: string;
  calls_reported: number;
  calls_unreported: number;
} & Record<string, string | number>;
export const utcDay = (n: number) => new Date(n).toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A UTC calendar day as YYYY-MM-DD. Text that is not a real day (such as 2026-02-30) is rejected. */
export function parseUsageDay(value: string | undefined, name: string): string {
  const time = value && DAY.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (!value || !Number.isFinite(time) || utcDay(time) !== value)
    throw badRequest("bad_request", `${name} must be a date as YYYY-MM-DD.`);
  return value;
}

/** Validates period + custom range and computes the requested UTC date bounds before tracking-since clipping. */
export function resolveRequestedWindow(
  requested: string = "30d",
  now: number = Date.now(),
  range: UsageRange = {},
): { period: UsagePeriod; from: string | undefined; to: string; today: string } {
  if (!(USAGE_PERIODS as readonly string[]).includes(requested))
    throw badRequest("bad_request", "period must be today, 7d, 30d, month, year, all or custom.");
  const period = requested as UsagePeriod;
  const date = new Date(now);
  const today = utcDay(now);
  if (period === "custom") {
    const from = parseUsageDay(range.from, "from");
    let to = parseUsageDay(range.to, "to");
    if (to > today) to = today;
    if (from > to)
      throw badRequest(
        "bad_request",
        "A custom range must start on or before its end and include a day since tracking began.",
      );
    return { period, from, to, today };
  }
  if (range.from !== undefined || range.to !== undefined)
    throw badRequest("bad_request", "from and to are only used with the custom period.");
  if (period === "all") return { period, from: undefined, to: today, today };
  const start =
    period === "today"
      ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
      : period === "7d" || period === "30d"
        ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - (period === "7d" ? 6 : 29))
        : period === "month"
          ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
          : Date.UTC(date.getUTCFullYear(), 0, 1);
  return { period, from: utcDay(start), to: today, today };
}
function totals(rows: Row[]): UsageTotals {
  const callsReported = rows.reduce((n, r) => n + r.calls_reported, 0);
  const callsUnreported = rows.reduce((n, r) => n + r.calls_unreported, 0);
  const modelCalls = callsReported + callsUnreported;
  const unknown = {} as UsageTotals["unknown"];
  const tokens = {} as UsageTotals["tokens"];
  for (const m of USAGE_METRICS) {
    const known = rows.reduce((n, r) => n + Number(r[`${COLUMNS[m]}_known`]), 0);
    unknown[m] = modelCalls - known;
    tokens[m] = known || !modelCalls ? rows.reduce((n, r) => n + Number(r[COLUMNS[m]]), 0) : null;
  }
  // Only calls that reported both input and cached tokens; the rest are left out of both sides.
  const pairedInput = rows.reduce((n, r) => n + Number(r.cache_pair_input), 0);
  const pairedCached = rows.reduce((n, r) => n + Number(r.cache_pair_cached), 0);
  const cacheHitPercent = pairedInput > 0 ? (pairedCached / pairedInput) * 100 : null;
  return { tokens, unknown, modelCalls, callsReported, callsUnreported, cacheHitPercent };
}

/** Days for the custom period: an inclusive UTC range, clipped to the days since tracking began and to today. */
export interface UsageRange {
  from?: string | undefined;
  to?: string | undefined;
}

/** Fixed period inputs and one custom date range; all-time is bounded by installation and today. Reads counters only. */
export function readUsage(
  db: Db,
  requested: string = "30d",
  now: number = Date.now(),
  providerNames: Record<string, string> = {},
  range: UsageRange = {},
): UsageResponse {
  const installedAt = Number(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'installed_at'")!.value);
  const trackingSince = new Date(installedAt).toISOString();
  const trackingDay = utcDay(installedAt);
  const win = resolveRequestedWindow(requested, now, range);
  const period = win.period;
  const to = win.to;
  let from = win.from ?? trackingDay;
  if (from < trackingDay) from = trackingDay;
  if (from > to) {
    if (period === "custom")
      throw badRequest(
        "bad_request",
        "A custom range must start on or before its end and include a day since tracking began.",
      );
    from = to;
  }
  const rows = db.all<Row>(
    "SELECT * FROM usage_daily WHERE day >= ? AND day <= ? ORDER BY day, purpose, provider, model, agent_id",
    from,
    to,
  );
  const group = (key: (r: Row) => string) => {
    const buckets = new Map<string, Row[]>();
    for (const row of rows) {
      const k = key(row);
      const bucket = buckets.get(k) ?? [];
      bucket.push(row);
      buckets.set(k, bucket);
    }
    return [...buckets.values()];
  };
  return {
    period,
    timezone: "UTC",
    trackingSince,
    from,
    to,
    summary: totals(rows),
    byPurpose: USAGE_PURPOSES.map((purpose) => ({ purpose, usage: totals(rows.filter((r) => r.purpose === purpose)) })),
    byModel: group((r) => JSON.stringify([r.provider, r.model])).map((rs) => ({
      provider: rs[0]!.provider,
      providerName: providerDisplayName(providerNames, rs[0]!.provider),
      model: rs[0]!.model,
      usage: totals(rs),
    })),
    byAgent: group((r) => r.agent_id).map((rs) => ({ agentId: rs[0]!.agent_id || null, usage: totals(rs) })),
    daily: group((r) => r.day).map((rs) => ({ day: rs[0]!.day, usage: totals(rs) })),
    search: readSearchUsage(db, from, to),
    images: readImageUsage(db, from, to),
  };
}
