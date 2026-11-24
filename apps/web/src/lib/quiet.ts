import type { Message, RunTrace } from "@rei/protocol";
import type { ApprovalOutcomes } from "./activity.ts";
import { stepNeedsAttention } from "./activity.ts";

/**
 * Simple mode shows what you need to know and nothing that is only bookkeeping: an approval you gave, a "Memory updated"
 * chip, and the assistant's follow-up about a memory save. Show details keeps all of it.
 */

/** What each approval in the chat became, by approval id. */
export function approvalOutcomes(messages: Message[]): ApprovalOutcomes {
  const out = new Map<string, NonNullable<Message["approval"]>["status"]>();
  for (const m of messages) if (m.role === "approval" && m.approval) out.set(m.approval.id, m.approval.status);
  return out;
}

/**
 * Runs the assistant started by itself (not in answer to something you wrote) whose only work was saving memory, and that
 * left nothing to act on. Their reply only says "saved", which the first reply and the approval already said.
 */
export function quietRunIds(runs: RunTrace[], outcomes: ApprovalOutcomes, messages: Message[]): Set<string> {
  // A run you started points at your message; one the assistant started on its own points at a note or at nothing.
  const yours = new Set(messages.filter((m) => m.role === "user").map((m) => m.id));
  const quiet = new Set<string>();
  for (const t of runs) {
    if ((t.triggerMessageId !== null && yours.has(t.triggerMessageId)) || t.run.status !== "completed") continue;
    const tools = t.steps.filter((s) => s.type === "tool.call");
    const onlyMemory =
      tools.length > 0 &&
      t.steps.every((s) => s.type === "llm.call" || (s.type === "tool.call" && s.toolName?.startsWith("memory_"))) &&
      tools.every((s) => s.status !== "error" && s.status !== "not_executed" && !stepNeedsAttention(s, outcomes));
    if (onlyMemory) quiet.add(t.run.id);
  }
  return quiet;
}

/** True when Simple mode leaves this message out of the chat. */
export function isSimpleNoise(message: Message, quiet: ReadonlySet<string>): boolean {
  if (message.role === "memory") return true;
  if (message.role === "approval")
    return message.approval?.status === "approved" && !message.approval.groupId && !message.approval.resumesTool;
  return message.role === "assistant" && !!message.runId && quiet.has(message.runId);
}
