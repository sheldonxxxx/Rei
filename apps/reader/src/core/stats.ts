// What the attempt rows say about the engines: the numbers behind the decision whether Chromium is still needed
// (docs/reader.md). Pure: it reads rows, so the CLI, GET /stats and the tests share it.

export interface StatRow {
  ts: number;
  readId: string;
  attempt: number;
  engine: string;
  engineVersion: string;
  role: string;
  outcome: string;
  quality: string | null;
  textChars: number | null;
  renderMs: number | null;
  host: string;
  fallbackReason: string | null;
}

export interface EngineStats {
  engine: string;
  engineVersion: string;
  attempts: number;
  primary: number;
  /** Primary attempts after which no fallback was needed, as a share of primary attempts. */
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface ReaderStats {
  sinceMs: number;
  /** Days between the oldest row in the window and now. */
  windowDays: number;
  primaryRenders: number;
  engines: EngineStats[];
  fallbackRate: { total: number; byReason: Record<string, number> };
  /** Fallbacks where the second engine turned a failed or thin read into a better one, over primary renders. */
  rescued: { count: number; rate: number | null; hosts: { host: string; count: number }[] };
  shadow: { pairs: number; diverged: number; divergence: number | null };
  decision: { ready: boolean; text: string };
}

const rank = (quality: string | null): number => (quality === "success" ? 2 : quality === "low_quality" ? 1 : 0);

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
}

const MIN_DAYS = 30;
const MIN_RENDERS = 500;
const RESCUE_BELOW = 0.01;
const DIVERGENCE_BELOW = 0.02;

export function computeStats(rows: StatRow[], sinceMs: number, now: number): ReaderStats {
  const byRead = new Map<string, StatRow[]>();
  for (const row of rows) {
    const list = byRead.get(row.readId);
    if (list) list.push(row);
    else byRead.set(row.readId, [row]);
  }
  const primaryRows = rows.filter((r) => r.role === "primary");
  const fallbackRows = rows.filter((r) => r.role === "fallback");
  const shadowRows = rows.filter((r) => r.role === "shadow");
  const fellBack = new Set(fallbackRows.map((r) => r.readId));

  const keys = [...new Set(rows.map((r) => `${r.engine}\u0000${r.engineVersion}`))].sort();
  const engines: EngineStats[] = keys.map((key) => {
    const [engine = "", engineVersion = ""] = key.split("\u0000");
    const mine = rows.filter((r) => r.engine === engine && r.engineVersion === engineVersion);
    const primary = mine.filter((r) => r.role === "primary");
    const times = mine
      .filter((r) => r.outcome === "ok" && r.renderMs !== null)
      .map((r) => r.renderMs as number)
      .sort((a, b) => a - b);
    return {
      engine,
      engineVersion,
      attempts: mine.length,
      primary: primary.length,
      successRate: primary.length === 0 ? null : primary.filter((r) => !fellBack.has(r.readId)).length / primary.length,
      p50Ms: percentile(times, 0.5),
      p95Ms: percentile(times, 0.95),
    };
  });

  const byReason: Record<string, number> = {};
  for (const r of fallbackRows)
    byReason[r.fallbackReason ?? "unknown"] = (byReason[r.fallbackReason ?? "unknown"] ?? 0) + 1;

  const rescuedHosts = new Map<string, number>();
  let rescued = 0;
  for (const f of fallbackRows) {
    const primary = (byRead.get(f.readId) ?? []).find((r) => r.role === "primary");
    const before = primary && primary.outcome === "ok" ? rank(primary.quality) : 0;
    if (f.outcome === "ok" && rank(f.quality) > before) {
      rescued++;
      rescuedHosts.set(f.host, (rescuedHosts.get(f.host) ?? 0) + 1);
    }
  }

  let diverged = 0;
  let pairs = 0;
  for (const s of shadowRows) {
    const primary = (byRead.get(s.readId) ?? []).find((r) => r.role === "primary");
    if (!primary || s.outcome !== "ok") continue;
    pairs++;
    const p = primary.textChars ?? 0;
    const c = s.textChars ?? 0;
    if (rank(s.quality) > rank(primary.quality) || (c > 0 && c >= p * 1.2 && c > p)) diverged++;
  }

  const oldest = rows.reduce((min, r) => Math.min(min, r.ts), now);
  const windowDays = rows.length === 0 ? 0 : (now - oldest) / 86_400_000;
  const rescueRate = primaryRows.length === 0 ? null : rescued / primaryRows.length;
  const divergence = pairs === 0 ? null : diverged / pairs;
  const ready =
    windowDays >= MIN_DAYS &&
    primaryRows.length >= MIN_RENDERS &&
    rescueRate !== null &&
    rescueRate < RESCUE_BELOW &&
    divergence !== null &&
    divergence < DIVERGENCE_BELOW;
  const text = ready
    ? "The decision rule is met: propose dropping the fallback (READER_ENGINES=moli, Chromium out of the image)."
    : `The decision rule is not met yet: it needs ${MIN_DAYS} days and ${MIN_RENDERS} primary renders (${windowDays.toFixed(1)} days, ${primaryRows.length} so far), rescue below ${RESCUE_BELOW * 100}% and shadow divergence below ${DIVERGENCE_BELOW * 100}%.`;
  return {
    sinceMs,
    windowDays,
    primaryRenders: primaryRows.length,
    engines,
    fallbackRate: { total: fallbackRows.length, byReason },
    rescued: {
      count: rescued,
      rate: rescueRate,
      hosts: [...rescuedHosts]
        .map(([host, count]) => ({ host, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    },
    shadow: { pairs, diverged, divergence },
    decision: { ready, text },
  };
}

const pct = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const ms = (value: number | null): string => (value === null ? "n/a" : `${Math.round(value)} ms`);

export function formatStats(stats: ReaderStats): string {
  const lines = [
    `Render attempts since ${new Date(Date.now() - stats.sinceMs).toISOString().slice(0, 10)} (${stats.primaryRenders} primary renders over ${stats.windowDays.toFixed(1)} days)`,
    "",
    "Engine versions",
  ];
  if (stats.engines.length === 0) lines.push("  none yet");
  for (const e of stats.engines)
    lines.push(
      `  ${e.engine} ${e.engineVersion}: ${e.attempts} attempts, ${e.primary} primary, no-fallback rate ${pct(e.successRate)}, p50 ${ms(e.p50Ms)}, p95 ${ms(e.p95Ms)}`,
    );
  const reasons = Object.entries(stats.fallbackRate.byReason)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  lines.push(
    "",
    `Fallbacks: ${stats.fallbackRate.total}${reasons ? ` (${reasons})` : ""}`,
    `Rescue rate: ${pct(stats.rescued.rate)} (${stats.rescued.count} rescued reads)`,
    `Shadow divergence: ${pct(stats.shadow.divergence)} (${stats.shadow.diverged} of ${stats.shadow.pairs} pairs)`,
  );
  if (stats.rescued.hosts.length > 0) {
    lines.push("", "Most rescued hosts");
    for (const h of stats.rescued.hosts) lines.push(`  ${h.host}: ${h.count}`);
  }
  lines.push("", stats.decision.text);
  return lines.join("\n");
}
