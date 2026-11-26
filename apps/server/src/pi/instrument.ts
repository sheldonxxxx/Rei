import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { UsagePurpose } from "@rei/protocol";
import { offeredTools } from "../trace-tools.ts";
import { usageEvidenceFromEvent } from "../usage/accounting.ts";
import {
  CONTEXT_LIMIT_PREFIX,
  DEADLINE_PREFIX,
  GATEWAY_DOWN_PREFIX,
  LOOP_GUARD_PREFIX,
  mapModelError,
  OUTPUT_LIMIT_PREFIX,
  providerErrorText,
} from "./errors.ts";
import { createGatewayFetch, deadlineMessage } from "./gateway-fetch.ts";
import type { Deadlines } from "./model-config.ts";
import { NATIVE_SEARCH_REPLACES, withNativeSearch } from "./native-search.ts";
import type { StepHandle, StepRecorder } from "./steps.ts";

export interface CallInfo {
  sessionId: string | undefined;
  runId: string | undefined;
  purpose: UsagePurpose;
  agentId?: string | undefined;
  deadlines: Deadlines;
  /** Whether a tool is deferred (offered only once search_capabilities loads it); unset: none is. */
  deferred?: ((name: string) => boolean) | undefined;
}

export interface InstrumentDeps {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Set and true: OpenAI Responses calls search with OpenAI's built-in tool, and web_search is not offered. */
  nativeSearch?: (info: CallInfo) => boolean;
  recorder: StepRecorder;
  /** Called for every model call; the tree this wrapper belongs to knows its session and the run in flight. */
  resolveCall(options: Record<string, unknown>, completion: boolean): CallInfo;
  /** Set: requests go through the gateway. Unset (faux mode): no HTTP at all. */
  gatewayUrl?: string;
  fetchImpl?: typeof fetch;
  /** Faux mode: pi-ai's faux provider never calls `onPayload`, so the wrapper records the request it was asked for. */
  syntheticPayload?: boolean;
  /** Runs right before the call is handed on (faux mode arms its next scripted reply here). */
  beforeCall?(): void;
  /**
   * Project the working context without rewriting durable history (home-chat window, mid-run section updates).
   * `midConversationSystem`: the model takes system messages in place, so pi-ai does not fold them into the first.
   */
  prepareMessages?(
    info: CallInfo,
    messages: unknown,
    otherContext: unknown,
    contextWindow?: number,
    midConversationSystem?: boolean,
  ): unknown;
  /** Loop guard: a message when this call must not be made (the run is over its limits); it is refused before it is sent. */
  refuse?(info: CallInfo): string | undefined;
  /** Applied to the error text of a failed call before Pi stores it (upstream error bodies can echo headers). */
  scrub?(text: string): string;
}

type AnyFn = (...args: any[]) => any;

/** The final message of a failed call, with the text the user-facing error mapping looks for. */
function rewriteFailure(
  step: StepHandle,
  message: AssistantMessage,
  scrub: (text: string) => string,
): AssistantMessage {
  if (message.stopReason !== "error") return message;
  if (step.deadline !== undefined) return { ...message, errorMessage: deadlineMessage(step.deadline, step) };
  if (step.gatewayDown) return { ...message, errorMessage: `${GATEWAY_DOWN_PREFIX} could not reach the model gateway` };
  return {
    ...message,
    errorMessage: providerErrorText(scrub(message.errorMessage ?? ""), step.httpErrorStatus),
  };
}

export function isDeadlineError(text: string | undefined): boolean {
  return text?.startsWith(DEADLINE_PREFIX) === true;
}

/** A failed call's final message, carrying the text the error mapping reads (see `errors.ts`). */
function failedMessage(model: { id: string; provider: string }, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: (model as { api?: string }).api ?? "unknown",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: text,
    timestamp: Date.now(),
  } as AssistantMessage;
}

/**
 * The estimated input when a known context window cannot hold it, else undefined. The estimate is pi-ai's own, so this
 * refuses exactly the calls pi-ai would otherwise send with a one-token output budget.
 */
function overflowTokens(
  model: { contextWindow?: number },
  context: Parameters<typeof estimateContextTokens>[0],
): number | undefined {
  const window = model.contextWindow ?? 0;
  if (window <= 0) return undefined;
  const tokens = estimateContextTokens(context).tokens;
  return tokens >= window ? tokens : undefined;
}

/** A reply that hit the output cap with no text or tool call: the answer never came, so it is a failure, not a reply. */
function emptyLengthStop(message: AssistantMessage): boolean {
  return (
    message.stopReason === "length" &&
    !message.content.some((block) => (block.type === "text" && block.text.trim() !== "") || block.type === "toolCall")
  );
}

