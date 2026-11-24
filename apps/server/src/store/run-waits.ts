// How long a run spent waiting for a person, which its time limit does not count: calls parked on an approval, and
// browser calls parked while the user controlled the window. Both come from SQLite rows, so a restart keeps them.

import { approvalWaitSpans } from "./approvals.ts";
import type { AppStore } from "./store.ts";

/** The browser's tools are the calls that park on a takeover (`browser_open`, `browser_click`, ...). */
const BROWSER_TOOLS = "browser\\_%";

/**
 * The spans a takeover held the run's browser calls: from the first call the takeover caught (or the takeover's own
 * start, when the call began earlier) to its end. One span per takeover, however many calls it caught. Takeovers still
 * open are left out: the limit is only asked between model calls, when nothing is parked.
 */
function takeoverWaitSpans(db: AppStore["db"], runId: string): [number, number][] {
  return db
    .all<{ asked: number; released: number }>(
      `SELECT MAX(t.started_at, MIN(s.started_at)) AS asked, t.ended_at AS released
       FROM steps s JOIN takeovers t ON t.session_id = s.session_id
       WHERE s.run_id = ? AND s.type = 'tool.call' AND s.tool_name LIKE ? ESCAPE '\\'
         AND t.started_at IS NOT NULL AND t.ended_at IS NOT NULL
         AND s.started_at < t.ended_at
         AND (s.status = 'running' OR s.started_at + COALESCE(s.latency_ms, 0) > t.started_at)
       GROUP BY t.id`,
      runId,
      BROWSER_TOOLS,
    )
    .map(({ asked, released }) => [asked, released]);
}

/** Milliseconds the run waited for a person, with time that two waits cover at once counted once. */
export function runWaitTime(db: AppStore["db"], runId: string): number {
  const spans = [...approvalWaitSpans(db, runId), ...takeoverWaitSpans(db, runId)]
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const [from, to] of spans) {
    total += Math.max(0, to - Math.max(from, end));
    end = Math.max(end, to);
  }
  return total;
}
