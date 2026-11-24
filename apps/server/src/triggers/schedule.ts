// Schedules: wall-clock times in an IANA zone. Pure: no clock, no I/O. A wall time becomes an instant through Intl
// alone (no library), correct for zones with 30 and 45 minute offsets and for zones without daylight saving.
import type { Schedule, TriggerStart, Weekday } from "@rei/protocol";
import { TRIGGER_LIMITS } from "@rei/protocol";
import { Invalid } from "../util/errors.ts";
import { knownTimeZone } from "../util/time.ts";

export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
const DAY_FULL: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** How far ahead (and back) occurrences are looked for. */
const SEARCH_DAYS = 400;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ONCE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

// ---- validation ----------------------------------------------------------------------------------------------------

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

function checkTime(value: unknown, what: string): string {
  if (typeof value !== "string" || !TIME.test(value))
    throw new Invalid(`${what} must be a time like "09:00" (24-hour, HH:mm).`);
  return value;
}

function checkTimes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Invalid('times must be a list of one to twelve times like "09:00".');
  if (value.length > TRIGGER_LIMITS.timesPerDay)
    throw new Invalid(`A schedule can have at most ${TRIGGER_LIMITS.timesPerDay} times a day.`);
  const times = value.map((t) => checkTime(t, "Each time"));
  if (new Set(times).size !== times.length) throw new Invalid("The times must all be different.");
  return times.sort();
}

function checkDays(value: unknown): Weekday[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0)
    throw new Invalid(`days must be a list of ${WEEKDAYS.join(", ")} (leave it out for every day).`);
  for (const d of value)
    if (typeof d !== "string" || !WEEKDAYS.includes(d as Weekday))
      throw new Invalid(`"${String(d)}" is not a day; use ${WEEKDAYS.join(", ")}.`);
  if (new Set(value).size !== value.length) throw new Invalid("The days must all be different.");
  const days = WEEKDAYS.filter((d) => value.includes(d));
  return days.length === 7 ? undefined : days;
}

/** A schedule as the server keeps it: checked, with the zone filled in, times and days sorted. Throws Invalid with one sentence. */
export function validateSchedule(s: unknown, defaultTz: string): Schedule {
  if (typeof s !== "object" || s === null || Array.isArray(s))
    throw new Invalid("The schedule must be an object with a kind: once, daily, monthly or interval.");
  const o = s as Record<string, unknown>;
  let timeZone = defaultTz;
  if (o.timeZone !== undefined && o.timeZone !== null && o.timeZone !== "") {
    const known = knownTimeZone(o.timeZone);
    if (!known)
      throw new Invalid(
        `"${String(o.timeZone)}" is not a time zone this server knows; use an IANA name like Asia/Macau.`,
      );
    timeZone = known;
  } else if (!knownTimeZone(defaultTz)) {
    throw new Invalid("The schedule needs a time zone, as an IANA name like Asia/Macau.");
  }
  switch (o.kind) {
    case "once": {
      const m = typeof o.at === "string" ? ONCE.exec(o.at) : null;
      if (!m)
        throw new Invalid(
          'A one-time schedule needs "at" as a local date and time like "2026-11-01T09:00" (no seconds).',
        );
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo))
        throw new Invalid(`"${o.at as string}" is not a real date.`);
      return { kind: "once", at: o.at as string, timeZone };
    }
    case "daily": {
      const days = checkDays(o.days);
      return { kind: "daily", times: checkTimes(o.times), ...(days ? { days } : {}), timeZone };
    }
    case "monthly": {
      const day = o.day;
      if (day !== "last" && !(typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31))
        throw new Invalid('A monthly schedule needs "day" as a number from 1 to 31, or "last".');
      return { kind: "monthly", day, times: checkTimes(o.times), timeZone };
    }
    case "interval": {
      const every = o.everyMinutes;
      if (
        typeof every !== "number" ||
        !Number.isInteger(every) ||
        every < TRIGGER_LIMITS.minIntervalMinutes ||
        every > 1_440
      ) {
        throw new Invalid(`everyMinutes must be a whole number from ${TRIGGER_LIMITS.minIntervalMinutes} to 1440.`);
      }
      const from = o.from === undefined ? undefined : checkTime(o.from, "from");
      const until = o.until === undefined ? undefined : checkTime(o.until, "until");
      if (minutesOf(from ?? "00:00") >= minutesOf(until ?? "23:59"))
        throw new Invalid("from must be earlier than until.");
      const days = checkDays(o.days);
      return {
        kind: "interval",
        everyMinutes: every,
        ...(from !== undefined ? { from } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(days ? { days } : {}),
        timeZone,
      };
    }
    default:
      throw new Invalid("The schedule's kind must be once, daily, monthly or interval.");
  }
}

