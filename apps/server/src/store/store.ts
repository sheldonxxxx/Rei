import { DEFAULT_SANDBOX_WHITELIST } from "@rei/network";
import type {
  Agent,
  AgentSettingsPatch,
  Approval,
  Attachment,
  ChatItem,
  Companion,
  EditLogEntry,
  MessageMemory,
  MessageMention,
  MessagePart,
  NotifyEvent,
  NotifyPayload,
  ProfileName,
  ReadMarker,
  ReadMarkerResponse,
  RunStatus,
  SandboxNetworkMode,
  Session,
  SessionOrigin,
  SessionReport,
  SessionStatus,
  TaintLabel,
  Takeover,
  ThinkingLevel,
  TriggerMessage,
} from "@rei/protocol";
import type { BranchEntryRef, BranchRow } from "../conversation/branches.ts";
import type { InputRole } from "../conversation/ledger.ts";
import {
  currentRun,
  inputAnsweredBy,
  outboxRun,
  RunRegistry,
  type RunRow,
  replyItemId,
  runError,
  userItemId,
} from "../conversation/runs.ts";
import type { Db } from "../db/db.ts";
import { type SuggestionRow, suggestionsLine, toSuggestion } from "../memory/rows.ts";
import { replyText } from "../surfaces/text.ts";
import type { Clock } from "../util/clock.ts";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../util/encoding.ts";
import { badRequest, HttpError, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { type EventLog, GLOBAL_STREAM, sessionStream } from "./events.ts";
import { ManualCompactionStore } from "./manual-compactions.ts";
import { type TakeoverRow, toTakeover } from "./takeovers.ts";

export const MAX_MESSAGE_CHARS = 32_000;

/** An input queued for admission (see `AppStore.queueAdmission`); the fields of `ConversationCommands.admit`. */
/** What started a run that completed. */
export interface FinishedInput {
  role: string;
  text: string;
  /** Written by another session's agent. */
  fromSession: boolean;
  createdAt: number;
}

/** Reads a session's transcript (Pi's entries as chat items). */
export interface ConversationReader {
  /** The newest window of items (or the page before a cursor). */
  view(
    sessionId: string,
    options?: { before?: string; limit?: number },
  ): Promise<{ items: ChatItem[]; before: string | null }>;
  /** The page an item is on, and its index there. */
  around(
    sessionId: string,
    itemId: string,
  ): Promise<{ items: ChatItem[]; at: number; before: string | null } | undefined>;
}

export interface QueuedAdmission {
  sessionId: string;
  requestId: string;
  role: InputRole;
  text: string;
  modelText?: string;
  assignedBy?: string;
  triggerRunId?: string;
  trigger?: TriggerMessage;
  report?: SessionReport;
  attachments?: Attachment[];
  mentions?: MessageMention[];
}
export const NEW_CHAT_TITLE = "New chat";
/** Chats the user has (their own words are input there): not a worker, not a trigger run. */
export const USER_CHAT_ORIGINS: readonly string[] = ["home", "user", "fork", "import"];

export interface SessionRow {
  id: string;
  agent_id: string;
  tree_id: string;
  pi_conversation_id: string | null;
  origin: string;
  pinned: number;
  title: string;
  status: string;
  preview: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  parent_session_id: string | null;
  forked_from_session_id: string | null;
  forked_from_message_id: string | null;
  forked_from_step_id: string | null;
  forked_from_edited: number;
  forked_from_retried: number;
  depth: number;
  spawn_key: string | null;
  profile: string;
  taint: string;
  pending_approvals: number;
  browser_url: string | null;
  browser_title: string | null;
  trigger_id: string | null;
  last_run_status: string | null;
  /** Agent entries after the read marker (`agent_entries`, `read_markers`). */
  unread: number;
}
interface AgentRow {
  id: string;
  name: string;
  avatar: string;
  model: string | null;
  thinking_level: ThinkingLevel;
  network_mode: SandboxNetworkMode;
  allowed_connector_ids: string | null;
  can_create_triggers_for_other_agents: number;
  default_profile: string;
  instructions: string;
  home_session_id: string | null;
  created_at: number;
}
export interface TreeRow {
  id: string;
  root_session_id: string | null;
  state: string;
  next_wake_at: number | null;
  work_in_flight: number;
  created_at: number;
  last_opened_at: number | null;
}

export interface OutboxRow {
  id: number;
  request_id: string;
  tree_id: string | null;
  session_id: string | null;
  kind: string;
  payload: string;
  state: string;
  attempts: number;
  created_at: number;
  delivered_at: number | null;
}
export interface DeletionJob {
  id: string;
  tree_id: string;
  sessionIds: string[];
  removeTree: boolean;
  blobRefs: string[];
}

/** Raised when start_session is refused (depth or child limit); the message goes back to the model as the tool error. */
export class SpawnRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnRefused";
  }
}

export const REPORT_SUMMARY_MAX = 1_000;
/** A session report carries its worker's final reply up to this length; longer replies are read with read_chat. */
export const SESSION_REPORT_INLINE_MAX = 6_000;

/** The one plain line a report message shows. */
export const reportLine = (r: SessionReport): string => `Session "${r.title}" ${r.outcome}`;
/** What the parent's model reads as the input of its reaction run. */
export const reportInputText = (r: SessionReport): string => {
  const head = `[Session report] "${r.title}" (${r.sessionId}) ${r.outcome}`;
  const cut = r.resultId !== undefined && r.resultChars !== undefined && r.resultChars > r.summary.length;
  const body =
    r.summary.trim() === ""
      ? "."
      : cut
        ? `. Its result is message ${r.resultId} (${r.resultChars} characters), too long to include here: read it with read_chat (session_id ${r.sessionId}, message_id ${r.resultId}) when you need it.`
        : r.resultId !== undefined
          ? `. Its complete result (message ${r.resultId}):\n${r.summary}`
          : `:\n${r.summary}`;
  return `${head}${body}${r.memorySuggestions?.length ? `\n${suggestionsLine(r.memorySuggestions)}` : ""}`;
};

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const interactiveProfile = (profile: string): ProfileName =>
  profile === "relaxed" ? "standard" : (profile as ProfileName);

