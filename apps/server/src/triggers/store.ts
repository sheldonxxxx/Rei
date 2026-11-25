// Triggers and their runs, in the app store. Rows are the record; `triggers.changed` follows every change, in the
// same transaction, and the scheduler is told to look again after the commit.
import type {
  MemorySuggestion,
  Schedule,
  Trigger,
  TriggerAction,
  TriggerAllow,
  TriggerAllowView,
  TriggerRunEvent,
  TriggerRunId,
  TriggerRunStatus,
  TriggerRunSummary,
  TriggerStart,
  TriggerStatus,
} from "@rei/protocol";
import { type SuggestionRow, toSuggestion } from "../memory/rows.ts";
import type { ToolCatalog } from "../pi/policy-ext.ts";
import { canonicalProfile } from "../policy/decision.ts";
import { GLOBAL_STREAM } from "../store/events.ts";
import type { AppStore } from "../store/store.ts";
import { newId } from "../util/ids.ts";
import { nextRuns, startText } from "./schedule.ts";
import type { EventSourceLookup, TriggerFields } from "./spec.ts";

export interface TriggerRow {
  id: string;
  agent_id: string;
  name: string;
  schedule_json: string;
  start_kind: string;
  event_json: string | null;
  action_json: string;
  landing: string;
  ongoing_session_id: string | null;
  report: string;
  lateness_minutes: number;
  catch_up: string;
  overlap: string;
  profile: string;
  allow_json: string;
  status: string;
  paused_reason: string | null;
  failures: number;
  next_fire_at: number | null;
  created_by_session_id: string | null;
  created_at: number;
  updated_at: number;
}
export interface TriggerRunRow {
  id: string;
  trigger_id: string;
  scheduled_at: number;
  manual: number;
  status: string;
  reason: string | null;
  session_id: string | null;
  run_id: string | null;
  skill_version: number | null;
  report: string | null;
  attempt: number;
  dropped_events: number;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
}

export const PAGE = 50;
/** Events one run keeps; when more arrive the oldest are dropped and counted. */
export const MAX_RUN_EVENTS = 20;

/** Who made a change that goes to the edit log. */
export type Author = "user" | "agent";

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The action as one short line, for the edit log. */
export function actionText(a: TriggerAction): string {
  if (a.kind === "notify") return `Notify: ${clip(flat(a.message), 80)}`;
  if (a.kind === "prompt") return `Prompt: ${clip(flat(a.prompt), 80)}`;
  return `Skill ${a.skill}${a.args ? ` (${clip(flat(a.args), 60)})` : ""}`;
}
const allowText = (allow: readonly TriggerAllow[]): string =>
  allow.length === 0 ? "none" : allow.map((a) => (a.destination ? `${a.tool} to ${a.destination}` : a.tool)).join(", ");

const scheduleJson = (start: TriggerStart): string => JSON.stringify(start.kind === "schedule" ? start.schedule : null);
const eventJson = (start: TriggerStart): string | null =>
  start.kind === "event" ? JSON.stringify({ source: start.source, types: start.types }) : null;

export class TriggerStore {
  readonly app: AppStore;
  readonly #catalog: ToolCatalog;
  /** The event sources, for the rules (an event trigger needs one that exists). */
  readonly sources: EventSourceLookup | undefined;
  /** Set by the scheduler: something changed that it should look at again (after the commit). */
  onChange: (() => void) | undefined;

