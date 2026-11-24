// When triggers fire. One timer, armed for the earliest thing due and never for longer than a minute, so a clock
// jump or a sleeping machine is noticed soon. `tick(now)` does everything due and is safe to call at any time: each
// trigger is handled in one transaction, and a run is unique by (trigger, scheduled time, attempt).
import type { TriggerRunSummary } from "@rei/protocol";
import type { AcceptedEvent } from "../events/receive.ts";
import type { Clock } from "../util/clock.ts";
import { notFound } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import type { TriggerRunner } from "./runner.ts";
import { latestDue, minGapMs, nextRuns } from "./schedule.ts";
import type { TriggerRow, TriggerStore } from "./store.ts";

const MAX_WAIT_MS = 60_000;
/** With catch-up "skip": a firing this much later than its time was missed (the scheduler wakes at least every minute). */
const MISSED_MS = 2 * 60_000;

export class TriggerScheduler {
  readonly #store: TriggerStore;
  readonly #runner: TriggerRunner;
  readonly #clock: Clock;
  readonly #log: Logger;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;

  constructor(store: TriggerStore, runner: TriggerRunner, clock: Clock, log: Logger) {
    this.#store = store;
    this.#runner = runner;
    this.#clock = clock;
    this.#log = log;
    store.onChange = () => this.#arm();
  }

  /** Startup: catches up on what was missed while the process was down, then keeps time. */
  start(): void {
    this.#stopped = false;
    this.tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Does everything due at `now`: fires triggers, starts runs that are waiting for their time, concludes runs that went quiet. */
  tick(now: number = this.#clock.now()): void {
    try {
      for (const row of this.#store.rows())
        if (row.status === "active" && row.next_fire_at !== null && row.next_fire_at <= now) this.#fire(row, now);
      for (const run of this.#store.unstartedRuns()) if (this.#runner.dueAt(run) <= now) this.#runner.begin(run);
      for (const run of this.#store.startedRuns()) this.#runner.finalize(run);
      for (const id of this.#store.triggersWithQueued()) this.#runner.startQueued(id);
      this.#runner.deliverNotes();
    } catch (error) {
      this.#log.error("trigger.tick_failed", { error: error instanceof Error ? error.name : "error" });
    }
    this.#arm();
  }

  /** One firing: a run for the latest time that is due (many missed times make one run), or a skipped one saying why. */
  #fire(row: TriggerRow, now: number): void {
    const store = this.#store;
    const schedule = store.schedule(row);
    const run = store.app.tx(() => {
      const fresh = store.row(row.id);
      if (!fresh || fresh.status !== "active" || fresh.next_fire_at === null || fresh.next_fire_at > now)
        return undefined;
      const due = latestDue(schedule, fresh.next_fire_at - 1, now) ?? fresh.next_fire_at;
      const gap = minGapMs(schedule, due);
      const lateness = Math.min(fresh.lateness_minutes * 60_000, gap ?? Number.POSITIVE_INFINITY);
      const next = nextRuns(schedule, now, 1)[0] ?? null;
      store.setNextFire(fresh.id, next, next === null ? "done" : undefined);
      store.changed(fresh.id);
      if (fresh.catch_up === "skip" && now - due > MISSED_MS)
        return store.insertRun({
          triggerId: fresh.id,
          scheduledAt: due,
          status: "skipped",
          reason: "missed",
          finishedAt: now,
        });
      if (now - due > lateness)
        return store.insertRun({
          triggerId: fresh.id,
          scheduledAt: due,
          status: "skipped",
          reason: "late",
          finishedAt: now,
        });
      if (store.isRunning(fresh.id))
        return store.insertRun({ triggerId: fresh.id, scheduledAt: due, ...this.#whileRunning(fresh, now) });
      return store.insertRun({ triggerId: fresh.id, scheduledAt: due });
    });
    if (run && run.status === "running") this.#runner.begin(run);
  }

  /** What a run made while one is going becomes: queued (overlap "queue", none waiting yet), else skipped as "overlap". */
  #whileRunning(
    row: TriggerRow,
    now: number,
  ): { status: "queued" } | { status: "skipped"; reason: string; finishedAt: number } {
    // Events gather into one waiting run, whatever the overlap setting (it is a schedule setting).
    if ((row.overlap === "queue" || row.start_kind === "event") && !this.#store.queuedRun(row.id))
      return { status: "queued" };
    return { status: "skipped", reason: "overlap", finishedAt: now };
  }

  /**
   * An accepted event (called inside the transaction that records it). Each active trigger listening for it starts a run
   * with the event, or, while one is going, makes the one waiting run or joins it. Returns how many triggers got it. The
   * runs that were made start in `tick()`, which the receiver calls once the transaction has committed.
   */
  onEvent(event: AcceptedEvent): number {
    const store = this.#store;
    let count = 0;
    for (const row of store.listeners(event.source, event.type)) {
      const queued = store.queuedRun(row.id);
      let run = queued;
      if (!run) {
        const busy = store.isRunning(row.id) ? { status: "queued" as const } : {};
        for (let at = event.receivedAt; !run; at++)
          run = store.insertRun({ triggerId: row.id, scheduledAt: at, ...busy });
      }
      store.addRunEvent(run.id, event);
      store.changed(row.id);
      count++;
    }
    return count;
  }

  /** Run now (the Triggers page): not late and not a missed time; while a run is going it is queued or skipped as "overlap", as a firing would be. Works when paused or done. */
  runNow(id: string): TriggerRunSummary {
    const store = this.#store;
    const now = this.#clock.now();
    const run = store.app.tx(() => {
      const row = store.row(id);
      if (!row) throw notFound("That trigger does not exist.");
      const busy = store.isRunning(id) ? this.#whileRunning(row, now) : {};
      for (let at = now; ; at++) {
        const made = store.insertRun({ triggerId: id, scheduledAt: at, manual: true, ...busy });
        if (made) {
          store.changed(id);
          return made;
        }
      }
    });
    if (run.status === "running") this.#runner.begin(run);
    return store.toRunSummary(store.runRow(run.id)!);
  }

  #arm(): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const now = this.#clock.now();
    let wait = MAX_WAIT_MS;
    for (const row of this.#store.rows())
      if (row.status === "active" && row.next_fire_at !== null) wait = Math.min(wait, row.next_fire_at - now);
    for (const run of this.#store.unstartedRuns()) wait = Math.min(wait, this.#runner.dueAt(run) - now);
    this.#timer = setTimeout(() => this.tick(), Math.max(wait, 0) + 5);
    (this.#timer as { unref?: () => void }).unref?.();
  }
}
