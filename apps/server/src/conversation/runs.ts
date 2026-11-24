// The runs of open trees, in memory. A run is one input (or continue) Rei submitted to Pi: Pi's submission record says
// where it stands, and the Rei command ledger (`rei.commands`) says what it is for. This registry answers the
// synchronous questions the rest of the server asks about runs (is a run going in this session, who assigned it, when
// did it start) without a second copy on disk: it is hydrated from Pi when a tree opens and kept current from Pi's
// commits. A closed tree has no unfinished run (trees close only when idle, and a tree with work is reopened at start).

import type { SubmissionRecord } from "@earendil-works/pi-durable";
import type { ErrorInfo, Run, RunStatus } from "@rei/protocol";
import { runFailureError } from "../pi/errors.ts";
import type { CommandRecord, InputRole } from "./ledger.ts";

export interface RunRow {
  id: string;
  tree_id: string;
  session_id: string;
  /** The client's request id (idempotency key). */
  request_id: string;
  status: RunStatus;
  error_code: string | null;
  error_message: string | null;
  /** The input's item id (`u:<runId>`). */
  user_message_id: string;
  /** The reply's item id (`a:<runId>`) once the run started. */
  assistant_message_id: string | null;
  pi_submission_id: string | null;
  cancel_requested: number;
  silent: number;
  assigned_by: string | null;
  direct: number;
  trigger_run_id: string | null;
  created_at: number;
  started_at: number;
  ended_at: number | null;
  /** What kind of input started the run. */
  role: InputRole;
  kind: "input" | "continue";
  /** The input's Pi entry, once placed. */
  entry_id: string | null;
  /** The answer's Pi entry, once done. */
  answer_entry_id: string | null;
  /** Rei has committed the settlement effects. */
  settled: boolean;
  /** The digest of the input's model text (see `inputDigest`). */
  input_digest: string | null;
  /** Queued in Rei's outbox, not yet admitted into Pi (an approval's or a trigger's input). */
  outbox?: true;
}

export const TERMINAL_RUN: readonly RunStatus[] = ["completed", "failed", "cancelled"];
export const isTerminal = (status: RunStatus): boolean => TERMINAL_RUN.includes(status);

export const userItemId = (runId: string): string => `u:${runId}`;
export const replyItemId = (runId: string): string => `a:${runId}`;
export const entryItemId = (entryId: string | number): string => `e:${entryId}`;
export const overlayItemId = (overlayId: string): string => `o:${overlayId}`;
/** The run an item id names (`u:`/`a:` items), if any. */
export const runOfItem = (itemId: string): string | undefined =>
  itemId.startsWith("u:") || itemId.startsWith("a:") ? itemId.slice(2) : undefined;