const toSession = (r: SessionRow, takeover: Takeover | null = null): Session => ({
  id: r.id,
  agentId: r.agent_id,
  origin: r.origin as SessionOrigin,
  pinned: r.pinned === 1,
  title: r.title,
  status: r.status as SessionStatus,
  preview: r.preview,
  parentSessionId: r.parent_session_id,
  forkedFrom:
    r.forked_from_session_id && r.forked_from_message_id
      ? {
          sessionId: r.forked_from_session_id,
          messageId: r.forked_from_message_id,
          ...(r.forked_from_step_id ? { stepId: r.forked_from_step_id } : {}),
          ...(r.forked_from_edited === 1 ? { edited: true } : {}),
          ...(r.forked_from_edited === 1 && r.forked_from_retried === 1 ? { retried: true } : {}),
        }
      : null,
  depth: r.depth,
  profile: r.origin === "trigger" ? (r.profile as ProfileName) : interactiveProfile(r.profile),
  taint: JSON.parse(r.taint) as TaintLabel[],
  pendingApprovals: r.pending_approvals,
  unread: r.unread,
  browser: r.browser_url === null ? null : { url: r.browser_url, title: r.browser_title ?? "", takeover },
  ...(r.origin === "trigger" ? { triggerId: r.trigger_id } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  name: r.name,
  avatar: r.avatar,
  model: r.model,
  thinkingLevel: r.thinking_level,
  networkMode: r.network_mode,
  allowedConnectorIds: r.allowed_connector_ids === null ? null : JSON.parse(r.allowed_connector_ids),
  canCreateTriggersForOtherAgents: r.can_create_triggers_for_other_agents === 1,
  defaultProfile: interactiveProfile(r.default_profile),
  homeSessionId: r.home_session_id ?? "",
});

export { type RunRow, TERMINAL_RUN, toRun } from "../conversation/runs.ts";

/** The metaGet key for the user's sandbox whitelist (absent until the user saves one). */
const SANDBOX_WHITELIST_KEY = "sandbox_whitelist";

export interface AcceptResult {
  messageId: string;
  runId: string;
  created: boolean;
}

/** The app store: the record of the product (agents, sessions, runs, messages), with committed events for the streams. */
export class AppStore {
  readonly db: Db;
  readonly clock: Clock;
  readonly events: EventLog;
  /** The runs of open trees (Pi submissions plus the Rei command ledger), kept current by the conversation layer. */
  readonly runs = new RunRegistry();
  readonly manualCompactions: ManualCompactionStore;
  /**
   * Set by the adapter: writes a line into a session's Pi conversation (an app notice, a trigger line). Fire and forget;
   * a closed tree is opened for it.
   */
  transcript:
    | {
        notice(sessionId: string, text: string, runId: string | null): void;
        triggerLine(sessionId: string, trigger: TriggerMessage): void;
      }
    | undefined;

  constructor(db: Db, clock: Clock, events: EventLog) {
    this.db = db;
    this.clock = clock;
    this.events = events;
    this.manualCompactions = new ManualCompactionStore(db, clock, (sessionId) => this.viewChanged(sessionId));
  }

  /** Set by the adapter: called (soon after the commit) when a report row was written to the outbox. */
  onReportQueued: (() => void) | undefined;
  /** Set by the adapter: called (soon after the commit) when an admission was queued. */
  onAdmitQueued: (() => void) | undefined;
  /** Set by notifications: called (soon after the commit) when a notify row was written to the outbox. */
  onNotifyQueued: (() => void) | undefined;
  /** Set by memory: a message that may be searchable was added or completed (after the commit); chats being deleted (inside the purge). */
  memoryHooks:
    | {
        indexable(item: import("../memory/history-indexing.ts").IndexableItem): void;
        purgeSession(sessionId: string): void;
        afterPurge(): void;
        /** A rewind or a version switch changed which of the session's history is in its active chain. */
        branchVisibility?(sessionId: string, visible: (row: BranchEntryRef) => boolean): void;
      }
    | undefined;
  /** Set by triggers: a run that belongs to a trigger run ended (after the commit); the argument is the trigger run. */
  onTriggerRunFinished: ((triggerRunId: string) => void) | undefined;
  /** Set by chat titles: a run completed (after the commit). */
  onRunFinished: ((runId: string) => void) | undefined;
  readonly #runFinishedListeners = new Set<(runId: string, input: FinishedInput) => void>();
  /** Called after a run completed, with what started it (the memory review reads the user's words from here). */
  addRunFinishedListener(listener: (runId: string, input: FinishedInput) => void): () => void {
    this.#runFinishedListeners.add(listener);
    return () => this.#runFinishedListeners.delete(listener);
  }
  #txDepth = 0;
  #after: (() => void)[] = [];

  /** Runs `fn` right after the current transaction commits (dropped if it rolls back). */
  afterCommit(fn: () => void): void {
    this.#after.push(fn);
  }

  /** One transaction; events appended inside it are published after the commit. */
  tx<T>(fn: () => T): T {
    // Nested MemoryLines/audit operations join the outer transaction. Publish only after the outer commit.
    if (this.#txDepth > 0) return fn();
    this.#txDepth++;
    let result: T;
    let after: (() => void)[];
    try {
      result = this.db.transaction(fn);
      after = this.#after;
      this.#after = [];
    } catch (error) {
      this.events.discard();
      this.#after = [];
      throw error;
    } finally {
      this.#txDepth--;
    }
    // Subscribers may start new transactions; the committed transaction is no longer on the stack.
    this.events.flush();
    for (const f of after) queueMicrotask(f);
    return result;
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  listAgents(): Agent[] {
    return this.db.all<AgentRow>("SELECT * FROM agents ORDER BY created_at, id").map(toAgent);
  }
  getAgentRow(id: string): AgentRow | undefined {
    return this.db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
  }
  getAgent(id: string): Agent | undefined {
    const row = this.getAgentRow(id);
    return row ? toAgent(row) : undefined;
  }
  defaultAgentId(): string | undefined {
    return this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'default_agent_id'")?.value;
  }
  /** The companion agent (GLOSSARY) and its home chat: the user's pick while that agent exists, else the default agent. */
  companion(): Companion {
    const picked = this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'companion_agent_id'")?.value;
    const agent =
      (picked !== undefined ? this.getAgentRow(picked) : undefined) ?? this.getAgentRow(this.defaultAgentId() ?? "");
    return { agentId: agent?.id ?? "", homeSessionId: agent?.home_session_id ?? "" };
  }
  /** Picks the companion agent and tells every client (`companion.changed`); 400 unknown_agent for no such agent. */
  setCompanionAgent(agentId: string): Companion {
    return this.tx(() => {
      if (!this.getAgentRow(agentId)) throw badRequest("unknown_agent", "That agent does not exist.");
      const before = this.companion();
      this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('companion_agent_id', ?)", agentId);
      const companion = this.companion();
      if (before.agentId !== companion.agentId || before.homeSessionId !== companion.homeSessionId)
        this.events.append(GLOBAL_STREAM, { type: "companion.changed", companion });
      return companion;
    });
  }
  listSessions(): Session[] {
    const open = new Map<string, Takeover>();
    for (const t of this.db.all<TakeoverRow>(
      "SELECT * FROM takeovers WHERE status IN ('pending', 'active') ORDER BY seq",
    ))
      open.set(t.session_id, toTakeover(t));
    return this.db
      .all<SessionRow>("SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC")
      .map((r) => toSession(r, open.get(r.id) ?? null));
  }
  /** Small global seed; sidebar history is fetched in pages. */
  sessionSeed(): Session[] {
    const rows = this.db.all<SessionRow>(`SELECT * FROM sessions WHERE deleted_at IS NULL AND (
      origin = 'home' OR status = 'waiting_for_user' OR id IN (
        SELECT id FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 6
      )) ORDER BY updated_at DESC, id DESC`);
    return rows.map((r) => this.#toSession(r));
  }

  /** Keyset page over the visible sessions. The cursor is the UTF-8 JSON boundary in unpadded base64url (Web APIs only, so it survives a Workers build); a cursor that will not decode is a client error, not a crash. */
  sessionPage(
    agentId: string | undefined,
    before: string | undefined,
    limit = 30,
    options: { triggers?: boolean } = {},
  ): { sessions: Session[]; nextCursor: string | null } {
    let boundary: { updatedAt: number; id: string } | undefined;
    if (before) {
      try {
        boundary = JSON.parse(fromUtf8(fromBase64Url(before)));
        if (!boundary || !Number.isSafeInteger(boundary.updatedAt) || typeof boundary.id !== "string")
          throw new Error();
      } catch {
        throw badRequest("bad_cursor", "Invalid session cursor");
      }
    }
    const rows = this.db.all<SessionRow>(
      `SELECT * FROM sessions WHERE deleted_at IS NULL
      AND origin != 'home' AND id NOT IN (SELECT home_session_id FROM agents WHERE home_session_id IS NOT NULL)
      AND (origin != 'trigger' OR ${options.triggers ? "1" : "status IN ('failed', 'waiting_for_user') OR EXISTS (SELECT 1 FROM takeovers WHERE session_id = sessions.id AND status = 'pending')"})
      ${agentId ? "AND agent_id = ?" : ""}
      ${boundary ? "AND (updated_at < ? OR (updated_at = ? AND id < ?))" : ""}
      ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ...[
        ...(agentId ? [agentId] : []),
        ...(boundary ? [boundary.updatedAt, boundary.updatedAt, boundary.id] : []),
        limit + 1,
      ],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      sessions: page.map((r) => this.#toSession(r)),
      nextCursor:
        rows.length > limit && last
          ? toBase64Url(utf8(JSON.stringify({ updatedAt: last.updated_at, id: last.id })))
          : null,
    };
  }

  /** Metadata needed by an open chat, including all descendants branched from it. */
  relatedSessions(id: string): Session[] {
    const row = this.getSessionRow(id);
    if (!row) throw notFound("That session does not exist.");
    return this.db
      .all<SessionRow>(
        `WITH RECURSIVE branches(id) AS (
      SELECT id FROM sessions WHERE id = ? AND deleted_at IS NULL
      UNION SELECT s.id FROM sessions s JOIN branches b ON s.forked_from_session_id = b.id WHERE s.deleted_at IS NULL
    ) SELECT * FROM sessions WHERE deleted_at IS NULL AND (
      id IN (SELECT id FROM branches) OR parent_session_id = ? OR id = ? OR id = ?
    ) ORDER BY updated_at DESC, id DESC`,
        id,
        id,
        row.parent_session_id,
        row.forked_from_session_id,
      )
      .map((r) => this.#toSession(r));
  }

  /** Live sessions that show a browser window (the service clears the stale ones at start). */
  sessionsWithBrowser(): string[] {
    return this.db
      .all<{ id: string }>("SELECT id FROM sessions WHERE browser_url IS NOT NULL AND deleted_at IS NULL")
      .map((r) => r.id);
  }
  /** The session as the PWA sees it: its browser window carries the pending or active takeover. */
  #toSession(r: SessionRow): Session {
    if (r.browser_url === null) return toSession(r);
    const t = this.db.get<TakeoverRow>(
      "SELECT * FROM takeovers WHERE session_id = ? AND status IN ('pending', 'active') ORDER BY seq DESC LIMIT 1",
      r.id,
    );
    return toSession(r, t ? toTakeover(t) : null);
  }
  getSessionRow(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>("SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL", id);
  }
  getSession(id: string): Session | undefined {
    const row = this.getSessionRow(id);
    return row ? this.#toSession(row) : undefined;
  }
  /** A session row including deleted (hidden) ones. */
  getSessionRowAny(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
  }
  /** The sessions of a tree, oldest first. */
  treeSessions(treeId: string, includeDeleted = false): SessionRow[] {
    return this.db.all<SessionRow>(
      `SELECT * FROM sessions WHERE tree_id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"} ORDER BY created_at, id`,
      treeId,
    );
  }
  /** The live session that owns a Pi conversation of a tree (conversation ids are only unique within one tree file). */
  sessionByConversation(treeId: string, conversationId: string): SessionRow | undefined {
    return this.db.get<SessionRow>(
      "SELECT * FROM sessions WHERE tree_id = ? AND pi_conversation_id = ? AND deleted_at IS NULL",
      treeId,
      conversationId,
    );
  }
  /** Sessions a session spawned (live ones), oldest first. */
  childrenOf(sessionId: string): SessionRow[] {
    return this.db.all<SessionRow>(
      "SELECT * FROM sessions WHERE parent_session_id = ? AND deleted_at IS NULL ORDER BY created_at, id",
      sessionId,
    );
  }
  /** The live sessions branched (directly or through other forks) from a session. */
  forkDescendants(sessionId: string): SessionRow[] {
    const out: SessionRow[] = [];
    const queue = [sessionId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const row of this.db.all<SessionRow>(
        "SELECT * FROM sessions WHERE forked_from_session_id = ? AND deleted_at IS NULL",
        id,
      )) {
        out.push(row);
        queue.push(row.id);
      }
    }
    return out;
  }
  hasUnfinishedRun(sessionId: string): boolean {
    return this.runs.nonTerminal(sessionId).length > 0;
  }
  /** The newest report a spawned session sent to `parentId`, for list_sessions. */
  lastReportFrom(parentId: string, childId: string): SessionReport | undefined {
    const row = this.db.get<{ payload: string }>(
      "SELECT payload FROM outbox WHERE kind = 'report' AND session_id = ? AND state = 'delivered' AND json_extract(payload, '$.parentId') = ? ORDER BY id DESC LIMIT 1",
      childId,
      parentId,
    );
    return row ? (JSON.parse(row.payload) as { report?: SessionReport }).report : undefined;
  }
  /** Saved attachments point at their library file (when it still exists); a purged item keeps its download reference. */
  enrichAttachment(attachment: Attachment): Attachment {
    const saved = this.db.get<{ file_id: string; version_id: string }>(
      "SELECT a.file_id, a.version_id FROM attachments a JOIN library_files f ON f.id = a.file_id WHERE a.id = ? AND f.purged_at IS NULL",
      attachment.id,
    );
    if (!saved) {
      const { fileId: _file, versionId: _version, ...download } = attachment;
      return download;
    }
    return { ...attachment, fileId: saved.file_id, versionId: saved.version_id };
  }
  getRun(id: string): RunRow | undefined {
    return this.runs.get(id);
  }
  runByRequest(sessionId: string, requestId: string): RunRow | undefined {
    return this.runs.byRequest(sessionId, requestId);
  }
  runBySubmission(submissionId: string): RunRow | undefined {
    return this.runs.bySubmission(submissionId);
  }
  /** Runs that are not finished, oldest first (Pi runs one input at a time per conversation, in order). */
  nonTerminalRuns(sessionId?: string): RunRow[] {
    return this.runs.nonTerminal(sessionId);
  }
  /** The newest model call (trace step) of a run: the one whose answer a tool call is part of. */
  latestModelStep(runId: string): string | undefined {
    return this.db.get<{ id: string }>(
      "SELECT id FROM steps WHERE run_id = ? AND type = 'llm.call' ORDER BY started_at DESC, id DESC LIMIT 1",
      runId,
    )?.id;
  }
  /** The run being answered now (see `currentRun`): after a steer, the steer's run, not the one it joined. */
  runningRun(sessionId: string): RunRow | undefined {
    return currentRun(this.runs.forSession(sessionId));
  }
  activeRunForSession(sessionId: string): RunRow | undefined {
    return this.nonTerminalRuns(sessionId)[0];
  }
  treeRow(id: string): TreeRow | undefined {
    return this.db.get<TreeRow>("SELECT * FROM session_trees WHERE id = ?", id);
  }
  /** Trees that may have work: flagged when opened (cleared when closed idle), or with an unfinished run in memory. */
  treesWithWork(): string[] {
    const flagged = this.db.all<{ id: string }>(
      "SELECT id FROM session_trees WHERE state = 'live' AND work_in_flight = 1",
    );
    const open = this.db
      .all<{ id: string }>("SELECT id FROM session_trees WHERE state = 'live'")
      .filter((r) => this.runs.hasWork(r.id));
    return [...new Set([...open.map((r) => r.id), ...flagged.map((r) => r.id)])];
  }
  liveTreeIds(): string[] {
    return this.db
      .all<{ id: string }>("SELECT id FROM session_trees WHERE state = 'live' ORDER BY created_at, id")
      .map((r) => r.id);
  }
  /** The model of the agent a session belongs to (sessions have none of their own); null: the default model. */
  modelOf(sessionId: string): string | null {
    const session = this.getSessionRow(sessionId);
    const agent = session ? this.getAgentRow(session.agent_id) : undefined;
    return agent?.model ?? null;
  }
  /** The instructions of the session's agent; undefined when the agent is gone. */
  instructionsOf(sessionId: string): string | undefined {
    const session = this.getSessionRow(sessionId);
    return session ? this.getAgentRow(session.agent_id)?.instructions : undefined;
  }
  /** Earlier versions of an agent's instructions from the edit log, newest first. */
  instructionHistory(agentId: string, limit = 20): { at: number; author: "user" | "agent"; text: string }[] {
    return this.db
      .all<{ at: number; author: string; before_text: string | null }>(
        "SELECT at, author, before_text FROM edit_log WHERE target_kind = 'agent' AND target_id = ? AND field = 'instructions' ORDER BY seq DESC LIMIT ?",
        agentId,
        limit,
      )
      .map((r) => ({
        at: r.at,
        author: r.author === "agent" ? ("agent" as const) : ("user" as const),
        text: r.before_text ?? "",
      }));
  }
  thinkingLevelOf(sessionId: string): ThinkingLevel {
    const session = this.getSessionRow(sessionId);
    return (session ? this.getAgentRow(session.agent_id)?.thinking_level : undefined) ?? "off";
  }
  /** Every model some agent is set to, for the model list. */
  modelsInUse(): string[] {
    return this.db
      .all<{ model: string }>("SELECT DISTINCT model FROM agents WHERE model IS NOT NULL ORDER BY model")
      .map((r) => r.model);
  }
  /** Ids of the agents set to exactly this model. */
  agentIdsUsingModel(model: string): string[] {
    return this.db.all<{ id: string }>("SELECT id FROM agents WHERE model = ? ORDER BY id", model).map((r) => r.id);
  }
  hasWork(treeId: string): boolean {
    return this.runs.hasWork(treeId);
  }
  /** Trees whose recorded wake time is due. */
  dueTrees(now: number): string[] {
    return this.db
      .all<{ id: string }>(
        "SELECT id FROM session_trees WHERE state = 'live' AND next_wake_at IS NOT NULL AND next_wake_at <= ?",
        now,
      )
      .map((r) => r.id);
  }

  // ---- agents, trees and sessions ----------------------------------------------------------------------------------

  /** Seeds the default agent and its home chat once; returns what exists on later starts. */
  seedDefaultAgent(): { agent: Agent; session: Session; created: boolean } {
    const existing = this.defaultAgentId();
    if (existing) {
      const agent = this.getAgent(existing);
      const session = agent ? this.getSession(agent.homeSessionId) : undefined;
      if (agent && session) return { agent, session, created: false };
    }
    return this.tx(() => {
      const made = this.#insertAgent({
        name: "Assistant",
        avatar: "bot:sprout",
        instructions:
          "You are Assistant, a personal AI assistant. Be direct, concise and honest about what you do not know.",
      });
      this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('default_agent_id', ?)", made.agent.id);
      return { agent: made.agent, session: made.session, created: true };
    });
  }

  /** The rows of a new agent and its home chat in a new tree, and the events for them (the adapter creates the tree file). */
  #insertAgent(input: { name: string; avatar: string; instructions: string }): {
    agent: Agent;
    session: Session;
    treeId: string;
  } {
    const now = this.clock.now();
    const agentId = newId("agt", now);
    const sessionId = newId("ses", now);
    const treeId = newId("tr", now);
    this.db.run(
      "INSERT INTO agents (id, name, avatar, default_profile, instructions, home_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      agentId,
      input.name,
      input.avatar,
      "standard",
      input.instructions,
      sessionId,
      now,
    );
    this.db.run(
      "INSERT INTO session_trees (id, root_session_id, state, created_at) VALUES (?, ?, 'live', ?)",
      treeId,
      sessionId,
      now,
    );
    this.db.run(
      "INSERT INTO sessions (id, agent_id, tree_id, origin, title, status, preview, created_at, updated_at) VALUES (?, ?, ?, 'home', ?, 'idle', '', ?, ?)",
      sessionId,
      agentId,
      treeId,
      input.name,
      now,
      now,
    );
    const agent = this.getAgent(agentId)!;
    const session = this.getSession(sessionId)!;
    this.events.append(GLOBAL_STREAM, { type: "agent.upserted", agent });
    this.events.append(GLOBAL_STREAM, { type: "session.upserted", session });
    return { agent, session, treeId };
  }

  /** A new agent (not the default one) with its home chat; the adapter creates the tree file. */
  createAgent(input: { name: string; avatar: string; instructions: string }): {
    agent: Agent;
    session: Session;
    treeId: string;
  } {
    return this.tx(() => this.#insertAgent(input));
  }

  /** The agent's sessions that are not deleted, oldest first (every kind: home, chats, forks, spawned, triggers). */
  agentSessionIds(agentId: string): string[] {
    return this.db
      .all<{ id: string }>(
        "SELECT id FROM sessions WHERE agent_id = ? AND deleted_at IS NULL ORDER BY created_at, id",
        agentId,
      )
      .map((r) => r.id);
  }

  /**
   * Removes an agent's rows once its sessions are deleted: its triggers (with their runs), grants, approvals and memory,
   * then the agent, and says `agent.removed`. Refuses the default agent (409 `default_agent`) and an unknown one (404).
   */
  removeAgentRows(agentId: string): void {
    this.tx(() => {
      const row = this.getAgentRow(agentId);
      if (!row) throw notFound("That agent does not exist.");
      if (this.defaultAgentId() === agentId)
        throw new HttpError(409, "default_agent", "The default agent can't be deleted.");
      const now = this.clock.now();
      this.db.run("DELETE FROM trigger_runs WHERE trigger_id IN (SELECT id FROM triggers WHERE agent_id = ?)", agentId);
      const triggers = this.db.run("DELETE FROM triggers WHERE agent_id = ?", agentId).changes;
      this.db.run("DELETE FROM grants WHERE agent_id = ?", agentId);
      this.db.run("DELETE FROM approvals WHERE agent_id = ?", agentId);
      this.db.run("DELETE FROM memory_changes WHERE agent_id = ?", agentId);
      this.db.run("DELETE FROM memory_suggestions WHERE agent_id = ?", agentId);
      this.db.run("DELETE FROM memory_lines WHERE agent_id = ?", agentId);
      this.db.run("DELETE FROM web_documents WHERE agent_id = ?", agentId);
      this.db.run("DELETE FROM agents WHERE id = ?", agentId);
      this.db.run(
        "INSERT INTO edit_log (id, at, author, target_kind, target_id, field, before_text, after_text) VALUES (?, ?, 'user', 'agent', ?, 'deleted', ?, NULL)",
        newId("edt", now),
        now,
        agentId,
        row.name,
      );
      if (triggers > 0) this.events.append(GLOBAL_STREAM, { type: "triggers.changed", triggerId: null });
      this.events.append(GLOBAL_STREAM, { type: "memory.changed", what: "lines" });
      this.events.append(GLOBAL_STREAM, { type: "agent.removed", agentId });
      if (this.db.run("DELETE FROM meta WHERE key = 'companion_agent_id' AND value = ?", agentId).changes > 0)
        this.events.append(GLOBAL_STREAM, { type: "companion.changed", companion: this.companion() });
    });
  }

  /** Changes how an agent looks and tells every open PWA; undefined when there is no such agent. */
  setAgentAvatar(agentId: string, avatar: string): Agent | undefined {
    return this.tx(() => {
      if (!this.getAgentRow(agentId)) return undefined;
      this.db.run("UPDATE agents SET avatar = ? WHERE id = ?", avatar, agentId);
      const agent = this.getAgent(agentId)!;
      this.events.append(GLOBAL_STREAM, { type: "agent.upserted", agent });
      return agent;
    });
  }

  /**
   * Changes an agent's name, model or default profile (the caller has checked the values) and writes one edit log row
   * per field that actually changed. A null model goes back to the default model. Undefined when there is no such agent.
   */
  agentCanUseConnector(agentId: string, connectorId: string): boolean {
    const agent = this.getAgent(agentId);
    return !!agent && (agent.allowedConnectorIds == null || agent.allowedConnectorIds.includes(connectorId));
  }

  updateAgentSettings(agentId: string, patch: AgentSettingsPatch): Agent | undefined {
    return this.tx(() => {
      const row = this.getAgentRow(agentId);
      if (!row) return undefined;
      const now = this.clock.now();
      const fields: [string, string, string | number | null, string | number | null | undefined][] = [
        ["name", "name", row.name, patch.name],
        [
          "allowedConnectorIds",
          "allowed_connector_ids",
          row.allowed_connector_ids,
          patch.allowedConnectorIds === undefined
            ? undefined
            : patch.allowedConnectorIds === null
              ? null
              : JSON.stringify(patch.allowedConnectorIds),
        ],
        ["model", "model", row.model, patch.model],
        ["thinkingLevel", "thinking_level", row.thinking_level, patch.thinkingLevel],
        ["networkMode", "network_mode", row.network_mode, patch.networkMode],
        [
          "canCreateTriggersForOtherAgents",
          "can_create_triggers_for_other_agents",
          row.can_create_triggers_for_other_agents,
          patch.canCreateTriggersForOtherAgents === undefined
            ? undefined
            : Number(patch.canCreateTriggersForOtherAgents),
        ],
        [
          "defaultProfile",
          "default_profile",
          row.default_profile,
          patch.defaultProfile === undefined ? undefined : interactiveProfile(patch.defaultProfile),
        ],
        ["instructions", "instructions", row.instructions, patch.instructions],
      ];
      for (const [field, column, before, after] of fields) {
        if (after === undefined || after === before) continue;
        this.db.run(`UPDATE agents SET ${column} = ? WHERE id = ?`, after, agentId);
        this.db.run(
          "INSERT INTO edit_log (id, at, author, target_kind, target_id, field, before_text, after_text) VALUES (?, ?, 'user', 'agent', ?, ?, ?, ?)",
          newId("edt", now),
          now,
          agentId,
          field,
          before === null ? null : String(before),
          after === null ? null : String(after),
        );
        // The home chat carries the agent's name as its title.
        if (field === "name" && row.home_session_id) {
          this.db.run(
            "UPDATE sessions SET title = ? WHERE id = ? AND origin = 'home' AND title = ?",
            after,
            row.home_session_id,
            before,
          );
          this.#emitSession(row.home_session_id);
        }
      }
      const agent = this.getAgent(agentId)!;
      this.events.append(GLOBAL_STREAM, { type: "agent.upserted", agent });
      return agent;
    });
  }

  /** The edit log, newest first. */
  editLog(limit: number): EditLogEntry[] {
    return this.db
      .all<{
        id: string;
        at: number;
        author: string;
        target_kind: string;
        target_id: string;
        field: string;
        before_text: string | null;
        after_text: string | null;
      }>("SELECT * FROM edit_log ORDER BY seq DESC LIMIT ?", limit)
      .map((r) => ({
        id: r.id,
        at: r.at,
        author: r.author === "agent" ? ("agent" as const) : ("user" as const),
        target:
          r.target_kind === "session"
            ? { kind: "session" as const, sessionId: r.target_id }
            : r.target_kind === "trigger"
              ? { kind: "trigger" as const, triggerId: r.target_id }
              : r.target_kind === "skill"
                ? { kind: "skill" as const, skillId: r.target_id }
                : { kind: "agent" as const, agentId: r.target_id },
        field: r.field,
        before: r.before_text,
        after: r.after_text,
      }));
  }

  /** New chat: a session and its own new tree (D29). The Pi conversation is attached afterwards by the adapter. */
  createSession(agentId: string, origin: SessionOrigin = "user"): { session: Session; treeId: string } {
    return this.tx(() => {
      const agent = this.getAgentRow(agentId);
      if (!agent) throw badRequest("unknown_agent", "That agent does not exist.");
      const now = this.clock.now();
      const sessionId = newId("ses", now);
      const treeId = newId("tr", now);
      this.db.run(
        "INSERT INTO session_trees (id, root_session_id, state, created_at) VALUES (?, ?, 'live', ?)",
        treeId,
        sessionId,
        now,
      );
      this.db.run(
        "INSERT INTO sessions (id, agent_id, tree_id, origin, title, status, preview, profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'idle', '', ?, ?, ?)",
        sessionId,
        agentId,
        treeId,
        origin,
        NEW_CHAT_TITLE,
        agent.default_profile,
        now,
        now,
      );
      const session = this.getSession(sessionId)!;
      this.events.append(GLOBAL_STREAM, { type: "session.upserted", session });
      return { session, treeId };
    });
  }

  /** A session for a trigger's run, in a new tree, with the trigger's profile and the trigger's name as its title. The adapter creates the tree folder. */
  createTriggerSession(input: { agentId: string; triggerId: string; title: string; profile: ProfileName }): {
    session: Session;
    treeId: string;
  } {
    return this.tx(() => {
      const made = this.createSession(input.agentId, "trigger");
      this.db.run(
        "UPDATE sessions SET title = ?, profile = ?, trigger_id = ? WHERE id = ?",
        input.title,
        input.profile,
        input.triggerId,
        made.session.id,
      );
      this.#emitSession(made.session.id);
      return { session: this.getSession(made.session.id)!, treeId: made.treeId };
    });
  }

  /** True when the session is blocked on you: a pending approval or a takeover the agent asked for. */
  isWaiting(sessionId: string): boolean {
    return (
      this.db.get("SELECT 1 AS x FROM approvals WHERE session_id = ? AND status = 'pending' LIMIT 1", sessionId) !==
        undefined ||
      this.db.get("SELECT 1 AS x FROM takeovers WHERE session_id = ? AND status = 'pending' LIMIT 1", sessionId) !==
        undefined
    );
  }

  /** A fresh home chat in a new tree for an agent whose old one is being cleared; the agent now points at it. The adapter creates the tree file. */
  replaceHome(agentId: string): { session: Session; treeId: string } {
    return this.tx(() => {
      const agent = this.getAgentRow(agentId);
      if (!agent) throw badRequest("unknown_agent", "That agent does not exist.");
      const made = this.createSession(agentId, "home");
      this.db.run("UPDATE sessions SET title = ? WHERE id = ?", agent.name, made.session.id);
      this.db.run("UPDATE agents SET home_session_id = ? WHERE id = ?", made.session.id, agentId);
      this.events.append(GLOBAL_STREAM, { type: "agent.upserted", agent: this.getAgent(agentId)! });
      this.events.append(GLOBAL_STREAM, { type: "session.upserted", session: this.getSession(made.session.id)! });
      if (this.companion().agentId === agentId)
        this.events.append(GLOBAL_STREAM, { type: "companion.changed", companion: this.companion() });
      return { session: this.getSession(made.session.id)!, treeId: made.treeId };
    });
  }

  setConversation(sessionId: string, conversationId: string): void {
    this.db.run("UPDATE sessions SET pi_conversation_id = ? WHERE id = ?", conversationId, sessionId);
  }

  /** Every conversation a session has had (message versions), oldest first; empty until its first rewind. */
  branchesOf(sessionId: string): BranchRow[] {
    return this.db.all<BranchRow>(
      "SELECT * FROM session_branches WHERE session_id = ? ORDER BY created_at, rowid",
      sessionId,
    );
  }

  /**
   * A rewind: records the new branch (and, on the session's first rewind, its original conversation) and makes it the
   * session's conversation, in one transaction. The caller has forked or created the conversation and swaps it in.
   */
  addBranch(input: {
    sessionId: string;
    conversationId: string;
    parentConversationId: string;
    cutEntryId: string | null;
    replacedMessageId: string;
  }): void {
    this.tx(() => {
      const session = this.getSessionRow(input.sessionId);
      if (!session) return;
      const now = this.clock.now();
      if (session.pi_conversation_id !== null)
        this.db.run(
          `INSERT OR IGNORE INTO session_branches (session_id, pi_conversation_id, parent_conversation_id, cut_entry_id, replaced_message_id, created_at, last_active_at)
           VALUES (?, ?, NULL, NULL, NULL, ?, ?)`,
          session.id,
          session.pi_conversation_id,
          Math.min(session.created_at, now),
          now,
        );
      this.db.run(
        `INSERT INTO session_branches (session_id, pi_conversation_id, parent_conversation_id, cut_entry_id, replaced_message_id, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        session.id,
        input.conversationId,
        input.parentConversationId,
        input.cutEntryId,
        input.replacedMessageId,
        now,
        this.#nextActive(session.id),
      );
      this.setConversation(session.id, input.conversationId);
    });
  }

  /** An activation time later than any of the session's (two in one millisecond still order). */
  #nextActive(sessionId: string): number {
    const newest =
      this.db.get<{ at: number | null }>(
        "SELECT MAX(last_active_at) AS at FROM session_branches WHERE session_id = ?",
        sessionId,
      )?.at ?? Number.NEGATIVE_INFINITY;
    return Math.max(this.clock.now(), newest + 1);
  }

  /** A version switch: an earlier conversation of the session becomes its conversation again. */
  activateBranch(sessionId: string, conversationId: string): void {
    this.tx(() => {
      this.db.run(
        "UPDATE session_branches SET last_active_at = ? WHERE session_id = ? AND pi_conversation_id = ?",
        this.#nextActive(sessionId),
        sessionId,
        conversationId,
      );
      this.setConversation(sessionId, conversationId);
    });
  }

  /** Restores the conversation after a replacement input could not be admitted. */
  undoBranch(sessionId: string, conversationId: string, previous: string, hadVersions: boolean): void {
    this.tx(() => {
      this.setConversation(sessionId, previous);
      if (hadVersions)
        this.db.run(
          "DELETE FROM session_branches WHERE session_id = ? AND pi_conversation_id = ?",
          sessionId,
          conversationId,
        );
      else this.db.run("DELETE FROM session_branches WHERE session_id = ?", sessionId);
    });
  }

  /** Recomputes the sidebar summary from the conversation now shown by this session. */
  refreshBranchSession(sessionId: string, preview: string, lastRunStatus: RunStatus | undefined): void {
    this.db.run("UPDATE sessions SET last_run_status = ? WHERE id = ?", lastRunStatus ?? null, sessionId);
    this.touchSession(sessionId, preview);
  }
  /** An open tree may have work until it closes idle: a crash leaves the flag, and startup reopens the tree. */
  markTreeOpened(treeId: string): void {
    this.db.run(
      "UPDATE session_trees SET last_opened_at = ?, work_in_flight = 1 WHERE id = ?",
      this.clock.now(),
      treeId,
    );
  }
  recordTreeClose(treeId: string, nextWakeAt: number | null, workInFlight: boolean): void {
    this.db.run(
      "UPDATE session_trees SET next_wake_at = ?, work_in_flight = ? WHERE id = ?",
      nextWakeAt,
      workInFlight ? 1 : 0,
      treeId,
    );
  }
  markTreeDeleted(treeId: string): void {
    this.tx(() => {
      const now = this.clock.now();
      this.db.run("UPDATE session_trees SET state = 'deleted' WHERE id = ?", treeId);
      const sessions = this.db.all<{ id: string }>(
        "SELECT id FROM sessions WHERE tree_id = ? AND deleted_at IS NULL",
        treeId,
      );
      for (const s of sessions) {
        this.db.run("UPDATE sessions SET deleted_at = ? WHERE id = ?", now, s.id);
        this.events.append(GLOBAL_STREAM, { type: "session.removed", sessionId: s.id });
      }
    });
  }

  // ---- runs: what Rei records around a Pi admission (the transcript itself is Pi's) ----------------------------------

  /** Refuses an empty or too long message (before anything is admitted). */
  /** Set by the Pi adapter: reads a session's transcript from Pi (history context, chat context). */
  reader?: ConversationReader;
  /** Set by the Pi adapter: binds files a run published to its reply. */
  fileOutputs?: (sessionId: string, runId: string, files: readonly Attachment[]) => Promise<void>;

  /** Set by the Pi adapter: marks a run silent (its reply is neither published nor notified). */
  silence?: (sessionId: string, runId: string) => Promise<void>;

  /** The home assistant chose not to answer a background event: the run's reply stays unpublished. */
  async dismissEvent(sessionId: string, runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run?.status !== "running" || (run.role !== "report" && run.role !== "trigger"))
      throw badRequest("not_event", "Only a running background-event turn can be dismissed.");
    if (!this.silence) throw new Error("Could not dismiss this event.");
    await this.silence(sessionId, runId);
  }

  /** Records that a session's transcript shows these files (they are kept, and readable from that chat). */
  referenceAttachments(sessionId: string, runId: string | null, files: readonly Attachment[]): void {
    for (const file of files)
      this.db.run("INSERT OR IGNORE INTO attachment_refs VALUES (?,?,?)", file.id, sessionId, runId);
  }

  /** Binds files a run published to its reply (in the run's ledger record). */
  async addFileOutputs(sessionId: string, runId: string, files: readonly Attachment[]): Promise<void> {
    await this.fileOutputs?.(sessionId, runId, files);
  }

  checkMessage(text: string, attachments?: readonly Attachment[]): void {
    if (text.trim() === "" && !attachments?.length) throw badRequest("empty_message", "The message is empty.");
    if (text.length > MAX_MESSAGE_CHARS)
      throw new HttpError(413, "too_long", `Messages can be at most ${MAX_MESSAGE_CHARS} characters.`);
  }

  /**
   * Whether the user is behind a new run of `session` (see `CommandRecord.direct`), and the trigger run it belongs to.
   * A trigger's run is without the user; an approval's re-run (a notice input) in a trigger session continues the
   * trigger run while it is still going, and is as direct as the run before it.
   */
  runContext(
    session: SessionRow,
    input: {
      role: "user" | "report" | "notice" | "trigger";
      from?: unknown;
      assignedBy?: string;
      triggerRunId?: string;
    },
  ): { direct: boolean; triggerRunId?: string } {
    const userChat = USER_CHAT_ORIGINS.includes(session.origin);
    // Only runs Pi has: a queued admission not yet delivered (this one among them) is not a run before it.
    const prior = this.runs
      .forSession(session.id)
      .filter((r) => !(r.status === "queued" && r.pi_submission_id === null))
      .reverse();
    const triggerRunId =
      input.triggerRunId ??
      (input.role === "notice"
        ? (prior.find(
            (r) =>
              r.trigger_run_id !== null &&
              this.db.get("SELECT 1 AS x FROM trigger_runs WHERE id = ? AND status = 'running'", r.trigger_run_id) !==
                undefined,
          )?.trigger_run_id ?? undefined)
        : undefined);
    const direct =
      input.triggerRunId !== undefined || input.role === "trigger"
        ? false
        : input.role === "report"
          ? userChat
          : input.role === "notice"
            ? (prior[0]?.direct ?? 1) === 1
            : input.from === undefined && input.assignedBy === undefined;
    return { direct, ...(triggerRunId ? { triggerRunId } : {}) };
  }

  /**
   * After Pi admitted a run's input: its saved files are linked to the session (and their labels taint it), a chat you
   * started is titled from its first message, and the session's status and preview are updated.
   */
  recordAdmission(input: {
    sessionId: string;
    runId: string;
    role: "user" | "report" | "notice" | "trigger";
    text: string;
    attachments?: readonly Attachment[];
    firstUser: boolean;
  }): void {
    this.tx(() => {
      const session = this.getSessionRow(input.sessionId);
      if (!session) return;
      this.referenceAttachments(session.id, input.runId, input.attachments ?? []);
      for (const file of input.attachments ?? [])
        if (file.fileId && file.versionId) {
          this.db.run(
            "INSERT OR IGNORE INTO library_links VALUES (?,?,?,?,?)",
            file.fileId,
            file.versionId,
            session.id,
            input.runId,
            "input",
          );
          const labels = this.db.get<{ taint: string }>("SELECT taint FROM library_files WHERE id = ?", file.fileId);
          if (labels) this.addTaint(session.id, JSON.parse(labels.taint) as TaintLabel[]);
        }
      // Only a chat you started yourself is titled from its first message; the others have a title from the start.
      if (input.firstUser && session.origin === "user" && input.role === "user")
        this.db.run(
          "UPDATE sessions SET title = ? WHERE id = ?",
          collapse(input.text).slice(0, 60) || NEW_CHAT_TITLE,
          session.id,
        );
      this.db.run("UPDATE session_trees SET work_in_flight = 1 WHERE id = ?", session.tree_id);
      this.touchSession(
        session.id,
        input.role === "trigger" || input.role === "report" ? undefined : collapse(input.text),
      );
    });
  }

  /** A view-affecting change that is not a Pi commit (a card, a run's settlement): the session's view refreshes. */
  viewChanged(sessionId: string): void {
    const emit = () => this.events.ephemeral(sessionStream(sessionId), { type: "view.changed" });
    if (this.#txDepth > 0) this.afterCommit(emit);
    else queueMicrotask(emit);
  }

  /**
   * start_session: a new spawned session in a new tree, with the brief as its first message and a run assigned by the
   * caller. Idempotent by `spawnKey` (caller session + tool call id): a replay returns the session it made before.
   * Refuses (SpawnRefused) beyond the depth limit or with too many unfinished children.
   */
  createSpawned(input: {
    callerId: string;
    spawnKey: string;
    brief: string;
    title: string;
    agentId: string;
    maxDepth: number;
    maxActive: number;
  }): { session: Session; treeId: string; created: boolean; deleted: boolean } {
    return this.tx(() => {
      const prior = this.db.get<SessionRow>("SELECT * FROM sessions WHERE spawn_key = ?", input.spawnKey);
      if (prior)
        return {
          session: this.#toSession(prior),
          treeId: prior.tree_id,
          created: false,
          deleted: prior.deleted_at !== null,
        };
      const caller = this.getSessionRow(input.callerId);
      if (!caller) throw new SpawnRefused("The calling session no longer exists.");
      if (caller.origin !== "home")
        throw new SpawnRefused("Only an agent's home chat can start worker sessions. Complete the task here yourself.");
      if (!this.getAgentRow(input.agentId)) throw new SpawnRefused("That agent does not exist.");
      const depth = caller.depth + 1;
      if (depth > input.maxDepth)
        throw new SpawnRefused(
          `Sessions can only be nested ${input.maxDepth} deep; this session is already at the limit, so it cannot start another. Do the work here instead.`,
        );
      const active = this.childrenOf(caller.id).filter((c) => this.hasUnfinishedRun(c.id)).length;
      if (active >= input.maxActive)
        throw new SpawnRefused(
          `You already have ${active} sessions running (the limit is ${input.maxActive}). Wait for some to report back, or cancel one.`,
        );
      if (input.brief.length > MAX_MESSAGE_CHARS)
        throw new SpawnRefused(`The brief is too long (at most ${MAX_MESSAGE_CHARS} characters).`);
      const now = this.clock.now();
      const sessionId = newId("ses", now);
      const treeId = newId("tr", now);
      this.db.run(
        "INSERT INTO session_trees (id, root_session_id, state, created_at) VALUES (?, ?, 'live', ?)",
        treeId,
        sessionId,
        now,
      );
      this.db.run(
        "INSERT INTO sessions (id, agent_id, tree_id, origin, title, status, preview, parent_session_id, depth, spawn_key, profile, created_at, updated_at) VALUES (?, ?, ?, 'spawned', ?, 'idle', '', ?, ?, ?, ?, ?, ?)",
        sessionId,
        input.agentId,
        treeId,
        input.title,
        caller.id,
        depth,
        input.spawnKey,
        interactiveProfile(caller.profile),
        now,
        now,
      );
      return { session: this.getSession(sessionId)!, treeId, created: true, deleted: false };
    });
  }

  /**
   * Branch in new chat: a session in the same tree and agent. The Pi conversation (`conversationId`) was forked by the
   * caller at the cut's entry, so the new chat's transcript is the source's up to there; `cut.messageId` is the source
   * item it was cut at (a client links back to it) and `preview` the last line it shows.
   */
  createFork(input: {
    source: SessionRow;
    cut: { messageId: string };
    conversationId: string;
    preview: string;
  }): Session {
    return this.tx(() => {
      const { source, cut } = input;
      const now = this.clock.now();
      const sessionId = newId("ses", now);
      this.db.run(
        `INSERT INTO sessions (id, agent_id, tree_id, pi_conversation_id, origin, title, status, preview, forked_from_session_id, forked_from_message_id, forked_from_step_id, forked_from_edited, forked_from_retried, depth, profile, taint, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'fork', ?, 'idle', '', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        sessionId,
        source.agent_id,
        source.tree_id,
        input.conversationId,
        source.title,
        source.id,
        cut.messageId,
        // Forks no longer cut at a step; the column keeps the step id of older forks.
        null,
        // Only the earlier Retry/Edit (which opened a new chat) set these; their chats keep saying so.
        0,
        0,
        // A fork copies the permissions and the taint of what it was branched from (conservative).
        source.profile,
        source.taint,
        now,
        now,
      );
      // The fork's transcript holds the source's entries up to the cut, files included (conservatively all of them).
      this.db.run(
        "INSERT OR IGNORE INTO attachment_refs SELECT attachment_id, ?, run_id FROM attachment_refs WHERE session_id = ?",
        sessionId,
        source.id,
      );
      this.touchSession(sessionId, input.preview);
      return this.getSession(sessionId)!;
    });
  }

  // ---- policy: profile, taint, notices and approval messages ---------------------------------------------------------

  /** Adds labels to a session's taint (labels never come off). Returns true when something was added. */
  addTaint(sessionId: string, labels: readonly TaintLabel[]): boolean {
    return this.tx(() => {
      const row = this.getSessionRow(sessionId);
      if (!row) return false;
      const have = JSON.parse(row.taint) as TaintLabel[];
      const next = [...new Set([...have, ...labels])].sort() as TaintLabel[];
      if (next.length === have.length) return false;
      this.db.run("UPDATE sessions SET taint = ? WHERE id = ?", JSON.stringify(next), sessionId);
      this.#emitSession(sessionId);
      return true;
    });
  }

  setProfile(sessionId: string, profile: ProfileName): void {
    this.tx(() => {
      this.db.run(
        "UPDATE sessions SET profile = CASE WHEN origin = 'trigger' THEN ? ELSE ? END WHERE id = ?",
        profile,
        interactiveProfile(profile),
        sessionId,
      );
      this.#emitSession(sessionId);
    });
  }

  setSessionTitle(sessionId: string, title: string): void {
    this.tx(() => {
      const changed =
        this.db.run(
          "UPDATE sessions SET title = ? WHERE id = ? AND deleted_at IS NULL AND title != ?",
          title,
          sessionId,
          title,
        ).changes > 0;
      if (changed) this.#emitSession(sessionId);
    });
  }

  setSessionPinned(sessionId: string, pinned: boolean): void {
    this.tx(() => {
      const changed =
        this.db.run(
          "UPDATE sessions SET pinned = ? WHERE id = ? AND deleted_at IS NULL AND pinned != ?",
          pinned ? 1 : 0,
          sessionId,
          pinned ? 1 : 0,
        ).changes > 0;
      if (changed) this.#emitSession(sessionId);
    });
  }

  // ---- imported chats (docs/importing.md) ----------------------------------------------------------------------------

  /** The import of one source chat, if one was begun. */
  importRow(source: string, sourceId: string): { session_id: string; status: "pending" | "complete" } | undefined {
    return this.db.get(
      "SELECT session_id, status FROM session_imports WHERE source = ? AND source_id = ?",
      source,
      sourceId,
    );
  }

  /** The source ids among `sourceIds` whose import finished and whose chat is still there. */
  importedSessions(source: string, sourceIds: readonly string[]): { sourceId: string; sessionId: string }[] {
    if (sourceIds.length === 0) return [];
    return this.db
      .all<{ source_id: string; session_id: string }>(
        `SELECT i.source_id, i.session_id FROM session_imports i JOIN sessions s ON s.id = i.session_id
         WHERE i.source = ? AND i.status = 'complete' AND s.deleted_at IS NULL
           AND i.source_id IN (SELECT value FROM json_each(?))`,
        source,
        JSON.stringify(sourceIds),
      )
      .map((r) => ({ sourceId: r.source_id, sessionId: r.session_id }));
  }

  /** An imported chat's session and tree, recorded as a pending import of its source chat (in one transaction). */
  beginImport(agentId: string, source: string, sourceId: string): { session: Session; treeId: string } {
    return this.tx(() => {
      const made = this.createSession(agentId, "import");
      this.db.run(
        "INSERT INTO session_imports (source, source_id, session_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
        source,
        sourceId,
        made.session.id,
        this.clock.now(),
      );
      return made;
    });
  }

  /**
   * An import whose entries are all written: the chat gets its original title, dates and pin, its uploaded files are
   * bound to their messages, and the import is complete. Answers false when the session is gone (deleted meanwhile).
   */
  finishImport(input: {
    sessionId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    pinned: boolean;
    preview: string;
    files: readonly { runId: string; attachment: Attachment }[];
  }): boolean {
    return this.tx(() => {
      if (!this.getSessionRow(input.sessionId)) return false;
      for (const { runId, attachment } of input.files) {
        this.db.run(
          "UPDATE attachments SET session_id = ? WHERE id = ? AND session_id = ''",
          input.sessionId,
          attachment.id,
        );
        this.referenceAttachments(input.sessionId, runId, [attachment]);
      }
      this.db.run(
        "UPDATE sessions SET title = ?, pinned = ?, preview = ?, created_at = ?, updated_at = ? WHERE id = ?",
        collapse(input.title).slice(0, 200) || NEW_CHAT_TITLE,
        input.pinned ? 1 : 0,
        collapse(input.preview).slice(0, 200),
        input.createdAt,
        input.updatedAt,
        input.sessionId,
      );
      this.db.run("UPDATE session_imports SET status = 'complete' WHERE session_id = ?", input.sessionId);
      this.#emitSession(input.sessionId);
      return true;
    });
  }

  #emitSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    this.events.append(GLOBAL_STREAM, { type: "session.upserted", session });
    this.viewChanged(sessionId);
  }

  // ---- read markers and unread counts ----------------------------------------------------------------------------------

  /**
   * An agent entry landed in a session's chat (a visible reply, or a trigger line): one more unread unless the read
   * marker is already past it. Recording the same item again does nothing. `emit` says session.upserted when the count
   * changed (a caller that touches the session anyway passes false).
   */
  recordAgentEntry(sessionId: string, at: number, itemId: string | null, emit = true): void {
    this.tx(() => {
      if (!this.getSessionRow(sessionId)) return;
      const added = this.db.run(
        "INSERT OR IGNORE INTO agent_entries (session_id, item_id, at) VALUES (?, ?, ?)",
        sessionId,
        itemId,
        at,
      ).changes;
      if (added === 0 || at <= (this.readMarker(sessionId)?.at ?? Number.NEGATIVE_INFINITY)) return;
      this.db.run("UPDATE sessions SET unread = unread + 1 WHERE id = ?", sessionId);
      if (emit) this.#emitSession(sessionId);
    });
  }

  readMarker(sessionId: string): ReadMarker | undefined {
    const row = this.db.get<{ item_id: string; item_at: number }>(
      "SELECT item_id, item_at FROM read_markers WHERE session_id = ?",
      sessionId,
    );
    return row ? { itemId: row.item_id, at: row.item_at } : undefined;
  }

  /**
   * Moves a session's read marker to an item the user has seen (`at` is the item's createdAt), never backwards: an
   * older item leaves it where it is. Every device hears the new unread count as session.upserted. 404 for no session.
   */
  markRead(sessionId: string, marker: ReadMarker): ReadMarkerResponse {
    return this.tx(() => {
      const row = this.getSessionRow(sessionId);
      if (!row) throw notFound("That session does not exist.");
      const current = this.readMarker(sessionId);
      if (current && current.at >= marker.at) return { marker: current, unread: row.unread };
      this.db.run(
        "INSERT OR REPLACE INTO read_markers (session_id, item_id, item_at, updated_at) VALUES (?, ?, ?, ?)",
        sessionId,
        marker.itemId,
        marker.at,
        this.clock.now(),
      );
      const unread =
        this.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_entries WHERE session_id = ? AND at > ?",
          sessionId,
          marker.at,
        )?.n ?? 0;
      if (unread !== row.unread) {
        this.db.run("UPDATE sessions SET unread = ? WHERE id = ?", unread, sessionId);
        this.#emitSession(sessionId);
      }
      return { marker, unread };
    });
  }

  /** Unread agent entries across every session, for the glance. */
  unreadTotal(): number {
    return this.db.get<{ n: number }>("SELECT COALESCE(SUM(unread), 0) AS n FROM sessions WHERE deleted_at IS NULL")!.n;
  }

  /** A line from the app (not the agent) in a session's chat: written into its Pi conversation. */
  addNotice(sessionId: string, text: string, runId: string | null = null): void {
    if (!this.getSessionRow(sessionId)) return;
    this.transcript?.notice(sessionId, text, runId);
  }

  /** A trigger's line in a chat (the agent's home chat): a notify message, a report, a failure or a self-pause. It starts no run. */
  addTriggerMessage(sessionId: string, trigger: TriggerMessage): void {
    if (!this.getSessionRow(sessionId)) return;
    this.transcript?.triggerLine(sessionId, trigger);
    this.touchSession(sessionId, collapse(trigger.text));
  }

  /** One card in a chat (an overlay: Rei data anchored to the run, and to the Pi tool task when known). */
  #addOverlay(input: {
    sessionId: string;
    kind: "approval" | "takeover" | "memory";
    refId: string;
    runId: string | null;
    taskId?: string | null;
    entryId?: string | null;
    json: unknown;
    text: string;
  }): string | undefined {
    return this.tx(() => {
      if (!this.getSessionRow(input.sessionId)) return undefined;
      const id = newId("ovl", this.clock.now());
      this.db.run(
        "INSERT INTO overlays (id, session_id, kind, ref_id, run_id, task_id, entry_id, json, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        input.sessionId,
        input.kind,
        input.refId,
        input.runId,
        input.taskId ?? null,
        input.entryId ?? null,
        JSON.stringify(input.json),
        input.text,
        this.clock.now(),
      );
      this.viewChanged(input.sessionId);
      return id;
    });
  }

  /** Rewrites the snapshot (and text) of every card that shows `refId`, and refreshes each chat's view. */
  #updateOverlays(
    kind: "approval" | "takeover" | "memory",
    refId: string,
    json: unknown,
    textFor: (sessionId: string) => string,
  ): void {
    this.tx(() => {
      const rows = this.db.all<{ id: string; session_id: string }>(
        "SELECT id, session_id FROM overlays WHERE kind = ? AND ref_id = ?",
        kind,
        refId,
      );
      for (const row of rows) {
        this.db.run(
          "UPDATE overlays SET json = ?, text = ? WHERE id = ?",
          JSON.stringify(json),
          textFor(row.session_id),
          row.id,
        );
        if (this.getSessionRow(row.session_id)) this.viewChanged(row.session_id);
      }
    });
  }

  /** Overlays of a session, oldest first. */
  overlaysFor(sessionId: string): import("../conversation/view-model.ts").OverlayRow[] {
    return this.db.all("SELECT * FROM overlays WHERE session_id = ? ORDER BY created_at, id", sessionId);
  }

  /** The card for a blocked call in a chat (one per chat that shows it). */
  addApprovalMessage(
    sessionId: string,
    runId: string | null,
    text: string,
    approval: Approval,
    taskId?: string,
  ): string | undefined {
    return this.#addOverlay({
      sessionId,
      kind: "approval",
      refId: approval.id,
      runId,
      taskId: taskId ?? null,
      json: approval,
      text,
    });
  }

  /** The card for a takeover in a chat (one per chat that shows it). */
  addTakeoverMessage(sessionId: string, runId: string | null, text: string, takeover: Takeover): string | undefined {
    return this.#addOverlay({ sessionId, kind: "takeover", refId: takeover.id, runId, json: takeover, text });
  }

  /** The chip ("Memory updated") or suggestion card in a chat; `memoryId` is the change or suggestion it shows. */
  addMemoryMessage(
    sessionId: string,
    runId: string | null,
    text: string,
    memoryId: string,
    memory: MessageMemory,
  ): string | undefined {
    return this.#addOverlay({ sessionId, kind: "memory", refId: memoryId, runId, json: memory, text });
  }

  /** Rewrites the change or suggestion in every card that shows it (undone, decided, no longer undoable). */
  updateMemoryMessages(memoryId: string, memory: MessageMemory, text: string): void {
    this.#updateOverlays("memory", memoryId, memory, () => text);
  }

  /** Rewrites the takeover snapshot in every card that shows it. */
  updateTakeoverMessages(takeover: Takeover, textFor: (sessionId: string) => string): void {
    this.#updateOverlays("takeover", takeover.id, takeover, textFor);
  }

  /** The session's browser window as last seen (null: it has none). Announced as `session.upserted` when it changed. */
  setBrowser(sessionId: string, page: { url: string; title: string } | null): void {
    this.tx(() => {
      const row = this.getSessionRow(sessionId);
      if (!row) return;
      if ((row.browser_url ?? null) === (page?.url ?? null) && (row.browser_title ?? null) === (page?.title ?? null))
        return;
      this.db.run(
        "UPDATE sessions SET browser_url = ?, browser_title = ? WHERE id = ?",
        page?.url ?? null,
        page ? page.title : null,
        sessionId,
      );
      this.#emitSession(sessionId);
    });
  }

  /** Rewrites the approval snapshot in every card that shows it. */
  updateApprovalMessages(approval: Approval, textFor: (sessionId: string) => string): void {
    this.#updateOverlays("approval", approval.id, approval, textFor);
  }

  // ---- report-back (outbox) ----------------------------------------------------------------------------------------

  pendingOutbox(kind: string): OutboxRow[] {
    return this.db.all<OutboxRow>("SELECT * FROM outbox WHERE kind = ? AND state = 'pending' ORDER BY id", kind);
  }
  outboxRow(requestId: string): OutboxRow | undefined {
    return this.db.get<OutboxRow>("SELECT * FROM outbox WHERE request_id = ?", requestId);
  }
  /**
   * Writes a notification to the outbox, once per `dedupe` key, in the caller's transaction (so it exists exactly when
   * the thing it announces does). Title and body are plain text; the body is cut to 200 characters.
   */
  queueNotify(input: {
    event: NotifyEvent;
    sessionId: string;
    messageId?: string;
    title: string;
    body: string;
    dedupe: string;
  }): void {
    const flat = (t: string, max: number) => {
      const text = t.replace(/\s+/g, " ").trim();
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    };
    const payload: NotifyPayload = {
      event: input.event,
      sessionId: input.sessionId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      title: flat(input.title, 80),
      body: flat(input.body, 200),
      path: input.sessionId ? `#/s/${input.sessionId}` : "#/",
    };
    const session = this.getSessionRowAny(input.sessionId);
    this.db.run(
      "INSERT OR IGNORE INTO outbox (request_id, tree_id, session_id, kind, payload, state, created_at) VALUES (?, ?, ?, 'notify', ?, 'pending', ?)",
      `notify:${input.event}:${input.dedupe}`,
      session?.tree_id ?? null,
      input.sessionId,
      JSON.stringify(payload),
      this.clock.now(),
    );
    this.afterCommit(() => this.onNotifyQueued?.());
  }

  /** Writes a line for an agent's home conversation to the outbox, once per `requestId`, in the caller's transaction (so it exists exactly when the thing it tells of does). */
  queueHomeNote(input: { sessionId: string; requestId: string; text: string; trigger?: TriggerMessage }): void {
    const session = this.getSessionRowAny(input.sessionId);
    this.db.run(
      "INSERT OR IGNORE INTO outbox (request_id, tree_id, session_id, kind, payload, state, created_at) VALUES (?, ?, ?, 'home_note', ?, 'pending', ?)",
      input.requestId,
      session?.tree_id ?? null,
      input.sessionId,
      JSON.stringify({
        sessionId: input.sessionId,
        requestId: input.requestId,
        text: input.text,
        ...(input.trigger ? { trigger: input.trigger } : {}),
      }),
      this.clock.now(),
    );
  }

  /**
   * An input for a session's conversation, queued in the caller's transaction (an approval's or a takeover's notice, a
   * trigger's brief) and admitted into Pi right after the commit (again at start until it is). Idempotent by `requestId`.
   * Its run counts as queued from the commit on.
   */
  queueAdmission(input: QueuedAdmission): { runId: string; messageId: string } {
    const key = `admit:${input.requestId}`;
    const existing = this.outboxRow(key);
    if (existing) {
      const runId = (JSON.parse(existing.payload) as { runId?: string }).runId ?? "";
      return { runId, messageId: userItemId(runId) };
    }
    const session = this.getSessionRow(input.sessionId);
    if (!session) throw notFound("That session does not exist.");
    const now = this.clock.now();
    const runId = newId("run", now);
    const payload: QueuedAdmission & { runId: string } = { ...input, runId };
    this.db.run(
      "INSERT INTO outbox (request_id, tree_id, session_id, kind, payload, state, created_at) VALUES (?, ?, ?, 'admit', ?, 'pending', ?)",
      key,
      session.tree_id,
      session.id,
      JSON.stringify(payload),
      now,
    );
    this.afterCommit(() => {
      this.#registerQueued(session, payload, now);
      this.onAdmitQueued?.();
    });
    return { runId, messageId: userItemId(runId) };
  }

  #registerQueued(session: SessionRow, payload: QueuedAdmission & { runId: string }, createdAt: number): void {
    if (this.runs.get(payload.runId)) return;
    this.runs.put(
      outboxRun({
        runId: payload.runId,
        treeId: session.tree_id,
        sessionId: session.id,
        requestId: payload.requestId,
        role: payload.role,
        createdAt,
        ...(payload.assignedBy ? { assignedBy: payload.assignedBy } : {}),
        ...(payload.triggerRunId ? { triggerRunId: payload.triggerRunId } : {}),
      }),
    );
    this.touchSession(session.id);
  }

  /** Pending queued admissions, oldest first; their runs are registered as queued (at start). */
  pendingAdmissions(): { row: OutboxRow; admission: QueuedAdmission & { runId: string } }[] {
    return this.pendingOutbox("admit").map((row) => {
      const admission = JSON.parse(row.payload) as QueuedAdmission & { runId: string };
      const session = this.getSessionRow(admission.sessionId);
      if (session) this.#registerQueued(session, admission, row.created_at);
      return { row, admission };
    });
  }

  /** A queued admission was cancelled (or its session went away) before it reached Pi. */
  dropQueuedAdmission(runId: string): void {
    const run = this.runs.get(runId);
    for (const row of this.pendingOutbox("admit"))
      if ((JSON.parse(row.payload) as { runId?: string }).runId === runId) this.finishOutbox(row.id, "dropped");
    if (run?.outbox) {
      this.runs.dropRun(runId);
      this.touchSession(run.session_id);
    }
  }

  /** Ends an outbox row: delivered, or dropped when what it was for is gone. */
  finishOutbox(id: number, state: "delivered" | "dropped"): void {
    this.db.run(
      "UPDATE outbox SET state = ?, delivered_at = ?, payload = CASE WHEN ? = 'dropped' THEN '{}' ELSE payload END WHERE id = ? AND state = 'pending'",
      state,
      this.clock.now(),
      state,
      id,
    );
  }

  bumpOutboxAttempts(id: number): void {
    this.db.run("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?", id);
  }

  /**
   * The report one outbox row carries, and the parent it is for; a parent that no longer exists drops the row. The
   * caller admits it into the parent's conversation (idempotent by the row's request id), then `reportDelivered`.
   */
  reportToDeliver(row: OutboxRow): { parent: SessionRow; report: SessionReport } | undefined {
    return this.tx(() => {
      const fresh = this.db.get<OutboxRow>("SELECT * FROM outbox WHERE id = ?", row.id);
      if (fresh?.state !== "pending") return undefined;
      const payload = JSON.parse(fresh.payload) as { parentId?: string; report?: SessionReport };
      const parent = payload.parentId ? this.getSessionRow(payload.parentId) : undefined;
      if (!parent || !payload.report) {
        this.db.run("UPDATE outbox SET state = 'dropped', payload = '{}' WHERE id = ?", fresh.id);
        return undefined;
      }
      return { parent, report: payload.report };
    });
  }

  /** The report is in the parent's conversation: the parent gains the child's taint, and the row is done. */
  reportDelivered(row: OutboxRow, parentId: string, report: SessionReport, reportRunId?: string): void {
    this.tx(() => {
      // What the child read, the parent now knows: it gains the child's taint labels.
      const child = this.getSessionRowAny(report.sessionId);
      if (child) this.addTaint(parentId, JSON.parse(child.taint) as TaintLabel[]);
      if (reportRunId) {
        const moved = this.db.run(
          `UPDATE overlays SET run_id = ? WHERE session_id = ? AND kind = 'approval' AND run_id IS NULL
           AND ref_id IN (SELECT id FROM approvals WHERE session_id = ? AND run_id = ?
                          AND (group_id IS NOT NULL OR tool_task_id IS NOT NULL))`,
          reportRunId,
          parentId,
          report.sessionId,
          row.request_id.slice("report:".length),
        ).changes;
        if (moved) this.viewChanged(parentId);
      }
      this.db.run(
        "UPDATE outbox SET state = 'delivered', delivered_at = ? WHERE id = ? AND state = 'pending'",
        this.clock.now(),
        row.id,
      );
    });
  }

  /** The sandbox whitelist (Whitelist agents reach it without asking): the user's list, or the defaults until one is saved. */
  sandboxWhitelist(): string[] {
    const saved = this.metaGet(SANDBOX_WHITELIST_KEY);
    if (saved === undefined) return [...DEFAULT_SANDBOX_WHITELIST];
    try {
      const parsed = JSON.parse(saved) as unknown;
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed;
    } catch {
      // a value this build cannot read is treated as unsaved
    }
    return [...DEFAULT_SANDBOX_WHITELIST];
  }
  /** Saves the whitelist, or with null restores the defaults (by forgetting the saved list). */
  setSandboxWhitelist(entries: readonly string[] | null): void {
    this.metaSet(SANDBOX_WHITELIST_KEY, entries === null ? null : JSON.stringify(entries));
  }
  /** The sandbox network mode of the agent that owns a tree (ask when there is no such agent). */
  networkModeOfTree(treeId: string): SandboxNetworkMode {
    const owner = this.db.get<{ agent_id: string }>("SELECT agent_id FROM sessions WHERE tree_id = ? LIMIT 1", treeId);
    return (owner ? this.getAgent(owner.agent_id)?.networkMode : undefined) ?? "block";
  }

  /** A small key-value store for single settings (the default agent, how chats are titled). */
  metaGet(key: string): string | undefined {
    return this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }
  metaSet(key: string, value: string | null): void {
    if (value === null) this.db.run("DELETE FROM meta WHERE key = ?", key);
    else this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }
  /** Whether the first-time setup dialog is switched off for this instance ("Don't show again"). Lives with the data, not the browser. */
  firstTimeSetupDismissed(): boolean {
    return this.metaGet("first_time_setup_dismissed") === "1";
  }
  setFirstTimeSetupDismissed(dismissed: boolean): void {
    this.metaSet("first_time_setup_dismissed", dismissed ? "1" : "0");
  }

  /** What chat titles read once a run settled (kept briefly in memory; Pi holds the text itself). */
  readonly #titleSources = new Map<string, { sessionId: string; user: string; reply: string }>();

  /**
   * What a better title for a chat can be made from, once its first run has completed: the chat is one you started, this run
   * answered its first message, and it still has the title that message gave it (so nothing has renamed it since).
   */
  titleSource(runId: string): { sessionId: string; current: string; user: string; reply: string } | undefined {
    const source = this.#titleSources.get(runId);
    this.#titleSources.delete(runId);
    const session = source ? this.getSessionRow(source.sessionId) : undefined;
    if (!source || !session || session.origin !== "user") return undefined;
    if (session.title !== (collapse(source.user).slice(0, 60) || NEW_CHAT_TITLE)) return undefined;
    return { sessionId: session.id, current: session.title, user: source.user, reply: source.reply };
  }
  /** Gives a chat a generated title, only if it still has `from` (nothing changed it meanwhile). */
  setGeneratedTitle(sessionId: string, from: string, to: string): boolean {
    return this.tx(() => {
      const changed =
        this.db.run("UPDATE sessions SET title = ? WHERE id = ? AND title = ?", to, sessionId, from).changes > 0;
      if (changed) this.#emitSession(sessionId);
      return changed;
    });
  }

  /**
   * A run ended in Pi (its submission settled): Rei's effects of that, in one transaction, idempotent (the caller marks
   * the run settled in the ledger afterwards, so a crash in between runs them again and their keys dedupe them).
   * `input` is what started the run, `reply` the reply as the view shows it.
   */
  settleRun(
    run: RunRow,
    input: {
      role: string;
      text: string;
      trigger?: TriggerMessage;
      report?: SessionReport;
      firstUser?: boolean;
      fromSession?: boolean;
      createdAt?: number;
    },
    reply: { text: string; parts?: MessagePart[]; attachments?: Attachment[] } | undefined,
  ): void {
    this.tx(() => {
      const status = run.status;
      if (status !== "completed" && status !== "failed" && status !== "cancelled") return;
      const error = runError(run);
      const now = this.clock.now();
      const session = this.getSessionRowAny(run.session_id);
      if (!session) return;
      this.db.run("UPDATE sessions SET last_run_status = ? WHERE id = ?", status, session.id);
      // A tool call that never got a result (the run was cancelled or failed under it) is closed with the run.
      this.db.run(
        "UPDATE steps SET status = 'cancelled', latency_ms = ? - started_at WHERE run_id = ? AND type = 'tool.call' AND status = 'running'",
        now,
        run.id,
      );
      // So is a model call whose stream a restart cut off (Pi made the call again): it ended without a response.
      this.db.run(
        "UPDATE steps SET status = 'error', error_code = 'interrupted', latency_ms = ? - started_at WHERE run_id = ? AND type = 'llm.call' AND status = 'running'",
        now,
        run.id,
      );
      const body = reply ? replyText(reply.text, reply.parts).trim() : "";
      const eventRun = session.origin === "home" && (input.role === "report" || input.role === "trigger");
      const shown = status === "completed" && !run.silent;
      if (shown && input.role === "trigger" && input.trigger && body) {
        const trigger = input.trigger;
        const event =
          trigger.kind === "failed"
            ? "trigger_failed"
            : trigger.kind === "paused"
              ? "trigger_paused"
              : "trigger_report";
        this.queueNotify({
          event,
          sessionId: session.id,
          messageId: replyItemId(run.id),
          title: trigger.triggerName,
          body,
          dedupe: `${run.request_id}:reply`,
        });
      }
      if (shown && input.role === "report" && input.report && body)
        this.queueNotify({
          event: "session_done",
          sessionId: session.id,
          messageId: replyItemId(run.id),
          title: input.report.title,
          body,
          dedupe: `${run.request_id}:reply`,
        });
      const preview = (!eventRun || shown) && !run.silent && body ? collapse(body) : undefined;
      if (status === "completed" && input.firstUser && reply)
        this.#titleSources.set(run.id, { sessionId: session.id, user: input.text, reply: body });
      if (run.trigger_run_id) {
        // The trigger run's outcome is that of its latest Pi run (kept here: the transcript is Pi's, the tree may close).
        this.db.run(
          "UPDATE trigger_runs SET last_run_id = ?, last_run_status = ?, last_error_code = ?, last_error_message = ?, last_reply = ? WHERE id = ?",
          run.id,
          status,
          error?.code ?? null,
          error?.message ?? null,
          status === "completed" ? body : null,
          run.trigger_run_id,
        );
        this.afterCommit(() => this.onTriggerRunFinished?.(run.trigger_run_id!));
      }
      if (status === "completed" && run.answer_entry_id) {
        const model = this.db.get<{ provider: string; model: string }>(
          "SELECT provider,model FROM steps WHERE run_id=? AND type='llm.call' AND provider IS NOT NULL AND model IS NOT NULL ORDER BY started_at DESC,rowid DESC LIMIT 1",
          run.id,
        );
        const eligible =
          run.kind === "input" &&
          run.direct === 1 &&
          run.assigned_by === null &&
          run.trigger_run_id === null &&
          run.cancel_requested === 0 &&
          run.role === "user" &&
          input.role === "user" &&
          !input.fromSession &&
          USER_CHAT_ORIGINS.includes(session.origin);
        this.db.run(
          "INSERT OR IGNORE INTO lifecycle_outbox(id,kind,session_id,agent_id,run_id,cut_entry_id,input_entry_id,eligible,provider,model,created_at) VALUES(?,'run.completed',?,?,?,?,?,?,?,?,?)",
          `run.completed:${run.id}`,
          session.id,
          session.agent_id,
          run.id,
          run.answer_entry_id,
          run.entry_id,
          eligible ? 1 : 0,
          model?.provider ?? null,
          model?.model ?? null,
          run.ended_at ?? now,
        );
      }
      if (status === "completed")
        this.afterCommit(() => {
          this.onRunFinished?.(run.id);
          for (const listener of this.#runFinishedListeners) {
            try {
              listener(run.id, {
                role: input.role,
                text: input.text,
                fromSession: input.fromSession === true,
                createdAt: input.createdAt ?? run.created_at,
              });
            } catch {
              /* Background observers cannot interfere with a completed reply. */
            }
          }
        });
      // A failed run reports to nobody: the work is not finished, and Continue takes it (and its assignment) up again.
      if (status !== "failed") {
        if (run.assigned_by) this.#queueReport(run, status, run.assigned_by, reply, body);
        else if (run.direct === 0) {
          // A reaction in a spawned session that proposed memory edits: they must not wait for a report that may never come,
          // so this run reports to the session's parent too (that is how a suggestion climbs a level).
          const hasPending =
            this.db.get(
              "SELECT 1 AS x FROM memory_suggestions WHERE session_id = ? AND status = 'pending' LIMIT 1",
              run.session_id,
            ) !== undefined;
          if (session.origin === "spawned" && session.parent_session_id && hasPending)
            this.#queueReport(run, status, session.parent_session_id, reply, body);
        }
      }
      if (status === "completed" && preview !== undefined)
        this.recordAgentEntry(session.id, run.started_at, replyItemId(run.id), false);
      this.touchSession(session.id, preview);
      this.viewChanged(session.id);
    });
  }

  /** The report to the parent is written in the same transaction as Rei's settlement of the run; a deliverer sends it. */
  #queueReport(
    run: RunRow,
    outcome: "completed" | "cancelled",
    parentId: string,
    reply: { attachments?: Attachment[] } | undefined,
    body: string,
  ): void {
    const child = this.getSessionRow(run.session_id); // a session being deleted no longer reports
    const parent = this.getSessionRow(parentId);
    if (!child || !parent) return;
    const summary = outcome === "completed" ? body.slice(0, SESSION_REPORT_INLINE_MAX) : "";
    // A continue's answer is shown as the reply to the input it went on with, so that is the message to read.
    const answered = run.kind === "continue" ? inputAnsweredBy(this.runs.forSession(run.session_id), run) : undefined;
    const report: SessionReport = {
      sessionId: child.id,
      title: child.title,
      outcome,
      summary,
      ...(outcome === "completed" && body.trim() !== ""
        ? { resultId: replyItemId(answered?.id ?? run.id), resultChars: body.length }
        : {}),
      ...(reply?.attachments?.length ? { files: reply.attachments } : {}),
    };
    // Memory edits this session proposed ride on its report, and are marked reported in the same transaction.
    const pending = this.db.all<SuggestionRow>(
      "SELECT * FROM memory_suggestions WHERE session_id = ? AND status = 'pending' ORDER BY seq",
      child.id,
    );
    if (pending.length > 0) {
      const now = this.clock.now();
      this.db.run(
        "UPDATE memory_suggestions SET status = 'reported', reported_at = ? WHERE session_id = ? AND status = 'pending'",
        now,
        child.id,
      );
      report.memorySuggestions = pending.map((r) => toSuggestion({ ...r, status: "reported", reported_at: now }));
    }
    this.db.run(
      "INSERT OR IGNORE INTO outbox (request_id, tree_id, session_id, kind, payload, state, created_at) VALUES (?, ?, ?, 'report', ?, 'pending', ?)",
      `report:${run.id}`,
      child.tree_id,
      child.id,
      JSON.stringify({ parentId: parent.id, report }),
      this.clock.now(),
    );
    this.afterCommit(() => this.onReportQueued?.());
  }

  // ---- deleting sessions (crash-safe: a job row is written with the hiding, removed when the purge is done) ----------

  /**
   * Hides the sessions at once (their lists and streams say `session.removed`), detaches what they spawned, drops
   * reports addressed to them, and records the job that finishes the deletion. Returns the job id.
   */
  beginDeletion(input: { sessionIds: string[]; treeId: string; removeTree: boolean }): string {
    return this.tx(() => {
      const now = this.clock.now();
      const jobId = newId("del", now);
      const ids = input.sessionIds;
      for (const id of ids) {
        this.db.run("UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", now, id);
        this.db.run(
          "UPDATE background_jobs SET status=CASE WHEN status IN ('queued','running','failed') THEN 'cancelled' ELSE status END,fence=fence+1,diagnostic='SOURCE_DELETED',payload='{}',result=NULL,session_id=NULL,dedupe='deleted:'||id,finished_at=COALESCE(finished_at,?) WHERE session_id=?",
          now,
          id,
        );
        this.db.run("DELETE FROM memory_review_sources WHERE session_id=?", id);
        this.db.run("DELETE FROM memory_review_state WHERE session_id=?", id);
        this.db.run(
          "DELETE FROM lifecycle_deliveries WHERE event_id IN (SELECT id FROM lifecycle_outbox WHERE session_id=? AND kind='run.completed')",
          id,
        );
        this.db.run("DELETE FROM lifecycle_outbox WHERE session_id=? AND kind='run.completed'", id);
        this.db.run(
          "INSERT OR IGNORE INTO lifecycle_outbox(id,kind,session_id,agent_id,created_at) SELECT ?,'session.deleting',id,agent_id,? FROM sessions WHERE id=?",
          `session.deleting:${id}`,
          now,
          id,
        );
        this.events.append(GLOBAL_STREAM, { type: "background.changed" });
        this.db.run(
          "DELETE FROM memory_review_jobs WHERE source_run_id IN (SELECT run_id FROM memory_review_turns WHERE session_id=?)",
          id,
        );
        this.db.run("DELETE FROM memory_review_turns WHERE session_id=?", id);
        this.events.append(GLOBAL_STREAM, { type: "session.removed", sessionId: id });
        this.events.append(sessionStream(id), { type: "session.removed", sessionId: id });
      }
      for (const id of ids) {
        for (const child of this.childrenOf(id)) {
          this.db.run("UPDATE sessions SET parent_session_id = NULL WHERE id = ?", child.id);
          this.touchSession(child.id);
        }
        this.db.run(
          "UPDATE outbox SET state = 'dropped', payload = '{}' WHERE kind = 'report' AND state = 'pending' AND json_extract(payload, '$.parentId') = ?",
          id,
        );
      }
      this.db.run(
        "INSERT INTO deletion_jobs (id, tree_id, session_ids, remove_tree, blob_refs, created_at) VALUES (?, ?, ?, ?, '[]', ?)",
        jobId,
        input.treeId,
        JSON.stringify(ids),
        input.removeTree ? 1 : 0,
        now,
      );
      return jobId;
    });
  }

  deletionJobs(): DeletionJob[] {
    return this.db
      .all<{ id: string; tree_id: string; session_ids: string; remove_tree: number; blob_refs: string }>(
        "SELECT * FROM deletion_jobs ORDER BY created_at, id",
      )
      .map((r) => ({
        id: r.id,
        tree_id: r.tree_id,
        sessionIds: JSON.parse(r.session_ids) as string[],
        removeTree: r.remove_tree === 1,
        blobRefs: JSON.parse(r.blob_refs) as string[],
      }));
  }

  /**
   * Removes everything the app store holds about the job's sessions: trace steps, cards, outbox rows and the text of
   * their rows (the transcript goes with the Pi conversation). Idempotent. Returns the blob refs no other step uses (the job keeps
   * them until the files are gone).
   */
  purgeSessions(jobId: string): string[] {
    return this.tx(() => {
      const job = this.deletionJobs().find((j) => j.id === jobId);
      if (!job) return [];
      const refs = new Set(job.blobRefs);
      for (const id of job.sessionIds) {
        for (const r of this.db.all<{ payload_blob: string | null; response_blob: string | null }>(
          "SELECT payload_blob, response_blob FROM steps WHERE (payload_blob IS NOT NULL OR response_blob IS NOT NULL) AND session_id = ?",
          id,
        )) {
          if (r.payload_blob) refs.add(r.payload_blob);
          if (r.response_blob) refs.add(r.response_blob);
        }
        for (const r of this.db.all<{ blob: string }>(
          "SELECT blob FROM step_images WHERE step_id IN (SELECT id FROM steps WHERE session_id = ?)",
          id,
        )) {
          refs.add(r.blob);
        }
        this.db.run("DELETE FROM skill_uses WHERE run_id IN (SELECT run_id FROM steps WHERE session_id = ?)", id);
        this.db.run("DELETE FROM step_images WHERE step_id IN (SELECT id FROM steps WHERE session_id = ?)", id);
        this.db.run("DELETE FROM steps WHERE session_id = ?", id);
        this.db.run("DELETE FROM agent_entries WHERE session_id = ?", id);
        this.db.run("DELETE FROM read_markers WHERE session_id = ?", id);
        this.db.run("DELETE FROM attachment_refs WHERE session_id = ?", id);
        this.db.run("DELETE FROM overlays WHERE session_id = ?", id);
        this.db.run("DELETE FROM manual_compactions WHERE session_id = ?", id);
        // Every version's record goes; their history rows go with memoryHooks.purgeSession (by session).
        this.db.run("DELETE FROM session_branches WHERE session_id = ?", id);
        // An imported chat that is deleted can be imported again.
        this.db.run("DELETE FROM session_imports WHERE session_id = ?", id);
        this.db.run("DELETE FROM outbox WHERE session_id = ?", id);
        this.db.run("DELETE FROM approvals WHERE session_id = ?", id);
        this.db.run("DELETE FROM web_documents WHERE session_id = ?", id);
        this.db.run("DELETE FROM web_calls WHERE session_id = ?", id);
        this.db.run(
          "DELETE FROM takeover_acts WHERE takeover_id IN (SELECT id FROM takeovers WHERE session_id = ?)",
          id,
        );
        this.db.run("DELETE FROM takeovers WHERE session_id = ?", id);
        this.db.run(
          "INSERT OR IGNORE INTO lifecycle_outbox(id,kind,session_id,agent_id,created_at) SELECT ?,'session.deleted',id,agent_id,? FROM sessions WHERE id=?",
          `session.deleted:${id}`,
          this.clock.now(),
          id,
        );
        this.db.run(
          "UPDATE sessions SET title = '', preview = '', browser_url = NULL, browser_title = NULL WHERE id = ?",
          id,
        );
        this.memoryHooks?.purgeSession(id);
        this.runs.dropSession(id);
      }
      this.memoryHooks?.afterPurge();
      const free = [...refs].filter(
        (ref) =>
          this.db.get("SELECT 1 AS x FROM steps WHERE payload_blob = ? OR response_blob = ? LIMIT 1", ref, ref) ===
            undefined && this.db.get("SELECT 1 AS x FROM step_images WHERE blob = ? LIMIT 1", ref) === undefined,
      );
      this.db.run("UPDATE deletion_jobs SET blob_refs = ? WHERE id = ?", JSON.stringify(free), jobId);
      return free;
    });
  }

  finishDeletionJob(jobId: string): void {
    this.db.run("DELETE FROM deletion_jobs WHERE id = ?", jobId);
    this.db.checkpoint?.();
  }

  /** Recomputes status, bumps updatedAt, optionally sets the preview, and emits `session.upserted` on both streams. */
  touchSession(sessionId: string, preview?: string): void {
    const row = this.getSessionRow(sessionId);
    if (!row) return;
    const active = this.runs.nonTerminal(sessionId).length;
    const approvals = this.db.get<{ n: number; checkpoint: number | null }>(
      `SELECT COUNT(*) AS n, MAX(group_id IS NOT NULL OR tool_task_id IS NOT NULL) AS checkpoint
       FROM approvals WHERE session_id = ? AND status = 'pending'`,
      sessionId,
    );
    const pending = approvals?.n ?? 0;
    // The agent asked you to take over the browser: also waiting for you (an active takeover is you working, not waiting).
    const asked =
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM takeovers WHERE session_id = ? AND status = 'pending'",
        sessionId,
      )?.n ?? 0;
    let status: SessionStatus = "idle";
    if (approvals?.checkpoint) status = "waiting_for_user";
    else if (active > 0) status = "running";
    else if (pending > 0 || asked > 0) status = "waiting_for_user";
    else {
      const last = row.last_run_status;
      // A spawned or trigger session shows how its last run ended; the other kinds go back to idle (a failure stays visible).
      if (last === "failed") status = "failed";
      else if ((row.origin === "spawned" || row.origin === "trigger") && (last === "completed" || last === "cancelled"))
        status = last;
    }
    this.db.run(
      "UPDATE sessions SET status = ?, pending_approvals = ?, updated_at = ?, preview = ? WHERE id = ?",
      status,
      pending,
      this.clock.now(),
      preview === undefined ? row.preview : preview.slice(0, 200),
      sessionId,
    );
    const session = this.getSession(sessionId)!;
    this.events.append(GLOBAL_STREAM, { type: "session.upserted", session });
    this.viewChanged(sessionId);
  }
}
