// Calendar days in the user's time zone. The process zone is the user's (TZ, which `rei setup` sets from the host); a
// request from the PWA may name the browser's zone instead.

const formats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let f = formats.get(key);
  if (!f) {
    // en-CA formats a date as YYYY-MM-DD.
    f = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
    formats.set(key, f);
  }
  return f;
}

/** The IANA zone if it is one this runtime knows, else undefined. */
export function knownTimeZone(timeZone: unknown): string | undefined {
  if (typeof timeZone !== "string" || timeZone === "" || timeZone.length > 64) return undefined;
  try {
    dayFormat(timeZone);
    return timeZone;
  } catch {
    return undefined;
  }
}

/** The date of `ms` as YYYY-MM-DD in `timeZone`, or in the process zone. */
export function localDay(ms: number, timeZone?: string): string {
  return dayFormat(timeZone).format(ms);
}

/** A YYYY-MM-DD date as its first and last millisecond in the process zone, or undefined when it is not a date. */
export function localDayRange(date: string): { start: number; end: number } | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const start = new Date(y, mo, d).getTime();
  const next = new Date(y, mo, d + 1).getTime();
  return Number.isNaN(start) ? undefined : { start, end: next - 1 };
}
