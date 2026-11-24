import type { GlobalEvent, Session, SessionEvent } from "@rei/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Api } from "../api/client.ts";
import { saveComposerDraft } from "../lib/composerDraft.ts";
import { globalReducer, initialGlobalState } from "../state/global.ts";
import type { PendingMessage } from "../state/session.ts";
import { initialSessionState, sessionReducer } from "../state/session.ts";
import type { ConnectionStatus } from "./connection.ts";
import { openStream } from "./connection.ts";

/** The browser's EventSource only hears the types named here: every event the global reducer handles must be listed. */
export const GLOBAL_TYPES = [
  "snapshot",
  "agent.upserted",
  "agent.removed",
  "session.upserted",
  "session.removed",
  "approval.upserted",
  "takeover.upserted",
  "companion.changed",
] as const;
/** Global events that change no app state: the pages that show them refetch. */
export const GLOBAL_EPHEMERAL_TYPES = [
  "memory.changed",
  "triggers.changed",
  "skills.changed",
  "plugins.changed",
  "knowledge.changed",
  "background.changed",
] as const;
// An event type missing from both lists is never delivered: this fails to compile until a new one is listed.
true satisfies Same<GlobalEvent["type"], (typeof GLOBAL_TYPES)[number] | (typeof GLOBAL_EPHEMERAL_TYPES)[number]>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The session stream's frames (none carries an SSE id: a reconnect always starts with a snapshot). */
const SESSION_TYPES = ["snapshot", "patch", "resync_required", "session.removed"] as const;

/** Used when the browser gives up on a stream: if the cookie is gone, send the user back to login. */
function checkAuth(api: Api, onUnauthorized: () => void) {
  api
    .getAuthState()
    .then((s) => {
      if (!s.signedIn) onUnauthorized();
    })
    .catch(() => {});
}

/** Counters the Memory page watches: each rises when the server says that part of memory changed (and on every fresh snapshot, in case events were missed). */
export interface MemoryRev {
  lines: number;
  index: number;
}
const initialMemoryRev: MemoryRev = { lines: 0, index: 0 };

/** Counters the Triggers and Skills pages watch: each rises when the server says that part changed (and on every fresh snapshot). */
export interface PageRev {
  background: number;
  triggers: number;
  skills: number;
  /** Rises on every knowledge.changed (and fresh snapshot); `knowledgePage` names the page that changed last. */
  knowledge: number;
  knowledgePage: string | null;
}
const initialPageRev: PageRev = { background: 0, triggers: 0, skills: 0, knowledge: 0, knowledgePage: null };

