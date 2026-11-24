import {
  applySessionEvent,
  type ConversationLive,
  type Message,
  type MessageContext,
  type MessageId,
  type Run,
  type Session,
  type SessionEvent,
  type ViewState,
} from "@rei/protocol";

/** A message the user just sent that the server hasn't shown in the conversation yet. */
export interface PendingMessage extends MessageContext {
  requestId: string;
  text: string;
  createdAt: number;
  /** Set from the POST response. */
  messageId?: string;
  /** Set when the send failed after retries; the user can retry with the same requestId. */
  error?: string;
  sending: boolean;
}

/**
 * One chat as the PWA shows it: the server's Conversation View (folded from the session stream by the shared reducer),
 * older pages loaded on request, and sends not yet in the view. `messages`, `runs` and `session` are derived so the
 * components read one list.
 */
export interface SessionState {
  ready: boolean;
  view: ViewState | undefined;
  /** Items older than the view's window, loaded with "Load earlier", oldest first. */
  earlier: Message[];
  /** Where the next older page starts (null: the start of the chat); undefined until the first snapshot. */
  before: MessageId | null | undefined;
  /** Set when the stream is out of step (a gap, another epoch, `resync_required`): the hook reconnects for a snapshot. */
  resync: boolean;
  session: Session | null;
  /** Oldest first: the loaded earlier pages, then the view's window. */
  messages: Message[];
  runs: Run[];
  live: ConversationLive | null;
  pending: PendingMessage[];
  /** The server deleted this session; its stream has ended. */
  removed: boolean;
}

export const initialSessionState: SessionState = {
  ready: false,
  view: undefined,
  earlier: [],
  before: undefined,
  resync: false,
  session: null,
  messages: [],
  runs: [],
  live: null,
  pending: [],
  removed: false,
};

export type SessionAction =
  | { type: "event"; event: SessionEvent }
  /** An older page from GET /api/sessions/:id/transcript, requested with the `before` it was asked from. */
  | { type: "earlier.loaded"; from: MessageId; items: Message[]; before: MessageId | null }
  | ({ type: "local.add"; requestId: string; text: string; now: number } & MessageContext)
  | { type: "local.sent"; requestId: string; messageId: string }
  | { type: "local.failed"; requestId: string; error: string }
  | { type: "local.retry"; requestId: string };

/** Earlier pages, then the window; an item in both (the window grew back over a page) shows once, from the window. */
function derive(state: SessionState): SessionState {
  const view = state.view?.view;
  if (!view) return state;
  const inWindow = new Set(view.items.map((m) => m.id));
  const earlier = state.earlier.filter((m) => !inWindow.has(m.id));
  return reconcile({
    ...state,
    earlier,
    session: view.session,
    messages: earlier.length ? [...earlier, ...view.items] : view.items,
    runs: view.runs,
    live: view.live,
  });
}

/** Drops pending sends the conversation now shows (matched by request id, or by the message id the POST returned). */
function reconcile(state: SessionState): SessionState {
  if (state.pending.length === 0) return state;
  const requests = new Set(state.messages.flatMap((m) => (m.requestId ? [m.requestId] : [])));
  const ids = new Set(state.messages.map((m) => m.id));
  const keep = state.pending.filter((p) => !requests.has(p.requestId) && !(p.messageId && ids.has(p.messageId)));
  return keep.length === state.pending.length ? state : { ...state, pending: keep };
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "local.add":
      return {
        ...state,
        pending: [
          ...state.pending,
          {
            requestId: action.requestId,
            text: action.text,
            attachments: action.attachments,
            mentions: action.mentions,
            selectedSkills: action.selectedSkills,
            createdAt: action.now,
            sending: true,
          },
        ],
      };
    case "local.sent":
      return reconcile({
        ...state,
        pending: state.pending.map((p) =>
          p.requestId === action.requestId ? { ...p, messageId: action.messageId, sending: false } : p,
        ),
      });
    case "local.failed":
      return {
        ...state,
        pending: state.pending.map((p) =>
          p.requestId === action.requestId ? { ...p, error: action.error, sending: false } : p,
        ),
      };
    case "local.retry":
      return {
        ...state,
        pending: state.pending.map((p) => {
          if (p.requestId !== action.requestId) return p;
          const { error: _error, ...rest } = p;
          return { ...rest, sending: true };
        }),
      };
    case "earlier.loaded": {
      // Only the page asked for from where the list starts now (a late answer to an older request is dropped).
      if (state.before !== action.from) return state;
      const have = new Set(state.messages.map((m) => m.id));
      const items = action.items.filter((m) => !have.has(m.id));
      return derive({ ...state, earlier: [...items, ...state.earlier], before: action.before });
    }
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  const step = applySessionEvent(state.view, event);
  if (step.kind === "removed") return { ...state, removed: true };
  if (step.kind === "resync") return state.resync ? state : { ...state, resync: true };
  const view = step.state.view;
  let earlier = state.earlier;
  if (earlier.length > 0) {
    if (event.type === "snapshot") {
      // A fresh window (a reconnect, or a rewind that replaced the conversation): loaded items stay only up to where
      // they join it, so nothing a rewind replaced is left above the window. A window from the start keeps none.
      const inWindow = new Set(view.items.map((m) => m.id));
      const at = view.before === null ? -1 : earlier.findIndex((m) => m.id === view.before);
      const overlap = earlier.findIndex((m) => inWindow.has(m.id));
      earlier =
        view.before === null ? [] : at >= 0 ? earlier.slice(0, at + 1) : overlap >= 0 ? earlier.slice(0, overlap) : [];
    } else if (state.view) {
      // Items the window slid past (not removed by the server) move to the loaded pages, so no gap opens.
      const kept = new Set(view.items.map((m) => m.id));
      const removed = new Set(event.type === "patch" ? (event.remove ?? []) : []);
      const slid = state.view.view.items.filter((m) => !kept.has(m.id) && !removed.has(m.id));
      if (slid.length) earlier = [...earlier, ...slid];
    }
  }
  const before = earlier.length > 0 ? state.before : view.before;
  return derive({ ...state, ready: true, resync: false, view: step.state, earlier, before });
}

export function activeRun(state: SessionState): Run | undefined {
  return state.runs.find((r) => r.status === "running" || r.status === "queued");
}

/** True while a run is in progress: the Stop button shows then. */
export function isRunning(state: SessionState): boolean {
  if (state.live?.runId) return true;
  if (state.runs.length > 0) return activeRun(state) !== undefined;
  return state.session?.status === "running"; // no run records known: trust the session status
}

/** The last run's typed failure when the chat can be continued from it (shown with a Continue button). */
export function continuable(state: SessionState): NonNullable<ConversationLive["runFailure"]> | undefined {
  const failure = state.live?.runFailure;
  return failure?.canContinue && !isRunning(state) ? failure : undefined;
}
