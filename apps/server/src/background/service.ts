import { GLOBAL_STREAM } from "../store/events.ts";
import type { AppStore } from "../store/store.ts";

export interface LifecycleEvent {
  id: string;
  kind: "run.completed" | "session.deleting" | "session.deleted";
  session_id: string;
  agent_id: string;
  run_id: string | null;
  cut_entry_id: string | null;
  input_entry_id: string | null;
  eligible: number;
  provider: string | null;
  model: string | null;
  created_at: number;
}
export interface BackgroundJob {
  id: string;
  kind: string;
  dedupe: string;
  session_id: string | null;
  agent_id: string;
  payload: string;
  status: string;
  attempt: number;
  fence: number;
  lease_until: number | null;
  retry_at: number;
  created_at: number;
  finished_at: number | null;
  diagnostic: string | null;
  result: string | null;
}
export interface TaskOutcome {
  status: "succeeded" | "no_changes" | "skipped";
  result?: unknown;
}
export interface TaskContext {
  signal: AbortSignal;
  /** Must be called in the same transaction as any feature side effect. */
  assertLive(): void;
  complete(outcome: TaskOutcome): void;
}
/** A task attempt that failed for a reason worth showing: `code` is a stable name, `detail` one short, secret-free line. */
export class TaskFailure extends Error {
  readonly detail: string | undefined;
  constructor(code: string, detail?: string) {
    super(code);
    this.detail = detail;
  }
}
export type TaskHandler = (job: BackgroundJob, context: TaskContext) => Promise<TaskOutcome>;

