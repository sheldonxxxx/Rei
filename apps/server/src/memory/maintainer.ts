// A small immediate cadence worker. SQLite rows are only progress/idempotency/audit, never staged memory candidates.
// Optional (Settings > Memory): off by default, because each review is a model call on the agent's own model. The agent's
// memory tools work either way; this only decides whether completed chats are reviewed in the background.
import type { FinishedInput } from "../store/store.ts";
import type { Logger } from "../util/log.ts";
import { looksSecret } from "./guard.ts";
import { reviewCandidate, reviewSource } from "./review-source.ts";
import { type ReviewerDeps, type ReviewJob, type ReviewOutcome, runMemoryReview } from "./reviewer.ts";

export const MEMORY_REVIEW_EVERY = 5;
/** The meta row that holds the setting: "1" on; absent or any other value off. */
export const MEMORY_EXTRACTION_KEY = "memory_extraction";
const MAX_PENDING = 16;
const MAX_ACTIVE = 2;
interface Deps extends ReviewerDeps {
  log: Logger;
  cadence?: number;
  review?: typeof runMemoryReview;
}
export class MemoryMaintainer {
  readonly #d: Deps;
  readonly #active = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  #unsubscribe: (() => void) | undefined;
  #stopped = true;

  constructor(deps: Deps) {
    this.#d = deps;
    if (!Number.isInteger(deps.cadence ?? MEMORY_REVIEW_EVERY) || (deps.cadence ?? MEMORY_REVIEW_EVERY) < 1)
      throw new Error("Invalid memory review cadence");
  }
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const { store } = this.#d;
    // Start from the current turn cursor; subsequent starts catch up completed turns.
    if (store.metaGet("memory_review_started_at") === undefined)
      store.metaSet("memory_review_started_at", String(store.clock.now()));
    store.db.run(
      "UPDATE memory_review_jobs SET status = 'failed', diagnostic = 'INTERRUPTED', finished_at = ? WHERE status = 'running'",
      store.clock.now(),
    );
    // Turns are counted as they settle (a run that ended while the server was down settles when its tree reopens).
    this.#unsubscribe = store.addRunFinishedListener((id, input) => this.completed(id, input));
    this.#pump();
  }
  /** Whether completed chats are reviewed in the background (Settings > Memory). Off unless someone turned it on. */
  enabled(): boolean {
    return this.#d.store.metaGet(MEMORY_EXTRACTION_KEY) === "1";
  }
  /**
   * Turning it on reviews chats completed from now on: earlier chats are not backfilled, since each review costs tokens.
   * Turning it off drops reviews still waiting and stops the running ones; their sources stay as they were.
   */
  setEnabled(on: boolean): void {
    const { store } = this.#d;
    // Saving the current value again changes nothing, so turns already counted toward the next review keep counting.
    if (on === this.enabled()) return;
    store.tx(() => {
      store.metaSet(MEMORY_EXTRACTION_KEY, on ? "1" : "0");
      if (on) store.metaSet("memory_review_started_at", String(store.clock.now()));
      else {
        store.db.run(
          "UPDATE memory_review_jobs SET status = 'skipped', diagnostic = 'DISABLED', finished_at = ? WHERE status = 'queued'",
          store.clock.now(),
        );
        // Turns counted but not yet in a review are retired, so turning it back on does not mix them into its first one.
        store.db.run("UPDATE memory_review_turns SET job_id = 'disabled' WHERE job_id IS NULL");
      }
    });
    if (!on) for (const active of this.#active.values()) active.abort.abort();
  }
  completed(runId: string, input: FinishedInput): void {
    if (this.#stopped || !this.enabled()) return;
    const { store } = this.#d;
    try {
      const run = store.getRun(runId);
      const source = reviewCandidate(store, run, input);
      if (!source || !run) return;
      if ((run.ended_at ?? store.clock.now()) < Number(store.metaGet("memory_review_started_at"))) return;
      store.tx(() => {
        const inserted = store.db.run(
          "INSERT OR IGNORE INTO memory_review_turns (message_id, run_id, agent_id, session_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          source.id,
          runId,
          source.agentId,
          source.sessionId,
          source.text,
          source.createdAt,
        ).changes;
        if (!inserted) return;
        const turns = store.db.all<{ message_id: string }>(
          "SELECT message_id FROM memory_review_turns WHERE agent_id = ? AND job_id IS NULL ORDER BY seq LIMIT ?",
          source.agentId,
          this.#d.cadence ?? MEMORY_REVIEW_EVERY,
        );
        if (turns.length < (this.#d.cadence ?? MEMORY_REVIEW_EVERY)) return;
        const full =
          store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_review_jobs WHERE status = 'queued'")!.n >=
            MAX_PENDING ||
          store.db.get("SELECT 1 FROM memory_review_jobs WHERE agent_id = ? AND status = 'queued'", source.agentId) !==
            undefined;
        store.db.run(
          "INSERT INTO memory_review_jobs (source_run_id, agent_id, source_ids, memory_revision, status, created_at, finished_at, diagnostic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          runId,
          source.agentId,
          JSON.stringify(turns.map((t) => t.message_id)),
          this.#d.lines.revision(),
          full ? "skipped" : "queued",
          store.clock.now(),
          full ? store.clock.now() : null,
          full ? "QUEUE_FULL" : null,
        );
        for (const t of turns)
          store.db.run("UPDATE memory_review_turns SET job_id = ? WHERE message_id = ?", runId, t.message_id);
      });
      this.#pump();
    } catch {
      this.#d.log.warn("memory.review_schedule_failed", { runId });
    }
  }
  #pump(): void {
    if (this.#stopped || !this.enabled()) return;
    const { store } = this.#d;
    const queued = store.db.all<ReviewJob>(
      "SELECT * FROM memory_review_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT ?",
      MAX_PENDING,
    );
    for (const job of queued) {
      if (this.#active.size >= MAX_ACTIVE) break;
      if (this.#active.has(job.agent_id)) continue;
      const claimed = store.db.run(
        "UPDATE memory_review_jobs SET status = 'running' WHERE source_run_id = ? AND status = 'queued'",
        job.source_run_id,
      ).changes;
      if (!claimed) continue;
      const abort = new AbortController();
      // Run asynchronously, immediately after completion; never await it in the user run's response path.
      const promise = Promise.resolve()
        .then(() => this.#run(job, abort.signal))
        .finally(() => {
          this.#active.delete(job.agent_id);
          this.#pump();
        });
      this.#active.set(job.agent_id, { promise, abort });
    }
  }
  async #run(job: ReviewJob, signal: AbortSignal): Promise<void> {
    const { store } = this.#d;
    let result: ReviewOutcome;
    try {
      const ids = JSON.parse(job.source_ids) as string[];
      const sources = ids.flatMap((id) => {
        const row = store.db.get<{ run_id: string }>(
          "SELECT run_id FROM memory_review_turns WHERE message_id = ? AND job_id = ?",
          id,
          job.source_run_id,
        );
        const source = row ? reviewSource(store, row.run_id) : undefined;
        return source && !looksSecret(source.text) ? [source] : [];
      });
      if (signal.aborted) result = { status: "failed", diagnostic: "STOPPED" };
      else if (this.#d.lines.revision() !== job.memory_revision)
        result = { status: "failed", diagnostic: "CAS_CONFLICT" };
      else if (sources.length === 0) result = { status: "skipped", diagnostic: "NO_TRUSTED_SOURCE" };
      else
        result = await (this.#d.review ?? runMemoryReview)(
          this.#d,
          job,
          {
            agentId: job.agent_id,
            revision: job.memory_revision,
            sources,
            jobId: job.source_run_id,
          },
          signal,
        );
    } catch {
      result = { status: "failed", diagnostic: signal.aborted ? "STOPPED" : "REVIEW_FAILED" };
    }
    // Accepted writes and the done marker already committed together. Never overwrite that durable result.
    store.db.run(
      "UPDATE memory_review_jobs SET status = ?, finished_at = ?, diagnostic = ? WHERE source_run_id = ? AND status = 'running'",
      result.status,
      store.clock.now(),
      result.diagnostic ?? null,
      job.source_run_id,
    );
    if (result.status !== "done")
      this.#d.log.info("memory.review_finished", {
        runId: job.source_run_id,
        status: result.status,
        diagnostic: result.diagnostic ?? null,
      });
  }
  async settle(): Promise<void> {
    while (this.#active.size > 0) await Promise.allSettled([...this.#active.values()].map((a) => a.promise));
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const active of this.#active.values()) active.abort.abort();
    await this.settle();
  }
}
