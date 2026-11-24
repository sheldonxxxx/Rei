import type { Schedule } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import { latestDue, minGapMs, nextRuns, scheduleText, validateSchedule } from "../src/triggers/schedule.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const daily = (times: string[], timeZone: string): Schedule => ({
  kind: "daily",
  times,
  timeZone,
});
const at = (s: string) => Date.parse(s);

describe("validateSchedule", () => {
  const v = (s: unknown) => validateSchedule(s, "Asia/Macau");
  it("fills the zone, sorts times and days, drops a full week of days", () => {
    expect(v({ kind: "daily", times: ["18:00", "08:30"] })).toEqual({
      kind: "daily",
      times: ["08:30", "18:00"],
      timeZone: "Asia/Macau",
    });
    expect(v({ kind: "daily", times: ["09:00"], days: ["fri", "mon"], timeZone: "Europe/London" })).toEqual({
      kind: "daily",
      times: ["09:00"],
      days: ["mon", "fri"],
      timeZone: "Europe/London",
    });
    expect(
      v({ kind: "daily", times: ["09:00"], days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }),
    ).not.toHaveProperty("days");
  });
  it("refuses with one sentence", () => {
    const bad = (s: unknown, re: RegExp) => expect(() => v(s)).toThrow(re);
    bad(null, /object/);
    bad({ kind: "weekly" }, /kind/);
    bad({ kind: "daily", times: ["9:00"] }, /HH:mm/);
    bad({ kind: "daily", times: ["24:00"] }, /HH:mm/);
    bad({ kind: "daily", times: [] }, /times/);
    bad({ kind: "daily", times: ["09:00", "09:00"] }, /different/);
    bad(
      { kind: "daily", times: Array.from({ length: 13 }, (_, i) => `${String(i).padStart(2, "0")}:00`) },
      /at most 12/,
    );
    bad({ kind: "daily", times: ["09:00"], timeZone: "Mars/Olympus" }, /time zone/);
    bad({ kind: "daily", times: ["09:00"], days: ["mon", "mon"] }, /different/);
    bad({ kind: "daily", times: ["09:00"], days: ["funday"] }, /not a day/);
    bad({ kind: "monthly", day: 32, times: ["09:00"] }, /1 to 31/);
    bad({ kind: "monthly", day: "first", times: ["09:00"] }, /1 to 31/);
    bad({ kind: "interval", everyMinutes: 5 }, /15 to 1440/);
    bad({ kind: "interval", everyMinutes: 1441 }, /15 to 1440/);
    bad({ kind: "interval", everyMinutes: 60, from: "10:00", until: "10:00" }, /earlier/);
    bad({ kind: "once", at: "2026-11-01T09:00:30" }, /no seconds/);
    bad({ kind: "once", at: "2026-02-30T09:00" }, /real date/);
  });
  it("accepts monthly last and interval defaults", () => {
    expect(v({ kind: "monthly", day: "last", times: ["18:00"] })).toMatchObject({ day: "last" });
    expect(v({ kind: "interval", everyMinutes: 15 })).toEqual({
      kind: "interval",
      everyMinutes: 15,
      timeZone: "Asia/Macau",
    });
  });
});

