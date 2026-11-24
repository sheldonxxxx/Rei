import type { UsagePurpose } from "@rei/protocol";
import type { Clock } from "../util/clock.ts";
import { instrumentModels } from "./instrument.ts";
import type { Deadlines } from "./model-config.ts";
import type { ModelRuntime } from "./models.ts";
import type { StepRecorder } from "./steps.ts";

/** A call outside any chat (such as a title) is short: it is cut off sooner than a chat turn. */
export const ONESHOT_DEADLINES: Deadlines = { firstEventMs: 30_000, idleMs: 30_000, totalMs: 60_000 };

export interface OneShotDeps {
  runtime: ModelRuntime;
  recorder: StepRecorder;
  clock: Clock;
  gatewayUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** What a one-shot call came to: the reply text, or why there is none (so a background task can say what went wrong). */
export type OneShotResult =
  | { ok: true; text: string }
  | { ok: false; reason: "unknown_model" | "aborted" | "error"; message: string };

/** Sends a system prompt and a single user message, with no tools or chat history. */
export async function askModelResult(
  d: OneShotDeps,
  modelId: string,
  system: string,
  prompt: string,
  purpose: UsagePurpose,
): Promise<OneShotResult> {
  await d.runtime.ensureProviders?.();
  await d.runtime.refreshCredential();
  const ref = d.runtime.ref(modelId);
  const models = instrumentModels(d.runtime.models, {
    recorder: d.recorder,
    resolveCall: () => ({ sessionId: undefined, runId: undefined, purpose, deadlines: ONESHOT_DEADLINES }),
    ...(d.gatewayUrl !== undefined ? { gatewayUrl: d.gatewayUrl } : {}),
    ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
    scrub: (text) => d.runtime.scrub(text),
  });
  const model = models.getModel(ref.provider, ref.modelId);
  if (!model) return { ok: false, reason: "unknown_model", message: `The model ${modelId} is not available.` };
  const result = await models.completeSimple(
    model,
    { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: d.clock.now() }] },
    { signal: AbortSignal.timeout(ONESHOT_DEADLINES.totalMs) },
  );
  if (result.stopReason === "error" || result.stopReason === "aborted")
    return {
      ok: false,
      reason: result.stopReason,
      message: d.runtime.scrub(result.errorMessage ?? "").trim() || "The model call did not finish.",
    };
  return { ok: true, text: result.content.map((part) => (part.type === "text" ? part.text : "")).join("") };
}
