import type { RunRow } from "../conversation/runs.ts";
import type { AppStore, FinishedInput } from "../store/store.ts";
import type { ReviewSource } from "./review-types.ts";

/** A chat the memory review may learn from: one the user has, still there. */
const SOURCE_SESSION = `SELECT agent_id FROM sessions WHERE id = ? AND origin IN ('home', 'user', 'fork', 'import')
  AND deleted_at IS NULL AND status <> 'deleting'`;

/**
 * A turn the review may learn from, at completion: your own words typed in the chat (no tools, assistant or report text,
 * no messages from other sessions, automation or failed turns).
 */
export function reviewCandidate(
  store: AppStore,
  run: RunRow | undefined,
  input: FinishedInput,
): ReviewSource | undefined {
  if (run?.status !== "completed" || run.kind !== "input" || run.direct !== 1 || run.assigned_by !== null) return;
  if (run.trigger_run_id !== null || run.cancel_requested !== 0 || run.role !== "user" || input.role !== "user") return;
  if (input.fromSession) return;
  const session = store.db.get<{ agent_id: string }>(SOURCE_SESSION, run.session_id);
  if (!session) return;
  return {
    runId: run.id,
    id: run.user_message_id,
    sessionId: run.session_id,
    agentId: session.agent_id,
    text: input.text,
    createdAt: input.createdAt,
  };
}

/** A counted turn as the review reads it (its words were kept when it was counted), while its chat is still there. */
export function reviewSource(store: AppStore, runId: string): ReviewSource | undefined {
  const turn = store.db.get<{ message_id: string; session_id: string; text: string; created_at: number }>(
    "SELECT message_id, session_id, text, created_at FROM memory_review_turns WHERE run_id = ?",
    runId,
  );
  if (!turn) return undefined;
  const session = store.db.get<{ agent_id: string }>(SOURCE_SESSION, turn.session_id);
  if (!session) return undefined;
  return {
    runId,
    id: turn.message_id,
    sessionId: turn.session_id,
    agentId: session.agent_id,
    text: turn.text,
    createdAt: turn.created_at,
  };
}
