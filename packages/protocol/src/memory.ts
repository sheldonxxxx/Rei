// Memory: a small profile that is always in context, history that is searched on demand, and a
// digest of recent activity. Profile docs are lines with a source and a last-confirmed date that the app keeps (not the
// model). History search is keyword (FTS5 with CJK bigrams) plus meaning (EmbeddingGemma vectors), merged by weighted
// fusion.
import type { AgentId, MessageId, SessionId, TaintLabel } from "./entities.ts";

export type MemoryLineId = string;
export type MemoryChangeId = string;
export type MemorySuggestionId = string;

/**
 * - profile: `profile.md`, about you, shared by every agent
 * - agent: one agent's `agent.md` (persona, standing instructions); `agentId` says which
 */
export type MemoryDoc = "profile" | "agent";

/** Independent estimated-token caps, including the always-injected headings, ids and date annotations. */
export const USER_MEMORY_TOKEN_BUDGET = 3_000;
export const AGENT_MEMORY_TOKEN_BUDGET = 1_000;
/** One line is at most this many characters. */
export const MEMORY_LINE_MAX_CHARS = 500;
/** A line not confirmed for this many days is shown as stale (to you, and to the model with its date). */
export const MEMORY_STALE_DAYS = 180;

/** Where a line came from: the message that started the run that wrote it. */
export interface MemorySource {
  sessionId: SessionId;
  messageId: MessageId;
  /** The chat's current title. */
  sessionTitle: string;
}

export interface MemoryLine {
  id: MemoryLineId;
  doc: MemoryDoc;
  /** Set for doc "agent". */
  agentId: AgentId | null;
  text: string;
  /** Null when you wrote it in the Memory page, or when its chat was deleted (`sourceDeleted`). */
  source: MemorySource | null;
  sourceDeleted: boolean;
  addedAt: number;
  /** When the fact was last stated or restated (memory_confirm, or a replace). */
  confirmedAt: number;
  updatedAt: number;
}

/**
 * One edit of a line. Every edit is kept, so the versions of a line are its changes in order.
 * - add / replace / remove: `before` and `after` are the text before and after (null where there is none)
 * - confirm: the date moved; the text did not change
 */
export interface MemoryChange {
  id: MemoryChangeId;
  lineId: MemoryLineId;
  doc: MemoryDoc;
  agentId: AgentId | null;
  op: "add" | "replace" | "remove" | "confirm";
  before: string | null;
  after: string | null;
  /** "agent": a memory tool in a chat; "user": you, in the Memory page. */
  by: "agent" | "user";
  /** The chat it happened in (agent changes). */
  sessionId: SessionId | null;
  at: number;
  /** Set once undone. Undo restores the line as it was before this change. */
  undoneAt: number | null;
  /** False once a later change touched the same line (undo that one first), or once undone. */
  undoable: boolean;
}

/**
 * A memory edit from a run going without you (a spawned session working on a brief, a message_session or a reaction
 * run). It is not applied: it rides on that session's next report to the agent that started it, which decides. If that
 * agent writes it, the write follows the normal rules (a chat you are in: applied with a chip and Undo, or an approval
 * when the chat read outside content; a spawned parent: suggested again, one level up). Runs you type yourself, in any
 * chat, write directly.
 */
export interface MemorySuggestion {
  id: MemorySuggestionId;
  doc: MemoryDoc;
  agentId: AgentId | null;
  op: "add" | "replace" | "remove";
  /** The line it changes (replace, remove). */
  lineId: MemoryLineId | null;
  /** The line's text now (replace, remove), so the card can show the difference. */
  current: string | null;
  /** The new text (add, replace). */
  text: string | null;
  /** The session that proposed it. */
  sessionId: SessionId;
  /** pending: waiting for the session's next report; reported: sent with it. */
  status: "pending" | "reported";
  createdAt: number;
  reportedAt: number | null;
}

/** On messages with role "memory": the "Memory updated" chip (with Undo). Upserted again when the change is undone. */
export interface MessageMemory {
  change: MemoryChange;
  review?: { jobId: string; changeIds: string[]; undoneCount?: number };
}

// ---- history search -------------------------------------------------------------------------------------------------

/** One match from search_history: a message, or a chunk of a long tool result. */
export interface HistoryHit {
  /** Retrieval evidence only, not answer confidence. */
  relevance?: "match" | "related";
  /** The index entry (a message, or one chunk of it). */
  chunkId: string;
  sessionId: SessionId;
  sessionTitle: string;
  agentId: AgentId;
  messageId: MessageId;
  /** "tool": a chunk of a tool result inside the run that `messageId` (the run's reply) belongs to. */
  kind: "user" | "assistant" | "report" | "tool";
  toolName: string | null;
  /** Up to about 300 characters around the match. */
  snippet: string;
  createdAt: number;
  /** Fused score; higher is better. */
  score: number;
  /** 1-based rank on each side, null when that side did not find it (Full mode shows why it matched). */
  keywordRank: number | null;
  vectorRank: number | null;
  cosine: number | null;
  /** The labels of the session it came from; reading it adds them to the reader (search_history does). */
  taint: TaintLabel[];
}

