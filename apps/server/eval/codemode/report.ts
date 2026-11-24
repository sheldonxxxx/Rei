// Prints the tables RESULTS.md records from one or more run files (REI_EVAL_OUT of the real-model part):
//   node apps/server/eval/codemode/report.ts apps/server/eval/codemode/runs/inline-1500.json [...]
// With several files it adds a budget comparison. The decision rule at the end is the ticket's: on when turns or tokens
// drop clearly on the multi-step scenarios with equal or better success and no regression on the single lookup.
import { readFileSync } from "node:fs";
import type { RunMetrics } from "./driver.ts";
import { SCENARIOS } from "./scenarios.ts";

interface RunFile {
  label: string;
  runs: RunMetrics[];
}

/**
 * Grades every run again from its stored answer and approval cards, so a fix to a check applies to a recorded run. A run
 * recorded before the cards were stored keeps its own result for the approval scenario.
 */
export function regrade(file: RunFile): RunFile {
  const runs = file.runs.map((r) => {
    const scenario = SCENARIOS.find((s) => s.id === r.scenario);
    if (!scenario || (!r.approvalCards && scenario.kind === "approval")) return r;
    const failures = scenario.check({ answer: r.answer, approvals: r.approvalCards ?? [] });
    return { ...r, failures, success: failures.length === 0 };
  });
  return { ...file, runs };
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const round = (n: number, digits = 0): string => n.toFixed(digits);
const pct = (on: number, off: number): string =>
  off === 0 ? "n/a" : `${on <= off ? "" : "+"}${round(((on - off) / off) * 100)}%`;

export interface Totals {
  runs: number;
  success: number;
  turns: number;
  tokens: number;
  uncached: number;
  output: number;
  wallS: number;
  scripts: number;
  nested: number;
}

export function totals(runs: RunMetrics[]): Totals {
  const sum = (pick: (r: RunMetrics) => number) => runs.reduce((n, r) => n + pick(r), 0);
  return {
    runs: runs.length,
    success: runs.filter((r) => r.success).length,
    turns: sum((r) => r.turns),
    tokens: sum((r) => r.inputTokens),
    uncached: sum((r) => r.uncachedTokens),
    output: sum((r) => r.outputTokens),
    wallS: sum((r) => r.wallMs) / 1000,
    scripts: sum((r) => r.scripts),
    nested: sum((r) => r.nestedCalls),
  };
}

const kindOf = (id: string) => SCENARIOS.find((s) => s.id === id)?.kind;

/** The ticket's rule, on one run file. */
export function decide(runs: RunMetrics[]): { verdict: "on" | "off"; reasons: string[] } {
  const multi = (arm: "off" | "on") => runs.filter((r) => r.arm === arm && kindOf(r.scenario) === "multi");
  const off = totals(multi("off"));
  const on = totals(multi("on"));
  const single = (arm: "off" | "on") => runs.filter((r) => r.arm === arm && kindOf(r.scenario) === "single");
  const sOff = totals(single("off"));
  const sOn = totals(single("on"));
  const all = (arm: "off" | "on") => totals(runs.filter((r) => r.arm === arm));
  const reasons: string[] = [];
  const turnsDrop = 1 - on.turns / off.turns;
  const tokenDrop = 1 - on.tokens / off.tokens;
  const clear = turnsDrop >= 0.2 || tokenDrop >= 0.2;
  reasons.push(
    `multi-step scenarios: turns ${off.turns} → ${on.turns} (${pct(on.turns, off.turns)}), prompt tokens ${off.tokens} → ${on.tokens} (${pct(on.tokens, off.tokens)}); a drop of 20% or more in either counts as clear: ${clear ? "yes" : "no"}`,
  );
  const successOk = all("on").success >= all("off").success;
  reasons.push(
    `task success ${all("off").success}/${all("off").runs} off, ${all("on").success}/${all("on").runs} on: ${successOk ? "on is at least as good" : "on is worse"}`,
  );
  const singleOk = sOn.turns <= sOff.turns && sOn.tokens <= sOff.tokens * 1.1 && sOn.success >= sOff.success;
  reasons.push(
    `single lookup: turns ${sOff.turns} → ${sOn.turns}, prompt tokens ${sOff.tokens} → ${sOn.tokens}, success ${sOff.success}/${sOff.runs} → ${sOn.success}/${sOn.runs}: ${singleOk ? "no regression" : "regression"}`,
  );
  return { verdict: clear && successOk && singleOk ? "on" : "off", reasons };
}

export function perScenario(runs: RunMetrics[]): string {
  const lines = [
    "| scenario | arm | ok | turns | prompt tokens | uncached | cache share | first call: tool defs + prompt | wall s | scripts | nested | direct |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of SCENARIOS)
    for (const arm of ["off", "on"] as const) {
      const rs = runs.filter((r) => r.scenario === s.id && r.arm === arm);
      if (rs.length === 0) continue;
      const m = (pick: (r: RunMetrics) => number) => mean(rs.map(pick));
      const share = rs.map((r) => r.cacheShare).filter((x): x is number => x !== null);
      lines.push(
        `| ${s.id} | ${arm} | ${rs.filter((r) => r.success).length}/${rs.length} | ${round(
          m((r) => r.turns),
          rs.length > 1 ? 1 : 0,
        )} | ${round(m((r) => r.inputTokens))} | ${round(m((r) => r.uncachedTokens))} | ${share.length ? round(mean(share), 2) : "n/a"} | ${round(m((r) => r.firstCall.toolDefinitions + r.firstCall.prompt))} | ${round(m((r) => r.wallMs) / 1000, 1)} | ${round(
          m((r) => r.scripts),
          rs.length > 1 ? 1 : 0,
        )} | ${round(
          m((r) => r.nestedCalls),
          rs.length > 1 ? 1 : 0,
        )} | ${round(
          m((r) => r.directCalls),
          rs.length > 1 ? 1 : 0,
        )} |`,
      );
    }
  return lines.join("\n");
}

export function summary(runs: RunMetrics[]): string {
  const row = (name: string, filter: (r: RunMetrics) => boolean) => {
    const off = totals(runs.filter((r) => r.arm === "off" && filter(r)));
    const on = totals(runs.filter((r) => r.arm === "on" && filter(r)));
    return `| ${name} | ${off.success}/${off.runs} → ${on.success}/${on.runs} | ${off.turns} → ${on.turns} (${pct(on.turns, off.turns)}) | ${off.tokens} → ${on.tokens} (${pct(on.tokens, off.tokens)}) | ${off.uncached} → ${on.uncached} (${pct(on.uncached, off.uncached)}) | ${round(off.wallS)} → ${round(on.wallS)} (${pct(on.wallS, off.wallS)}) |`;
  };
  return [
    "| group | success off → on | turns | prompt tokens | uncached tokens | wall s |",
    "| --- | --- | --- | --- | --- | --- |",
    row("multi-step", (r) => kindOf(r.scenario) === "multi"),
    row("single lookup", (r) => kindOf(r.scenario) === "single"),
    row("approval", (r) => kindOf(r.scenario) === "approval"),
    row("all", () => true),
  ].join("\n");
}

export function failures(runs: RunMetrics[]): string {
  const lines: string[] = [];
  for (const r of runs) {
    if (!r.success) lines.push(`- ${r.scenario} (${r.arm}): ${r.failures.join("; ")}`);
    for (const e of r.scriptErrors) lines.push(`- ${r.scenario} (${r.arm}) script failed: ${e}`);
  }
  return lines.length ? lines.join("\n") : "none";
}

if (import.meta.main) {
  const files = process.argv.slice(2).map((p) => regrade(JSON.parse(readFileSync(p, "utf8")) as RunFile));
  for (const f of files) {
    console.log(`## ${f.label || "run"}\n`);
    console.log(summary(f.runs), "\n");
    console.log(perScenario(f.runs), "\n");
    console.log(`Failures:\n${failures(f.runs)}\n`);
    const d = decide(f.runs);
    console.log(`Rule: ${d.verdict}\n${d.reasons.map((r) => `- ${r}`).join("\n")}\n`);
  }
  if (files.length > 1) {
    console.log("## Budget comparison (Code mode on, all scenarios)\n");
    console.log(
      "| run | success | turns | prompt tokens | uncached | first call tool defs + prompt (mean) | scripts | nested |",
    );
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const f of files) {
      const on = f.runs.filter((r) => r.arm === "on");
      if (on.length === 0) continue;
      const t = totals(on);
      console.log(
        `| ${f.label} | ${t.success}/${t.runs} | ${t.turns} | ${t.tokens} | ${t.uncached} | ${round(mean(on.map((r) => r.firstCall.toolDefinitions + r.firstCall.prompt)))} | ${t.scripts} | ${t.nested} |`,
      );
    }
  }
}
