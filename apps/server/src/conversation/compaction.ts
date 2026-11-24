// Manual compaction (`/compact`): a Rei-owned action on a session's conversation, not a message and not a run.
//
// Pi's `Conversation.compact()` returns a task id and takes no request id, and it cannot join a Rei commit, so Rei writes
// its intent first (a `manual_compactions` row), asks Pi, then links the task id. A crash between the two leaves a row
// with no task: it is reported as `unknown_after_restart` and never retried, because the task may have started. The user
// asks again with a new request id. A finished task is not a visible compaction: the task may hand back a write
// submission whose summary is placed now, later, or never (stale); only a placed summary is `applied`.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type SubmissionRecord } from "@earendil-works/pi-durable";
import { COMPACT_INSTRUCTIONS_MAX, type CompactResponse, type ManualCompactionStatus } from "@rei/protocol";
import type { OpenTree, TreeManager } from "../pi/trees.ts";
import {
  isTerminalCompaction,
  type ManualCompactionRow,
  type ManualCompactionStore,
} from "../store/manual-compactions.ts";
import type { AppStore } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import { HttpError, notFound } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { inputDigest } from "./ledger.ts";

export interface ManualCompactionsDeps {
  store: AppStore;
  trees: TreeManager;
  clock: Clock;
  log: Logger;
  /** Writes a data-only line into the transcript (the user's record of how a request ended). */
  notice: (sessionId: string, text: string) => Promise<void>;
  /** Delivers admissions that waited for the compaction to end (triggers, reports, notes). */
  kick: () => void;
}

const POLL_MS = 400;

/** Plain words for each way a request ends without a summary placed; the transcript keeps this line. */
const OUTCOME_TEXT: Partial<Record<ManualCompactionStatus, string>> = {
  no_change: "Nothing to compact: the conversation is already short enough to keep as it is.",
  stale: "Compaction finished, but a newer summary had already replaced this one, so it was not applied.",
  unknown_after_restart:
    "Rei restarted while a compaction was being requested and cannot tell whether it started. Run /compact again if you still want one.",
};

export class ManualCompactions {
  readonly #d: ManualCompactionsDeps;
  /** Requests between their intent row and the task link in this process: not a crash gap. */
  readonly #linking = new Set<string>();
  readonly #tracking = new Set<string>();
  #stopped = false;

  constructor(deps: ManualCompactionsDeps) {
    this.#d = deps;
  }

