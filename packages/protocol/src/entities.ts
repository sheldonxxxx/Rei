import type { SessionBrowser, Takeover } from "./browser.ts";
import type { FileReference } from "./library.ts";
import type { MemorySuggestion, MessageMemory } from "./memory.ts";
import type { SandboxNetworkMode } from "./network.ts";
import type { PluginPreview } from "./plugins.ts";
import type { SkillPreview } from "./skills.ts";
import type { MessagePart, SurfaceActionRef } from "./surfaces.ts";
import type { ThinkingLevel } from "./thinking.ts";
import type { TriggerId, TriggerMessage, TriggerPreview } from "./triggers.ts";

// Product entities as the PWA sees them. The app store is the record of the product; Pi Durable
// is the record of the conversation. Ids are opaque strings, never reused. Times are epoch milliseconds.

export type AgentId = string;
export type SessionId = string;
export type RunId = string;
export type StepId = string;
export type MessageId = string;
export type ApprovalId = string;
export type GrantId = string;

export interface Agent {
  id: AgentId;
  name: string;
  /**
   * How the agent looks (the floating assistant in the browser view, the sidebar, the chat header). One of:
   * - `bot:<id>`: a built-in bot drawn by the PWA (AGENT_BOT_AVATARS); an id the PWA doesn't know shows the default bot
   * - `data:image/png|jpeg|webp;base64,...`: your own picture, at most AVATAR_IMAGE_MAX_CHARS (the PWA resizes to 128 px)
   * - anything else: an emoji or a short text badge, at most 8 characters
   */
  avatar: string;
  /**
   * The model the agent thinks with, chosen by the user (a model id as the gateway knows it, e.g. "gpt-6.1-sol").
   * Null: no choice made, the server uses its default model (GET /api/models says which).
   */
  model: string | null;
  /** Reasoning effort for this agent's replies. Off preserves the provider's default behavior. */
  thinkingLevel: ThinkingLevel;
  /** What the agent's sandbox may reach outside (see SandboxNetworkMode). */
  networkMode: SandboxNetworkMode;
  /** The profile new sessions of this agent start with. */
  defaultProfile: ProfileName;
  /** Null or omitted allows all connectors; an empty list disables connector use. */
  allowedConnectorIds?: string[] | null;
  /** Whether this agent can create triggers assigned to another agent. Defaults to false. */
  canCreateTriggersForOtherAgents?: boolean;
  /** The agent's pinned home chat (the "Dot"). */
  homeSessionId: SessionId;
}

// ---- policy --------------------------------------------------------------

/**
 * What an action does, declared by every tool:
 * - read_internal: memory, history, sandbox files
 * - read_external: web pages, MCP output, email reads (adds the "external" taint label)
 * - write_internal: sandbox files, drafts, managing your own sessions
 * - write_external: reversible writes outside, e.g. a calendar event or a to-do
 * - send: send or publish, e.g. email, a message, a post, a form
 * - irreversible: purchases, payments, deletes, account or security settings, accepting terms
 * - credentials: logins, 2FA, CAPTCHAs (always a takeover; the agent never types a secret)
 */
/**
 * memory_write: an edit of profile.md from a chat you are in. Allowed, except that a session that read outside
 * content asks first in strict chats, so a planted instruction can't write itself into every future conversation.
 */
/**
 * configure: making or changing what runs without you, or what future runs follow: creating, editing or deleting a
 * trigger, saving a skill. The approval card shows what would be set up when approval is required.
 */
export type ActionClass =
  | "read_internal"
  | "read_external"
  | "write_internal"
  | "write_external"
  | "send"
  | "irreversible"
  | "credentials"
  | "memory_write"
  | "configure";

/**
 * - strict: ask for outside reads and effects
 * - standard (default): allow routine research, reversible writes and memory edits in interactive chats
 * - relaxed: legacy profile retained for unattended runs and older clients
 * - yolo: allow built-in actions automatically except credential entry, which uses takeover
 */
export type ProfileName = "strict" | "standard" | "relaxed" | "yolo";

/** external: the session read outside content. private: it read your private data. Labels never come off a session. */
export type TaintLabel = "external" | "private";

