import type { Session } from "@rei/protocol";

/** Spawned sessions that `parentId` started (they report back to it). */
export function childrenOf(sessions: Session[], parentId: string): Session[] {
  return sessions.filter((s) => s.parentSessionId === parentId);
}

/** True while a spawned session still has work in progress or waits for you. */
export function isUnfinished(s: Session): boolean {
  return s.status === "running" || s.status === "waiting_for_user";
}

/**
 * The branches taken from `id`: sessions forked from it, and from those, transitively. "Delete with branches" removes
 * these together with `id`; the chat it was itself branched from stays.
 */
export function branchesOf(sessions: Session[], id: string): Session[] {
  const out: Session[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const s of sessions) {
      if (s.forkedFrom?.sessionId === cur && !out.includes(s)) {
        out.push(s);
        queue.push(s.id);
      }
    }
  }
  return out;
}
