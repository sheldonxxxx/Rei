// What happens when a trigger is due and when its run ends: start the action, then report, retry or fail.
// The scheduler decides WHEN; this decides WHAT. Everything here is rows in the app store plus two calls out: the host
// (kick a session, tell the home conversation) and the skill lookup.
import { TRIGGER_LIMITS, type TriggerAction, type TriggerMessage, type TriggerRunEvent } from "@rei/protocol";
import { suggestionsLine } from "../memory/rows.ts";
import type { AppStore, OutboxRow } from "../store/store.ts";
import { REPORT_SUMMARY_MAX } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import type { Logger } from "../util/log.ts";
import type { SkillLookup } from "./spec.ts";
import type { TriggerRow, TriggerRunRow, TriggerStore } from "./store.ts";

/** What the runner asks of the control plane (the Pi adapter implements it). */
export interface TriggerHost {
  /** A session made for a run needs its tree folder. */
  treeCreated(treeId: string): void;
  /** Start dispatching a session's unsent runs. */
  kick(sessionId: string): void;
  /** Deliver a background result as a home-assistant turn, or append a context-only note. Idempotent by requestId. */
  noteInHome(sessionId: string, requestId: string, text: string, trigger?: TriggerMessage): Promise<void>;
}

export interface RunnerDeps {
  store: TriggerStore;
  app: AppStore;
  host: TriggerHost;
  skills: SkillLookup;
  clock: Clock;
  log: Logger;
}

/** Run errors that are the model's or the provider's trouble, not the run's: worth another try if nothing was done yet. */
const TRANSIENT = new Set([
  "model_error",
  "deadline_exceeded",
  "gateway_unavailable",
  "caller_concurrency",
  "rate_limited",
  "provider_timeout",
  "provider_unreachable",
  "provider_unavailable",
  "provider_stream_interrupted",
]);
/** How long the n-th retry waits (1 minute, then 5). */
export const RETRY_DELAYS_MS = [60_000, 300_000] as const;
const REPORT_MAX = TRIGGER_LIMITS.reportChars;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The brief a prompt or skill run starts from. */
export function briefOf(
  a: Exclude<TriggerAction, { kind: "notify" }>,
  start?: { source: string; events: TriggerRunEvent[]; dropped: number },
): string {
  const base =
    a.kind === "prompt"
      ? a.prompt
      : `Use the skill "${a.skill}" (call use_skill first).${a.args ? `\nArguments: ${a.args}` : ""}`;
  if (!start) return base;
  if (start.events.length === 0) return `${base}\n\nStarted by hand; no event.`;
  const lines = start.events.map((e) => `- ${e.type}: ${e.ref} (${new Date(e.receivedAt).toISOString()})`);
  const dropped =
    start.dropped > 0
      ? `\n${start.dropped} earlier event${start.dropped === 1 ? " was" : "s were"} dropped; check the source for anything missing.`
      : "";
  return `${base}\n\nStarted by ${start.events.length === 1 ? "an event" : `${start.events.length} events`} from "${start.source}". A ref only points at the item; look it up with your tools.\n${lines.join("\n")}${dropped}`;
}

export class TriggerRunner {
  readonly #d: RunnerDeps;
  /** Lines being written to home conversations (tests wait for them). */
  #notes = new Set<Promise<unknown>>();
  /** Outbox rows being delivered right now. */
  #inFlight = new Set<number>();
  /** Test hook: while set, home lines stay in the outbox (as if the process died before delivering them). */
  holdNotes = false;

  constructor(deps: RunnerDeps) {
    this.#d = deps;
  }