/**
 * Wraps a `Models` so that every model call (a) gets a step row and a step id, (b) has its exact payload stored before
 * it leaves, (c) is sent to the gateway through pi-ai's `fetch` option with the deadlines enforced,
 * and (d) ends with a final message whose error text says why when a deadline or an unreachable gateway was the cause.
 */
export function instrumentModels(inner: Models, deps: InstrumentDeps): Models {
  const instrument =
    (method: "stream" | "streamSimple", completion = false) =>
    (
      model: {
        id: string;
        provider: string;
        contextWindow?: number;
        api?: string;
        compat?: { supportsMidConvoSystemMessages?: boolean };
      },
      context: { messages: unknown; tools?: unknown; systemPrompt?: unknown },
      options: Record<string, any> = {},
    ) => {
      const scrub = deps.scrub ?? ((text: string) => text);
      const info = deps.resolveCall(options, completion);
      const refusal = deps.refuse?.(info);
      if (refusal !== undefined) {
        const refused = createAssistantMessageEventStream();
        const error = {
          role: "assistant",
          content: [],
          api: (model as { api?: string }).api ?? "unknown",
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: `${LOOP_GUARD_PREFIX} ${refusal}`,
          timestamp: Date.now(),
        } as AssistantMessage;
        refused.push({ type: "error", reason: "error", error });
        refused.end();
        return refused;
      }
      if (deps.prepareMessages)
        context = {
          ...context,
          messages: deps.prepareMessages(
            info,
            context.messages,
            { system: context.systemPrompt, tools: context.tools },
            model.contextWindow,
            model.compat?.supportsMidConvoSystemMessages === true,
          ),
        };
      deps.beforeCall?.();
      const native =
        deps.nativeSearch?.(info) === true && model.provider === "openai" && model.api === "openai-responses";
      const offered = offeredTools({ tools: context.tools ?? [], messages: context.messages })?.filter(
        (name) => !(native && name === NATIVE_SEARCH_REPLACES),
      );
      const step = deps.recorder.begin({
        sessionId: info.sessionId,
        runId: info.runId,
        provider: model.provider,
        model: model.id,
        contextWindow: model.contextWindow,
        purpose: info.purpose,
        agentId: info.agentId,
        deadlines: info.deadlines,
        offeredTools: offered,
        loadedTools: offered && info.deferred ? offered.filter(info.deferred) : undefined,
      });
      const callerOnPayload: AnyFn | undefined = options.onPayload;
      const callerOnProviderEvent: AnyFn | undefined = options.onProviderStreamEvent;
      const callOptions: Record<string, any> = {
        ...options,
        onProviderStreamEvent: async (event: unknown, m: unknown) => {
          const evidence = usageEvidenceFromEvent(event);
          if (evidence !== undefined) step.usageEvidence = evidence;
          await callerOnProviderEvent?.(event, m);
        },
        onPayload: async (payload: unknown, m: unknown) => {
          const effort = providerDefaultEffort(payload, options.reasoningEffort);
          const own = native ? withNativeSearch(effort ?? payload) : effort;
          const replaced = (await callerOnPayload?.(own ?? payload, m)) ?? own;
          await step.capture(replaced === undefined ? payload : replaced);
          return replaced;
        },
      };
      const outputAbort = deps.maxOutputTokens ? new AbortController() : undefined;
      if (outputAbort) {
        callOptions.maxTokens = Math.min(
          typeof options.maxTokens === "number" ? options.maxTokens : Infinity,
          deps.maxOutputTokens!,
        );
        callOptions.signal = options.signal
          ? AbortSignal.any([options.signal, outputAbort.signal])
          : outputAbort.signal;
      }
      if (deps.gatewayUrl !== undefined) {
        callOptions.fetch = createGatewayFetch({
          gatewayUrl: deps.gatewayUrl,
          step,
          providerId: model.provider,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
      }
      const out = createAssistantMessageEventStream();
      const overBudget =
        deps.maxInputTokens &&
        estimateContextTokens(context as Parameters<typeof estimateContextTokens>[0]).tokens > deps.maxInputTokens;
      const overflow = overBudget
        ? deps.maxInputTokens
        : overflowTokens(model, context as Parameters<typeof estimateContextTokens>[0]);
      if (overflow !== undefined) {
        // Refused before the request leaves: the step records why, and the chat gets the error at once.
        const error = failedMessage(
          model,
          overBudget
            ? `${CONTEXT_LIMIT_PREFIX} Private execution exceeds its ${deps.maxInputTokens} input-token budget.`
            : `${CONTEXT_LIMIT_PREFIX} This chat needs about ${overflow} input tokens, but the model's context window is ${model.contextWindow}. Start a new chat, or raise Context window for this model in Settings → Models.`,
        );
        step.finish("error", error, "context_too_large");
        out.push({ type: "error", reason: "error", error });
        out.end();
        return out;
      }
      void (async () => {
        let final: AssistantMessage | undefined;
        let terminal: AssistantMessageEvent | undefined;
        let status: "ok" | "error" | "aborted" = "error";
        try {
          if (deps.syntheticPayload) {
            await step.capture({
              model: model.id,
              messages: context.messages,
              tools: context.tools ?? [],
              system: context.systemPrompt ?? null,
            });
          }
          const stream = (inner[method] as AnyFn).call(
            inner,
            model,
            context,
            callOptions,
          ) as AsyncIterable<AssistantMessageEvent>;
          for await (const event of stream) {
            const partial = "partial" in event ? event.partial : event.type === "done" ? event.message : undefined;
            if (deps.maxOutputTokens && partial && estimateMessageTokens(partial) > deps.maxOutputTokens) {
              outputAbort?.abort();
              const error = {
                ...partial,
                stopReason: "error" as const,
                errorMessage: `${OUTPUT_LIMIT_PREFIX} Private execution output budget exceeded.`,
              };
              final = error;
              status = "error";
              terminal = { type: "error", reason: "error", error };
              break;
            }
            if (event.type === "error") {
              const error = rewriteFailure(step, event.error, scrub);
              final = error;
              status = error.stopReason === "aborted" ? "aborted" : "error";
              terminal = { type: "error", reason: event.reason, error };
            } else {
              if (event.type === "done" && emptyLengthStop(event.message)) {
                // The model used its whole output budget (reasoning, usually) and never wrote an answer. Say so.
                const error: AssistantMessage = {
                  ...event.message,
                  stopReason: "error",
                  errorMessage: `${OUTPUT_LIMIT_PREFIX} The model stopped at its output limit before writing a reply. Raise Max output tokens for this model in Settings → Models, or lower its thinking level.`,
                };
                final = error;
                status = "error";
                terminal = { type: "error", reason: "error", error };
              } else if (event.type === "done") {
                final = event.message;
                status = "ok";
                terminal = event;
              } else out.push(event);
            }
          }
          if (!terminal) throw new Error("The model stream ended without a terminal event.");
        } catch (cause) {
          const error = options.signal?.aborted
            ? { ...failedMessage(model, "The run was stopped."), stopReason: "aborted" as const }
            : rewriteFailure(step, failedMessage(model, cause instanceof Error ? cause.message : ""), scrub);
          final = error;
          status = error.stopReason === "aborted" ? "aborted" : "error";
          terminal = { type: "error", reason: status, error };
        } finally {
          try {
            step.finish(status, final, status === "error" ? mapModelError(final?.errorMessage).code : undefined);
          } catch {
            // A stopped server can close the DB mid-call. Uncommitted usage stays unaccounted; never infer it from historical logs.
          }
          // Publish the terminal event only after finish commits: completeSimple().result() must see its snapshot.
          if (terminal) out.push(terminal);
          out.end();
        }
      })();
      return out;
    };
  const stream = instrument("stream");
  const streamSimple = instrument("streamSimple");
  const complete = instrument("stream", true);
  const completeSimple = instrument("streamSimple", true);
  const overrides: Record<string | symbol, unknown> = {
    stream,
    streamSimple,
    complete: (...args: unknown[]) => (complete as AnyFn)(...args).result(),
    completeSimple: (...args: unknown[]) => (completeSimple as AnyFn)(...args).result(),
  };
  return new Proxy(inner, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Rei's thinking level "off" is shown as Default: the provider decides. pi-ai 1.5 sends `reasoning: { effort: "none" }`
 * for it instead, which turns reasoning off. Without a requested effort, drop exactly that field, so the request is the
 * one 1.4 sent. Any other reasoning field (a requested effort, a summary) is left as it is.
 */
export function providerDefaultEffort(payload: unknown, requested: unknown): unknown {
  if (requested !== undefined || typeof payload !== "object" || payload === null) return undefined;
  const reasoning = (payload as { reasoning?: unknown }).reasoning;
  if (typeof reasoning !== "object" || reasoning === null) return undefined;
  const keys = Object.keys(reasoning);
  if (keys.length !== 1 || (reasoning as { effort?: unknown }).effort !== "none") return undefined;
  const { reasoning: _dropped, ...rest } = payload as Record<string, unknown>;
  return rest;
}
