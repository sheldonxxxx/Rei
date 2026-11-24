// Chart maths for the SVG charts: scales, tick marks and pie slices.

/** Round, readable tick values covering [min, max]: 0, 5, 10, 15... Returns the ticks and the axis range they span. */
export function niceTicks(min: number, max: number, count = 5): { ticks: number[]; min: number; max: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0, 1], min: 0, max: 1 };
  if (min === max) {
    if (min === 0) return { ticks: [0, 1], min: 0, max: 1 };
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const step = niceStep((max - min) / Math.max(1, count - 1));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { ticks, min: ticks[0]!, max: ticks[ticks.length - 1]! };
}

function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const f = raw / 10 ** exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

/** The value range an axis must cover: bars always include 0; lines may float. Null gaps are ignored. */
export function valueRange(values: (number | null)[][], includeZero: boolean): { min: number; max: number } {
  const all = values.flat().filter((v): v is number => v !== null && Number.isFinite(v));
  if (all.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  return { min, max };
}

/** A value with its unit, grouped and trimmed: "1,234.5 HKD", "21 °C". */
export function formatValue(v: number | null, unit?: string): string {
  if (v === null) return "no data";
  const n = Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (!unit) return n;
  return /^[°%]/.test(unit) ? `${n}${unit}` : `${n} ${unit}`;
}

/** The slice of a pie: share of the total and the start and end angles (radians, clockwise from 12 o'clock). */
export interface Slice {
  label: string;
  value: number;
  share: number;
  start: number;
  end: number;
  /** The merged "Other" slice. */
  other?: boolean;
}

/** Slices for a pie: values that are zero, negative or missing are left out; more than `max` slices merge the smallest into "Other". */
export function pieSlices(labels: string[], values: (number | null)[], max = 12): Slice[] {
  let items = labels.map((label, i) => ({ label, value: values[i] ?? 0 })).filter((s) => s.value > 0);
  let otherValue = 0;
  if (items.length > max) {
    const sorted = [...items].sort((a, b) => b.value - a.value);
    const keep = new Set(sorted.slice(0, max - 1));
    otherValue = items.filter((s) => !keep.has(s)).reduce((a, s) => a + s.value, 0);
    items = items.filter((s) => keep.has(s));
  }
  const total = items.reduce((a, s) => a + s.value, 0) + otherValue;
  if (total <= 0) return [];
  const rows: { label: string; value: number; other?: boolean }[] =
    otherValue > 0 ? [...items, { label: "Other", value: otherValue, other: true }] : items;
  let angle = 0;
  return rows.map((s) => {
    const share = s.value / total;
    const start = angle;
    angle += share * Math.PI * 2;
    return { ...s, share, start, end: angle };
  });
}

/** SVG path of a pie wedge centred at (cx, cy). A full circle is drawn as two arcs so the path isn't degenerate. */
export function wedgePath(cx: number, cy: number, r: number, start: number, end: number): string {
  const pt = (a: number) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  if (end - start >= Math.PI * 2 - 1e-6)
    return `M ${pt(0)} A ${r} ${r} 0 1 1 ${pt(Math.PI)} A ${r} ${r} 0 1 1 ${pt(0)} Z`;
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${pt(start)} A ${r} ${r} 0 ${large} 1 ${pt(end)} Z`;
}

/** The chart palette is CSS tokens --chart-1..--chart-8 (both themes); more series or slices cycle. */
export const chartColor = (i: number) => `var(--chart-${(i % 8) + 1})`;
