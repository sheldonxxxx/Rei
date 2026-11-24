import { describe, expect, it } from "vitest";
import { clockText, savedTimeZone, saveTimeZone } from "../src/pi/clock-context.ts";

// 16:30 UTC on 7 November 2026: still the 7th in New York, already the 8th in Macau.
const instant = Date.UTC(2026, 10, 7, 16, 30);

const memoryStore = () => {
  const meta = new Map<string, string>();
  return {
    metaGet: (key: string) => meta.get(key),
    metaSet: (key: string, value: string | null) => (value === null ? meta.delete(key) : meta.set(key, value)),
  };
};

describe("clock prompt section", () => {
  it("gives the calendar day in the user's zone, not in UTC", () => {
    expect(clockText(instant, "America/New_York", "America/New_York")).toMatch(
      /^Today is \w+, 2026-11-07 \(YYYY-MM-DD\)\./,
    );
    expect(clockText(instant, "Asia/Macau", "Asia/Macau")).toMatch(/^Today is \w+, 2026-11-08 \(YYYY-MM-DD\)\./);
  });

  it("names the user's time zone when it is saved", () => {
    expect(clockText(instant, "Asia/Macau", "Asia/Macau")).toContain("The user's time zone is Asia/Macau.");
  });

  it("says the zone is not set, and which zone the date is in, until the user's zone is saved", () => {
    const text = clockText(instant, "UTC", null);
    expect(text).toContain("in the server's time zone (UTC)");
    expect(text).toContain("The user's time zone is not set.");
  });
});

describe("saved time zone", () => {
  it("round-trips a saved zone and ignores a stored value the runtime does not know", () => {
    const store = memoryStore();
    expect(savedTimeZone(store)).toBeNull();
    saveTimeZone(store, "Asia/Macau");
    expect(savedTimeZone(store)).toBe("Asia/Macau");
    store.metaSet("user_time_zone", "Not/AZone");
    expect(savedTimeZone(store)).toBeNull();
  });
});
