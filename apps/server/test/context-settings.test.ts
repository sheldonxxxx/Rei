import { describe, expect, it } from "vitest";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import {
  compactionSettings,
  DEFAULT_COMPACTION,
  readContextSettings,
  updateContextSettings,
} from "../src/pi/context-settings.ts";
import { homeContextConfig } from "../src/pi/home-context.ts";
import { EventLog } from "../src/store/events.ts";
import { AppStore } from "../src/store/store.ts";

function fixture() {
  const db = openSqliteDb(":memory:");
  initializeDatabase(db);
  const clock = { now: () => 1 };
  return new AppStore(db, clock, new EventLog(clock));
}

describe("context settings", () => {
  it("defaults to Pi's policy and the documented home values", () => {
    const store = fixture();
    const s = readContextSettings(store);
    expect(s.compaction).toEqual(DEFAULT_COMPACTION);
    expect(s.home).toEqual({ idleGapMinutes: 60, recentMessages: 10, maxTokens: 64000 });
  });

  it("persists compaction edits, feeds Pi live, and resets", () => {
    const store = fixture();
    updateContextSettings(store, { compaction: { reserveTokens: 4000, enabled: false } });
    expect(compactionSettings(store)).toMatchObject({ reserveTokens: 4000, enabled: false, keepRecentTokens: 20000 });
    updateContextSettings(store, { modelOverrides: { "openai/gpt-x": { reserveTokens: 900 } } });
    expect(compactionSettings(store).modelOverrides).toEqual({ "openai/gpt-x": { reserveTokens: 900 } });
    updateContextSettings(store, { compaction: null });
    expect(readContextSettings(store).compaction).toEqual(DEFAULT_COMPACTION);
  });

  it("writes home settings in the key the runtime reads", () => {
    const store = fixture();
    updateContextSettings(store, { home: { idleGapMinutes: 5, recentMessages: 3 } });
    expect(homeContextConfig(store)).toEqual({ idleGapMs: 300_000, maxTokens: 64000 });
    updateContextSettings(store, { home: null });
    expect(readContextSettings(store).home.idleGapMinutes).toBe(60);
  });

  it("rejects invalid values without changing anything", () => {
    const store = fixture();
    expect(() => updateContextSettings(store, { compaction: { reserveTokens: 0 } })).toThrow(/reserveTokens/);
    expect(() => updateContextSettings(store, { compaction: { enabled: "yes" } })).toThrow(/enabled/);
    expect(() => updateContextSettings(store, { home: { maxTokens: 1.5 } })).toThrow(/maxTokens/);
    expect(readContextSettings(store).compaction).toEqual(DEFAULT_COMPACTION);
  });
});
