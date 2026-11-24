import { describe, expect, it } from "vitest";
import type { AttemptRow } from "../src/core/render.ts";
import { computeStats, formatStats, type StatRow } from "../src/core/stats.ts";
import { SqliteAttempts } from "../src/node/attempts.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;
let n = 0;
const row = (over: Partial<StatRow>): StatRow => ({
  ts: NOW - DAY,
  readId: `r${++n}`,
  attempt: 1,
  engine: "moli",
  engineVersion: "1.1",
  role: "primary",
  outcome: "ok",
  quality: "success",
  textChars: 1000,
  renderMs: 1000,
  host: "a.test",
  fallbackReason: null,
  ...over,
});

describe("computeStats", () => {
  it("is empty and not ready without rows", () => {
    const stats = computeStats([], 30 * DAY, NOW);
    expect(stats).toMatchObject({ primaryRenders: 0, engines: [], decision: { ready: false } });
    expect(stats.rescued.rate).toBeNull();
    expect(formatStats(stats)).toContain("none yet");
  });

  it("counts rescues, fallbacks by reason, percentiles and shadow divergence", () => {
    const rows: StatRow[] = [];
    for (let i = 0; i < 10; i++) rows.push(row({ renderMs: (i + 1) * 100 }));
    // A read Moli failed and Chromium rescued.
    rows.push(row({ readId: "rescue", outcome: "crash", quality: null, textChars: null, renderMs: null }));
    rows.push(
      row({
        readId: "rescue",
        attempt: 2,
        engine: "chromium",
        engineVersion: "146",
        role: "fallback",
        fallbackReason: "failed",
        host: "b.test",
      }),
    );
    // A fallback that did not improve things.
    rows.push(row({ readId: "same", quality: "low_quality" }));
    rows.push(
      row({
        readId: "same",
        attempt: 2,
        engine: "chromium",
        engineVersion: "146",
        role: "fallback",
        fallbackReason: "thin",
        quality: "low_quality",
      }),
    );
    // Shadow pairs: one diverged by quality, one by text, one equal, one failed (ignored).
    const shadow = (id: string, over: Partial<StatRow>, primary: Partial<StatRow> = {}) => {
      rows.push(row({ readId: id, ...primary }));
      rows.push(row({ readId: id, attempt: 2, engine: "chromium", engineVersion: "146", role: "shadow", ...over }));
    };
    shadow("s1", { quality: "success" }, { quality: "low_quality" });
    shadow("s2", { textChars: 1500 });
    shadow("s3", {});
    shadow("s4", { outcome: "crash", quality: null });
    const stats = computeStats(rows, 30 * DAY, NOW);
    expect(stats.rescued).toMatchObject({ count: 1, hosts: [{ host: "b.test", count: 1 }] });
    expect(stats.fallbackRate).toEqual({ total: 2, byReason: { failed: 1, thin: 1 } });
    expect(stats.shadow).toEqual({ pairs: 3, diverged: 2, divergence: 2 / 3 });
    const moli = stats.engines.find((e) => e.engine === "moli")!;
    expect(moli.p50Ms).toBe(800);
    expect(moli.p95Ms).toBe(1000);
    expect(moli.successRate).toBeLessThan(1);
    expect(stats.decision.ready).toBe(false);
    const text = formatStats(stats);
    expect(text).toContain("Rescue rate");
    expect(text).toContain("b.test: 1");
    expect(text).toContain("failed 1, thin 1");
  });

  it("is ready only after 30 days, 500 renders, rescue under 1% and divergence under 2%", () => {
    const rows: StatRow[] = [];
    for (let i = 0; i < 600; i++) rows.push(row({ ts: NOW - (i % 40) * DAY - 1000 }));
    for (let i = 0; i < 100; i++) {
      const id = `p${i}`;
      rows.push(row({ readId: id }));
      rows.push(row({ readId: id, attempt: 2, engine: "chromium", role: "shadow" }));
    }
    const ready = computeStats(rows, 90 * DAY, NOW);
    expect(ready.decision.ready).toBe(true);
    expect(formatStats(ready)).toContain("decision rule is met");
    expect(computeStats(rows.slice(0, 400), 90 * DAY, NOW).decision.ready).toBe(false);
    const young = rows.map((r) => ({ ...r, ts: NOW - DAY }));
    expect(computeStats(young, 90 * DAY, NOW).decision.ready).toBe(false);
  });
});

const attempt = (over: Partial<AttemptRow> = {}): AttemptRow => ({
  readId: "r1",
  attempt: 1,
  caller: "rei",
  stepId: undefined,
  engine: "moli",
  engineVersion: "1.1",
  role: "primary",
  trigger: "requires_js",
  outcome: "ok",
  errorDetail: undefined,
  quality: "success",
  textChars: 100,
  sections: 2,
  ended: "stable",
  renderMs: 900,
  slotWaitMs: 0,
  connections: 5,
  bytes: 1234,
  refused: 0,
  blockedMedia: 1,
  url: "https://a.test/path?q=1",
  host: "a.test",
  fallbackReason: undefined,
  used: true,
  ...over,
});

describe("SqliteAttempts", () => {
  it("stores the full URL, reads rows back for a window and prunes old ones", () => {
    let now = 1_000 * DAY;
    const store = new SqliteAttempts(":memory:", { now: () => now, maxAgeMs: 180 * DAY });
    store.record(attempt());
    now += 100 * DAY;
    store.record(
      attempt({
        readId: "r2",
        outcome: "crash",
        quality: undefined,
        textChars: undefined,
        used: false,
        errorDetail: "boom",
      }),
    );
    expect(store.all()[1]).toMatchObject({ url: "https://a.test/path?q=1", used: 1 });
    expect(store.rows(30 * DAY).map((r) => r.readId)).toEqual(["r2"]);
    expect(store.rows(200 * DAY).map((r) => r.readId)).toEqual(["r1", "r2"]);
    now += 100 * DAY;
    store.prune();
    expect(store.rows(1_000 * DAY).map((r) => r.readId)).toEqual(["r2"]);
    store.close();
    expect(() => store.record(attempt())).not.toThrow(); // a closed store never fails a read
  });
});
