import { describe, expect, it } from "vitest";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { readImageUsage, recordImageUsage } from "../src/usage/images.ts";

describe("image usage", () => {
  it("counts requests by kind and outcome, with failures by reason and the average time of successes", () => {
    const db = openSqliteDb(":memory:");
    initializeDatabase(db);
    const now = Date.UTC(2026, 10, 14);
    recordImageUsage(db, now, { edit: false, ms: 20_000 });
    recordImageUsage(db, now, { edit: false, ms: 40_000 });
    recordImageUsage(db, now, { edit: true, ms: 30_000 });
    recordImageUsage(db, now, { edit: false, ms: 500, failure: "rate_limited" });
    recordImageUsage(db, now, { edit: true, ms: 100, failure: "rate_limited" });
    recordImageUsage(db, now, { edit: false, ms: 100, failure: "sign_in_required" });
    expect(readImageUsage(db, "2026-11-14", "2026-11-14")).toEqual({
      requests: 6,
      succeeded: 3,
      failed: 3,
      generated: 4,
      edited: 2,
      averageMs: 30_000,
      failures: [
        { reason: "rate_limited", calls: 2 },
        { reason: "sign_in_required", calls: 1 },
      ],
    });
    expect(readImageUsage(db, "2026-11-15", "2026-11-15")).toEqual({
      requests: 0,
      succeeded: 0,
      failed: 0,
      generated: 0,
      edited: 0,
      averageMs: null,
      failures: [],
    });
  });
});
