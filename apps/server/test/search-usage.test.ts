import { describe, expect, it } from "vitest";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { readSearchUsage, recordSearchUsage } from "../src/usage/search.ts";

describe("search usage", () => {
  it("counts per-provider outcomes and fallbacks", () => {
    const db = openSqliteDb(":memory:");
    initializeDatabase(db);
    const now = Date.UTC(2026, 10, 14);
    recordSearchUsage(db, now, "answered", [
      { provider: "exa", status: "failed", reason: "search_timeout", totalMs: 1000 },
      { provider: "brave", status: "succeeded", totalMs: 400 },
    ]);
    recordSearchUsage(db, now, "answered", [{ provider: "exa", status: "succeeded", totalMs: 600 }]);
    recordSearchUsage(db, now, "failed", [
      { provider: "tavily", status: "skipped", reason: "not_configured", totalMs: 0 },
      { provider: "exa", status: "failed", totalMs: 200 },
    ]);
    const u = readSearchUsage(db, "2026-11-14", "2026-11-14");
    expect(u).toMatchObject({ searches: 3, answered: 2, failed: 1, searchesWithFallback: 1 });
    const exa = u.byProvider.find((p) => p.provider === "exa")!;
    expect(exa).toMatchObject({ succeeded: 1, failed: 2, fallback: 0, averageMs: 600 });
    expect(u.byProvider.find((p) => p.provider === "brave")).toMatchObject({
      succeeded: 1,
      fallback: 1,
      answeredAfterFallback: 1,
    });
    expect(u.byProvider.find((p) => p.provider === "tavily")).toMatchObject({ skipped: 1, averageMs: null });
    expect(readSearchUsage(db, "2026-11-15", "2026-11-15").searches).toBe(0);
  });
});
