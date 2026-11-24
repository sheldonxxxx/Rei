import type { AssistantMessage } from "@earendil-works/pi-ai";
import { USAGE_METRICS, type UsageMetric, type UsagePurpose } from "@rei/protocol";
import type { Db } from "../db/db.ts";

export const COLUMNS: Record<UsageMetric, string> = {
  inputTotal: "input_total",
  inputCached: "input_cached",
  inputUncached: "input_uncached",
  outputTotal: "output_total",
  totalProcessed: "total_processed",
  reasoningOutput: "reasoning_output",
};
export type TokenReport = Record<UsageMetric, number | null>;
/** Numeric evidence from the current response, used only to validate Pi counts and detect its default zeros.
 * undefined: no provider-event evidence (e.g. faux); null: terminal event without a usage report.
 * This is neither another accounting source nor a persisted request log. */
export interface UsageEvidence {
  input: unknown;
  cached: unknown;
  output: unknown;
  reasoning: unknown;
}
const object = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** Pi's read-only provider-event observer: retain numeric usage fields only, never event text. */
export function usageEvidenceFromEvent(event: unknown): UsageEvidence | null | undefined {
  const e = object(event);
  if (!["response.completed", "response.done", "response.incomplete", "response.failed"].includes(String(e.type)))
    return undefined;
  const u = object(object(e.response).usage);
  if (!Object.keys(u).length) return null;
  return {
    input: tokenCount(u.input_tokens),
    cached: tokenCount(object(u.input_tokens_details).cached_tokens),
    output: tokenCount(u.output_tokens),
    reasoning: tokenCount(object(u.output_tokens_details).reasoning_tokens),
  };
}
export const tokenCount = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const sum = (...v: (number | null)[]): number | null =>
  v.every((n) => n !== null) ? tokenCount(v.reduce<number>((a, b) => a + b!, 0)) : null;

/** Pi 1.4.0 openai-responses-shared subtracts cacheRead AND cacheWrite from inclusive input_tokens.
 * Only that currently supported API is trusted. Unknown APIs remain unreported until their semantics are verified.
 * The raw numeric evidence masks absent fields that Pi otherwise changes into zero, and cross-checks inclusive input.
 * Failed/aborted calls retain reliable partial reports; synthetic failures without evidence are unknown, never zero.
 */
export function normalizeUsage(message: AssistantMessage | undefined, evidence?: UsageEvidence | null): TokenReport {
  const empty = Object.fromEntries(USAGE_METRICS.map((m) => [m, null])) as TokenReport;
  if (!message?.usage || (message.api !== "openai-responses" && message.api !== "openai-codex-responses") || !evidence)
    return empty;
  const u = message.usage;
  const inclusive = sum(tokenCount(u.input), tokenCount(u.cacheRead), tokenCount(u.cacheWrite));
  const input = inclusive !== null && inclusive === tokenCount(evidence.input) ? inclusive : null;
  const cached = tokenCount(evidence.cached) === tokenCount(u.cacheRead) ? tokenCount(evidence.cached) : null;
  const validCached = cached !== null && input !== null && cached <= input ? cached : null;
  const output = tokenCount(evidence.output) === tokenCount(u.output) ? tokenCount(evidence.output) : null;
  const reasoning = tokenCount(evidence.reasoning) === tokenCount(u.reasoning) ? tokenCount(evidence.reasoning) : null;
  return {
    inputTotal: input,
    inputCached: validCached,
    inputUncached: input !== null && validCached !== null ? input - validCached : null,
    outputTotal: output,
    totalProcessed: sum(input, output),
    reasoningOutput: reasoning !== null && output !== null && reasoning <= output ? reasoning : null,
  };
}

/** Called inside the same transaction as the terminal step write. No scan/replay of historical steps.
 * First terminal finish wins, including failures with no report. Incomplete calls are excluded until finish;
 * a crash before finish loses its report (we never infer usage from old traces or count a fabricated zero).
 * BEGIN IMMEDIATE serializes competing writers; the durable marker and UPSERT commit or roll back together.
 * Snapshots have no foreign keys to steps/sessions and survive their deletion and gateway retention.
 */
export function recordUsageForCompletedStep(db: Db, stepId: string, now: number, tokens: TokenReport): boolean {
  return db.transaction(() => {
    const step = db.get<{
      usage_purpose: UsagePurpose | null;
      usage_agent_id: string;
      provider: string;
      model: string;
      run_id: string | null;
    }>(
      "SELECT usage_purpose, usage_agent_id, provider, model, run_id FROM steps WHERE id = ? AND usage_accounted_at IS NULL AND status IN ('ok', 'error', 'aborted')",
      stepId,
    );
    if (!step?.usage_purpose) return false;
    if (
      !db.run("UPDATE steps SET usage_accounted_at = ? WHERE id = ? AND usage_accounted_at IS NULL", now, stepId)
        .changes
    )
      return false;
    const reported = tokens.inputTotal !== null && tokens.inputCached !== null && tokens.outputTotal !== null;
    // Cache hit leaves out the first model call of each run: it starts with a cold cache, so a zero cache read says nothing
    // about caching. A call with no run is a run of its own. Every other call with both input and cached tokens pairs.
    // The tokens of excluded calls still count in the totals.
    const firstInRun =
      step.run_id === null ||
      !db.get<{ id: string }>(
        "SELECT id FROM steps WHERE run_id = ? AND id != ? AND usage_accounted_at IS NOT NULL LIMIT 1",
        step.run_id,
        stepId,
      );
    const paired = !firstInRun && tokens.inputTotal !== null && tokens.inputCached !== null;
    const cols = USAGE_METRICS.flatMap((m) => [COLUMNS[m], `${COLUMNS[m]}_known`]);
    const pairs = ["cache_pair_input", "cache_pair_cached"];
    const names = [
      "day",
      "purpose",
      "provider",
      "model",
      "agent_id",
      ...cols,
      ...pairs,
      "calls_reported",
      "calls_unreported",
      "updated_at",
    ];
    const counters = [...cols, ...pairs, "calls_reported", "calls_unreported"];
    db.run(
      `INSERT INTO usage_daily (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})
      ON CONFLICT (day, purpose, provider, model, agent_id) DO UPDATE SET
      ${counters.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`,
      new Date(now).toISOString().slice(0, 10),
      step.usage_purpose,
      step.provider,
      step.model,
      step.usage_agent_id,
      ...USAGE_METRICS.flatMap((m) => [tokens[m] ?? 0, tokens[m] === null ? 0 : 1]),
      paired ? (tokens.inputTotal ?? 0) : 0,
      paired ? (tokens.inputCached ?? 0) : 0,
      reported ? 1 : 0,
      reported ? 0 : 1,
      now,
    );
    return true;
  });
}
