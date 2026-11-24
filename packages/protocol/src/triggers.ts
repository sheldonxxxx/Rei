// Triggers: when an agent does something on its own, on a schedule or when an outside event arrives (ADR 0019). A trigger is made
// in chat (the agent drafts it and you approve a card), then edited, paused, run or deleted on the Triggers page.
import type { ActionClass, AgentId, ProfileName, RunId, SessionId } from "./entities.ts";

export type TriggerId = string;
export type TriggerRunId = string;

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/**
 * When a trigger fires, as wall-clock times in an IANA time zone (daylight saving handled: a time that doesn't exist
 * that day moves forward by the gap, a time that happens twice fires the first time). Times are "HH:mm", 24-hour.
 * - once: one time; the trigger is done after it fires (or is skipped)
 * - daily: at each of `times` on `days` (every day when missing); weekly is daily with one day
 * - monthly: on `day` (1..31, or "last"; a day past the month's end means its last day) at each of `times`
 * - interval: every `everyMinutes` (15..1440) from `from` (default "00:00") while not later than `until` (default
 *   "23:59") on `days`; the count restarts at `from` each day. A heartbeat is an interval trigger.
 */
export type Schedule =
  | { kind: "once"; at: string; timeZone: string }
  | { kind: "daily"; times: string[]; days?: Weekday[]; timeZone: string }
  | { kind: "monthly"; day: number | "last"; times: string[]; timeZone: string }
  | { kind: "interval"; everyMinutes: number; from?: string; until?: string; days?: Weekday[]; timeZone: string };

/**
 * How a trigger starts. An event trigger names one event source and 1 to 10 event types (or `["*"]`: every type from
 * that source). Lateness, catch-up and overlap apply to schedules only: events that arrive while a run is going gather
 * into one waiting run.
 */
export type TriggerStart =
  | { kind: "schedule"; schedule: Schedule }
  | { kind: "event"; source: string; types: string[] };

/** Limits the server checks. */
export const TRIGGER_LIMITS = {
  /** Event types one trigger may listen to. */
  eventTypes: 10,
  nameChars: 80,
  /** A notify message or a prompt. */
  textChars: 4_000,
  /** A complete report, including paragraphs and Markdown. */
  reportChars: 64_000,
  timesPerDay: 12,
  minIntervalMinutes: 15,
  allowEntries: 20,
  /** Default and maximum lateness; the default is also capped at the gap to the next run. */
  defaultLatenessMinutes: 120,
  maxLatenessMinutes: 1_440,
  /** Failed runs in a row before a trigger pauses itself. */
  failuresBeforePause: 3,
  /** Automatic retries of a run that failed on a transient model or provider error, with no side effect yet. */
  retries: 2,
} as const;

/**
 * - notify: posts `message` to the agent's home chat; no model call, so it is free and can't fail on an outage
 * - prompt: runs the agent with `prompt` as the brief
 * - skill: runs the agent with the saved skill `skill` and free-text `args`; the run records the skill version
 */
export type TriggerAction =
  | { kind: "notify"; message: string }
  | { kind: "prompt"; prompt: string }
  | { kind: "skill"; skill: string; args?: string };

/**
 * - always: every finished run sends a report to the home assistant (report() text, else its complete final reply)
 * - on_change: only when the agent calls report() (the default for checks)
 * - never: run history only
 * A failed run always posts a note unless the setting is "never"; pausing itself after failures always does.
 */
export type ReportSetting = "always" | "on_change" | "never";

/**
 * Something a trigger's runs may do without asking, beyond the profile: one tool, to one destination when the tool has
 * destinations (missing = any destination; a send from a run that read outside content needs a fixed destination).
 * Irreversible actions always ask; credentials are always a takeover.
 */
export interface TriggerAllow {
  tool: string;
  destination?: string;
}

/** An allow entry as the card and the page show it. */
export interface TriggerAllowView extends TriggerAllow {
  actionClass: ActionClass;
  /** The tool's one-line description. */
  label: string;
}

/**
 * - active: waiting for its next run
 * - paused: by you, by the agent, or by itself after failures (`pausedReason` says which)
 * - done: a one-time trigger that has fired or been skipped
 */
export type TriggerStatus = "active" | "paused" | "done";