export function useGlobalStream(api: Api, onUnauthorized: () => void) {
  const [state, dispatch] = useReducer(globalReducer, initialGlobalState);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [memoryRev, setMemoryRev] = useState<MemoryRev>(initialMemoryRev);
  const [pageRev, setPageRev] = useState<PageRev>(initialPageRev);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  useEffect(() => {
    const conn = openStream({
      url: "/api/stream?paged=1",
      committedTypes: GLOBAL_TYPES,
      ephemeralTypes: GLOBAL_EPHEMERAL_TYPES,
      onEvent: (type, data, cursor) => {
        // Not part of the app state: the Memory page refetches what it shows.
        if (type === "memory.changed") {
          const what = (data as { what?: string }).what;
          setMemoryRev((r) => ({
            lines: r.lines + (what === "lines" ? 1 : 0),
            index: r.index + (what === "index" ? 1 : 0),
          }));
          return;
        }
        if (type === "knowledge.changed") {
          const pageId = (data as { pageId?: string }).pageId ?? null;
          setPageRev((r) => ({ ...r, knowledge: r.knowledge + 1, knowledgePage: pageId }));
          return;
        }
        if (type === "background.changed") {
          setPageRev((r) => ({ ...r, background: r.background + 1 }));
          return;
        }
        if (type === "triggers.changed" || type === "skills.changed" || type === "plugins.changed") {
          setPageRev((r) =>
            type === "triggers.changed" ? { ...r, triggers: r.triggers + 1 } : { ...r, skills: r.skills + 1 },
          );
          return;
        }
        if (type === "snapshot") {
          setMemoryRev((r) => ({ lines: r.lines + 1, index: r.index + 1 }));
          setPageRev((r) => ({
            ...r,
            background: r.background + 1,
            triggers: r.triggers + 1,
            skills: r.skills + 1,
            knowledge: r.knowledge + 1,
            knowledgePage: null,
          }));
        }
        // A trigger run's "waiting" is worked out when it is read, so no triggers.changed says a run started waiting for you:
        // these events can mean it did. The page refetches only while it is open.
        if (
          type === "approval.upserted" ||
          type === "takeover.upserted" ||
          (type === "session.upserted" && (data as { session?: { triggerId?: string | null } }).session?.triggerId)
        ) {
          setPageRev((r) => ({ ...r, triggers: r.triggers + 1 }));
        }
        dispatch({ type: "event", event: { ...(data as object), type } as GlobalEvent, ...(cursor ? { cursor } : {}) });
      },
      onStatus: setStatus,
      onClosed: () => checkAuth(api, () => unauthorized.current()),
    });
    return () => conn.close();
  }, [api]);

  const hydrateSessions = useCallback(
    (sessions: Session[], snapshotVersion: number | undefined, sidebar = true) =>
      dispatch({ type: "hydrate", sessions, snapshotVersion, sidebar }),
    [],
  );
  return { state, status, memoryRev, pageRev, hydrateSessions };
}

export function useSessionStream(api: Api, sessionId: string, onUnauthorized: () => void) {
  const pendingKey = `rei:pending:${sessionId}`;
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState, (initial) => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey) ?? "[]") as PendingMessage[];
      return {
        ...initial,
        pending: saved.map((p) => ({
          ...p,
          sending: false,
          error: p.error ?? "Delivery was interrupted. Retry to confirm.",
        })),
      };
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      if (state.pending.length) sessionStorage.setItem(pendingKey, JSON.stringify(state.pending));
      else sessionStorage.removeItem(pendingKey);
    } catch {
      /* Delivery still works without browser storage. */
    }
  }, [pendingKey, state.pending]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  // Bumped to reconnect: a new connection starts with a fresh snapshot.
  const [connection, setConnection] = useState(0);

  useEffect(() => {
    void connection;
    const conn = openStream({
      url: `/api/sessions/${encodeURIComponent(sessionId)}/stream`,
      committedTypes: SESSION_TYPES,
      onEvent: (type, data) => {
        dispatch({ type: "event", event: { ...(data as object), type } as SessionEvent });
        if (type === "session.removed") {
          conn.close();
          try {
            sessionStorage.removeItem(pendingKey);
          } catch {
            /* Browser storage is optional. */
          }
          void saveComposerDraft(sessionId, { text: "", mentions: [], files: [] }).catch(() => {});
        } // the server ends the stream; don't reconnect to a deleted session
      },
      onStatus: setStatus,
      onClosed: () => checkAuth(api, () => unauthorized.current()),
    });
    return () => conn.close();
  }, [api, sessionId, pendingKey, connection]);

  // Out of step with the server (a gap, a new epoch, or it asked): reconnect for a fresh snapshot.
  useEffect(() => {
    if (state.resync && !state.removed) setConnection((n) => n + 1);
  }, [state.resync, state.removed]);

  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const before = state.before;
  const loadEarlier = useCallback(async () => {
    if (!before) return;
    setLoadingEarlier(true);
    try {
      const page = await api.getTranscript(sessionId, before);
      dispatch({ type: "earlier.loaded", from: before, items: page.items, before: page.before });
    } finally {
      setLoadingEarlier(false);
    }
  }, [api, sessionId, before]);

  return { state, dispatch, status, loadEarlier, loadingEarlier };
}
