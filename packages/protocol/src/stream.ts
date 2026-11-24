// Server-sent event streams: a snapshot, then committed deltas with a cursor.
//
// Two streams, both GET, both need the session cookie:
//   /api/stream                     global: agents and the session list
//   /api/sessions/:id/stream        one session: its Conversation View (snapshot / patch / resync_required)
//
// Wire format: standard SSE. `event:` is the event type below, `data:` is its JSON.
// - Committed global events carry `id: <cursor>`. Cursors are decimal strings of an increasing integer that keeps
//   increasing across a server restart; the server keeps only a bounded in-memory buffer of recent events.
// - A connection without Last-Event-ID starts with a snapshot, sent with `id: <its cursor>` so a reconnect resumes
//   from it.
// - On reconnect the browser sends Last-Event-ID. If the server still has every committed event after that cursor
//   it replays them (no snapshot); otherwise it sends a fresh snapshot. Clients must handle both.
// - The server sends `ping` every 15 s so proxies keep the connection open.
import type { Takeover } from "./browser.ts";
import type { Agent, Approval, ErrorInfo, Message, MessageId, Run, RunId, Session, SessionId } from "./entities.ts";

export type Cursor = string;

// ---- global stream --------------------------------------------------------------------------------------------------

/** The companion agent (GLOSSARY): the agent a companion client quick-sends to, and that agent's home chat. */
export interface Companion {
  agentId: string;
  homeSessionId: SessionId;
}

export interface GlobalSnapshot {
  type: "snapshot";
  cursor: Cursor;
  agents: Agent[];
  defaultAgentId: string;
  companion: Companion;
  sessions: Session[];
  /** Pending approvals in every session, oldest first. */
  approvals: Approval[];
  /** Pending and active takeovers in every session, oldest first. */
  takeovers: Takeover[];
}
export interface AgentUpserted {
  type: "agent.upserted";
  agent: Agent;
}
/** An agent was deleted (its sessions get their own `session.removed`); clients drop it. */
export interface AgentRemoved {
  type: "agent.removed";
  agentId: string;
}
export interface SessionUpserted {
  type: "session.upserted";
  session: Session;
}
export interface SessionRemoved {
  type: "session.removed";
  sessionId: SessionId;
}
/** An approval was created or changed; once it is no longer pending, clients drop it from their pending list. */
export interface ApprovalUpserted {
  type: "approval.upserted";
  approval: Approval;
}
/** A takeover was created or changed; once it is done or cancelled, clients drop it from their open list. */
export interface TakeoverUpserted {
  type: "takeover.upserted";
  takeover: Takeover;
}
/** Profile docs or the index changed; the Memory page refetches GET /api/memory (and the index status). */
export interface MemoryChanged {
  type: "memory.changed";
  /** What changed, so a page can skip a refetch it doesn't need. */
  what: "lines" | "index";
}
/** A trigger or its runs changed, or a skill changed; the Triggers and Skills pages refetch what they show. */
export interface TriggersChanged {
  type: "triggers.changed";
  /** The trigger that changed; null for several. */
  triggerId: string | null;
}
export interface SkillsChanged {
  type: "skills.changed";
}
export interface PluginsChanged {
  type: "plugins.changed";
}
/** A Knowledge page changed (or several did: pageId null); the Knowledge view refetches what it shows. */
export interface KnowledgeChanged {
  type: "knowledge.changed";
  pageId: string | null;
}
/** The companion agent changed: the user picked another, its agent was deleted, or its home chat was replaced. */
export interface CompanionChanged {
  type: "companion.changed";
  companion: Companion;
}
export type GlobalEvent =
  | { type: "background.changed" }
  | GlobalSnapshot
  | AgentUpserted
  | AgentRemoved
  | SessionUpserted
  | SessionRemoved
  | ApprovalUpserted
  | TakeoverUpserted
  | MemoryChanged
  | TriggersChanged
  | SkillsChanged
  | PluginsChanged
  | KnowledgeChanged
  | CompanionChanged;

// ---- session stream: the Conversation View ----------------------------------------------------------------------------
//
// The per-session stream carries one server-side view of the conversation (`ReiConversationViewV2`): Pi owns the
// transcript and the live run state, and the server maps them to this shape. Frames are ordered by `{ epoch, rev }`:
// `epoch` names one server-side watch of the conversation (it changes on a server restart or when the server rebuilt
// the watch), `rev` counts the frames within it. Neither is a Pi cursor, and frames carry no SSE `id:`. A reconnect
// always starts with a fresh `snapshot`. A client that sees a `rev` it did not expect, or gets `resync_required`,
// refetches (or reconnects for) a snapshot. History older than the window is paged with
// GET /api/sessions/:id/transcript?before=<itemId>.

