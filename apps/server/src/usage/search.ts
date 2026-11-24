import {
  SEARCH_PROVIDER_IDS,
  type SearchAttemptOutcome,
  type SearchAttemptSummary,
  type SearchRequestOutcome,
  type SearchUsageResponse,
} from "@rei/protocol";
import type { Db } from "../db/db.ts";

const NAMES: Record<string, string> = {
  "codex-subscription": "ChatGPT / Codex",
  exa: "Exa",
  brave: "Brave",
  tavily: "Tavily",
  searxng: "SearXNG",
};
export const searchProviderName = (provider: string): string => NAMES[provider] ?? provider;
const day = (n: number) => new Date(n).toISOString().slice(0, 10);

/** Counters only. A provider counts as a fallback once an earlier provider was actually asked and did not answer. */
export function recordSearchUsage(
  db: Db,
  now: number,
  outcome: SearchRequestOutcome,
  attempts: SearchAttemptSummary[],
): void {
  const d = day(now);
  db.transaction(() => {
    let asked = false;
    for (const a of attempts) {
      const fallback = asked && a.status !== "skipped" ? 1 : 0;
      if (a.status !== "skipped") asked = true;
      db.run(
        `INSERT INTO search_usage_attempts (day, provider, outcome, reason, fallback, calls, total_ms)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (day, provider, outcome, reason, fallback)
         DO UPDATE SET calls = calls + 1, total_ms = total_ms + excluded.total_ms`,
        d,
        a.provider,
        a.status,
        a.reason ?? "",
        fallback,
        Math.max(0, Math.round(a.totalMs) || 0),
      );
    }
    const withFallback = attempts.filter((a) => a.status !== "skipped").length > 1 ? 1 : 0;
    db.run(
      `INSERT INTO search_usage_requests (day, outcome, with_fallback, calls) VALUES (?, ?, ?, 1)
       ON CONFLICT (day, outcome, with_fallback) DO UPDATE SET calls = calls + 1`,
      d,
      outcome,
      withFallback,
    );
  });
}

export function readSearchUsage(db: Db, from: string, to: string): SearchUsageResponse {
  const requests = db.all<{ outcome: SearchRequestOutcome; with_fallback: number; calls: number }>(
    "SELECT outcome, with_fallback, SUM(calls) AS calls FROM search_usage_requests WHERE day >= ? AND day <= ? GROUP BY outcome, with_fallback",
    from,
    to,
  );
  const count = (o: SearchRequestOutcome) => requests.filter((r) => r.outcome === o).reduce((n, r) => n + r.calls, 0);
  const rows = db.all<{
    provider: string;
    outcome: SearchAttemptOutcome;
    reason: string;
    fallback: number;
    calls: number;
    total_ms: number;
  }>(
    `SELECT provider, outcome, reason, fallback, SUM(calls) AS calls, SUM(total_ms) AS total_ms
     FROM search_usage_attempts WHERE day >= ? AND day <= ?
     GROUP BY provider, outcome, reason, fallback ORDER BY provider, outcome, reason, fallback`,
    from,
    to,
  );
  const order = (p: string) => {
    const i = (SEARCH_PROVIDER_IDS as readonly string[]).indexOf(p);
    return i < 0 ? SEARCH_PROVIDER_IDS.length : i;
  };
  const ids = [...new Set(rows.map((r) => r.provider))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return {
    searches: requests.reduce((n, r) => n + r.calls, 0),
    answered: count("answered"),
    empty: count("empty"),
    failed: count("failed"),
    searchesWithFallback: requests.filter((r) => r.with_fallback).reduce((n, r) => n + r.calls, 0),
    byProvider: ids.map((provider) => {
      const mine = rows.filter((r) => r.provider === provider);
      const sum = (f: (r: (typeof mine)[number]) => boolean) => mine.filter(f).reduce((n, r) => n + r.calls, 0);
      const reached = mine.filter((r) => r.outcome !== "skipped");
      const reachedCalls = reached.reduce((n, r) => n + r.calls, 0);
      return {
        provider,
        providerName: NAMES[provider] ?? provider,
        succeeded: sum((r) => r.outcome === "succeeded"),
        empty: sum((r) => r.outcome === "empty"),
        failed: sum((r) => r.outcome === "failed"),
        skipped: sum((r) => r.outcome === "skipped"),
        fallback: sum((r) => !!r.fallback),
        answeredAfterFallback: sum((r) => !!r.fallback && r.outcome === "succeeded"),
        averageMs: reachedCalls ? Math.round(reached.reduce((n, r) => n + r.total_ms, 0) / reachedCalls) : null,
        details: mine.map((r) => ({
          outcome: r.outcome,
          reason: r.reason || null,
          fallback: !!r.fallback,
          calls: r.calls,
        })),
      };
    }),
  };
}
