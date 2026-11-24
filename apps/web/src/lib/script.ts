import type { ConversationLive, LiveTool, Message, StepSummary } from "@rei/protocol";
import type { ApprovalOutcomes, ParkedCalls } from "./activity.ts";
import { activityStatus, isScriptStep } from "./activity.ts";

/** "1 call", "2 calls". */
export const callsText = (n: number): string => `${n} ${n === 1 ? "call" : "calls"}`;

/** The live slots of calls a script is making now, in the order Pi lists them. */
export const nestedLiveCalls = (live: ConversationLive | null | undefined): readonly LiveTool[] =>
  (live?.tools ?? []).filter((t) => t.nested === true && t.parentCallId !== undefined);

/** A row's identity across the live run and the trace: the call's id, which the recorded step keeps. */
export const rowKey = (step: StepSummary): string => step.toolCallId ?? step.id;

/** True for the stand-in row of a live call the trace has not recorded yet; it has no step to inspect. */
export const isPlaceholder = (step: StepSummary): boolean => step.id.startsWith("live:");

export interface ScriptTree {
  /** The rows of the run itself: every step that is not a script's nested call. */
  top: StepSummary[];
  /** A script step's nested calls (by the script's step id), in the order they were made. */
  calls: ReadonlyMap<string, StepSummary[]>;
}

/**
 * Groups a run's steps under their scripts. Recorded nested steps come from the trace (`parentStepId`). A call the live run
 * shows but the trace has not recorded yet (the trace is fetched every few seconds) gets a stand-in row with the same key
 * the recorded step will have, so the row keeps its place and identity when the trace catches up.
 */
export function scriptTree(steps: StepSummary[], live: readonly LiveTool[] = []): ScriptTree {
  const ids = new Set(steps.map((s) => s.id));
  const top: StepSummary[] = [];
  const calls = new Map<string, StepSummary[]>();
  for (const s of steps) {
    // A nested step whose script is not in the list (it should always be) stays a row of its own rather than vanishing.
    if (s.parentStepId !== undefined && ids.has(s.parentStepId)) {
      calls.set(s.parentStepId, [...(calls.get(s.parentStepId) ?? []), s]);
    } else top.push(s);
  }
  const recorded = new Set(steps.flatMap((s) => (s.toolCallId ? [s.toolCallId] : [])));
  for (const t of live) {
    if (t.parentCallId === undefined || recorded.has(t.callId)) continue;
    const script = steps.find((s) => isScriptStep(s) && s.toolCallId === t.parentCallId);
    if (!script) continue;
    const stand: StepSummary = {
      id: `live:${t.callId}`,
      runId: script.runId,
      sessionId: script.sessionId,
      type: "tool.call",
      status: t.status === "done" ? "ok" : "running",
      startedAt: script.startedAt,
      latencyMs: null,
      piEntryId: null,
      sideEffect: false,
      toolName: t.name,
      toolCallId: t.callId,
      parentStepId: script.id,
    };
    calls.set(script.id, [...(calls.get(script.id) ?? []), stand]);
  }
  return { top, calls };
}

/**
 * What a running script is waiting for, if anything: "Waiting for approval" while one of its calls waits on a decision,
 * "Waiting" while another is parked. Null when the script is running (or done) and the usual word applies.
 */
export function scriptWait(
  script: StepSummary,
  calls: readonly StepSummary[],
  asked: number,
  outcomes: ApprovalOutcomes | undefined,
  waitingForApproval: boolean,
  parked: ParkedCalls | undefined,
): string | null {
  if (script.status !== "running") return null;
  const words = calls.map((c) => activityStatus(c, outcomes, waitingForApproval, parked));
  if (asked > 0 || words.some((w) => w === "Waiting for approval" || w === "Needs approval"))
    return "Waiting for approval";
  return words.includes("Waiting") ? "Waiting" : null;
}

/**
 * The approval cards a script's calls asked for, by the script's call id, for the scripts in the runs the chat draws.
 * A card whose script row is not in view (another chat's mirror, a run not loaded yet) is left out and keeps its usual place.
 */
export function scriptCards(messages: Message[], scripts: ReadonlySet<string>): Map<string, Message[]> {
  const byScript = new Map<string, Message[]>();
  for (const m of messages) {
    const parent = m.role === "approval" ? m.approval?.parentCallId : undefined;
    if (parent && scripts.has(parent)) byScript.set(parent, [...(byScript.get(parent) ?? []), m]);
  }
  return byScript;
}