describe("nextRuns across daylight saving", () => {
  it("a time inside the spring-forward gap moves forward by the gap (Europe/London)", () => {
    const s = daily(["01:30"], "Europe/London");
    // 2026-03-29: 01:00 -> 02:00 does not exist. 01:30 becomes 02:30 BST = 01:30Z.
    expect(nextRuns(s, at("2026-03-28T12:00:00Z"), 1).map(iso)).toEqual(["2026-03-29T01:30:00.000Z"]);
    expect(nextRuns(s, at("2026-03-29T12:00:00Z"), 1).map(iso)).toEqual(["2026-03-30T00:30:00.000Z"]);
  });
  it("02:30 in New York's gap becomes 03:30 EDT", () => {
    const s = daily(["02:30"], "America/New_York");
    expect(nextRuns(s, at("2026-03-07T12:00:00Z"), 1).map(iso)).toEqual(["2026-03-08T07:30:00.000Z"]);
  });
  it("an ambiguous time (fall back) takes the earlier instant, once", () => {
    const s = daily(["01:30"], "America/New_York");
    expect(nextRuns(s, at("2026-10-31T12:00:00Z"), 2).map(iso)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
    const london = daily(["01:30"], "Europe/London");
    expect(nextRuns(london, at("2026-10-24T12:00:00Z"), 1).map(iso)).toEqual(["2026-10-25T00:30:00.000Z"]);
  });
  it("Lord Howe has a 30-minute shift", () => {
    const s = daily(["02:10", "12:00"], "Australia/Lord_Howe");
    // DST starts 2026-10-04 at 02:00 (+10:30 -> +11:00): 02:10 does not exist and moves to 02:40 (+11) = 15:40Z the day before.
    const runs = nextRuns(s, at("2026-10-03T02:00:00Z"), 3).map(iso);
    expect(runs).toEqual(["2026-10-03T15:40:00.000Z", "2026-10-04T01:00:00.000Z", "2026-10-04T15:10:00.000Z"]);
  });
  it("Kathmandu is +05:45 and Macau has no DST", () => {
    expect(nextRuns(daily(["09:00"], "Asia/Kathmandu"), at("2026-06-01T00:00:00Z"), 1).map(iso)).toEqual([
      "2026-06-01T03:15:00.000Z",
    ]);
    expect(nextRuns(daily(["09:00"], "Asia/Macau"), at("2026-06-01T02:00:00Z"), 2).map(iso)).toEqual([
      "2026-06-02T01:00:00.000Z",
      "2026-06-03T01:00:00.000Z",
    ]);
    expect(nextRuns(daily(["09:00"], "Asia/Macau"), at("2026-01-01T02:00:00Z"), 1).map(iso)).toEqual([
      "2026-01-02T01:00:00.000Z",
    ]);
  });
  it("is strictly after, and sorted for several times", () => {
    const s = daily(["18:00", "08:30"], "Asia/Macau");
    expect(nextRuns(s, at("2026-06-01T00:30:00Z"), 3).map(iso)).toEqual([
      "2026-06-01T10:00:00.000Z",
      "2026-06-02T00:30:00.000Z",
      "2026-06-02T10:00:00.000Z",
    ]);
    expect(nextRuns(s, at("2026-06-01T00:30:00Z") - 1, 1).map(iso)).toEqual(["2026-06-01T00:30:00.000Z"]);
  });
  it("weekday filter", () => {
    const s: Schedule = { kind: "daily", times: ["09:00"], days: ["mon", "fri"], timeZone: "Asia/Macau" };
    // 2026-11-01 is a Sunday.
    expect(nextRuns(s, at("2026-11-01T00:00:00Z"), 3).map(iso)).toEqual([
      "2026-11-02T01:00:00.000Z",
      "2026-11-06T01:00:00.000Z",
      "2026-11-09T01:00:00.000Z",
    ]);
  });
});

describe("monthly", () => {
  const m = (day: number | "last"): Schedule => ({ kind: "monthly", day, times: ["09:00"], timeZone: "Asia/Macau" });
  it("a day past the month's end means its last day", () => {
    expect(nextRuns(m(31), at("2027-01-31T02:00:00Z"), 3).map(iso)).toEqual([
      "2027-02-28T01:00:00.000Z",
      "2027-03-31T01:00:00.000Z",
      "2027-04-30T01:00:00.000Z",
    ]);
    expect(nextRuns(m(31), at("2028-01-31T02:00:00Z"), 1).map(iso)).toEqual(["2028-02-29T01:00:00.000Z"]);
  });
  it("last", () => {
    expect(nextRuns(m("last"), at("2027-02-01T00:00:00Z"), 2).map(iso)).toEqual([
      "2027-02-28T01:00:00.000Z",
      "2027-03-31T01:00:00.000Z",
    ]);
  });
  it("day 1", () => {
    expect(nextRuns(m(1), at("2026-11-01T01:00:00Z"), 1).map(iso)).toEqual(["2026-12-01T01:00:00.000Z"]);
  });
});

describe("interval", () => {
  const s: Schedule = { kind: "interval", everyMinutes: 120, from: "08:00", until: "22:00", timeZone: "Asia/Macau" };
  it("restarts at from each day and includes until", () => {
    const runs = nextRuns(s, at("2026-06-01T12:30:00Z"), 3).map(iso); // 20:30 local
    expect(runs).toEqual(["2026-06-01T14:00:00.000Z", "2026-06-02T00:00:00.000Z", "2026-06-02T02:00:00.000Z"]);
  });
  it("does not fire after until", () => {
    const t = nextRuns(
      { kind: "interval", everyMinutes: 90, from: "08:00", until: "10:00", timeZone: "Asia/Macau" },
      at("2026-06-01T02:00:00Z"),
      3,
    ).map(iso); // 10:00 local = 02:00Z, after
    expect(t).toEqual(["2026-06-02T00:00:00.000Z", "2026-06-02T01:30:00.000Z", "2026-06-03T00:00:00.000Z"]);
  });
  it("weekdays only", () => {
    const w: Schedule = {
      kind: "interval",
      everyMinutes: 30,
      from: "09:00",
      until: "18:00",
      days: ["mon", "tue", "wed", "thu", "fri"],
      timeZone: "Asia/Macau",
    };
    expect(nextRuns(w, at("2026-11-06T10:00:00Z"), 1).map(iso)).toEqual(["2026-11-09T01:00:00.000Z"]); // Fri 18:00 local passed, so Monday
  });
});

describe("once", () => {
  const s: Schedule = { kind: "once", at: "2026-11-01T09:00", timeZone: "Asia/Macau" };
  it("fires once, never in the past", () => {
    expect(nextRuns(s, at("2026-10-01T00:00:00Z"), 5).map(iso)).toEqual(["2026-11-01T01:00:00.000Z"]);
    expect(nextRuns(s, at("2026-11-01T01:00:00Z"), 5)).toEqual([]);
    expect(latestDue(s, at("2026-10-01T00:00:00Z"), at("2026-12-01T00:00:00Z"))).toBe(at("2026-11-01T01:00:00Z"));
    expect(latestDue(s, at("2026-11-02T00:00:00Z"), at("2026-12-01T00:00:00Z"))).toBeNull();
  });
});

describe("latestDue", () => {
  const s: Schedule = { kind: "daily", times: ["09:00", "18:00"], timeZone: "Asia/Macau" };
  it("is the latest occurrence in (from, to]", () => {
    expect(latestDue(s, at("2026-06-01T00:00:00Z"), at("2026-06-03T05:00:00Z"))).toBe(at("2026-06-03T01:00:00Z"));
    expect(latestDue(s, at("2026-06-03T01:00:00Z"), at("2026-06-03T05:00:00Z"))).toBeNull();
    expect(latestDue(s, at("2026-06-03T00:59:59Z"), at("2026-06-03T01:00:00Z"))).toBe(at("2026-06-03T01:00:00Z"));
    expect(latestDue(s, at("2026-06-03T05:00:00Z"), at("2026-06-03T00:00:00Z"))).toBeNull();
  });
});

describe("scheduleText", () => {
  it("reads as plain English", () => {
    const tz = "Asia/Macau";
    expect(scheduleText({ kind: "once", at: "2026-11-01T09:00", timeZone: tz })).toBe(
      "Once on Sun 1 Nov 2026 at 09:00 (Asia/Macau)",
    );
    expect(scheduleText({ kind: "daily", times: ["09:00"], timeZone: tz })).toBe("Every day at 09:00 (Asia/Macau)");
    expect(scheduleText({ kind: "daily", times: ["08:30", "18:00"], days: ["mon", "wed", "fri"], timeZone: tz })).toBe(
      "Mon, Wed and Fri at 08:30 and 18:00 (Asia/Macau)",
    );
    expect(
      scheduleText({ kind: "daily", times: ["07:00"], days: ["mon", "tue", "wed", "thu", "fri"], timeZone: tz }),
    ).toBe("Weekdays at 07:00 (Asia/Macau)");
    expect(scheduleText({ kind: "daily", times: ["10:00"], days: ["sat", "sun"], timeZone: tz })).toBe(
      "Weekends at 10:00 (Asia/Macau)",
    );
    expect(scheduleText({ kind: "monthly", day: 1, times: ["09:00"], timeZone: tz })).toBe(
      "On day 1 of each month at 09:00 (Asia/Macau)",
    );
    expect(scheduleText({ kind: "monthly", day: "last", times: ["18:00"], timeZone: tz })).toBe(
      "On the last day of each month at 18:00 (Asia/Macau)",
    );
    expect(scheduleText({ kind: "interval", everyMinutes: 120, from: "08:00", until: "22:00", timeZone: tz })).toBe(
      "Every 2 hours from 08:00 to 22:00 (Asia/Macau)",
    );
    expect(
      scheduleText({
        kind: "interval",
        everyMinutes: 30,
        from: "09:00",
        until: "18:00",
        days: ["mon", "tue", "wed", "thu", "fri"],
        timeZone: tz,
      }),
    ).toBe("Every 30 minutes, weekdays from 09:00 to 18:00 (Asia/Macau)");
    expect(scheduleText({ kind: "interval", everyMinutes: 60, timeZone: tz })).toBe("Every 1 hour (Asia/Macau)");
  });
});

describe("minGapMs", () => {
  it("is the shortest gap, null for a one-time schedule", () => {
    expect(
      minGapMs({ kind: "daily", times: ["09:00", "09:30"], timeZone: "Asia/Macau" }, at("2026-06-01T00:00:00Z")),
    ).toBe(30 * 60_000);
    expect(minGapMs({ kind: "once", at: "2026-11-01T09:00", timeZone: "Asia/Macau" }, 0)).toBeNull();
  });
});
