/** Finished sessions the sessions section lists after the unfinished ones; older ones stay reachable via list_sessions. */
export const SESSIONS_FINISHED_SHOWN = 10;
const FINISHED = new Set(["completed", "failed", "cancelled"]);

export interface ChildSession {
  id: string;
  title: string;
  status: string;
  created_at: number;
}

/** The children a sessions section shows, newest first, and how many older finished ones it leaves out. */
export function shownChildren<T extends ChildSession>(children: readonly T[]): { shown: T[]; hidden: number } {
  const newest = [...children].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
  let finished = 0;
  const shown = newest.filter((c) => !FINISHED.has(c.status) || finished++ < SESSIONS_FINISHED_SHOWN);
  return { shown, hidden: newest.length - shown.length };
}
