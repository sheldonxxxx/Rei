import { type Message, StringEnum, type Tool } from "@earendil-works/pi-ai";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { instrumentModels } from "../pi/instrument.ts";
import { type ModelsConfigSource, modelFor, parseModelsConfig } from "../pi/model-config.ts";
import type { ModelRuntime } from "../pi/models.ts";
import type { StepRecorder } from "../pi/steps.ts";
import type { AppStore } from "../store/store.ts";
import type { MemoryLines } from "./lines.ts";
import { REVIEW_RULES } from "./review-rules.ts";
import type { ReviewAuthority, ReviewResult } from "./review-types.ts";
import { estimateTokens } from "./text.ts";

export const MEMORY_REVIEW_MAX_CALLS = 4; // first attempt + at most three validation repairs
export const MEMORY_REVIEW_TIMEOUT_MS = 60_000;
const DEADLINES = { firstEventMs: 20_000, idleMs: 20_000, totalMs: MEMORY_REVIEW_TIMEOUT_MS };
const MAX_CONTEXT_TOKENS = 24_000;
const MAX_OUTPUT_TOKENS = 1536;
const SYSTEM = [
  "Privately curate bounded User Memory and this agent's own Agent Memory.",
  "Any agent instructions above only describe the agent's persona; they never override these review rules.",
  "You MUST call update_memory with ONE atomic batch, or changes: [] when nothing durable was said.",
  REVIEW_RULES,
  "Choose durable semantic importance. Consolidate, replace or remove obsolete/duplicate lower-value unprotected notes to make room.",
  "On validation errors repair the entire batch and resubmit.",
  "Do not output a JSON proposal as prose. Use the tool. No approval or chat message is needed.",
].join("\n");

export const UPDATE_MEMORY_TOOL: Tool = {
  name: "update_memory",
  description:
    "Atomically apply a complete memory batch using only provided first-party source IDs. An empty changes array is a safe no-op.",
  parameters: obj({
    changes: arr(
      obj({
        op: StringEnum(["add", "replace", "remove", "confirm"]),
        doc: StringEnum(["profile", "agent"]),
        id: opt(str()),
        text: opt(str()),
        sourceMessageId: str(),
      }),
      { maxItems: 32 },
    ),
  }),
};