// ---- zones: wall time and instants ---------------------------------------------------------------------------------

const formats = new Map<string, Intl.DateTimeFormat>();
function wallFormat(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timeZone, f);
  }
  return f;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}
function wallOf(ms: number, timeZone: string): Wall {
  const out: Record<string, number> = {};
  for (const p of wallFormat(timeZone).formatToParts(ms)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { y: out.year!, mo: out.month!, d: out.day!, h: out.hour!, mi: out.minute!, s: out.second! };
}

/** The zone's offset from UTC at an instant, in milliseconds (positive east). */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallOf(ms, timeZone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of a local date and minute of the day. A time that does not exist (the clocks jumped over it) moves
 * forward by the gap; a time that happens twice is the earlier one.
 */
function instantOf(day: number, minutes: number, timeZone: string): number {
  const local = day * DAY_MS + minutes * MINUTE_MS; // the wall time read as if it were UTC
  const before = offsetAt(local - DAY_MS, timeZone);
  const after = offsetAt(local + DAY_MS, timeZone);
  const candidates = [...new Set([local - before, local - after])].filter((c) => offsetAt(c, timeZone) === local - c);
  if (candidates.length > 0) return Math.min(...candidates);
  return local - before;
}

const dayNumber = (y: number, mo: number, d: number): number => Math.floor(Date.UTC(y, mo - 1, d) / DAY_MS);
const dateOfDay = (day: number): { y: number; mo: number; d: number; weekday: Weekday } => {
  const date = new Date(day * DAY_MS);
  return {
    y: date.getUTCFullYear(),
    mo: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    weekday: WEEKDAYS[(date.getUTCDay() + 6) % 7]!,
  };
};
export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
const dayOf = (ms: number, timeZone: string): number => {
  const w = wallOf(ms, timeZone);
  return dayNumber(w.y, w.mo, w.d);
};

function onceInstant(s: Extract<Schedule, { kind: "once" }>): number {
  const m = ONCE.exec(s.at)!;
  return instantOf(dayNumber(Number(m[1]), Number(m[2]), Number(m[3])), Number(m[4]) * 60 + Number(m[5]), s.timeZone);
}

/** The instants a schedule fires on one local calendar day, earliest first (none when the day does not match). */
function occurrencesOn(s: Schedule, day: number): number[] {
  const date = dateOfDay(day);
  const at = (minutes: number): number => instantOf(day, minutes, s.timeZone);
  let minutes: number[] = [];
  switch (s.kind) {
    case "once":
      return [];
    case "daily":
      if (!s.days || s.days.includes(date.weekday)) minutes = s.times.map(minutesOf);
      break;
    case "monthly": {
      const last = daysInMonth(date.y, date.mo);
      if (date.d === (s.day === "last" ? last : Math.min(s.day, last))) minutes = s.times.map(minutesOf);
      break;
    }
    case "interval": {
      if (s.days && !s.days.includes(date.weekday)) break;
      const until = minutesOf(s.until ?? "23:59");
      for (let m = minutesOf(s.from ?? "00:00"); m <= until; m += s.everyMinutes) minutes.push(m);
      break;
    }
  }
  return [...new Set(minutes.map(at))].sort((a, b) => a - b);
}

/** The next `count` instants strictly after `afterMs` (fewer when none is within about 400 days). */
export function nextRuns(s: Schedule, afterMs: number, count: number): number[] {
  if (s.kind === "once") return count > 0 && onceInstant(s) > afterMs ? [onceInstant(s)] : [];
  const out: number[] = [];
  const first = dayOf(afterMs, s.timeZone) - 1;
  for (let day = first; day <= first + SEARCH_DAYS && out.length < count; day++) {
    for (const t of occurrencesOn(s, day)) {
      if (t > afterMs && out.length < count) out.push(t);
    }
  }
  return out;
}

/** The latest occurrence in (fromMs, toMs], for catching up after the server was down; null when there is none. */
export function latestDue(s: Schedule, fromMs: number, toMs: number): number | null {
  if (toMs <= fromMs) return null;
  if (s.kind === "once") {
    const t = onceInstant(s);
    return t > fromMs && t <= toMs ? t : null;
  }
  const lowest = Math.max(dayOf(fromMs, s.timeZone) - 1, dayOf(toMs, s.timeZone) - SEARCH_DAYS);
  for (let day = dayOf(toMs, s.timeZone) + 1; day >= lowest; day--) {
    const found = occurrencesOn(s, day).filter((t) => t > fromMs && t <= toMs);
    if (found.length > 0) return found[found.length - 1]!;
  }
  return null;
}

/** The shortest gap between consecutive runs among the next several after `afterMs`, in milliseconds; null for a schedule that fires once or less. */
export function minGapMs(s: Schedule, afterMs: number): number | null {
  const runs = nextRuns(s, afterMs, 16);
  if (runs.length < 2) return null;
  let gap = Infinity;
  for (let i = 1; i < runs.length; i++) gap = Math.min(gap, runs[i]! - runs[i - 1]!);
  return gap;
}

// ---- in words ------------------------------------------------------------------------------------------------------

const list = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The days as words: "weekdays", "weekends", "Mondays", or "Mon, Wed and Fri"; undefined for every day. */
function daysText(days: readonly Weekday[] | undefined): string | undefined {
  if (!days) return undefined;
  if (same(days, ["mon", "tue", "wed", "thu", "fri"])) return "weekdays";
  if (same(days, ["sat", "sun"])) return "weekends";
  return days.length === 1 ? `${DAY_FULL[days[0]!]}s` : list(days.map((d) => DAY_NAMES[d]));
}

function everyText(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} minutes`;
}

/** The schedule in plain English, for the card and the page. */
export function scheduleText(s: Schedule): string {
  const zone = `(${s.timeZone})`;
  switch (s.kind) {
    case "once": {
      const m = ONCE.exec(s.at)!;
      const date = dateOfDay(dayNumber(Number(m[1]), Number(m[2]), Number(m[3])));
      return `Once on ${DAY_NAMES[date.weekday]} ${date.d} ${MONTH_NAMES[date.mo - 1]} ${date.y} at ${m[4]}:${m[5]} ${zone}`;
    }
    case "daily": {
      const days = daysText(s.days);
      return `${days === undefined ? "Every day" : days[0]!.toUpperCase() + days.slice(1)} at ${list(s.times)} ${zone}`;
    }
    case "monthly":
      return `${s.day === "last" ? "On the last day of each month" : `On day ${s.day} of each month`} at ${list(s.times)} ${zone}`;
    case "interval": {
      const days = daysText(s.days);
      const range =
        s.from !== undefined || s.until !== undefined ? ` from ${s.from ?? "00:00"} to ${s.until ?? "23:59"}` : "";
      return `Every ${everyText(s.everyMinutes)}${days === undefined ? "" : `, ${days}`}${range} ${zone}`;
    }
  }
}

/** An instant as wall-clock words in the schedule's zone, e.g. "Mon 2 Nov 2026 at 09:00 (Asia/Macau)". */
export function whenText(ms: number, timeZone: string): string {
  const w = wallOf(ms, timeZone);
  const date = dateOfDay(dayNumber(w.y, w.mo, w.d));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAY_NAMES[date.weekday]} ${w.d} ${MONTH_NAMES[w.mo - 1]} ${w.y} at ${two(w.h)}:${two(w.mi)} (${timeZone})`;
}

/** A trigger's start in plain English: the schedule, or the events it waits for. */
export function startText(start: TriggerStart): string {
  if (start.kind === "schedule") return scheduleText(start.schedule);
  const t = start.types;
  const what =
    t.length === 1 && t[0] === "*"
      ? "any event"
      : t.length <= 1
        ? (t[0] ?? "")
        : `${t.slice(0, -1).join(", ")} or ${t[t.length - 1]}`;
  return `When ${what} arrives from source ${start.source}`;
}
