import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  CompactionTask,
  type ContextView,
  type ConversationId,
  defineDoc,
  LiveDoc,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Ledger } from "../conversation/ledger.ts";

export const HOME_COMPACTION_FOCUS =
  "Keep a concise working summary for this ongoing chat. Preserve active topics, user decisions and constraints, " +
  "open questions, next actions, and exact identifiers needed to resume. Fold in the previous summary. " +
  "Omit superseded details and bulky tool output. Aim for at most 1,200 tokens.";

export const IDLE_COMPACTION_FOCUS = `${HOME_COMPACTION_FOCUS} Preserve the wording of recent human decisions and requests that fall outside the verbatim window.`;

/** A crossed Home budget survives a restart while the conversation is still busy. */
export const HomeBudgetCompactionDoc = defineDoc<{ pending?: true }>({
  kind: "rei.home-budget-compaction",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  checkpointWhen: () => true,
});

/** One decision per quiet period, committed in the same Pi transaction as the compaction task. */
export const HomeIdleCompactionDoc = defineDoc<{ checkedRun?: string }>({
  kind: "rei.home-idle-compaction",
  version: 2,
  // Recheck quiet periods evaluated under the original two-exchange guard.
  migrate: () => ({}),
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  checkpointWhen: () => true,
});

export function latestHumanRun(ledger: Ledger): { id: string; at: number } | undefined {
  const id = ledger.order.findLast((id) => {
    const run = ledger.byId[id];
    return run?.kind === "input" && run.role === "user" && run.direct && !run.assignedBy;
  });
  return id ? { id, at: ledger.byId[id]!.createdAt } : undefined;
}

/** The most recent two placed human inputs, in transcript order. */
export function recentHumanEntries(ledger: Ledger): number[] {
  const entries: number[] = [];
  for (let i = ledger.order.length - 1; i >= 0 && entries.length < 2; i--) {
    const run = ledger.byId[ledger.order[i]!];
    if (run?.kind === "input" && run.role === "user" && run.direct && !run.assignedBy && run.entryId !== undefined)
      entries.push(run.entryId);
  }
  return entries;
}

export function hasIdleCompactionWork(view: ContextView, ledger: Ledger, keepRecentTokens: number): boolean {
  const previousHuman = recentHumanEntries(ledger)[1];
  if (previousHuman === undefined) return false;
  const recent = view.entries.findIndex((entry) => entry.id === previousHuman);
  if (recent < 1) return false;
  let olderTokens = 0;
  let totalTokens = 0;
  for (let i = view.head ? 1 : 0; i < view.contributions.length; i++) {
    for (const message of view.contributions[i]!) {
      if (message.role === "system") continue;
      const count = estimateMessageTokens(message);
      if (i < recent) olderTokens += count;
      totalTokens += count;
    }
  }
  // Count only unsummarized dialogue and tool results. Prompt changes and the last summary cannot justify a new one.
  const minOlderTokens = Math.min(2_000, Math.max(256, Math.floor(keepRecentTokens / 4)));
  return olderTokens >= minOlderTokens && totalTokens >= keepRecentTokens + minOlderTokens;
}

export async function enqueueHomeCompaction(tx: Tx, conversationId: ConversationId, instructions: string) {
  const live = await tx.doc(LiveDoc, conversationId);
  const taskId = await tx.createTask(
    CompactionTask,
    { reason: "threshold", instructions },
    { ownership: { kind: "conversation" }, background: true },
  );
  live.compactions = [{ taskId, trigger: "threshold", blocking: false, attempt: 1 }];
}
