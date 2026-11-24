import type { Agent, Approval, Companion, GlobalEvent, Session, Takeover } from "@rei/protocol";
import { isOpenTakeover } from "../lib/browser.ts";
import { effectiveStatus } from "../lib/policy.ts";
import { isStale } from "./cursor.ts";

export interface GlobalState {
  /** False until the first snapshot has arrived. */
  ready: boolean;
  cursor: string | null;
  agents: Agent[];
  defaultAgentId: string | null;
  /** The companion agent and its home chat; null until the first snapshot (or from a server that predates it). */
  companion: Companion | null;
  /** Unordered; use selectSessions for display. */
  sessions: Session[];
  sidebarSessionIds?: string[];
  removedSessionIds?: string[];
  snapshotVersion?: number;
  /** Approvals waiting for you, oldest first. A decided or expired one is dropped. */
  approvals: Approval[];
  /** Takeovers pending (the agent waits for you) or active, oldest first. A finished one is dropped. */
  takeovers: Takeover[];
}

export const initialGlobalState: GlobalState = {
  ready: false,
  cursor: null,
  agents: [],
  defaultAgentId: null,
  companion: null,
  sessions: [],
  approvals: [],
  takeovers: [],
};

export type GlobalAction =
  | { type: "event"; event: GlobalEvent; cursor?: string }
  | { type: "hydrate"; sessions: Session[]; snapshotVersion: number | undefined; sidebar?: boolean };

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function globalReducer(state: GlobalState, action: GlobalAction): GlobalState {
  if (action.type === "hydrate") {
    if (action.snapshotVersion !== state.snapshotVersion) return state;
    let sessions = state.sessions;
    for (const session of action.sessions) {
      if (state.removedSessionIds?.includes(session.id) || !state.agents.some((a) => a.id === session.agentId))
        continue;
      const current = sessions.find((s) => s.id === session.id);
      if (!current || current.updatedAt < session.updatedAt) sessions = upsert(sessions, session);
    }
    return {
      ...state,
      sessions,
      ...(action.sidebar !== false
        ? { sidebarSessionIds: [...new Set([...(state.sidebarSessionIds ?? []), ...action.sessions.map((s) => s.id)])] }
        : {}),
    };
  }
  const { event } = action;
  if (event.type === "snapshot") {
    // A snapshot is authoritative: it replaces everything, whatever the old cursor was.
    return {
      ready: true,
      snapshotVersion: (state.snapshotVersion ?? 0) + 1,
      removedSessionIds: [],
      cursor: event.cursor,
      agents: event.agents,
      defaultAgentId: event.defaultAgentId,
      companion: event.companion ?? null,
      sessions: event.sessions,
      sidebarSessionIds: event.sessions.map((s) => s.id),
      approvals: (event.approvals ?? []).filter((a) => a.status === "pending"),
      takeovers: (event.takeovers ?? []).filter(isOpenTakeover),
    };
  }
  if (isStale(state.cursor, action.cursor)) return state;
  const cursor = action.cursor ?? state.cursor;
  switch (event.type) {
    case "agent.upserted":
      return { ...state, cursor, agents: upsert(state.agents, event.agent) };
    case "agent.removed": {
      const gone = new Set(state.sessions.filter((s) => s.agentId === event.agentId).map((s) => s.id));
      return {
        ...state,
        cursor,
        agents: state.agents.filter((a) => a.id !== event.agentId),
        sessions: state.sessions.filter((s) => !gone.has(s.id)),
        approvals: state.approvals.filter((a) => !gone.has(a.sessionId)),
        takeovers: state.takeovers.filter((t) => !gone.has(t.sessionId)),
      };
    }
    case "session.upserted":
      return {
        ...state,
        cursor,
        sidebarSessionIds: [...new Set([...(state.sidebarSessionIds ?? []), event.session.id])],
        sessions: upsert(state.sessions, event.session),
      };
    case "session.removed":
      return {
        ...state,
        removedSessionIds: [...(state.removedSessionIds ?? []), event.sessionId],
        cursor,
        sessions: state.sessions.filter((s) => s.id !== event.sessionId),
        approvals: state.approvals.filter((a) => a.sessionId !== event.sessionId),
        takeovers: state.takeovers.filter((t) => t.sessionId !== event.sessionId),
      };
    case "approval.upserted":
      return {
        ...state,
        cursor,
        approvals:
          event.approval.status === "pending"
            ? upsert(state.approvals, event.approval)
            : state.approvals.filter((a) => a.id !== event.approval.id),
      };
    case "takeover.upserted":
      return {
        ...state,
        cursor,
        takeovers: isOpenTakeover(event.takeover)
          ? upsert(state.takeovers, event.takeover)
          : state.takeovers.filter((t) => t.id !== event.takeover.id),
      };
    case "companion.changed":
      return { ...state, cursor, companion: event.companion };
    default:
      return state;
  }
}

/** Session list, newest first, of one agent when `agentId` is given. Home chats are excluded; they are pinned through the agents. A trigger run stays out unless it is selected, needs you, or failed (the rest are on the Triggers page). */
export function selectSessions(
  state: GlobalState,
  agentId?: string | null,
  selectedId?: string | null,
  showTriggers = false,
): Session[] {
  const homeIds = new Set(state.agents.map((a) => a.homeSessionId));
  // Trigger runs stay out of the list unless they need you, failed, or the "Trigger sessions" filter is on.
  const shown = (s: Session) =>
    s.id === selectedId ||
    s.origin !== "trigger" ||
    showTriggers ||
    s.status === "failed" ||
    effectiveStatus(s) === "waiting_for_user";
  return state.sessions
    .filter((s) => (!agentId || s.agentId === agentId) && s.origin !== "home" && !homeIds.has(s.id) && shown(s))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
}

/** The agent the sidebar follows: the open chat's agent, else the default agent, else the first one. */
export function selectActiveAgentId(state: GlobalState, sessionId: string | null): string | null {
  const open = sessionId ? state.sessions.find((s) => s.id === sessionId) : undefined;
  if (open && state.agents.some((a) => a.id === open.agentId)) return open.agentId;
  return (state.agents.find((a) => a.id === state.defaultAgentId) ?? state.agents[0])?.id ?? null;
}

export function selectSession(state: GlobalState, id: string): Session | undefined {
  return state.sessions.find((s) => s.id === id);
}

/** Approvals waiting for you in every session, oldest first. */
export function selectPendingApprovals(state: GlobalState): Approval[] {
  return state.approvals;
}

/** Approvals waiting in one session. */
export function selectPendingInSession(state: GlobalState, sessionId: string): Approval[] {
  return state.approvals.filter((a) => a.sessionId === sessionId);
}

/** Agent requests waiting for you to take over the browser, oldest first (an active one is you, already there). */
export function selectPendingTakeovers(state: GlobalState): Takeover[] {
  return state.takeovers.filter((t) => t.status === "pending");
}