/**
 * How long an approval's grant lasts. "once" matches only the exact call that was approved. "trigger" (offered only
 * in a trigger's run): adds the tool (and destination) to that trigger's allow list instead of making a grant.
 * "web_session" covers public web research in this chat.
 */
export type GrantLength = "once" | "session" | "web_session" | "agent" | "hours" | "always" | "trigger";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

/** Provider identity and claimed effect shown on an MCP read-consent card. */
export interface McpProviderPreview {
  kind: "mcp-provider";
  connectorId: string;
  connectorName: string;
  url: string;
  tool: string;
  claimedReadOnly: boolean;
  actionClass?: ActionClass;
  mcpProfile?: "always_ask" | "read_only" | "read_write" | "yolo";
}

/** A blocked call waiting for you (D28: the call is blocked, nothing is in flight while this is pending). */
export interface Approval {
  id: ApprovalId;
  /** The short number the agent uses for it ("#3"); unique for you, counting up. */
  number: number;
  sessionId: SessionId;
  /** The session's title when the call was blocked. */
  sessionTitle: string;
  agentId: AgentId;
  tool: string;
  /** e.g. "demo", "email"; with `operation` it names what a grant covers. */
  connector: string;
  operation: string;
  actionClass: ActionClass;
  /** Who or where the action goes to, when it has one (an address, a host, a calendar). */
  destination: string | null;
  /** One line for the card, written by the tool, e.g. `Send "Lunch?" to ana@example.com`. */
  summary: string;
  /** The exact arguments as pretty JSON, at most 4,000 characters (cut with "…"). */
  argsPreview: string;
  /** Structured trigger, skill or MCP provider context, computed when the call was blocked. */
  preview?: TriggerPreview | SkillPreview | PluginPreview | McpProviderPreview;
  /** The session's taint labels when the call was blocked. */
  taint: TaintLabel[];
  /** The grant lengths you may choose; always includes "once". */
  lengths: GrantLength[];
  status: ApprovalStatus;
  /** Reads requested in the same tool round can be decided together. */
  groupId?: string;
  /** A single approval that resumes the tool task in its original run. */
  resumesTool?: boolean;
  /**
   * Set when a script asked for it: the tool call ID of the `codemode` call whose script made this nested call. The
   * card belongs under that call's row.
   */
  parentCallId?: string;
  /** Why a cancelled approval was withdrawn, when it was not the user: "script_ended" (the script that asked ended). */
  cancelReason?: "script_ended";
  /** Execution of a checkpointed call is independent of the user's decision. */
  execution?: "ran" | "failed" | "needs_approval" | "interrupted";
  /** Set once approved. */
  grantLength?: GrantLength;
  /** Set when approved for "hours": when that grant ends. */
  grantExpiresAt?: number;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

/** Permission to run an operation or use public web research without asking. */
export interface Grant {
  id: GrantId;
  connector: string;
  operation: string;
  /** Null when the operation has no destination. */
  destination: string | null;
  length: Exclude<GrantLength, "once" | "trigger">;
  /** For "session" and "web_session": the session; for "agent": the agent. */
  sessionId: SessionId | null;
  agentId: AgentId | null;
  /** For "hours". */
  expiresAt: number | null;
  /** The approval it came from. */
  approvalId: ApprovalId;
  createdAt: number;
}

/**
 * How a session started:
 * - home: an agent's pinned home chat
 * - user: New chat
 * - spawned: an agent called start_session; it reports back to `parentSessionId`
 * - fork: Branch in new chat, from `forkedFrom`
 * - trigger: a trigger run
 * - import: a past conversation brought in from another app (docs/importing.md); you can continue it like a chat you started
 */
export type SessionOrigin = "home" | "user" | "spawned" | "trigger" | "fork" | "import";

/**
 * - running: a run is in progress or queued
 * - idle: nothing to do (home, user and fork chats)
 * - completed / failed / cancelled: a spawned session's outcome of the last run its parent asked for
 * - waiting_for_user: an approval is pending, or the agent asked you to take over the browser
 */
export type SessionStatus = "idle" | "running" | "waiting_for_user" | "completed" | "failed" | "cancelled";

export interface ForkPoint {
  sessionId: SessionId;
  /**
   * The message the fork was taken at. A branch holds the conversation up to and including it; an edit or retry
   * (`edited`) holds it up to just before this user message.
   */
  messageId: MessageId;
  /** Legacy: set on forks taken at a step before step forking was removed; kept so those chats still say so. */
  stepId?: string;
  /** Edit or Retry of one of your messages. */
  edited?: boolean;
  /** With `edited`: the text was sent unchanged (Retry). */
  retried?: boolean;
  /** The source message is on an inactive version of the source chat. */
  onAnotherVersion?: boolean;
}

export interface Session {
  id: SessionId;
  agentId: AgentId;
  origin: SessionOrigin;
  /** Whether the user pinned this session in the sidebar. */
  pinned: boolean;
  /** Set from the first user message until a real title exists; never empty. */
  title: string;
  status: SessionStatus;
  /** Plain text of the last message, at most 200 characters. */
  preview: string;
  /** The session whose agent started this one (origin "spawned"). Null otherwise, or when that session was deleted. */
  parentSessionId: SessionId | null;
  /** Set for origin "fork". */
  forkedFrom: ForkPoint | null;
  /** 0 for home, user and fork chats; a spawned session is one deeper than its parent. */
  depth: number;
  profile: ProfileName;
  taint: TaintLabel[];
  /** Approvals waiting in this session. While above 0 the status is "waiting_for_user" unless a run is going. */
  pendingApprovals: number;
  /** Agent entries (visible replies, trigger lines) after the read marker every device shares. */
  unread: number;
  /** The session's browser window, when it has one. */
  browser: SessionBrowser | null;
  /** For origin "trigger", the trigger (null once it is deleted). Trigger sessions stay out of the main list unless they need you or failed. */
  triggerId?: TriggerId | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * - user: input to the agent. Usually typed by you; `from` is set when another session's agent wrote it (a brief from
 *   start_session, or message_session).
 * - assistant: the agent's reply
 * - report: a spawned session finished; it is also the input of the run in which this chat's agent reacts to it
 * - approval: a blocked call waiting for you, or what became of it; `approval` holds it and the message is upserted as
 *   it changes. It also shows in the chat that spawned the session (same approval, its own message there).
 * - notice: a line from the app, not the agent (e.g. "You changed the profile to Relaxed"); `text` holds it
 * - takeover: the agent asked you to take over the browser, or you did; `takeover` holds it and the message is upserted
 *   as it changes
 * - trigger: a trigger's line in the agent's home chat: a notify message, a report, a failure or a self-pause;
 *   `trigger` holds it. It starts no run.
 */
/**
 * `compaction` and `reset` are transcript markers: earlier messages were summarized, or a new context started. They
 * carry no model text to the client.
 */
export type MessageRole =
  | "user"
  | "assistant"
  | "report"
  | "approval"
  | "notice"
  | "takeover"
  | "memory"
  | "trigger"
  | "compaction"
  | "reset";

/** Another session's agent, as the author of a user-role message. */
export interface MessageSender {
  sessionId: SessionId;
  /** That session's title when the message was written. */
  title: string;
}

/** What a spawned session sent back to the chat that started it (one per finished assignment). */
export interface SessionReport {
  files?: Attachment[];
  sessionId: SessionId;
  /** The spawned session's title when it reported. */
  title: string;
  outcome: "completed" | "failed" | "cancelled";
  /** The spawned session's final reply, at most 6,000 characters; for failed, the error message; may be empty. */
  summary: string;
  /** The chat item id of the final reply the report is about (completed runs), for read_chat's message_id. */
  resultId?: string;
  /** The final reply's full length in characters; longer than `summary` when the summary was cut. */
  resultChars?: number;
  /** Memory edits the session proposed since its last report, for the receiving agent to decide on. */
  memorySuggestions?: MemorySuggestion[];
}

/**
 * - pending: a user message accepted but not yet seen by the model
 * - streaming: an assistant message being generated (text grows through message.delta events)
 * - complete: final
 * - aborted: cut off by cancel or a crash; the text so far is kept
 * - error: generation failed; `error` says why
 */
export type MessageStatus = "pending" | "streaming" | "complete" | "aborted" | "error";

export interface ErrorInfo {
  /**
   * Stable machine-readable code, e.g. "deadline_exceeded", "gateway_unavailable", "model_error", "parked",
   * "loop_guard" (the run hit its model-call or time limit).
   */
  code: string;
  /** One sentence for the user; never contains a token or a raw upstream body. */
  message: string;
  /** Validation failures, one per field: a JSON Pointer `path` into the body or query and a `message`. */
  issues?: { path: string; message: string; line?: number; column?: number }[];
}

/**
 * One file: 1 GiB. Uploads stream through the server to the object store, so this bounds disk and transfer time, not
 * the server's memory. Paths that read a file into memory or into a model's context keep their own, smaller limits.
 */
export const ATTACHMENT_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * One message's files together: 2 GiB, so a file at the limit fits with room to spare. A message's files are all copied
 * into the agent's sandbox before its run starts, so this bounds that copy, not memory.
 */
export const MESSAGE_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
export const MESSAGE_MAX_ATTACHMENTS = 10;

export interface Attachment {
  fileId?: string;
  versionId?: string;
  location?: FileReference["location"];
  id: string;
  name: string;
  mediaType: string;
  size: number;
  /**
   * Set when only the file's name is known: an imported message's file that the import did not carry, with why
   * (e.g. "Not in export"). Such an attachment has no bytes to open.
   */
  unavailable?: string;
}

/** UTF-16 offsets into Message.text, as used by browser selection APIs. */
export interface MessageMention {
  /** "page": a Knowledge page; the agent reads its latest revision (the message keeps no revision). */
  kind: "connector" | "chat" | "page";
  id: string;
  label: string;
  start: number;
  end: number;
}

export interface MessageContext {
  attachments?: Attachment[];
  mentions?: MessageMention[];
  /**
   * Skills the user selected with `/` for this message, in chip order. Message-level metadata: it does not touch
   * `mentions` (which are spans of `text`). The skill versions are frozen when the message is admitted.
   */
  selectedSkills?: import("./skills.ts").MessageSkill[];
}

export interface Message extends MessageContext {
  /** Background replies remain internal until published; dismissed events stay internal. */
  internal?: boolean;
  id: MessageId;
  sessionId: SessionId;
  role: MessageRole;
  /** The run this message belongs to (a user message starts a run; the assistant reply is part of it). */
  runId: RunId | null;
  /** For a report message: a one-line plain text form of `report`. */
  text: string;
  status: MessageStatus;
  error?: ErrorInfo;
  /** Only on user-role messages written by another session's agent. */
  from?: MessageSender;
  /** Only on report messages. */
  report?: SessionReport;
  /** Only on approval messages. */
  approval?: Approval;
  /** Only on takeover messages. */
  takeover?: Takeover;
  /** Only on memory messages: the "Memory updated" chip, or a suggestion card. */
  memory?: MessageMemory;
  /** Only on trigger messages. */
  trigger?: TriggerMessage;
  /** A complete assistant message that "Branch in new chat" accepts. */
  forkable?: boolean;
  /** An assistant reply that shows surfaces, as text and surface parts in order (see surfaces.ts). */
  parts?: MessagePart[];
  /** A user message sent by a surface action (a button press or a final submit). */
  surfaceAction?: SurfaceActionRef;
  /** A user message you typed that Edit and Retry accept (complete, not a brief, report or event). */
  editable?: boolean;
  /** The version shown (1-based) and the number of versions of this user message. */
  versions?: { index: number; count: number };
  /**
   * The Pi entry this item shows (the input entry of a user item, the answer entry of a finished reply): the address
   * fork, edit and retry use. Absent while the item has no entry yet (a queued input, a reply still streaming).
   */
  entryId?: string;
  /** On a user item you sent: the request id of the send, so a client can match its pending send. */
  requestId?: string;
  /** On a user item you sent to steer a running reply (it joins that reply after its current tool round). */
  steer?: boolean;
  /**
   * On an imported reply: the reasoning the other app showed, one block per step. Display only (detail mode): the model
   * never sees it and history search does not index it.
   */
  thinking?: string[];
  createdAt: number;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Run {
  id: RunId;
  sessionId: SessionId;
  status: RunStatus;
  error?: ErrorInfo;
  startedAt: number;
  endedAt: number | null;
}
