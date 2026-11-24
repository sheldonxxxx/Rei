import type { ReportSetting, Schedule, Trigger, TriggerRunSummary, Weekday } from "@rei/protocol";
import { TRIGGER_LIMITS } from "@rei/protocol";

export const WEEKDAYS: { id: Weekday; label: string }[] = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
];

export const REPORT_LABEL: Record<ReportSetting, string> = {
  always: "Every run",
  on_change: "Only when something changed",
  never: "Never (history only)",
};
export const CATCH_UP_LABEL = { once: "Run it once when back", skip: "Skip it" } as const;
export const OVERLAP_LABEL = { skip: "Skip this run", queue: "Run it after" } as const;
export const LANDING_LABEL = { new: "A new chat each run", ongoing: "One ongoing chat" } as const;

/** What a trigger does, in a few words: "Message: Pay rent", "Run a prompt", "Skill: weekly-review". */
export function actionText(a: Trigger["action"]): string {
  if (a.kind === "notify") return `Message: ${a.message}`;
  if (a.kind === "prompt") return `Prompt: ${a.prompt}`;
  return `Skill: ${a.skill}${a.args ? ` (${a.args})` : ""}`;
}

export const TRIGGER_BADGE_VARIANT = {
  ok: "success",
  warn: "attention",
  bad: "destructive",
  busy: "default",
  off: "secondary",
} as const;

/** The status chip on the Triggers page: Active, Paused (by you / by the agent / after failures), Done. */
export function statusChip(t: Pick<Trigger, "status" | "pausedReason">): {
  label: string;
  tone: "ok" | "warn" | "off";
} {
  if (t.status === "active") return { label: "Active", tone: "ok" };
  if (t.status === "done") return { label: "Done", tone: "off" };
  const why =
    t.pausedReason === "failures"
      ? "after failures"
      : t.pausedReason === "agent"
        ? "by the agent"
        : t.pausedReason === "user"
          ? "by you"
          : "";
  return { label: why ? `Paused ${why}` : "Paused", tone: "warn" };
}

const RUN_LABEL: Record<TriggerRunSummary["status"], string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting for you",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
};

/** A run's outcome with its reason: "Failed: model_error", "Skipped (late)", "Skipped (missed)". */
export function runStatusText(r: Pick<TriggerRunSummary, "status" | "reason">): string {
  const label = RUN_LABEL[r.status];
  if (!r.reason) return label;
  return r.status === "skipped" ? `${label} (${r.reason})` : `${label}: ${r.reason}`;
}

/** The chip tone for a run status; the label always says it too. */
export const runTone = (status: TriggerRunSummary["status"]): "ok" | "warn" | "bad" | "busy" | "off" =>
  status === "succeeded"
    ? "ok"
    : status === "failed"
      ? "bad"
      : status === "waiting"
        ? "warn"
        : status === "running"
          ? "busy"
          : "off";

/** A trigger's next run: "08:30" today, otherwise "Mon 2 Nov, 08:30" (with the year when it is not this one). The hour is two digits, like the schedule text. */
export function formatNextRun(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString(
    undefined,
    sameYear
      ? { weekday: "short", day: "numeric", month: "short" }
      : { weekday: "short", day: "numeric", month: "short", year: "numeric" },
  );
  return `${date}, ${time}`;
}

/** "42 s", "3 min", "1 h 5 min". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

// ---- the schedule editor's draft -----------------------------------------------------------------------------------------

/** A schedule as the form holds it: text fields for every kind, so switching kinds loses nothing. */
export interface ScheduleDraft {
  kind: Schedule["kind"];
  timeZone: string;
  /** once: "YYYY-MM-DDTHH:mm". */
  at: string;
  /** daily and monthly. */
  times: string[];
  /** daily and interval; empty means every day. */
  days: Weekday[];
  /** monthly: "1".."31" or "last". */
  day: string;
  /** interval. */
  everyMinutes: string;
  from: string;
  until: string;
}

export const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const pad = (n: number) => String(n).padStart(2, "0");
/** Tomorrow 09:00 in the browser's zone, as a datetime-local value. */
function tomorrowAtNine(): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

export function draftFromSchedule(s: Schedule | null, timeZone: string = browserTimeZone()): ScheduleDraft {
  const base: ScheduleDraft = {
    kind: "daily",
    timeZone,
    at: tomorrowAtNine(),
    times: ["09:00"],
    days: [],
    day: "1",
    everyMinutes: "60",
    from: "00:00",
    until: "23:59",
  };
  if (!s) return base;
  base.kind = s.kind;
  base.timeZone = s.timeZone || timeZone;
  if (s.kind === "once") base.at = s.at;
  else if (s.kind === "daily") {
    base.times = [...s.times];
    base.days = s.days ?? [];
  } else if (s.kind === "monthly") {
    base.times = [...s.times];
    base.day = String(s.day);
  } else {
    base.everyMinutes = String(s.everyMinutes);
    base.from = s.from ?? "00:00";
    base.until = s.until ?? "23:59";
    base.days = s.days ?? [];
  }
  return base;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ONCE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const orderedDays = (days: Weekday[]): Weekday[] => WEEKDAYS.map((d) => d.id).filter((d) => days.includes(d));

/**
 * The schedule a draft stands for, in one canonical shape (times sorted and unique, days in week order, defaults left out),
 * or the sentence saying what is wrong. The server checks again.
 */
export function scheduleFromDraft(d: ScheduleDraft): { schedule: Schedule } | { error: string } {
  const timeZone = d.timeZone.trim();
  if (!timeZone) return { error: "Enter a time zone, like Asia/Macau." };
  if (d.kind === "once") {
    if (!ONCE.test(d.at)) return { error: "Pick the date and time." };
    return { schedule: { kind: "once", at: d.at, timeZone } };
  }
  if (d.kind === "interval") {
    const every = Number(d.everyMinutes);
    if (!Number.isInteger(every) || every < TRIGGER_LIMITS.minIntervalMinutes || every > 1_440)
      return { error: `Repeat every ${TRIGGER_LIMITS.minIntervalMinutes} to 1440 minutes.` };
    if (!TIME.test(d.from) || !TIME.test(d.until)) return { error: "Enter the start and end times." };
    if (d.from >= d.until) return { error: "The start time must be before the end time." };
    const days = orderedDays(d.days);
    return {
      schedule: {
        kind: "interval",
        everyMinutes: every,
        ...(d.from === "00:00" ? {} : { from: d.from }),
        ...(d.until === "23:59" ? {} : { until: d.until }),
        ...(days.length > 0 && days.length < 7 ? { days } : {}),
        timeZone,
      },
    };
  }
  const times = [...new Set(d.times)].sort();
  if (times.length === 0) return { error: "Add at least one time." };
  if (times.length > TRIGGER_LIMITS.timesPerDay) return { error: `Use at most ${TRIGGER_LIMITS.timesPerDay} times.` };
  if (!times.every((t) => TIME.test(t))) return { error: "Enter every time as hours and minutes." };
  if (d.kind === "monthly") {
    const day = d.day === "last" ? "last" : Number(d.day);
    if (day !== "last" && (!Number.isInteger(day) || day < 1 || day > 31))
      return { error: "Pick a day from 1 to 31, or the last day." };
    return { schedule: { kind: "monthly", day, times, timeZone } };
  }
  const days = orderedDays(d.days);
  return { schedule: { kind: "daily", times, ...(days.length > 0 && days.length < 7 ? { days } : {}), timeZone } };
}

/** The known IANA zones, for the zone field's suggestions (empty where the browser can't list them). */
export function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}