/**
 * Where a live tool call is: `sleeping` or `waiting` while it is parked (on an approval, say). A parked call holds no
 * work and is not stuck: it resumes when what it waits for arrives.
 */
export type LiveToolStatus = "pending" | "running" | "sleeping" | "waiting" | "done";

/** Whether a live tool call is parked, waiting for something outside the run. */
export const isParkedTool = (status: LiveToolStatus): boolean => status === "sleeping" || status === "waiting";

/** One live tool slot of the run (`pi.live.tools`, plus nested calls of a code-mode tool). */
export interface LiveTool {
  callId: string;
  name: string;
  status: LiveToolStatus;
  nested?: boolean;
  /** For a nested call: the call id of the `codemode` call it belongs under (a nested call id is `<parentCallId>/<key>`). */
  parentCallId?: string;
}

/** What the running run is doing right now: Pi's live state, without host state, secrets or model-hidden data. */
export interface ConversationLive {
  /** The run going now (its id), or null when the conversation is idle. */
  runId: RunId | null;
  /** Model turns the run has taken. */
  turns?: number;
  /** The in-flight generation: its text so far (shown before Pi stores it; a host crash can lose it). */
  generation?: { attempt: number; text: string; retry?: { attempt: number; error?: string } };
  tools?: LiveTool[];
  compaction?: { status: "running" | "failed"; error?: string };
  /** The newest manual compaction (`/compact`) that has not ended, or that ended without a summary placed. */
  manualCompaction?: {
    requestId: string;
    status: import("./api.ts").ManualCompactionStatus;
    error?: string;
  };
  /** The last run failed and nothing has run since: a typed failure, with Continue when the conversation admits one. */
  runFailure?: { runId: RunId | null; reason: string; error: ErrorInfo; canContinue: boolean };
}

/** An approval, takeover or memory chip shown in the conversation, anchored to a Pi tool task, entry or run. */
export interface ConversationOverlay {
  /** The item that shows it in `items`. */
  itemId: MessageId;
  kind: "approval" | "takeover" | "memory";
  /**
   * A card for a tool call is anchored to its Pi tool task. A nested call's card (one a script asked for) also names the
   * `codemode` call it belongs under, `parentCallId`.
   */
  anchor: { taskId: string; parentCallId?: string } | { entryId: string } | { runId: RunId };
}

export interface ReiConversationViewV2 {
  version: 2;
  session: Session;
  /** Oldest first: the newest window of the transcript, user and reply items, cards and markers. */
  items: ChatItem[];
  runs: Run[];
  /** The item just before the window (page older history with it); null when the window starts the transcript. */
  before: MessageId | null;
  live: ConversationLive;
  overlays: ConversationOverlay[];
}

/** One item of the conversation (user, reply, report, card, marker), keyed by `id`. */
export type ChatItem = Message;

export interface ViewEnvelope {
  epoch: string;
  rev: number;
}
export interface SessionSnapshot extends ViewEnvelope {
  type: "snapshot";
  view: ReiConversationViewV2;
}
/**
 * What changed since the frame before: items upserted (by id) and removed; `order` is the full item order of the window
 * when it is not the old order with the upserts appended; `runs`, `live`, `overlays`, `session` and `before` replace.
 */
export interface SessionPatch extends ViewEnvelope {
  type: "patch";
  upsert?: ChatItem[];
  remove?: MessageId[];
  order?: MessageId[];
  runs?: Run[];
  live?: ConversationLive;
  overlays?: ConversationOverlay[];
  session?: Session;
  before?: MessageId | null;
}
/** The server cannot continue this client's sequence (it fell behind, or the watch was rebuilt): take a snapshot. */
export interface SessionResyncRequired extends ViewEnvelope {
  type: "resync_required";
}
// A deleted session's stream sends `session.removed` (the global event type) and then ends.
export type SessionEvent = SessionSnapshot | SessionPatch | SessionResyncRequired | SessionRemoved;

export type StreamEventType = GlobalEvent["type"] | SessionEvent["type"] | "ping";

export const PING_INTERVAL_MS = 15_000;