/** One executor for registered background work. Delivery acknowledges only committed handler effects. */
export class BackgroundTaskService {
  readonly subscribers = new Map<string, (event: LifecycleEvent) => void>();
  readonly handlers = new Map<string, TaskHandler>();
  readonly active = new Map<string, { abort: AbortController; promise: Promise<void>; fence: number }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = true;
  readonly store: AppStore;
  constructor(store: AppStore) {
    this.store = store;
  }
  subscribe(id: string, handler: (event: LifecycleEvent) => void): void {
    if (this.subscribers.has(id)) throw new Error("DUPLICATE_SUBSCRIBER");
    this.subscribers.set(id, handler);
  }
  register(kind: string, handler: TaskHandler): void {
    if (this.handlers.has(kind)) throw new Error("DUPLICATE_TASK_KIND");
    this.handlers.set(kind, handler);
  }
  enqueue(input: { kind: string; dedupe: string; sessionId: string; agentId: string; payload: unknown }): string {
    const existing = this.store.db.get<{ id: string }>("SELECT id FROM background_jobs WHERE dedupe = ?", input.dedupe);
    if (existing) return existing.id;
    const id = `bg_${crypto.randomUUID()}`;
    this.store.db.run(
      "INSERT INTO background_jobs(id,kind,dedupe,session_id,agent_id,payload,created_at) VALUES(?,?,?,?,?,?,?)",
      id,
      input.kind,
      input.dedupe,
      input.sessionId,
      input.agentId,
      JSON.stringify(input.payload),
      this.store.clock.now(),
    );
    this.store.events.append(GLOBAL_STREAM, { type: "background.changed" });
    return id;
  }
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.tick();
    this.#timer = setInterval(() => this.tick(), 250);
    this.#timer.unref?.();
  }
  tick(): void {
    if (this.#stopped) return;
    const { db, clock } = this.store;
    // A deletion fence is checked on every tick and again atomically at every feature commit.
    for (const [id, active] of this.active) {
      const job = db.get<BackgroundJob>("SELECT * FROM background_jobs WHERE id = ?", id);
      if (
        !job ||
        job.fence !== active.fence ||
        job.status === "cancelled" ||
        !job.session_id ||
        !this.store.getSessionRow(job.session_id)
      )
        active.abort.abort();
      else if (job.status === "running")
        db.run(
          "UPDATE background_jobs SET lease_until = ? WHERE id = ? AND fence = ?",
          clock.now() + 120_000,
          id,
          job.fence,
        );
    }
    db.run(
      "UPDATE background_jobs SET status='queued', fence=fence+1, lease_until=NULL WHERE status='running' AND lease_until < ?",
      clock.now(),
    );
    for (const [handler, consume] of this.subscribers) {
      const events = db.all<LifecycleEvent>(
        "SELECT e.* FROM lifecycle_outbox e WHERE NOT EXISTS(SELECT 1 FROM lifecycle_deliveries d WHERE d.event_id=e.id AND d.handler=?) ORDER BY e.created_at,e.rowid LIMIT 100",
        handler,
      );
      for (const event of events) {
        try {
          this.store.tx(() => {
            consume(event);
            db.run("INSERT OR IGNORE INTO lifecycle_deliveries(event_id,handler) VALUES(?,?)", event.id, handler);
          });
        } catch {
          break;
        }
      }
    }
    if (this.active.size >= 2 || !this.handlers.size) return;
    const kinds = [...this.handlers.keys()];
    const jobs = db.all<BackgroundJob>(
      `SELECT * FROM background_jobs j WHERE status='queued' AND kind IN (${kinds.map(() => "?").join(",")}) AND retry_at<=? AND NOT EXISTS(SELECT 1 FROM background_jobs earlier WHERE earlier.session_id=j.session_id AND earlier.kind=j.kind AND earlier.rowid<j.rowid AND earlier.status IN ('queued','running','failed')) ORDER BY created_at,rowid LIMIT ?`,
      ...kinds,
      clock.now(),
      2 - this.active.size,
    );
    for (const job of jobs) {
      const handler = this.handlers.get(job.kind);
      if (!handler || this.active.has(job.id)) continue;
      const claimed = this.store.tx(() => {
        const changed = db.run(
          "UPDATE background_jobs SET status='running',attempt=attempt+1,fence=fence+1,lease_until=? WHERE id=? AND status='queued'",
          clock.now() + 120_000,
          job.id,
        ).changes;
        if (!changed) return undefined;
        const row = db.get<BackgroundJob>("SELECT * FROM background_jobs WHERE id=?", job.id)!;
        db.run(
          "INSERT INTO background_attempts(job_id,attempt,started_at) VALUES(?,?,?)",
          row.id,
          row.attempt,
          clock.now(),
        );
        this.store.events.append(GLOBAL_STREAM, { type: "background.changed" });
        return row;
      });
      if (!claimed) continue;
      const abort = new AbortController();
      const promise = this.#execute(claimed, handler, abort).finally(() => this.active.delete(job.id));
      this.active.set(job.id, { abort, promise, fence: claimed.fence });
    }
  }
  async #execute(job: BackgroundJob, handler: TaskHandler, abort: AbortController): Promise<void> {
    const { db, clock } = this.store;
    const assertLive = () => {
      if (
        abort.signal.aborted ||
        !job.session_id ||
        !this.store.getSessionRow(job.session_id) ||
        !db.get("SELECT 1 FROM background_jobs WHERE id=? AND fence=? AND status='running'", job.id, job.fence)
      )
        throw new Error("CANCELLED");
    };
    const complete = (outcome: TaskOutcome) =>
      this.store.tx(() => {
        assertLive();
        db.run(
          "UPDATE background_jobs SET status=?,result=?,finished_at=?,lease_until=NULL,diagnostic=NULL WHERE id=? AND fence=?",
          outcome.status,
          JSON.stringify(outcome.result ?? null),
          clock.now(),
          job.id,
          job.fence,
        );
        db.run(
          "UPDATE background_attempts SET finished_at=?,outcome=? WHERE job_id=? AND attempt=?",
          clock.now(),
          outcome.status,
          job.id,
          job.attempt,
        );
        this.store.events.append(GLOBAL_STREAM, { type: "background.changed" });
      });
    try {
      assertLive();
      const result = await handler(job, { signal: abort.signal, assertLive, complete });
      if (db.get<{ status: string }>("SELECT status FROM background_jobs WHERE id=?", job.id)?.status === "running")
        complete(result);
    } catch (error) {
      this.store.tx(() => {
        const current = db.get<{ status: string; fence: number }>(
          "SELECT status,fence FROM background_jobs WHERE id=?",
          job.id,
        );
        if (!current || current.fence !== job.fence || current.status !== "running") {
          db.run(
            "UPDATE background_attempts SET finished_at=COALESCE(finished_at,?),outcome=COALESCE(outcome,?) WHERE job_id=? AND attempt=?",
            clock.now(),
            current?.status === "cancelled" ? "cancelled" : "interrupted",
            job.id,
            job.attempt,
          );
          return;
        }
        const cancelled = abort.signal.aborted || !job.session_id || !this.store.getSessionRow(job.session_id);
        const status = this.#stopped ? "queued" : cancelled ? "cancelled" : job.attempt < 3 ? "queued" : "failed";
        const code = error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : "ATTEMPT_FAILED";
        const diagnostic =
          error instanceof TaskFailure && error.detail
            ? `${code}: ${error.detail.replace(/\s+/g, " ").slice(0, 300)}`
            : code;
        db.run(
          "UPDATE background_jobs SET status=?,diagnostic=?,retry_at=?,lease_until=NULL,finished_at=? WHERE id=? AND fence=? AND status='running'",
          status,
          cancelled ? "CANCELLED" : diagnostic,
          clock.now() + 1000 * 2 ** job.attempt,
          status === "queued" ? null : clock.now(),
          job.id,
          job.fence,
        );
        db.run(
          "UPDATE background_attempts SET finished_at=?,outcome=? WHERE job_id=? AND attempt=?",
          clock.now(),
          status,
          job.id,
          job.attempt,
        );
        this.store.events.append(GLOBAL_STREAM, { type: "background.changed" });
      });
    }
  }
  retry(id: string): boolean {
    return (
      this.store.db.run(
        "UPDATE background_jobs SET status='queued',retry_at=0,diagnostic=NULL WHERE id=? AND status='failed' AND session_id IN (SELECT id FROM sessions WHERE deleted_at IS NULL AND status<>'deleting')",
        id,
      ).changes > 0
    );
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    for (const active of this.active.values()) active.abort.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.promise));
  }
}