  get #rows(): ManualCompactionStore {
    return this.#d.store.manualCompactions;
  }

  stop(): void {
    this.#stopped = true;
  }

  /** Whether a manual compaction of this session has not ended (the send barrier). */
  active(sessionId: string): boolean {
    return this.#rows.open(sessionId).length > 0;
  }

  /** The response a request's row stands for. */
  #response(row: ManualCompactionRow): CompactResponse {
    return {
      requestId: row.request_id,
      status: row.status,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.error_code ? { error: { code: row.error_code, message: row.error_message ?? "" } } : {}),
    };
  }

  /** The newest request that is open, for the session view. */
  live(sessionId: string): { requestId: string; status: ManualCompactionStatus; error?: string } | undefined {
    const row = this.#rows.open(sessionId).at(-1);
    return row
      ? { requestId: row.request_id, status: row.status, ...(row.error_message ? { error: row.error_message } : {}) }
      : undefined;
  }

  status(sessionId: string, requestId: string): CompactResponse {
    const row = this.#rows.get(sessionId, requestId);
    if (!row) throw notFound("That compaction request does not exist.");
    return this.#response(row);
  }

  /**
   * Starts a manual compaction, once per request id. A repeat returns the request's current status. Refused with 409
   * "busy" while a run of the session is active or queued, a compaction (manual or automatic) is in progress, or Rei
   * cannot tell whether an earlier request started.
   */
  async request(sessionId: string, requestId: string, instructions: string | undefined): Promise<CompactResponse> {
    const { store, trees } = this.#d;
    const known = this.#rows.get(sessionId, requestId);
    if (known) return this.#response(known);
    const text = instructions?.trim() || undefined;
    if (text !== undefined && Array.from(text).length > COMPACT_INSTRUCTIONS_MAX)
      throw new HttpError(
        413,
        "too_long",
        `Compaction guidance can be at most ${COMPACT_INSTRUCTIONS_MAX} characters.`,
      );
    const row = store.getSessionRow(sessionId);
    if (!row) throw notFound("That session does not exist.");
    const tree = await trees.open(row.tree_id);
    return tree.serial(async () => {
      const again = this.#rows.get(sessionId, requestId);
      if (again) return this.#response(again);
      const ts = tree.session(sessionId);
      if (!ts) throw notFound("That session does not exist.");
      this.#assertIdle(sessionId);
      if (await this.#automaticRunning(tree, sessionId))
        throw new HttpError(409, "busy", "The conversation is already being compacted.");
      const key = `${sessionId}:${requestId}`;
      // The intent first: if the process dies before the task id is linked, the request is "unknown", never repeated.
      this.#linking.add(key);
      this.#rows.insert(sessionId, requestId, inputDigest(text ?? ""));
      try {
        const task = await ts.conv.compact(text, BACKGROUND_CONTEXT);
        this.#rows.update(sessionId, requestId, { status: "running", taskId: String(task) });
        this.#track(tree, sessionId, requestId, String(task));
      } catch (error) {
        this.#d.log.error("compaction.start_failed", { error: error instanceof Error ? error.name : "error" });
        this.#fail(sessionId, requestId, "compaction_failed", "Compaction could not be started.");
      } finally {
        this.#linking.delete(key);
      }
      return this.#response(this.#rows.get(sessionId, requestId)!);
    });
  }

  #assertIdle(sessionId: string): void {
    const { store } = this.#d;
    if (this.#rows.open(sessionId).length > 0)
      throw new HttpError(409, "busy", "A compaction is already in progress. Wait for it to finish.");
    if (store.nonTerminalRuns(sessionId).length > 0)
      throw new HttpError(409, "busy", "The chat is busy. Wait for the reply to finish, then try /compact again.");
  }

  /** An automatic (threshold or overflow) compaction of the conversation is running: never start a second summary. */
  async #automaticRunning(tree: OpenTree, sessionId: string): Promise<boolean> {
    const ts = tree.session(sessionId);
    if (!ts) return false;
    // The document is only valid inside the commit: read what is needed there.
    return ts.conv.commit(async (tx) => {
      const live = (await tx.doc(LiveDoc, ts.conv.id)) as { compactions?: readonly unknown[] };
      return (live.compactions?.length ?? 0) > 0;
    }, BACKGROUND_CONTEXT);
  }

  #fail(sessionId: string, requestId: string, code: string, message: string): void {
    this.#rows.update(sessionId, requestId, { status: "failed", error: { code, message } });
    void this.#d.notice(sessionId, `Compaction failed: ${message}`).catch(() => undefined);
    this.#d.kick();
  }

  #end(sessionId: string, requestId: string, status: ManualCompactionStatus): void {
    this.#rows.update(sessionId, requestId, { status });
    const text = OUTCOME_TEXT[status];
    if (text) void this.#d.notice(sessionId, text).catch(() => undefined);
    this.#d.kick();
  }

  /**
   * After a restart: every request still open is picked up again. One with a task id is followed to its end; one with
   * none may or may not have started, so it ends as `unknown_after_restart` and is not repeated.
   */
  async recover(sessionId?: string): Promise<void> {
    for (const row of this.#rows.open(sessionId)) {
      const key = `${row.session_id}:${row.request_id}`;
      if (this.#linking.has(key) || this.#tracking.has(key)) continue;
      if (!row.task_id) {
        this.#end(row.session_id, row.request_id, "unknown_after_restart");
        continue;
      }
      const session = this.#d.store.getSessionRow(row.session_id);
      if (!session) continue;
      try {
        const tree = await this.#d.trees.open(session.tree_id);
        this.#track(tree, row.session_id, row.request_id, row.task_id);
      } catch (error) {
        this.#d.log.error("compaction.recover_failed", { error: error instanceof Error ? error.name : "error" });
      }
    }
  }

  /** Follows a task, then the write submission it produced, until the request has a final status. */
  #track(tree: OpenTree, sessionId: string, requestId: string, taskId: string): void {
    const key = `${sessionId}:${requestId}`;
    if (this.#tracking.has(key)) return;
    this.#tracking.add(key);
    void (async () => {
      try {
        while (!this.#stopped) {
          const row = this.#rows.get(sessionId, requestId);
          if (!row || isTerminalCompaction(row.status) || !this.#d.store.getSessionRow(sessionId)) return;
          const next = await this.#step(tree, sessionId, requestId, taskId, row);
          if (next === "done") return;
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } catch (error) {
        this.#d.log.error("compaction.track_failed", { error: error instanceof Error ? error.name : "error" });
        if (!this.#stopped && this.#d.store.getSessionRow(sessionId))
          this.#fail(sessionId, requestId, "compaction_failed", "Compaction could not be followed to its end.");
      } finally {
        this.#tracking.delete(key);
      }
    })();
  }

  async #step(
    tree: OpenTree,
    sessionId: string,
    requestId: string,
    taskId: string,
    row: ManualCompactionRow,
  ): Promise<"again" | "done"> {
    const record = await tree.harness.getTask(Number(taskId) as never, BACKGROUND_CONTEXT);
    if (!record) {
      this.#fail(sessionId, requestId, "compaction_failed", "The compaction task is gone.");
      return "done";
    }
    const state = record.state;
    if (state.status !== "terminal" && state.status !== "completing") return "again";
    const outcome = state.outcome as {
      status: string;
      result?: { entryId?: unknown; submissionId?: unknown };
      error?: { message?: string };
    };
    if (outcome.status === "failed" || outcome.status === "orphaned") {
      this.#fail(sessionId, requestId, "compaction_failed", "The model could not summarize the conversation.");
      return "done";
    }
    if (outcome.status === "aborted") {
      this.#fail(sessionId, requestId, "compaction_aborted", "The compaction was stopped before it finished.");
      return "done";
    }
    const result = outcome.result ?? {};
    // A blocking summary's entry exists already.
    if (result.entryId !== undefined) {
      this.#end(sessionId, requestId, "applied");
      return "done";
    }
    if (result.submissionId === undefined) {
      this.#end(sessionId, requestId, "no_change");
      return "done";
    }
    // A conversation-owned summary is a write submission: queued, placed (applied) or stale.
    const submission = await tree.harness.submission(result.submissionId as never, BACKGROUND_CONTEXT);
    if (!submission) {
      this.#fail(sessionId, requestId, "compaction_failed", "The summary could not be found.");
      return "done";
    }
    const settled: SubmissionRecord = await submission.status(BACKGROUND_CONTEXT);
    if (settled.status === "done") {
      this.#end(sessionId, requestId, "applied");
      return "done";
    }
    if (settled.status === "unanswered") {
      this.#end(sessionId, requestId, "stale");
      return "done";
    }
    if (row.status !== "pending_placement")
      this.#rows.update(sessionId, requestId, {
        status: "pending_placement",
        submissionId: String(result.submissionId),
      });
    return "again";
  }
}