/**
 * The embedder and the index.
 * - ready: every entry has a vector in the active set
 * - indexing: entries are waiting for vectors (new messages or a rebuild into a new set)
 * - down: the embedder does not answer; keyword search still works and entries wait
 * - off: no embedder is configured; keyword search only
 */
export interface IndexStatus {
  state: "ready" | "indexing" | "down" | "off";
  /** The active vector set's model, e.g. "mlx-community/embeddinggemma-2-6bit affine-6bit-g64-bf16", or null when there is none yet. */
  model: string | null;
  dimensions: number | null;
  /** Searchable index entries (messages and tool chunks). */
  entries: number;
  /** Entries with a vector in the active set. */
  embedded: number;
  /** Set while a new vector set is built (a model change or Rebuild); search keeps using the active set until it is done. */
  building: { model: string; embedded: number; total: number } | null;
  lastError: string | null;
  /** The endpoint is not on this box: the provider receives all indexed text. */
  remote: boolean;
  /**
   * Present when search runs on the retrieval service (Qdrant): how many entries SQLite has changed and the service
   * does not know about yet, and the last thing that went wrong getting them there. The entries themselves are always
   * in SQLite, so this backlog is a delay in ranking, never a loss of history.
   */
  indexing?: { pending: number; lastError: string | null };
}

// ---- HTTP -----------------------------------------------------------------------------------------------------------

/** GET /api/memory */
export interface MemoryResponse {
  profile: MemoryLine[];
  /** Every agent's agent.md, including empty ones. */
  agents: { agentId: AgentId; lines: MemoryLine[]; usedTokens: number; tokenBudget: number }[];
  userUsedTokens: number;
  userTokenBudget: number;
  /** Total carried by the largest agent context; informational, not a combined cap. */
  usedTokens: number;
}

/** POST /api/memory/lines: you add a line. Errors: "too_long", "over_budget", "unknown_agent", "empty". Answers the line. */
export interface AddMemoryLineRequest {
  doc: MemoryDoc;
  agentId?: AgentId;
  text: string;
}
/** PATCH /api/memory/lines/:id: you edit a line (a replace by "user"; it also confirms). Errors: "not_found", "too_long", "over_budget", "empty". */
export interface UpdateMemoryLineRequest {
  text: string;
}
/** POST /api/memory/lines, PATCH /api/memory/lines/:id */
export interface MemoryLineResponse {
  line: MemoryLine;
  change: MemoryChange;
}
/** DELETE /api/memory/lines/:id answers `{ change }`. Errors: "not_found". */
/** GET /api/memory/lines/:id/changes: the line's versions, oldest first. Errors: "not_found". */
export interface MemoryChangesResponse {
  changes: MemoryChange[];
}
/** POST /api/memory/changes/:id/undo. Errors: "not_found", "not_undoable" (a later change touched the line, or already undone), "over_budget". */
export interface UndoMemoryChangeResponse {
  change: MemoryChange;
  /** The line after the undo; null when the undo removed it (undoing an add). */
  line: MemoryLine | null;
}

/**
 * GET /api/history/search?q=&from=&to=&agent=&limit= (from/to: epoch ms; agent: an agent id, only that agent's chats and
 * sessions, default every agent; limit 1–50, default 20). Errors: "bad_query", "unknown_agent".
 */
export interface HistorySearchResponse {
  hits: HistoryHit[];
  index: IndexStatus;
}

/** GET /api/memory/index */
export interface IndexStatusResponse {
  index: IndexStatus;
}
/** POST /api/memory/index/rebuild: re-embed everything into a new vector set in the background. Answers `{ index }`. */

/**
 * GET /api/diagnostics/storage (M11/M12): what SQLite and the two services agree about. Counts and states only — never
 * an object key, a filename, a credential or a query. `rei doctor` and the settings page report this; the object store
 * and the retrieval service are separately configurable, so each says its own piece.
 */
export interface StorageStatusResponse {
  files: {
    /** The bucket Rei writes file bytes into. Its name is not secret, but it is a location, so it is only for a signed-in operator. */
    bucket: string;
    /** Objects SQLite has decided must exist, in each state of the ledger. */
    pending: number;
    ready: number;
    deletePending: number;
    failed: number;
    readyBytes: number;
    /** The last deletion that failed, in words. The intent stays in SQLite until it succeeds. */
    lastError: string | null;
  };
  search: {
    configured: boolean;
    /** Null when no retrieval service is configured (Rei then searches its own index inside SQLite). */
    ok: boolean | null;
    detail: string | null;
    lexicalCollection: string | null;
    lexicalPoints: number | null;
    dense: { collection: string; points: number }[];
    /** Entries SQLite has changed and the service has not been told about yet. A delay in ranking, never a loss. */
    queued: number;
    queueError: string | null;
  };
}
