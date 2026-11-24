import type { Approval, ConversationLive, StepSummary } from "@rei/protocol";
import { isParkedTool } from "@rei/protocol";
import type { IconName } from "../components/Icon.tsx";

const SURFACE_TOOLS = new Set(["show_surface", "update_surface"]);
/** A surface tool call: its result shows in the reply as the surface itself, so the chat draws no row for it. */
export const isSurfaceStep = (step: StepSummary): boolean =>
  step.type === "tool.call" && SURFACE_TOOLS.has(step.toolName ?? "");

/** The `codemode` tool: one script whose calls to other tools are recorded as its nested steps. */
export const isScriptStep = (step: StepSummary): boolean => step.type === "tool.call" && step.toolName === "codemode";

export function activityLabel(step: StepSummary): string {
  if (step.type === "llm.call") return "Model call";
  // A script's policy summary is its first line of code, which says nothing to a reader: the model's label, or this.
  if (isScriptStep(step)) return step.activity?.trim() || "Ran a script";
  if (isSurfaceStep(step) && step.status === "error")
    return step.toolName === "show_surface"
      ? "A surface was refused and sent back to fix"
      : "A surface change was refused";
  if (step.type === "capabilities.changed") return "Capabilities changed";
  return step.activity?.trim() || step.summary?.trim() || step.toolName?.replaceAll("_", " ") || "Use a tool";
}

export function activityIcon(step: StepSummary, outcomes?: ApprovalOutcomes): IconName {
  if (isApprovedStep(step, outcomes)) return "check";
  if (step.status === "error" || step.status === "blocked" || step.status === "not_executed") return "alert";
  if (step.type === "llm.call") return "sparkle";
  if (step.type === "capabilities.changed") return "puzzle";
  const name = step.toolName ?? "";
  if (name === "codemode") return "code";
  if (name === "bash") return "terminal";
  if (name === "show_surface" || name === "update_surface") return "grid";
  if (name === "read" || name === "read_skill_file" || name === "use_skill") return "memory";
  if (name === "write" || name === "edit") return "edit";
  if (name.includes("search")) return "search";
  if (name.startsWith("web_") || name.startsWith("browser_")) return "globe";
  if (name.endsWith("_session") || name === "list_sessions") return "sessions";
  if (name.startsWith("memory_")) return "memory";
  if (name.startsWith("knowledge_")) return "knowledge";
  return "wrench";
}

/** What became of the approval a blocked step asked for, by approval id (from the chat's approval messages). */
export type ApprovalOutcomes = ReadonlyMap<string, Approval["status"]>;

const DECIDED_WORD: Partial<Record<Approval["status"], string>> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
};

/** The decided word for a step that was blocked on an approval that has since been decided; otherwise null. */
export function decidedWord(step: StepSummary, outcomes?: ApprovalOutcomes): string | null {
  if (step.status !== "blocked" || step.decision !== "ask" || !step.approvalId) return null;
  const status = outcomes?.get(step.approvalId);
  return (status && DECIDED_WORD[status]) || null;
}

/** A blocked step whose approval was approved: it is done waiting, so it reads green rather than as needing attention. */
export const isApprovedStep = (step: StepSummary, outcomes?: ApprovalOutcomes): boolean =>
  decidedWord(step, outcomes) === "Approved";

/** True while a step is still waiting on you (or blocked outright); a decided approval no longer asks for attention. */
export const stepNeedsAttention = (step: StepSummary, outcomes?: ApprovalOutcomes): boolean =>
  step.status === "blocked" && decidedWord(step, outcomes) === null;

/** Tool calls of the live run that are parked: they hold no work and wait for something outside the run. */
export type ParkedCalls = ReadonlySet<string>;

/** The parked calls of the live run, from its tool slots. */
export function parkedCalls(live: ConversationLive | null | undefined): ParkedCalls {
  return new Set((live?.tools ?? []).filter((t) => isParkedTool(t.status)).map((t) => t.callId));
}

/** A running step whose call is parked in the live run. */
export const isParkedStep = (step: StepSummary, parked?: ParkedCalls): boolean =>
  step.status === "running" && step.toolCallId !== undefined && parked?.has(step.toolCallId) === true;

export function activityStatus(
  step: StepSummary,
  outcomes?: ApprovalOutcomes,
  waitingForApproval = false,
  parked?: ParkedCalls,
): string {
  const decided = decidedWord(step, outcomes);
  if (decided) return decided;
  if (step.status === "running")
    return (waitingForApproval && step.decision === "ask") ||
      (step.approvalId && outcomes?.get(step.approvalId) === "pending")
      ? "Waiting for approval"
      : isParkedStep(step, parked)
        ? step.decision === "ask"
          ? "Waiting for approval"
          : "Waiting"
        : "Running";
  if (step.status === "error") return "Failed";
  if (step.status === "cancelled") return "Stopped";
  if (step.status === "not_executed") return step.errorCode === "interrupted" ? "Interrupted" : "Not run";
  if (step.status === "blocked") return step.decision === "ask" ? "Needs approval" : "Blocked";
  return "Completed";
}
