import type { ImageFailureReason, ImageUsageResponse } from "@rei/protocol";
import type { Db } from "../db/db.ts";

const day = (n: number) => new Date(n).toISOString().slice(0, 10);
const REASONS: readonly ImageFailureReason[] = ["rate_limited", "busy", "sign_in_required", "error"];

/** Counters only: how many requests, how they ended and how long they took. Never a prompt or an image. */
export function recordImageUsage(
  db: Db,
  now: number,
  request: { edit: boolean; ms: number; failure?: ImageFailureReason },
): void {
  db.run(
    `INSERT INTO image_usage (day, kind, outcome, reason, calls, total_ms) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT (day, kind, outcome, reason) DO UPDATE SET calls = calls + 1, total_ms = total_ms + excluded.total_ms`,
    day(now),
    request.edit ? "edit" : "generate",
    request.failure ? "failed" : "succeeded",
    request.failure ?? "",
    Math.max(0, Math.round(request.ms) || 0),
  );
}

export function readImageUsage(db: Db, from: string, to: string): ImageUsageResponse {
  const rows = db.all<{ kind: string; outcome: string; reason: string; calls: number; total_ms: number }>(
    `SELECT kind, outcome, reason, SUM(calls) AS calls, SUM(total_ms) AS total_ms
     FROM image_usage WHERE day >= ? AND day <= ? GROUP BY kind, outcome, reason`,
    from,
    to,
  );
  const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((n, r) => n + r.calls, 0);
  const succeeded = sum((r) => r.outcome === "succeeded");
  const succeededMs = rows.filter((r) => r.outcome === "succeeded").reduce((n, r) => n + r.total_ms, 0);
  return {
    requests: sum(() => true),
    succeeded,
    failed: sum((r) => r.outcome === "failed"),
    generated: sum((r) => r.kind === "generate"),
    edited: sum((r) => r.kind === "edit"),
    averageMs: succeeded ? Math.round(succeededMs / succeeded) : null,
    failures: REASONS.map((reason) => ({
      reason,
      calls: sum((r) => r.outcome === "failed" && r.reason === reason),
    })).filter((f) => f.calls > 0),
  };
}