export interface Trigger {
  id: TriggerId;
  name: string;
  agentId: AgentId;
  start: TriggerStart;
  /** The start in words, e.g. "Every day at 09:00 (Asia/Macau)" or "When items.new arrives from source my-service". */
  startText: string;
  action: TriggerAction;
  /** new: a new session per run (default). ongoing: one session for the trigger, which remembers earlier runs. */
  landing: "new" | "ongoing";
  /** Set for "ongoing" after the first run. */
  ongoingSessionId: SessionId | null;
  report: ReportSetting;
  /** Schedules only. A run that would start later than this after its time is skipped and logged as Skipped (late). */
  latenessMinutes: number;
  /** Schedules only. once: a time missed (e.g. while the server was down) runs once when back (default). skip: it is skipped as "missed". */
  catchUp: "once" | "skip";
  /** Schedules only. skip: a firing while the last run is still going is skipped as "overlap" (default). queue: it waits and starts when that run ends (one waits at most). */
  overlap: "skip" | "queue";
  /** The permission profile of its runs (never yolo). */
  profile: Exclude<ProfileName, "yolo">;
  allow: TriggerAllowView[];
  status: TriggerStatus;
  pausedReason: "user" | "agent" | "failures" | null;
  /** Failed runs in a row. */
  failures: number;
  /** Null when paused or done. */
  nextRunAt: number | null;
  /** When the newest event that started or joined one of its runs arrived (event triggers; null otherwise). */
  lastEventAt: number | null;
  lastRun: TriggerRunSummary | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * - queued: made while the last run was still going (overlap "queue"); it starts when that run ends
 * - running: the run is going
 * - waiting: the run is blocked on you (an approval or a takeover in its session)
 * - succeeded, failed (with `reason`)
 * - skipped: `reason` is "late", "missed" (catch-up "skip"), "overlap" (the previous run was still going) or "paused"
 */
export type TriggerRunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "skipped";

export interface TriggerRunSummary {
  id: TriggerRunId;
  triggerId: TriggerId;
  /** The time it was due. */
  scheduledAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: TriggerRunStatus;
  reason: string | null;
  /** True when you pressed Run now. */
  manual: boolean;
  /** The session the run used (null for notify, and for skipped runs). */
  sessionId: SessionId | null;
  runId: RunId | null;
  /** For a skill action: the version it used. */
  skillVersion: number | null;
  /** The report it posted, if any. */
  report: string | null;
  /** 0 for the first attempt. */
  attempt: number;
  /** The events this run was started for (at most 20; empty for schedules and Run now). */
  events: TriggerRunEvent[];
  /** Events that arrived for this run beyond the 20 it keeps (the oldest were dropped). */
  droppedEvents: number;
}

/** One event a run was started for. `ref` is the sender's pointer, never the content. */
export interface TriggerRunEvent {
  id: string;
  type: string;
  ref: string;
  receivedAt: number;
}

/** An event source as the Triggers page shows it (read-only; sources are made and rotated with `./rei sources`). */
export interface EventSourceView {
  id: string;
  name: string;
  status: "active" | "disabled";
  /** When the newest event arrived, or null. */
  lastEventAt: number | null;
  /** The event types seen in the last 30 days. */
  types: string[];
}
/** GET /api/event-sources */
export interface EventSourcesResponse {
  sources: EventSourceView[];
}

/** GET /api/triggers */
export interface TriggersResponse {
  triggers: Trigger[];
}
/** POST /api/triggers: create a scheduled or event-driven trigger from the trusted UI. */
export interface CreateTriggerRequest {
  agentId: string;
  name: string;
  start: TriggerStart;
  action: TriggerAction;
  landing?: "new" | "ongoing";
  report?: ReportSetting;
  latenessMinutes?: number;
  catchUp?: "once" | "skip";
  overlap?: "skip" | "queue";
  profile?: Exclude<ProfileName, "yolo">;
}
export interface TriggerCreatedResponse {
  trigger: Trigger;
}

/** GET /api/triggers/:id[?before=<runId>]: the trigger and its newest 50 runs. Errors: "not_found". */
export interface TriggerResponse {
  trigger: Trigger;
  runs: TriggerRunSummary[];
  next: TriggerRunId | null;
}

/**
 * PATCH /api/triggers/:id: edit from the trusted UI; each changed field goes to the edit log. `paused: false` resumes
 * (and clears the failure count). The start is checked as in create_trigger. Errors: "not_found", "bad_request".
 */
export interface UpdateTriggerRequest {
  name?: string;
  start?: TriggerStart;
  action?: TriggerAction;
  landing?: "new" | "ongoing";
  report?: ReportSetting;
  latenessMinutes?: number;
  catchUp?: "once" | "skip";
  overlap?: "skip" | "queue";
  profile?: Exclude<ProfileName, "yolo">;
  /** Replaces the allow list; the page can only remove entries (adding one is the agent's card, or an approval). */
  allow?: TriggerAllow[];
  paused?: boolean;
}
export interface TriggerUpdatedResponse {
  trigger: Trigger;
}

/** POST /api/triggers/:id/run: run it now (not counted as missed or late; if a run is going: queued when overlap is "queue" and none waits, else skipped as "overlap"). */
export interface RunTriggerResponse {
  run: TriggerRunSummary;
}

/** DELETE /api/triggers/:id[?withSessions=1]: removes the trigger and its run history; with withSessions its sessions too. */

/**
 * What a trigger card shows (an approval of create_trigger or update_trigger), computed when the call is blocked.
 * For an update, `before` holds the current trigger so the card can show what changes.
 */
export interface TriggerPreview {
  kind: "trigger";
  op: "create" | "update" | "delete";
  name: string;
  agentName: string;
  startText: string;
  /** Whether it starts on a schedule or on events (lateness, catch-up and overlap are for schedules). */
  startKind: TriggerStart["kind"];
  /** The next three run times (empty for delete, or a one-time trigger in the past). */
  nextRuns: number[];
  action: TriggerAction;
  landing: "new" | "ongoing";
  report: ReportSetting;
  latenessMinutes: number;
  catchUp: "once" | "skip";
  overlap: "skip" | "queue";
  profile: Exclude<ProfileName, "yolo">;
  allow: TriggerAllowView[];
  /** For a skill action: what the skill says it needs (its allowed-tools), which grants nothing by itself. */
  skillNeeds?: string[];
  before?: Omit<TriggerPreview, "kind" | "op" | "before">;
}

/**
 * A trigger event in the agent's home chat (Message.role "trigger"). Reports, failures and pauses
 * start an assistant turn; detail mode links to the source session without showing the raw input. Plain notify reminders start no turn.
 * - notify: a notify action's message
 * - report: a run's report
 * - failed: a run failed (after its retries)
 * - paused: the trigger paused itself after failures in a row
 */
export interface TriggerMessage {
  kind: "notify" | "report" | "failed" | "paused";
  triggerId: TriggerId;
  triggerName: string;
  triggerRunId: TriggerRunId | null;
  /** The run's session, to open from the line. */
  sessionId: SessionId | null;
  text: string;
}