export const toRun = (r: RunRow): Run => ({
  id: r.id,
  sessionId: r.session_id,
  status: r.status,
  ...(r.error_code ? { error: { code: r.error_code, message: r.error_message ?? "" } } : {}),
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export const runError = (r: RunRow): ErrorInfo | undefined =>
  r.error_code ? { code: r.error_code, message: r.error_message ?? "" } : undefined;

export class RunRegistry {
  readonly #runs = new Map<string, RunRow>();
  readonly #bySession = new Map<string, Map<string, RunRow>>();
  readonly #listeners = new Set<(run: RunRow) => void>();

  get(id: string): RunRow | undefined {
    return this.#runs.get(id);
  }

  /** Adds or replaces a run (same id) and tells the listeners. */
  put(run: RunRow): RunRow {
    const previous = this.#runs.get(run.id);
    if (previous && previous.session_id !== run.session_id) this.#bySession.get(previous.session_id)?.delete(run.id);
    this.#runs.set(run.id, run);
    let session = this.#bySession.get(run.session_id);
    if (!session) {
      session = new Map();
      this.#bySession.set(run.session_id, session);
    }
    session.set(run.id, run);
    for (const listener of this.#listeners) {
      try {
        listener(run);
      } catch {
        // a listener cannot stop the registry
      }
    }
    return run;
  }

  update(id: string, patch: Partial<RunRow>): RunRow | undefined {
    const run = this.#runs.get(id);
    if (!run) return undefined;
    return this.put({ ...run, ...patch });
  }

  onChange(listener: (run: RunRow) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** A session's runs, oldest first. */
  forSession(sessionId: string): RunRow[] {
    return [...(this.#bySession.get(sessionId)?.values() ?? [])].sort(
      (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  byRequest(sessionId: string, requestId: string): RunRow | undefined {
    for (const run of this.#bySession.get(sessionId)?.values() ?? []) if (run.request_id === requestId) return run;
    return undefined;
  }

  bySubmission(submissionId: string): RunRow | undefined {
    for (const run of this.#runs.values()) if (run.pi_submission_id === submissionId) return run;
    return undefined;
  }

  /** Unfinished runs (queued or running), oldest first; of one session, or of every open tree. */
  nonTerminal(sessionId?: string): RunRow[] {
    const all = sessionId === undefined ? [...this.#runs.values()] : this.forSession(sessionId);
    return all
      .filter((r) => !isTerminal(r.status))
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Whether any run of the tree is unfinished or not yet settled by Rei. */
  hasWork(treeId: string): boolean {
    for (const run of this.#runs.values())
      if (run.tree_id === treeId && (!isTerminal(run.status) || !run.settled)) return true;
    return false;
  }

  /** Forgets a tree's runs (it closed, or it was deleted). */
  dropTree(treeId: string): void {
    for (const run of [...this.#runs.values()]) if (run.tree_id === treeId) this.#drop(run);
  }

  dropRun(runId: string): void {
    const run = this.#runs.get(runId);
    if (run) this.#drop(run);
  }

  dropSession(sessionId: string): void {
    for (const run of [...(this.#bySession.get(sessionId)?.values() ?? [])]) this.#drop(run);
  }

  #drop(run: RunRow): void {
    this.#runs.delete(run.id);
    const session = this.#bySession.get(run.session_id);
    session?.delete(run.id);
    if (session?.size === 0) this.#bySession.delete(run.session_id);
  }
}

/**
 * The run being answered now among a session's runs: the running one whose input was placed last. A steer joins the
 * running Pi run, so several inputs can be running at once; what the model writes from the steer on belongs to it.
 */
export function currentRun(runs: Iterable<RunRow>): RunRow | undefined {
  let best: RunRow | undefined;
  for (const run of runs) {
    if (run.status !== "running") continue;
    if (!best) {
      best = run;
      continue;
    }
    const at = run.entry_id === null ? -1 : Number(run.entry_id);
    const bestAt = best.entry_id === null ? -1 : Number(best.entry_id);
    if (
      at > bestAt ||
      (at === bestAt && (run.created_at > best.created_at || (run.created_at === best.created_at && run.id > best.id)))
    )
      best = run;
  }
  return best;
}

/** A run whose input waits in Rei's outbox for admission (it is queued until Pi has it). */
export function outboxRun(input: {
  runId: string;
  treeId: string;
  sessionId: string;
  requestId: string;
  role: InputRole;
  createdAt: number;
  assignedBy?: string;
  triggerRunId?: string;
}): RunRow {
  return {
    id: input.runId,
    tree_id: input.treeId,
    session_id: input.sessionId,
    request_id: input.requestId,
    status: "queued",
    error_code: null,
    error_message: null,
    user_message_id: userItemId(input.runId),
    assistant_message_id: null,
    pi_submission_id: null,
    cancel_requested: 0,
    silent: 0,
    assigned_by: input.assignedBy ?? null,
    direct: 0,
    trigger_run_id: input.triggerRunId ?? null,
    created_at: input.createdAt,
    started_at: input.createdAt,
    ended_at: null,
    role: input.role,
    kind: "input",
    entry_id: null,
    answer_entry_id: null,
    settled: false,
    input_digest: null,
    outbox: true,
  };
}

/** A run as Pi's submission record and the Rei ledger describe it. */
export function runFromRecords(input: {
  runId: string;
  treeId: string;
  sessionId: string;
  record: CommandRecord;
  submission: SubmissionRecord | undefined;
}): RunRow {
  const { runId, record: rec, submission: sub } = input;
  let status: RunStatus;
  let error: ErrorInfo | undefined;
  if (rec.error) {
    status = "failed";
    error = rec.error;
  } else if (rec.settled && rec.outcome) {
    status = rec.outcome;
    error = rec.failure;
  } else if (!sub || sub.status === "queued") status = "queued";
  else if (sub.status === "placed") status = "running";
  else if (sub.status === "done") status = "completed";
  else if ((sub.type === "input" || sub.type === "continue") && sub.status === "unanswered") {
    if (sub.reason === "aborted" || rec.cancelRequested) status = "cancelled";
    else {
      status = "failed";
      error = runFailureError(sub.reason, typeof sub.detail === "string" ? sub.detail : undefined);
    }
  } else status = "completed";
  const subEntry = sub && "entry" in sub && sub.entry !== undefined ? String(sub.entry) : null;
  const entry =
    subEntry ??
    (rec.entryId !== undefined
      ? String(rec.entryId)
      : rec.kind === "continue" && rec.afterEntry !== undefined
        ? String(rec.afterEntry)
        : null);
  const answer =
    sub && (sub.type === "input" || sub.type === "continue") && sub.status === "done"
      ? String(sub.answer)
      : rec.answerId !== undefined
        ? String(rec.answerId)
        : null;
  return {
    id: runId,
    tree_id: input.treeId,
    session_id: input.sessionId,
    request_id: rec.requestId,
    status,
    error_code: error?.code ?? null,
    error_message: error?.message ?? null,
    user_message_id: userItemId(runId),
    assistant_message_id: status === "queued" ? null : replyItemId(runId),
    pi_submission_id: sub ? String(sub.id) : rec.submissionId !== undefined ? String(rec.submissionId) : null,
    cancel_requested: rec.cancelRequested ? 1 : 0,
    silent: rec.silent ? 1 : 0,
    assigned_by: rec.assignedBy ?? null,
    direct: rec.direct ? 1 : 0,
    trigger_run_id: rec.triggerRunId ?? null,
    created_at: rec.createdAt,
    started_at: rec.startedAt ?? rec.createdAt,
    ended_at: isTerminal(status) ? (rec.endedAt ?? null) : null,
    role: rec.role,
    kind: rec.kind,
    entry_id: entry,
    answer_entry_id: answer,
    settled: rec.settled === true,
    input_digest: rec.inputDigest ?? null,
  };
}
