/** Section heading for the session list: "Today", "Yesterday", "Previous 7 days", "Previous 30 days", then month (and year). */
export function dateGroup(ts: number, now: number = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "long" } : { month: "long", year: "numeric" });
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** Coarse time left until `at`: "less than a minute", "12 minutes", "2 hours", "3 days". */
export function timeLeft(at: number, now: number = Date.now()): string {
  const ms = Math.max(0, at - now);
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return "less than a minute";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.round(ms / 86_400_000), "day");
}

/** A moment for a log line: the time today, otherwise the date and time. */
export function formatWhen(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const same = d.toDateString() === new Date(now).toDateString();
  if (same) return time;
  const date = d.toLocaleDateString(
    undefined,
    d.getFullYear() === new Date(now).getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
  return `${date}, ${time}`;
}

/** How long ago, in words: "just now", "5 minutes ago", "yesterday", "3 months ago". */
export function ago(ts: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - ts);
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.floor(ms / 86_400_000);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${plural(months, "month")} ago`;
  return `${plural(Math.floor(days / 365), "year")} ago`;
}