  /** Resolves when every line to a home conversation started so far has been written. */
  async idle(): Promise<void> {
    while (this.#notes.size > 0) await Promise.allSettled([...this.#notes]);
  }

  /** When a run that is made but not started should start: a first attempt at once, a retry after its wait. */
  dueAt(run: TriggerRunRow): number {
    return run.attempt === 0
      ? run.created_at
      : run.created_at + (RETRY_DELAYS_MS[Math.min(run.attempt, RETRY_DELAYS_MS.length) - 1] ?? 0);
  }

  // ---- start -------------------------------------------------------------------------------------------------------

  /** Starts a run that was made (its row exists, `started_at` is empty). Never throws: a failure ends the run as failed. */
  begin(run: TriggerRunRow): void {
    const { store } = this.#d;
    const trigger = store.row(run.trigger_id);
    if (!trigger || run.started_at !== null) return;
    try {
      const action = store.action(trigger);
      if (action.kind === "notify") return this.#notify(run, trigger, action.message);
      this.#startSession(run, trigger);
    } catch (error) {
      this.#d.log.error("trigger.start_failed", {
        triggerId: trigger.id,
        runId: run.id,
        error: error instanceof Error ? error.name : "error",
      });
      this.#fail(run, trigger, "The run could not be started.", false);
    }
  }

  /** Starts the run waiting behind a trigger's last one, once nothing of that trigger is running. Safe to call at any time. */
  startQueued(triggerId: string): void {
    const { store, app } = this.#d;
    const next = app.tx(() => {
      if (store.isRunning(triggerId)) return undefined;
      const queued = store.queuedRun(triggerId);
      if (!queued) return undefined;
      store.promoteQueued(queued.id);
      store.changed(triggerId);
      return store.runRow(queued.id);
    });
    if (next) this.begin(next);
  }

  #notify(run: TriggerRunRow, trigger: TriggerRow, message: string): void {
    const { store, app } = this.#d;
    app.tx(() => {
      this.#post(trigger, run, "notify", message, null);
      store.startRun(run.id, { sessionId: null, runId: null });
      store.endRun(run.id, { status: "succeeded", report: null });
      store.setFailures(trigger.id, 0);
      store.changed(trigger.id);
    });
    this.deliverNotes();
  }

  #startSession(run: TriggerRunRow, trigger: TriggerRow): void {
    const { store, app, host, skills } = this.#d;
    const action = store.action(trigger);
    if (action.kind === "notify") return;
    let skillVersion: number | null = null;
    if (action.kind === "skill") {
      const skill = skills.find(trigger.agent_id, action.skill);
      if (!skill) return this.#fail(run, trigger, `skill "${action.skill}" no longer exists`, false);
      skillVersion = skill.version;
    }
    const start = store.start(trigger);
    const brief = briefOf(
      action,
      start.kind === "event"
        ? { source: start.source, events: store.runEvents(run.id), dropped: run.dropped_events }
        : undefined,
    );
    let treeId: string | undefined;
    let sessionId = "";
    let runId = "";
    app.tx(() => {
      // Ongoing: the trigger's own chat. A retry goes on in the chat of the attempt that failed. Otherwise a new chat.
      const earlier =
        run.attempt > 0
          ? store.previousAttempt(run)?.session_id
          : trigger.landing === "ongoing"
            ? trigger.ongoing_session_id
            : null;
      let session = earlier ? app.getSessionRow(earlier) : undefined;
      if (!session) {
        const made = app.createTriggerSession({
          agentId: trigger.agent_id,
          triggerId: trigger.id,
          title: trigger.name,
          profile: trigger.profile,
        });
        session = app.getSessionRow(made.session.id)!;
        treeId = made.treeId;
        if (trigger.landing === "ongoing") store.setOngoingSession(trigger.id, session.id);
      }
      sessionId = session.id;
      const accepted = app.queueAdmission({
        sessionId,
        requestId: `trigger:${run.id}`,
        role: "user",
        text: brief,
        triggerRunId: run.id,
      });
      runId = accepted.runId;
      store.startRun(run.id, { sessionId, runId, skillVersion });
      store.changed(trigger.id);
    });
    // The folder of a new tree: a crash before this is repaired when the adapter starts (it makes every live tree's folder).
    if (treeId !== undefined) host.treeCreated(treeId);
    host.kick(sessionId);
  }

  // ---- end ---------------------------------------------------------------------------------------------------------

  /** A run that belongs to a trigger run ended (store hook, after the commit). */
  onRunFinished(triggerRunId: string): void {
    const run = this.#d.store.runRow(triggerRunId);
    if (run) this.finalize(run);
  }

  /**
   * Concludes a started trigger run if its session has nothing more to do: no unfinished run, and nothing blocked on
   * you (an approval or takeover keeps it "waiting"). The outcome is that of the session's latest run for this trigger
   * run. Also called by the scheduler for runs whose session went quiet without a finish hook (an approval denied).
   */
  finalize(run: TriggerRunRow): void {
    const { store, app } = this.#d;
    if (run.status !== "running" || run.started_at === null) return;
    const trigger = store.row(run.trigger_id);
    if (!trigger) return;
    if (run.session_id === null) return;
    const session = app.getSessionRow(run.session_id);
    if (!session) return this.#fail(run, trigger, "The chat of this run was deleted.", false);
    if (app.nonTerminalRuns(session.id).length > 0 || app.isWaiting(session.id)) return;
    const row = app.db.get<{
      id: string | null;
      status: string | null;
      error_code: string | null;
      error_message: string | null;
    }>(
      "SELECT last_run_id AS id, last_run_status AS status, last_error_code AS error_code, last_error_message AS error_message FROM trigger_runs WHERE id = ?",
      run.id,
    );
    const last = row?.id && row.status ? { ...row, id: row.id, status: row.status } : undefined;
    if (!last) {
      this.#fail(run, trigger, "The run never started.", false);
      return;
    }
    // A turn that ended on a call you then denied (or let expire) did not do what it was for; its reply only asked you.
    const refused = app.db.get<{ status: string; summary: string }>(
      "SELECT status, summary FROM approvals WHERE run_id = ? AND status IN ('denied', 'expired') ORDER BY seq DESC LIMIT 1",
      last.id,
    );
    if (refused)
      return this.#fail(
        run,
        trigger,
        `${refused.status === "denied" ? "You denied" : "No answer in time to"}: ${refused.summary}`,
        false,
        true,
      );
    if (last.status === "completed") return this.#succeed(run, trigger, last.id, session.id);
    if (last.status === "cancelled") return this.#fail(run, trigger, "cancelled", false);
    const transient = last.error_code !== null && TRANSIENT.has(last.error_code);
    this.#fail(
      run,
      trigger,
      last.error_message ?? "The run failed.",
      transient && run.attempt < TRIGGER_LIMITS.retries && !store.hadSideEffect(run.id),
    );
  }

  #succeed(run: TriggerRunRow, trigger: TriggerRow, lastRunId: string, sessionId: string): void {
    const { store, app } = this.#d;
    app.tx(() => {
      const fresh = store.runRow(run.id);
      if (fresh?.status !== "running") return;
      const said = fresh.report ?? undefined;
      const final =
        app.db.get<{ last_reply: string | null }>(
          "SELECT last_reply FROM trigger_runs WHERE id = ? AND last_run_id = ?",
          run.id,
          lastRunId,
        )?.last_reply ?? "";
      const report =
        trigger.report === "never"
          ? null
          : trigger.report === "always"
            ? clip((said ?? (final || "Done.")).trim(), REPORT_MAX)
            : said
              ? clip(said.trim(), REPORT_MAX)
              : null;
      store.endRun(run.id, { status: "succeeded", report });
      store.setFailures(trigger.id, 0);
      // The memory edits the run proposed ride with the report (to the agent's home conversation), reported or not.
      const suggestions = store.takeSuggestions(sessionId);
      this.#post(trigger, fresh, "report", report, suggestions.length > 0 ? suggestionsLine(suggestions) : null);
      store.changed(trigger.id);
    });
    this.deliverNotes();
    this.startQueued(trigger.id);
  }

  /**
   * The run failed: another attempt when it is worth one, else a failure on the trigger (and a pause after enough in a
   * row). A `denied` run (you refused its last call) still ends failed and says so, but is no failure of the trigger:
   * it neither counts nor resets the count, and never pauses it.
   */
  #fail(run: TriggerRunRow, trigger: TriggerRow, why: string, retry: boolean, denied = false): void {
    const { store, app } = this.#d;
    app.tx(() => {
      const fresh = store.runRow(run.id);
      if (fresh?.status !== "running") return;
      store.endRun(run.id, { status: "failed", reason: clip(why, 300), report: null });
      if (retry) {
        const again = store.insertRun({
          triggerId: trigger.id,
          scheduledAt: run.scheduled_at,
          manual: run.manual === 1,
          attempt: run.attempt + 1,
        });
        if (again) store.copyRunEvents(run.id, again.id);
        this.#d.log.info("trigger.retry", { triggerId: trigger.id, runId: run.id, attempt: run.attempt + 1 });
        store.changed(trigger.id);
        return;
      }
      const failures = denied ? trigger.failures : trigger.failures + 1;
      if (!denied) store.setFailures(trigger.id, failures);
      if (trigger.report !== "never")
        this.#post(trigger, fresh, "failed", `Couldn't ${trigger.name}: ${clip(why, 200)}`, null);
      if (!denied && failures >= TRIGGER_LIMITS.failuresBeforePause && trigger.status === "active") {
        store.setPaused(trigger.id, true, "failures", { log: false });
        this.#post(
          trigger,
          fresh,
          "paused",
          `Paused "${trigger.name}" after ${failures} failed runs in a row. Fix what is wrong, then resume it on the Triggers page.`,
          null,
        );
      }
      store.changed(trigger.id);
    });
    this.deliverNotes();
    this.startQueued(trigger.id);
  }

  // ---- the home chat -----------------------------------------------------------------------------------------------

  /** Queue results for the home assistant; plain notify reminders are posted directly. Call inside a transaction. */
  #post(
    trigger: TriggerRow,
    run: TriggerRunRow,
    kind: TriggerMessage["kind"],
    text: string | null,
    extra: string | null,
  ): void {
    const { app } = this.#d;
    const home = app.getAgent(trigger.agent_id)?.homeSessionId;
    if (!home || !app.getSessionRow(home)) return;
    let result: TriggerMessage | undefined;
    if (text !== null) {
      const message: TriggerMessage = {
        kind,
        triggerId: trigger.id,
        triggerName: trigger.name,
        triggerRunId: run.id,
        sessionId: run.session_id,
        text,
      };
      if (kind !== "notify") result = { ...message, text: text.slice(0, REPORT_SUMMARY_MAX) };
      else {
        app.addTriggerMessage(home, message);
        app.queueNotify({
          event: "trigger_report",
          sessionId: home,
          title: trigger.name,
          body: text,
          dedupe: `${run.id}:${kind}`,
        });
      }
    }
    if (text === null && extra === null) return;
    const line = `[Trigger "${trigger.name}"]${text !== null ? ` ${result?.text ?? text}` : ""}${extra !== null ? `\n${extra}` : ""}`;
    app.queueHomeNote({
      sessionId: home,
      requestId: `trigger:${run.id}:${kind}`,
      text: line,
      ...(result ? { trigger: result } : {}),
    });
  }

  /**
   * Writes every pending home-conversation line (outbox rows) to its agent, each once at a time; a failure leaves the row
   * for the next tick, a session that is gone drops it. Runs after each commit, on startup and on every scheduler tick.
   */
  deliverNotes(): void {
    const { app } = this.#d;
    if (this.holdNotes) return;
    for (const row of app.pendingOutbox("home_note")) {
      if (this.#inFlight.has(row.id)) continue;
      this.#inFlight.add(row.id);
      const done: Promise<unknown> = this.#deliverNote(row).finally(() => {
        this.#inFlight.delete(row.id);
        this.#notes.delete(done);
      });
      this.#notes.add(done);
    }
  }

  async #deliverNote(row: OutboxRow): Promise<void> {
    const { app, host, log } = this.#d;
    try {
      const note = JSON.parse(row.payload) as {
        sessionId?: string;
        requestId?: string;
        text?: string;
        trigger?: TriggerMessage;
      };
      if (!note.sessionId || !note.requestId || note.text === undefined || !app.getSessionRow(note.sessionId))
        return app.finishOutbox(row.id, "dropped");
      await host.noteInHome(note.sessionId, note.requestId, note.text, note.trigger);
      app.finishOutbox(row.id, "delivered");
    } catch (error) {
      log.error("trigger.note_failed", { error: error instanceof Error ? error.name : "error" });
      try {
        app.bumpOutboxAttempts(row.id);
      } catch {
        // The store is closed (shutdown): the row stays pending for the next start.
      }
    }
  }
}
