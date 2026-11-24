// Rei's Pi signals and the one way to deliver them. A signal only wakes a parked call: its value is always empty, and the
// woken gate re-reads Rei's own tables to decide. Decisions, arguments and secrets never go into Pi this way.

import type { Context } from "@earendil-works/chord/context";
import { defineSignal, LiveDoc, type SignalToken, type TaskId } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import type { Logger } from "../util/log.ts";
import type { OpenTree } from "./trees.ts";

/** A signal that carries nothing but the wake itself. */
export type WakeSignal = SignalToken<Record<string, never>>;

/** Wakes a call parked on an approval: the key is the approval ID for one call, or the group ID for grouped reads. */
export const ApprovalWake: WakeSignal = defineSignal({ name: "rei.approval", version: 1, schema: obj({}) });

/** Wakes a browser call parked while the user controls the window: the key is the takeover ID. */
export const TakeoverEnded: WakeSignal = defineSignal({ name: "rei.takeover", version: 1, schema: obj({}) });

/**
 * What a delivery came to: `ok` (the task holds the wake now, or held one already), `ended` (the call is over, or there
 * is no such task), `invalid` (Pi refused the value), `unavailable` (the tree is not open, or could not be opened).
 */
export type SignalOutcome = "ok" | "ended" | "invalid" | "unavailable";

/** The trees the signals reach; `TreeManager` is one. */
export interface SignalTrees {
  get(treeId: string): OpenTree | undefined;
  open(treeId: string): Promise<OpenTree>;
}

export interface SignalOptions {
  /** Open the tree when it is closed (default). Off for work that is about to be torn down anyway. */
  open?: boolean;
}

export type SignalTask = (
  treeId: string,
  taskId: string,
  signal: WakeSignal,
  key: string,
  context: Context,
  options?: SignalOptions,
) => Promise<SignalOutcome>;

/** The tree's Harness, opened on demand unless `open` is false. */
async function harnessOf(trees: SignalTrees, treeId: string, options: SignalOptions | undefined) {
  const open = trees.get(treeId);
  if (open || options?.open === false) return open?.harness;
  return (await trees.open(treeId)).harness;
}

/**
 * Delivers a wake to one task of a tree. Never throws: the caller has already committed what the wake is about, and a
 * call that misses its wake still re-reads that state the next time Pi runs its gates (every open does).
 */
export function createSignalTask(trees: SignalTrees, log: Logger): SignalTask {
  return async (treeId, taskId, signal, key, context, options) => {
    try {
      const harness = await harnessOf(trees, treeId, options);
      if (!harness) return "unavailable";
      const result = await harness.signal(Number(taskId) as TaskId, signal, key, {}, context);
      switch (result) {
        case "delivered":
        case "duplicate":
          return "ok";
        case "closed":
        case "not_found":
          return "ended";
        default:
          log.error("signal.invalid", { treeId, signal: signal.name });
          return "invalid";
      }
    } catch (error) {
      log.error("signal.failed", { treeId, signal: signal.name, error: error instanceof Error ? error.name : "error" });
      return "unavailable";
    }
  };
}

/**
 * The tool tasks of the session's current round whose calls are among `callIds`, read from Pi's live document. A call
 * that has no task yet (a later call of a sequential round) is left out: its gates run after it starts.
 */
export async function callTasks(
  trees: SignalTrees,
  treeId: string,
  sessionId: string,
  callIds: ReadonlySet<string>,
  context: Context,
): Promise<string[]> {
  const tree = trees.get(treeId);
  const conversation = tree?.session(sessionId)?.conv;
  if (!tree || !conversation) return [];
  const live = await tree.harness.snapshot(LiveDoc, conversation.id, context);
  return (live?.tools ?? []).flatMap((slot) =>
    slot.taskId !== undefined && callIds.has(slot.callId) ? [String(slot.taskId)] : [],
  );
}