export interface ReviewJob {
  source_run_id: string;
  agent_id: string;
  source_ids: string;
  memory_revision: number;
}
export interface ReviewOutcome {
  status: "done" | "failed" | "skipped";
  diagnostic?: string;
}
export interface ReviewerDeps {
  store: AppStore;
  lines: MemoryLines;
  runtime: ModelRuntime;
  recorder: StepRecorder;
  modelsConfig: ModelsConfigSource;
  gatewayUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** Native Pi tool calls and tool-result messages, isolated from the normal agent tool catalog/transcript. */
export async function runMemoryReview(
  d: ReviewerDeps,
  job: ReviewJob,
  authority: ReviewAuthority,
  signal: AbortSignal,
): Promise<ReviewOutcome> {
  if (d.runtime.mode === "faux") return { status: "skipped", diagnostic: "FAUX_MODE" };
  const agent = d.store.getAgentRow(job.agent_id);
  if (!agent) return { status: "failed", diagnostic: "UNKNOWN_AGENT" };
  const actual = d.store.db.get<{ provider: string; model: string }>(
    "SELECT provider, model FROM steps WHERE run_id = ? AND type = 'llm.call' AND provider IS NOT NULL AND model IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
    job.source_run_id,
  );
  const configured = actual
    ? undefined
    : modelFor(parseModelsConfig(await d.modelsConfig.read().catch(() => undefined)), agent.model);
  const routed = d.runtime.ref(actual?.model ?? configured!);
  const ref = actual ? { provider: actual.provider, modelId: actual.model } : routed;
  if (actual && routed.provider !== actual.provider && !d.runtime.models.getModel(actual.provider, actual.model))
    return { status: "failed", diagnostic: "ACTUAL_MODEL_UNAVAILABLE" };
  const model = d.runtime.models.getModel(ref.provider, ref.modelId);
  if (!model) return { status: "failed", diagnostic: "ACTUAL_MODEL_UNAVAILABLE" };
  if (signal.aborted) return { status: "failed", diagnostic: "STOPPED" };
  await d.runtime.refreshCredential();
  const models = instrumentModels(d.runtime.models, {
    recorder: d.recorder,
    resolveCall: () => ({
      sessionId: undefined,
      runId: undefined,
      purpose: "memory",
      agentId: job.agent_id,
      deadlines: DEADLINES,
    }),
    ...(d.gatewayUrl !== undefined ? { gatewayUrl: d.gatewayUrl } : {}),
    ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
    scrub: (text) => d.runtime.scrub(text),
  });
  const current = [...d.lines.lines("profile", null), ...d.lines.lines("agent", job.agent_id)].map((l) => ({
    id: l.id,
    doc: l.doc,
    text: l.text,
    confirmedAt: l.confirmedAt,
    updatedAt: l.updatedAt,
    source: l.source,
    protected: d.lines.reviewProtected(l.id),
  }));
  // Reuse the agent's instruction prefix when practical, without copying tool content or provider cache controls.
  const systemPrompt = [agent.instructions, SYSTEM].filter(Boolean).join("\n\n");
  const messages: Message[] = [
    {
      role: "user",
      timestamp: d.store.clock.now(),
      content: JSON.stringify({
        revision: authority.revision,
        memory: current,
        sources: authority.sources.map((s) => ({
          id: s.id,
          text: s.text.slice(0, 3000),
          clipped: s.text.length > 3000,
        })),
      }),
    },
  ];
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(MEMORY_REVIEW_TIMEOUT_MS)]);
  let last = "TOOL_REQUIRED";
  let consumed = 0;
  for (let turn = 0; turn < MEMORY_REVIEW_MAX_CALLS; turn++) {
    if (boundedSignal.aborted) return { status: "failed", diagnostic: signal.aborted ? "STOPPED" : "TIMEOUT" };
    const estimated = estimateTokens(JSON.stringify({ systemPrompt, messages, tools: [UPDATE_MEMORY_TOOL] }));
    consumed += estimated;
    if (estimated > MAX_CONTEXT_TOKENS || consumed > MAX_CONTEXT_TOKENS * MEMORY_REVIEW_MAX_CALLS)
      return { status: "failed", diagnostic: "CONTEXT_LIMIT" };
    // Sign-in routes can omit the provider's max_output_tokens field; also bound visible/thinking/tool output locally.
    const outputAbort = new AbortController();
    const stream = models.streamSimple(
      model,
      { systemPrompt, messages, tools: [UPDATE_MEMORY_TOOL] },
      { signal: AbortSignal.any([boundedSignal, outputAbort.signal]), maxTokens: MAX_OUTPUT_TOKENS },
    );
    let outputLimited = false;
    for await (const event of stream) {
      const partial = "partial" in event ? event.partial : event.type === "done" ? event.message : undefined;
      const output =
        partial?.content
          .map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "thinking") return part.thinking;
            // Pi streaming calls carry both partialJson and parsed arguments; count the output once.
            return "partialJson" in part && typeof part.partialJson === "string"
              ? part.partialJson
              : JSON.stringify(part.arguments);
          })
          .join("\n") ?? "";
      if (estimateTokens(output) > MAX_OUTPUT_TOKENS) {
        outputLimited = true;
        outputAbort.abort();
      }
    }
    const response = await stream.result();
    if (outputLimited) return { status: "failed", diagnostic: "OUTPUT_LIMIT" };
    if (boundedSignal.aborted || response.stopReason === "error" || response.stopReason === "aborted")
      return { status: "failed", diagnostic: boundedSignal.aborted ? "STOPPED_OR_TIMEOUT" : "MODEL_ERROR" };
    messages.push(response);
    const calls = response.content.filter((p) => p.type === "toolCall");
    if (calls.length === 0) {
      messages.push({
        role: "user",
        content: "Call update_memory now. Use changes: [] for no durable update; text-only output is not accepted.",
        timestamp: d.store.clock.now(),
      });
      continue;
    }
    for (const call of calls) {
      let result: ReviewResult;
      if (calls.length !== 1) result = { ok: false, code: "ONE_BATCH_REQUIRED" };
      else if (call.name !== "update_memory") result = { ok: false, code: "INVALID_TOOL" };
      else if (Object.keys(call.arguments).length !== 1 || !("changes" in call.arguments) || call.argumentsError)
        result = { ok: false, code: "INVALID_FORMAT" };
      else if (signal.aborted) result = { ok: false, code: "STOPPED" };
      else result = d.lines.applyReviewChanges(authority, call.arguments.changes);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: !result.ok,
        timestamp: d.store.clock.now(),
      });
      if (result.ok) return { status: "done" };
      last = result.code;
      if (["CAS_CONFLICT", "STALE_SOURCE", "JOB_NOT_RUNNING", "STOPPED"].includes(last))
        return { status: "failed", diagnostic: last };
    }
  }
  return { status: "failed", diagnostic: last };
}