  constructor(app: AppStore, catalog: ToolCatalog, sources?: EventSourceLookup) {
    this.app = app;
    this.#catalog = catalog;
    this.sources = sources;
  }
  get #db() {
    return this.app.db;
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  row(id: string): TriggerRow | undefined {
    return this.#db.get<TriggerRow>("SELECT * FROM triggers WHERE id = ?", id);
  }
  rows(): TriggerRow[] {
    return this.#db.all<TriggerRow>("SELECT * FROM triggers ORDER BY created_at, id");
  }
  list(): Trigger[] {
    return this.rows().map((r) => this.toTrigger(r));
  }
  get(id: string): Trigger | undefined {
    const r = this.row(id);
    return r ? this.toTrigger(r) : undefined;
  }
  /** The schedule of a scheduled trigger. Only call it for one: an event trigger has none. */
  schedule(r: TriggerRow): Schedule {
    return JSON.parse(r.schedule_json) as Schedule;
  }
  start(r: TriggerRow): TriggerStart {
    if (r.start_kind === "event") {
      const e = JSON.parse(r.event_json ?? "{}") as { source: string; types: string[] };
      return { kind: "event", source: e.source, types: e.types };
    }
    return { kind: "schedule", schedule: this.schedule(r) };
  }
  /** Active triggers that start on this source's events and listen for this type. */
  listeners(source: string, type: string): TriggerRow[] {
    return this.#db
      .all<TriggerRow>(
        "SELECT * FROM triggers WHERE start_kind = 'event' AND status = 'active' AND json_extract(event_json, '$.source') = ? ORDER BY created_at, id",
        source,
      )
      .filter((r) => {
        const types = (JSON.parse(r.event_json ?? "{}") as { types?: string[] }).types ?? [];
        return types.includes("*") || types.includes(type);
      });
  }
  action(r: TriggerRow): TriggerAction {
    return JSON.parse(r.action_json) as TriggerAction;
  }
  allow(r: TriggerRow): TriggerAllow[] {
    return JSON.parse(r.allow_json) as TriggerAllow[];
  }
  /** The allow list of a trigger by id (the policy's view); undefined when it is gone. */
  allowOf(id: string): TriggerAllow[] | undefined {
    const r = this.row(id);
    return r ? this.allow(r) : undefined;
  }
  fields(r: TriggerRow): TriggerFields {
    return {
      name: r.name,
      start: this.start(r),
      action: this.action(r),
      landing: r.landing as "new" | "ongoing",
      report: r.report as TriggerFields["report"],
      latenessMinutes: r.lateness_minutes,
      catchUp: r.catch_up as TriggerFields["catchUp"],
      overlap: r.overlap as TriggerFields["overlap"],
      profile: canonicalProfile(r.profile),
      allow: this.allow(r),
    };
  }
  allowViews(allow: readonly TriggerAllow[]): TriggerAllowView[] {
    return allow.map((a) => ({
      ...a,
      actionClass: this.#catalog.get(a.tool)?.actionClass ?? "write_external",
      label: this.#catalog.describe(a.tool),
    }));
  }

  toTrigger(r: TriggerRow): Trigger {
    const start = this.start(r);
    const last = this.#db.get<TriggerRunRow>(
      "SELECT * FROM trigger_runs WHERE trigger_id = ? ORDER BY created_at DESC, attempt DESC, id DESC LIMIT 1",
      r.id,
    );
    return {
      id: r.id,
      name: r.name,
      agentId: r.agent_id,
      start,
      startText: startText(start),
      action: this.action(r),
      landing: r.landing as "new" | "ongoing",
      ongoingSessionId: r.ongoing_session_id,
      report: r.report as Trigger["report"],
      latenessMinutes: r.lateness_minutes,
      catchUp: r.catch_up as Trigger["catchUp"],
      overlap: r.overlap as Trigger["overlap"],
      profile: canonicalProfile(r.profile),
      allow: this.allowViews(this.allow(r)),
      status: r.status as TriggerStatus,
      pausedReason: r.paused_reason as Trigger["pausedReason"],
      failures: r.failures,
      nextRunAt: r.status === "active" ? r.next_fire_at : null,
      lastEventAt:
        this.#db.get<{ at: number | null }>(
          "SELECT MAX(e.received_at) AS at FROM trigger_run_events e JOIN trigger_runs r ON r.id = e.run_id WHERE r.trigger_id = ?",
          r.id,
        )?.at ?? null,
      lastRun: last ? this.toRunSummary(last) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  toRunSummary(r: TriggerRunRow): TriggerRunSummary {
    const sessionLive = r.session_id !== null && this.app.getSessionRow(r.session_id) !== undefined;
    const status: TriggerRunStatus =
      r.status === "running" && sessionLive && this.app.isWaiting(r.session_id!)
        ? "waiting"
        : (r.status as TriggerRunStatus);
    return {
      id: r.id,
      triggerId: r.trigger_id,
      scheduledAt: r.scheduled_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status,
      reason: r.reason,
      manual: r.manual === 1,
      // A deleted session reads as none.
      sessionId: sessionLive ? r.session_id : null,
      runId: r.run_id,
      skillVersion: r.skill_version,
      report: r.report,
      attempt: r.attempt,
      events: this.runEvents(r.id),
      droppedEvents: r.dropped_events,
    };
  }

