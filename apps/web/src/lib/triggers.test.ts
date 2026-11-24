import type { Schedule } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import {
  draftFromSchedule,
  formatDuration,
  formatNextRun,
  runStatusText,
  scheduleFromDraft,
  statusChip,
} from "./triggers.ts";

const roundTrip = (s: Schedule) => {
  const r = scheduleFromDraft(draftFromSchedule(s));
  if ("error" in r) throw new Error(r.error);
  return r.schedule;
};

describe("schedule draft", () => {
  it("round-trips each of the four kinds", () => {
    const all: Schedule[] = [
      { kind: "once", at: "2030-01-05T09:30", timeZone: "Asia/Macau" },
      { kind: "daily", times: ["08:30", "18:00"], days: ["mon", "wed", "fri"], timeZone: "Europe/London" },
      { kind: "daily", times: ["09:00"], timeZone: "Asia/Macau" },
      { kind: "monthly", day: "last", times: ["18:00"], timeZone: "Asia/Kathmandu" },
      { kind: "monthly", day: 1, times: ["09:00"], timeZone: "Asia/Macau" },
      {
        kind: "interval",
        everyMinutes: 30,
        from: "09:00",
        until: "18:00",
        days: ["mon", "tue"],
        timeZone: "Asia/Macau",
      },
      { kind: "interval", everyMinutes: 120, timeZone: "Asia/Macau" },
    ];
    for (const s of all) expect(roundTrip(s)).toEqual(s);
  });

  it("normalises: times sorted and unique, all seven days means every day, default interval bounds left out", () => {
    const d = {
      ...draftFromSchedule({ kind: "daily", times: ["09:00"], timeZone: "UTC" }),
      times: ["18:00", "09:00", "09:00"],
      days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as never,
    };
    expect(scheduleFromDraft(d)).toEqual({ schedule: { kind: "daily", times: ["09:00", "18:00"], timeZone: "UTC" } });
    const i = {
      ...draftFromSchedule({ kind: "interval", everyMinutes: 60, timeZone: "UTC" }),
      from: "00:00",
      until: "23:59",
    };
    expect(scheduleFromDraft(i)).toEqual({ schedule: { kind: "interval", everyMinutes: 60, timeZone: "UTC" } });
  });

  it("says what is wrong in a sentence", () => {
    const base = draftFromSchedule({ kind: "daily", times: ["09:00"], timeZone: "UTC" });
    const err = (patch: object) => (scheduleFromDraft({ ...base, ...patch }) as { error: string }).error;
    expect(err({ timeZone: " " })).toMatch(/time zone/i);
    expect(err({ times: [] })).toMatch(/at least one time/i);
    expect(err({ times: Array.from({ length: 13 }, (_, i) => `0${i % 10}:${10 + i}`) })).toMatch(/at most 12/);
    expect(err({ kind: "once", at: "" })).toMatch(/date and time/i);
    expect(err({ kind: "monthly", day: "32" })).toMatch(/1 to 31/);
    expect(err({ kind: "interval", everyMinutes: "5" })).toMatch(/15 to 1440/);
    expect(err({ kind: "interval", everyMinutes: "60", from: "18:00", until: "09:00" })).toMatch(/before/);
  });

  it("defaults the zone to the browser's and the kind to daily at 09:00", () => {
    const d = draftFromSchedule(null);
    expect(d.kind).toBe("daily");
    expect(d.times).toEqual(["09:00"]);
    expect(d.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("labels", () => {
  it("names a trigger's status and why it is paused", () => {
    expect(statusChip({ status: "active", pausedReason: null }).label).toBe("Active");
    expect(statusChip({ status: "done", pausedReason: null }).label).toBe("Done");
    expect(statusChip({ status: "paused", pausedReason: "failures" }).label).toBe("Paused after failures");
    expect(statusChip({ status: "paused", pausedReason: "user" }).label).toBe("Paused by you");
    expect(statusChip({ status: "paused", pausedReason: "agent" }).label).toBe("Paused by the agent");
  });

  it("puts a run's reason next to its status", () => {
    expect(runStatusText({ status: "succeeded", reason: null })).toBe("Succeeded");
    expect(runStatusText({ status: "failed", reason: "model_error" })).toBe("Failed: model_error");
    expect(runStatusText({ status: "skipped", reason: "late" })).toBe("Skipped (late)");
    expect(runStatusText({ status: "skipped", reason: "missed" })).toBe("Skipped (missed)");
    expect(runStatusText({ status: "queued", reason: null })).toBe("Queued");
    expect(runStatusText({ status: "waiting", reason: null })).toBe("Waiting for you");
  });

  it("shows a duration in the largest sensible unit", () => {
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(180_000)).toBe("3 min");
    expect(formatDuration(3_900_000)).toBe("1 h 5 min");
  });

  it("formats a next run with a two-digit hour, and a weekday and date when it is not today", () => {
    const now = new Date(2026, 10, 1, 7, 0).getTime();
    expect(formatNextRun(new Date(2026, 10, 1, 8, 30).getTime(), now)).toMatch(/^08:30/);
    const later = formatNextRun(new Date(2026, 10, 2, 8, 30).getTime(), now);
    expect(later).toContain("Mon");
    expect(later).toContain("08");
    expect(later).not.toContain("2026");
    expect(formatNextRun(new Date(2027, 0, 4, 8, 30).getTime(), now)).toContain("2027");
  });
});
