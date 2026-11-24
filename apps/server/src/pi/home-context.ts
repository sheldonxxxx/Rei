import type { Message } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import { inputDigest } from "../conversation/ledger.ts";
import type { AppStore } from "../store/store.ts";
import type { RunPins } from "./stable-prefix.ts";

export const DEFAULT_HOME_CONTEXT = { idleGapMs: 60 * 60_000, maxTokens: 64_000 } as const;
export interface HomeContextConfig {
  idleGapMs: number;
  maxTokens: number;
}
type Entry = { role?: string; content?: unknown };
let tokenizer: Tiktoken | undefined;
const tokens = (value: unknown) => {
  tokenizer ??= new Tiktoken(o200k);
  const text = JSON.stringify(value, (key, v) => (key === "data" && typeof v === "string" ? "[binary]" : v)) ?? "";
  // Bound BPE work on unusually long, repetitive reports. Chunk boundaries conservatively overestimate tokens.
  let count = 0;
  for (let at = 0; at < text.length; at += 2048) count += tokenizer.encode(text.slice(at, at + 2048)).length;
  return count;
};
const textOf = (m: Entry): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
      : "";

// Pi presents the active compaction head as the first conversation message, with this envelope.
const isSummary = (message: Entry) =>
  message.role === "user" &&
  textOf(message).startsWith(
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\n",
  ) &&
  textOf(message).endsWith("\n</summary>");

export function homeContextConfig(store: AppStore): HomeContextConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(store.metaGet("home_context") ?? "{}");
  } catch {
    /* Defaults remain usable if settings are malformed. */
  }
  const positive = (key: keyof HomeContextConfig) =>
    typeof raw?.[key] === "number" && Number.isSafeInteger(raw[key]) && (raw[key] as number) > 0
      ? (raw[key] as number)
      : DEFAULT_HOME_CONTEXT[key];
  return {
    idleGapMs: positive("idleGapMs"),
    maxTokens: positive("maxTokens"),
  };
}

/** Settings for the actual provider request, and a notification when Home should compact its older turns. */
interface HomeProjection {
  midConversationSystem?: boolean;
  windowBudget?: number;
  compact?: () => void;
}

/**
 * Select whole input/response groups and preserve the active turn and Pi's compaction head. Start a new window with
 * cache headroom where possible, but keep the previous exchange if it still fits and the rounding would lose it.
 */
export function selectHomeMessages<T extends Entry>(
  messages: T[],
  budget: number,
  protect?: (text: string) => boolean,
  pinnedStart?: number,
  projection: HomeProjection = {},
): T[] {
  const system = (m: Entry) => m.role === "system";
  const first = messages.findIndex((m) => !system(m));
  const summary = first >= 0 && isSummary(messages[first]!) ? first : -1;
  const input = (m: Entry, index: number) => m.role === "user" && index !== summary;
  let start = 0;
  const lastInput = messages.findLastIndex(input);
  const protectedAt = protect ? messages.findLastIndex((m, i) => input(m, i) && protect(textOf(m))) : -1;
  const limit = protectedAt >= 0 ? protectedAt : lastInput;
  const previous = messages.findLastIndex((m, i) => i < limit && input(m, i));

  // Providers without mid-conversation system updates replay section replacements and tool changes into a single
  // prompt. Count that effective state while leaving the original messages for the transport to render.
  const folded = projection.midConversationSystem === false;
  const mandatorySystem = folded ? tokens(getCurrentSystemMessage(messages as unknown as Message[])) : 0;
  const counts = messages.map((m) => (folded && system(m) ? 0 : tokens(m)));
  const total = mandatorySystem + counts.reduce((sum, count) => sum + count, 0);
  const removable = (i: number) => i !== summary && !system(messages[i]!);

  if (previous >= 0 && total > budget * 0.8) projection.compact?.();
  const keepFrom = (at: number) => messages.filter((_, i) => i >= at || !removable(i));
  if (pinnedStart !== undefined && pinnedStart <= limit) {
    let pinnedTotal = total;
    for (let i = 0; i < pinnedStart; i++) if (removable(i)) pinnedTotal -= counts[i]!;
    if (pinnedTotal <= Math.min(2 * budget, projection.windowBudget ?? Infinity)) return keepFrom(pinnedStart);
  }

  if (total > budget) {
    const step = Math.max(1, Math.floor(budget / 4));
    const target = Math.ceil((total - budget) / step) * step;
    let dropped = 0;
    for (let i = start; i <= limit; i++) {
      if (i > start && input(messages[i]!, i)) {
        start = i;
        if (dropped >= target || (i === previous && total - dropped <= budget)) break;
      }
      if (removable(i)) dropped += counts[i]!;
    }
  }
  return keepFrom(start);
}

/** Runtime-only projection: persisted conversation and visible history are never rewritten. */
export function homeMessages(
  store: AppStore,
  sessionId: string | undefined,
  runId: string | undefined,
  messages: unknown,
  otherContext: unknown,
  contextWindow?: number,
  pins?: RunPins,
  projection: HomeProjection = {},
): unknown {
  if (!sessionId || !runId || !Array.isArray(messages) || store.getSessionRow(sessionId)?.origin !== "home")
    return messages;
  const run = store.getRun(runId);
  if (!run) return messages;
  const config = homeContextConfig(store);
  // Human activity: the direct inputs the user typed in this chat, up to this run.
  const humans = store.runs
    .forSession(sessionId)
    .filter(
      (r) =>
        r.kind === "input" &&
        r.role === "user" &&
        r.direct === 1 &&
        !r.assigned_by &&
        (r.created_at < run.created_at || (r.created_at === run.created_at && r.id <= runId)),
    );
  const lastHuman = humans.at(-1);
  const windowBudget = contextWindow ? Math.max(1, Math.floor(contextWindow * 0.75) - tokens(otherContext)) : undefined;
  const budget = Math.min(config.maxTokens, windowBudget ?? Infinity);
  // The user's latest message stays in view, so a large report or tool result never hides the question it answers.
  const humanDigest = lastHuman?.input_digest;
  const selected = selectHomeMessages(
    messages,
    budget,
    humanDigest ? (text: string) => inputDigest(text) === humanDigest : undefined,
    pins?.windowStart(runId, messages as Entry[]),
    {
      ...(projection.midConversationSystem !== undefined
        ? { midConversationSystem: projection.midConversationSystem }
        : {}),
      ...(windowBudget !== undefined ? { windowBudget } : {}),
      ...(projection.compact ? { compact: projection.compact } : {}),
    },
  );
  // The run's later calls keep this start while it fits, so their requests share one prefix.
  const first = selected.find((m) => (m as Entry).role !== "system" && !isSummary(m as Entry));
  if (pins && first) pins.pinWindowStart(runId, first as Entry);
  return selected;
}