  /** The events a run was started for, oldest first. */
  runEvents(runId: string): TriggerRunEvent[] {
    return this.#db
      .all<{ event_id: string; type: string; ref: string; received_at: number }>(
        "SELECT event_id, type, ref, received_at FROM trigger_run_events WHERE run_id = ? ORDER BY received_at, rowid",
        runId,
      )
      .map((e) => ({ id: e.event_id, type: e.type, ref: e.ref, receivedAt: e.received_at }));
  }

  /** Adds an event to a run. A run keeps at most `MAX_RUN_EVENTS`: the oldest is dropped and counted. */
  addRunEvent(runId: string, e: { id: string; type: string; ref: string; receivedAt: number }): void {
    this.#db.run(
      "INSERT OR IGNORE INTO trigger_run_events (run_id, event_id, type, ref, received_at) VALUES (?, ?, ?, ?, ?)",
      runId,
      e.id,
      e.type,
      e.ref,
      e.receivedAt,
    );
    const over =
      this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trigger_run_events WHERE run_id = ?", runId)!.n -
      MAX_RUN_EVENTS;
    if (over > 0) {
      this.#db.run(
        "DELETE FROM trigger_run_events WHERE rowid IN (SELECT rowid FROM trigger_run_events WHERE run_id = ? ORDER BY received_at, rowid LIMIT ?)",
        runId,
        over,
      );
      this.#db.run("UPDATE trigger_runs SET dropped_events = dropped_events + ? WHERE id = ?", over, runId);
    }
  }

  /** A retry carries the events (and the dropped count) of the attempt it follows. */
  copyRunEvents(from: string, to: string): void {
    this.#db.run(
      "INSERT OR IGNORE INTO trigger_run_events (run_id, event_id, type, ref, received_at) SELECT ?, event_id, type, ref, received_at FROM trigger_run_events WHERE run_id = ?",
      to,
      from,
    );
    this.#db.run(
      "UPDATE trigger_runs SET dropped_events = (SELECT dropped_events FROM trigger_runs WHERE id = ?) WHERE id = ?",
      from,
      to,
    );
  }

  runRow(id: string): TriggerRunRow | undefined {
    return this.#db.get<TriggerRunRow>("SELECT * FROM trigger_runs WHERE id = ?", id);
  }
  /** The newest 50 runs of a trigger (older ones with `before`, the id of the last run of the previous page). */
  runsPage(triggerId: string, before?: string): { runs: TriggerRunSummary[]; next: TriggerRunId | null } {
    const anchor = before ? this.runRow(before) : undefined;
    const rows = anchor
      ? this.#db.all<TriggerRunRow>(
          "SELECT * FROM trigger_runs WHERE trigger_id = ? AND (created_at < ? OR (created_at = ? AND (attempt < ? OR (attempt = ? AND id < ?)))) ORDER BY created_at DESC, attempt DESC, id DESC LIMIT ?",
          triggerId,
          anchor.created_at,
          anchor.created_at,
          anchor.attempt,
          anchor.attempt,
          anchor.id,
          PAGE + 1,
        )
      : this.#db.all<TriggerRunRow>(
          "SELECT * FROM trigger_runs WHERE trigger_id = ? ORDER BY created_at DESC, attempt DESC, id DESC LIMIT ?",
          triggerId,
          PAGE + 1,
        );
    const page = rows.slice(0, PAGE);
    return { runs: page.map((r) => this.toRunSummary(r)), next: rows.length > PAGE ? page[page.length - 1]!.id : null };
  }
  runsOfTrigger(triggerId: string): TriggerRunRow[] {
    return this.#db.all<TriggerRunRow>(
      "SELECT * FROM trigger_runs WHERE trigger_id = ? ORDER BY created_at, attempt, id",
      triggerId,
    );
  }
  /** Runs that were started (they have a session) and have not finished, oldest first. */
  startedRuns(): TriggerRunRow[] {
    return this.#db.all<TriggerRunRow>(
      "SELECT * FROM trigger_runs WHERE status = 'running' AND started_at IS NOT NULL ORDER BY created_at, id",
    );
  }
  /** Runs that are made but not started: a first attempt that crashed before it started, or a retry waiting for its time. */
  unstartedRuns(): TriggerRunRow[] {
    return this.#db.all<TriggerRunRow>(
      "SELECT * FROM trigger_runs WHERE status = 'running' AND started_at IS NULL ORDER BY created_at, id",
    );
  }
  /** Whether a run is going (queued runs are not: they are waiting for it). */
  isRunning(triggerId: string): boolean {
    return (
      this.#db.get("SELECT 1 AS x FROM trigger_runs WHERE trigger_id = ? AND status = 'running' LIMIT 1", triggerId) !==
      undefined
    );
  }
  /** The run waiting for the running one to end (overlap "queue"), if any. */
  queuedRun(triggerId: string): TriggerRunRow | undefined {
    return this.#db.get<TriggerRunRow>(
      "SELECT * FROM trigger_runs WHERE trigger_id = ? AND status = 'queued' ORDER BY created_at, id LIMIT 1",
      triggerId,
    );
  }
  /** Ids of triggers that have a run waiting. */
  triggersWithQueued(): string[] {
    return this.#db
      .all<{ trigger_id: string }>("SELECT DISTINCT trigger_id FROM trigger_runs WHERE status = 'queued'")
      .map((r) => r.trigger_id);
  }
  /** A queued run becomes a made-but-not-started run (the runner starts it). */
  promoteQueued(id: string): void {
    this.#db.run("UPDATE trigger_runs SET status = 'running' WHERE id = ? AND status = 'queued'", id);
  }
  previousAttempt(r: TriggerRunRow): TriggerRunRow | undefined {
    return r.attempt === 0
      ? undefined
      : this.#db.get<TriggerRunRow>(
          "SELECT * FROM trigger_runs WHERE trigger_id = ? AND scheduled_at = ? AND attempt = ?",
          r.trigger_id,
          r.scheduled_at,
          r.attempt - 1,
        );
  }
  /** The newest report text of a trigger other than the run asking, with when it was posted. */
  lastReport(triggerId: string, exceptRunId: string | undefined): { text: string; at: number } | undefined {
    const r = this.#db.get<{ report: string; finished_at: number | null; created_at: number }>(
      "SELECT report, finished_at, created_at FROM trigger_runs WHERE trigger_id = ? AND report IS NOT NULL AND status = 'succeeded' AND id IS NOT ? ORDER BY created_at DESC, attempt DESC LIMIT 1",
      triggerId,
      exceptRunId ?? null,
    );
    return r ? { text: r.report, at: r.finished_at ?? r.created_at } : undefined;
  }
  /** The trigger run a session's current (or latest) run belongs to. */
  runOfSession(sessionId: string): TriggerRunRow | undefined {
    const running = this.app
      .nonTerminalRuns(sessionId)
      .find((r) => r.status === "running" && r.trigger_run_id !== null);
    const id =
      running?.trigger_run_id ??
      this.#db.get<{ id: string }>(
        "SELECT id FROM trigger_runs WHERE session_id = ? AND started_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1",
        sessionId,
      )?.id;
    return id ? this.runRow(id) : undefined;
  }
  /** Whether any step of the Pi run(s) of a trigger run acted outside (a retry could repeat it). */
  hadSideEffect(triggerRunId: string): boolean {
    return (
      this.#db.get(
        // The trigger run's session, from when the run started (its Pi runs are the session's runs since then).
        "SELECT 1 AS x FROM steps s JOIN trigger_runs t ON t.id = ? WHERE s.session_id = t.session_id AND s.started_at >= t.started_at AND s.type = 'tool.call' AND s.side_effect = 1 LIMIT 1",
        triggerRunId,
      ) !== undefined
    );
  }
  /** The memory edits a trigger session proposed, marked as reported (they ride on the report). */
  takeSuggestions(sessionId: string): MemorySuggestion[] {
    return this.app.tx(() => {
      const pending = this.#db.all<SuggestionRow>(
        "SELECT * FROM memory_suggestions WHERE session_id = ? AND status = 'pending' ORDER BY seq",
        sessionId,
      );
      if (pending.length === 0) return [];
      const now = this.app.clock.now();
      this.#db.run(
        "UPDATE memory_suggestions SET status = 'reported', reported_at = ? WHERE session_id = ? AND status = 'pending'",
        now,
        sessionId,
      );
      return pending.map((r) => toSuggestion({ ...r, status: "reported", reported_at: now }));
    });
  }

  // ---- changes ---------------------------------------------------------------------------------------------------

  /** Announces a change inside the transaction and tells the scheduler after it. */
  changed(triggerId: string | null): void {
    this.app.events.append(GLOBAL_STREAM, { type: "triggers.changed", triggerId });
    this.app.afterCommit(() => this.onChange?.());
  }

  #log(triggerId: string, field: string, before: string | null, after: string | null, author: Author = "user"): void {
    const now = this.app.clock.now();
    this.#db.run(
      "INSERT INTO edit_log (id, at, author, target_kind, target_id, field, before_text, after_text) VALUES (?, ?, ?, 'trigger', ?, ?, ?, ?)",
      newId("edt", now),
      now,
      author,
      triggerId,
      field,
      before,
      after,
    );
  }

  /** Makes a trigger. With an `author` the creation goes to the edit log. */
  create(input: {
    agentId: string;
    fields: TriggerFields;
    createdBySessionId: string | null;
    author?: Author;
  }): Trigger {
    return this.app.tx(() => {
      const now = this.app.clock.now();
      const id = newId("trg", now);
      const f = input.fields;
      this.#db.run(
        `INSERT INTO triggers (id, agent_id, name, schedule_json, start_kind, event_json, action_json, landing, report, lateness_minutes, catch_up, overlap, profile, allow_json, status, failures, next_fire_at, created_by_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`,
        id,
        input.agentId,
        f.name,
        scheduleJson(f.start),
        f.start.kind,
        eventJson(f.start),
        JSON.stringify(f.action),
        f.landing,
        f.report,
        f.latenessMinutes,
        f.catchUp,
        f.overlap,
        f.profile,
        JSON.stringify(f.allow),
        f.start.kind === "schedule" ? (nextRuns(f.start.schedule, now, 1)[0] ?? null) : null,
        input.createdBySessionId,
        now,
        now,
      );
      if (input.author) this.#log(id, "create", null, f.name, input.author);
      this.changed(id);
      return this.get(id)!;
    });
  }

  /** Applies checked fields; one edit log row per field that changed. A schedule change moves the next run. */
  update(id: string, next: TriggerFields, opts: { log: boolean; author?: Author }): Trigger | undefined {
    return this.app.tx(() => {
      const row = this.row(id);
      if (!row) return undefined;
      const before = this.fields(row);
      const now = this.app.clock.now();
      const changes: [string, string, string][] = [];
      const diff = (field: string, a: string, b: string) => a !== b && changes.push([field, a, b]);
      diff("name", before.name, next.name);
      diff("start", startText(before.start), startText(next.start));
      diff("action", actionText(before.action), actionText(next.action));
      diff("landing", before.landing, next.landing);
      diff("report", before.report, next.report);
      diff("latenessMinutes", String(before.latenessMinutes), String(next.latenessMinutes));
      diff("catchUp", before.catchUp, next.catchUp);
      diff("overlap", before.overlap, next.overlap);
      diff("profile", before.profile, next.profile);
      diff("allow", allowText(before.allow), allowText(next.allow));
      if (changes.length === 0) return this.toTrigger(row);
      let status = row.status;
      let fire = row.next_fire_at;
      if (JSON.stringify(before.start) !== JSON.stringify(next.start)) {
        // An event trigger has no time to fire at and is never done: it waits for events for as long as it is active.
        fire = next.start.kind === "schedule" ? (nextRuns(next.start.schedule, now, 1)[0] ?? null) : null;
        // A one-time trigger that had fired comes back when its time is moved ahead.
        if (status === "done" && (fire !== null || next.start.kind === "event")) status = "active";
        if (status === "active" && fire === null && next.start.kind === "schedule") status = "done";
        if (status !== "active") fire = status === "paused" ? null : fire;
        if (status === "paused") fire = null;
      }
      this.#db.run(
        "UPDATE triggers SET name = ?, schedule_json = ?, start_kind = ?, event_json = ?, action_json = ?, landing = ?, report = ?, lateness_minutes = ?, catch_up = ?, overlap = ?, profile = ?, allow_json = ?, status = ?, next_fire_at = ?, updated_at = ? WHERE id = ?",
        next.name,
        scheduleJson(next.start),
        next.start.kind,
        eventJson(next.start),
        JSON.stringify(next.action),
        next.landing,
        next.report,
        next.latenessMinutes,
        next.catchUp,
        next.overlap,
        next.profile,
        JSON.stringify(next.allow),
        status,
        status === "active" ? fire : null,
        now,
        id,
      );
      if (opts.log) for (const [field, a, b] of changes) this.#log(id, field, a, b, opts.author);
      this.changed(id);
      return this.get(id)!;
    });
  }

  /** Pauses (for a `reason`) or resumes (clears the failure count and looks for the next run). */
  setPaused(
    id: string,
    paused: boolean,
    reason: "user" | "agent" | "failures",
    opts: { log: boolean; author?: Author },
  ): Trigger | undefined {
    return this.app.tx(() => {
      const row = this.row(id);
      if (!row) return undefined;
      const now = this.app.clock.now();
      if (paused) {
        if (row.status === "done") return this.toTrigger(row);
        this.#db.run(
          "UPDATE triggers SET status = 'paused', paused_reason = ?, next_fire_at = NULL, updated_at = ? WHERE id = ?",
          reason,
          now,
          id,
        );
        if (opts.log && row.status !== "paused") this.#log(id, "paused", "active", "paused", opts.author);
      } else {
        // Resuming an event trigger does not replay the events it ignored while paused.
        const isEvent = row.start_kind === "event";
        const fire = isEvent ? null : (nextRuns(this.schedule(row), now, 1)[0] ?? null);
        this.#db.run(
          "UPDATE triggers SET status = ?, paused_reason = NULL, failures = 0, next_fire_at = ?, updated_at = ? WHERE id = ?",
          fire === null && !isEvent ? "done" : "active",
          fire,
          now,
          id,
        );
        if (opts.log && row.status === "paused") this.#log(id, "paused", "paused", "active", opts.author);
      }
      this.changed(id);
      return this.get(id)!;
    });
  }

  /** The allow entry an approval with the length "trigger" adds (author: you). Safe to repeat. */
  addAllow(id: string, entry: TriggerAllow): void {
    this.app.tx(() => {
      const row = this.row(id);
      if (!row) return;
      const allow = this.allow(row);
      if (allow.some((a) => a.tool === entry.tool && a.destination === entry.destination)) return;
      const next = [...allow, entry];
      this.#db.run(
        "UPDATE triggers SET allow_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(next),
        this.app.clock.now(),
        id,
      );
      this.#log(id, "allow", allowText(allow), allowText(next));
      this.changed(id);
    });
  }

  setOngoingSession(id: string, sessionId: string): void {
    this.#db.run("UPDATE triggers SET ongoing_session_id = ? WHERE id = ?", sessionId, id);
  }
  setNextFire(id: string, next: number | null, status?: TriggerStatus): void {
    this.#db.run(
      "UPDATE triggers SET next_fire_at = ?, status = COALESCE(?, status), updated_at = ? WHERE id = ?",
      next,
      status ?? null,
      this.app.clock.now(),
      id,
    );
  }
  setFailures(id: string, failures: number): void {
    this.#db.run("UPDATE triggers SET failures = ? WHERE id = ?", failures, id);
  }

  /** Removes the trigger and its run history; its sessions stay (and stop saying which trigger they were runs of). Returns their ids. */
  remove(id: string, author: Author = "user"): { sessionIds: string[] } | undefined {
    return this.app.tx(() => {
      const row = this.row(id);
      if (!row) return undefined;
      const sessionIds = this.#db
        .all<{ id: string }>("SELECT id FROM sessions WHERE trigger_id = ? AND deleted_at IS NULL", id)
        .map((r) => r.id);
      this.#db.run(
        "DELETE FROM trigger_run_events WHERE run_id IN (SELECT id FROM trigger_runs WHERE trigger_id = ?)",
        id,
      );
      this.#db.run("DELETE FROM trigger_runs WHERE trigger_id = ?", id);
      this.#db.run("DELETE FROM triggers WHERE id = ?", id);
      this.#db.run("UPDATE sessions SET trigger_id = NULL WHERE trigger_id = ?", id);
      this.#log(id, "delete", row.name, null, author);
      for (const sid of sessionIds) this.app.touchSession(sid);
      this.changed(id);
      return { sessionIds };
    });
  }

  // ---- runs ------------------------------------------------------------------------------------------------------

  /** A run row; undefined when the same (trigger, time, attempt) exists already (the scheduler is idempotent by this key). */
  insertRun(input: {
    triggerId: string;
    scheduledAt: number;
    manual?: boolean;
    status?: TriggerRunStatus;
    reason?: string;
    attempt?: number;
    startedAt?: number;
    finishedAt?: number;
  }): TriggerRunRow | undefined {
    const now = this.app.clock.now();
    const id = newId("trr", now);
    const done = this.#db.run(
      "INSERT OR IGNORE INTO trigger_runs (id, trigger_id, scheduled_at, manual, status, reason, attempt, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.triggerId,
      input.scheduledAt,
      input.manual ? 1 : 0,
      input.status ?? "running",
      input.reason ?? null,
      input.attempt ?? 0,
      input.startedAt ?? null,
      input.finishedAt ?? null,
      now,
    );
    return done.changes > 0 ? this.runRow(id) : undefined;
  }
  startRun(id: string, input: { sessionId: string | null; runId: string | null; skillVersion?: number | null }): void {
    this.#db.run(
      "UPDATE trigger_runs SET session_id = ?, run_id = ?, skill_version = ?, started_at = ? WHERE id = ?",
      input.sessionId,
      input.runId,
      input.skillVersion ?? null,
      this.app.clock.now(),
      id,
    );
  }
  /** Ends a run. `report`: a string sets it, null clears it (nothing was posted), undefined leaves what report() stored. */
  endRun(
    id: string,
    input: { status: "succeeded" | "failed" | "skipped"; reason?: string | null; report?: string | null },
  ): void {
    const now = this.app.clock.now();
    this.#db.run(
      "UPDATE trigger_runs SET status = ?, reason = ?, report = CASE WHEN ? = 1 THEN ? ELSE report END, finished_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'running'",
      input.status,
      input.reason ?? null,
      input.report !== undefined ? 1 : 0,
      input.report ?? null,
      now,
      now,
      id,
    );
  }
  /** report(): the summary the run posts; the last call wins. */
  setReport(id: string, text: string): void {
    this.#db.run("UPDATE trigger_runs SET report = ? WHERE id = ?", text, id);
    this.changed(this.runRow(id)?.trigger_id ?? null);
  }
}
