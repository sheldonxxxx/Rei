import { describe, expect, it } from "vitest";
import { chartColor, formatValue, niceTicks, pieSlices, valueRange, wedgePath } from "./chart.ts";

describe("niceTicks", () => {
  it("uses round steps that cover the data", () => {
    expect(niceTicks(0, 97)).toEqual({ ticks: [0, 25, 50, 75, 100], min: 0, max: 100 });
    expect(niceTicks(0, 10).ticks).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(-3, 8).ticks[0]).toBeLessThanOrEqual(-3);
    expect(niceTicks(-3, 8).max).toBeGreaterThanOrEqual(8);
  });
  it("copes with a flat series and non-finite input", () => {
    expect(niceTicks(0, 0).ticks).toEqual([0, 1]);
    const flat = niceTicks(5, 5);
    expect(flat.min).toBeLessThan(5);
    expect(flat.max).toBeGreaterThan(5);
    expect(niceTicks(Number.NaN, 3).ticks).toEqual([0, 1]);
  });
});

describe("valueRange", () => {
  it("ignores gaps, and includes zero for bars only", () => {
    expect(valueRange([[3, null, 8]], false)).toEqual({ min: 3, max: 8 });
    expect(valueRange([[3, null, 8]], true)).toEqual({ min: 0, max: 8 });
    expect(valueRange([[null]], true)).toEqual({ min: 0, max: 1 });
  });
});

describe("formatValue", () => {
  it("groups digits and attaches the unit", () => {
    expect(formatValue(1234.5, "HKD")).toBe(`${(1234.5).toLocaleString(undefined, { maximumFractionDigits: 2 })} HKD`);
    expect(formatValue(21, "°C")).toBe("21°C");
    expect(formatValue(null)).toBe("no data");
  });
});

describe("pieSlices", () => {
  it("shares add up to one and angles go round once", () => {
    const s = pieSlices(["a", "b", "c"], [1, 1, 2]);
    expect(s.map((x) => x.share)).toEqual([0.25, 0.25, 0.5]);
    expect(s[2]!.end).toBeCloseTo(Math.PI * 2, 10);
  });
  it("leaves out zero, negative and missing values", () => {
    expect(pieSlices(["a", "b", "c"], [0, -2, null])).toEqual([]);
    expect(pieSlices(["a", "b"], [3, 0]).map((x) => x.label)).toEqual(["a"]);
  });
  it("merges the smallest into Other beyond twelve slices", () => {
    const labels = Array.from({ length: 15 }, (_, i) => `s${i}`);
    const s = pieSlices(
      labels,
      labels.map((_, i) => i + 1),
    );
    expect(s).toHaveLength(12);
    expect(s[11]).toMatchObject({ label: "Other", other: true });
    expect(s.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 10);
  });
});

describe("wedgePath and colours", () => {
  it("draws a full circle without a degenerate arc", () => {
    expect(wedgePath(0, 0, 10, 0, Math.PI * 2)).toContain("A 10 10 0 1 1");
  });
  it("sets the large-arc flag past a half turn", () => {
    expect(wedgePath(0, 0, 10, 0, Math.PI * 1.5)).toContain("0 1 1");
    expect(wedgePath(0, 0, 10, 0, Math.PI / 2)).toContain("0 0 1");
  });
  it("cycles the palette tokens", () => {
    expect(chartColor(0)).toBe("var(--chart-1)");
    expect(chartColor(8)).toBe("var(--chart-1)");
  });
});
