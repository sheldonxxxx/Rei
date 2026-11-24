// REST API between the PWA and the app server. All paths are under /api. JSON in and out.
//
// Rules every endpoint follows:
// - Every request except GET /api/auth/state, POST /api/auth/setup* and POST /api/auth/login needs the session
//   cookie (HttpOnly, SameSite=Strict); without it the server answers 401 with code "unauthenticated".
// - Every non-GET request must carry the header `x-rei: 1` (CSRF guard on top of SameSite); otherwise 403 "csrf".
// - Errors are `{ error: ErrorInfo }` with a 4xx/5xx status. Codes are listed per endpoint.
import type {
  Agent,
  Approval,
  ApprovalId,
  ErrorInfo,
  Grant,
  GrantLength,
  Message,
  MessageId,
  ProfileName,
  Run,
  RunId,
  Session,
} from "./entities.ts";
import type { ComponentOwner } from "./skills.ts";
import type { Companion, ConversationLive } from "./stream.ts";
import type { ThinkingLevel } from "./thinking.ts";
import type { AgentSettingsPatch } from "./trace.ts";

export const CSRF_HEADER = "x-rei";
export const SESSION_COOKIE = "rei_session";

export interface ErrorBody {
  error: ErrorInfo;
}

// ---- auth (password and optional TOTP; the account is created once with a setup code printed on the VM) -----------------------
// Setup and login answer "rate_limited" after 5 failures in
// 15 minutes.

// Auth and device types are defined by their schemas in contract/auth.ts.

/** POST /api/auth/logout: clears the cookie and revokes the session token. */

// ---- agents and sessions --------------------------------------------------------------------------------------------

/**
 * GET /api/models: the models an agent can be set to. `default` is what an agent with no model of its own uses; `models`
 * is every id offered: the default first, then a fixed list of known models, then any others named in models.json or already
 * in use, without repeats. Nothing checks that the account can use them; a call to one it cannot use fails with the
 * gateway's error.
 */
export interface ModelsResponse {
  default: string;
  models: string[];
  /** Display text for model values that carry a connection prefix (`connectionId/model`); the value stays the key. */
  labels?: Record<string, string>;
  /** Supported explicit efforts per model; "off" always remains available as the provider default. */
  thinkingLevels?: Record<string, ThinkingLevel[]>;
}

/** Built-in model call deadlines, in milliseconds. */
export const DEFAULT_MODEL_DEADLINES = { firstEventMs: 120_000, idleMs: 500_000, totalMs: 600_000 } as const;

/** GET /api/settings/models: defaults and the chat call deadlines. All times are milliseconds. */
export interface ModelSetting {
  model: string;
  firstEventMs: number;
  idleMs: number;
  totalMs: number;
}

/**
 * Where a limit came from: the user (`custom`), the provider's model list (`detected`), the built-in catalog
 * (`built_in`), or nowhere (`unknown`: the provider reported nothing and the user has not set a value).
 */
export type CapabilitySource = "custom" | "detected" | "built_in" | "unknown";

/** One model's limits as they apply now. A `null` value means no limit is known. */
export interface ModelCapability {
  /** The model choice (`connectionId/model`, or a bare OpenAI model id). */
  id: string;
  contextWindow: { value: number | null; source: CapabilitySource };
  maxTokens: { value: number | null; source: CapabilitySource };
}

export interface ModelSettingsResponse {
  /** Quick model used by background tasks and as the default for chat titles. */
  fast: ModelSetting;
  /** Default model for new agent conversations. */
  standard: ModelSetting;
  /** Limits and thinking efforts for the models offered, and for any model with a saved override. */
  capabilities: ModelCapability[];
}

/** One model's override in a PUT. `null` removes the user's value so the detected or built-in one applies again. */
export interface ModelCapabilityPatch {
  contextWindow?: number | null;
  maxTokens?: number | null;
}

/** PUT /api/settings/models: partial model/deadline updates, and per-model limit overrides keyed by model choice. */
export interface UpdateModelSettingsRequest {
  fast?: Partial<ModelSetting>;
  standard?: Partial<ModelSetting>;
  capabilities?: Record<string, ModelCapabilityPatch>;
}

/**
 * GET /api/settings/titles: how chats you start get their title. Off, a chat is titled with its first message. On, once the
 * first reply is in, one short model call writes a better title (it replaces the first-message one; if the call fails the
 * first-message title stays). `model` is the model for that call, or null for `default` (the server's fast model).
 */
export interface TitleSettings {
  enabled: boolean;
  model: string | null;
  default: string;
}
/** PUT /api/settings/titles: change either field; answers the new TitleSettings. "bad_request": a model id that is empty, over 100 characters or has spaces. */
export interface UpdateTitleSettingsRequest {
  enabled?: boolean;
  model?: string | null;
}

/**
 * GET /api/settings/memory-extraction: whether finished chats are reviewed in the background to save durable facts. Off by
 * default. When on, each review is a model call on the agent's own model: it runs right after the chat, so the agent's
 * prompt cache is usually still warm, which keeps it cheaper, but it still uses extra tokens. The agent's memory tools work
 * whether this is on or off.
 */
export interface MemoryExtractionSettings {
  enabled: boolean;
  everyNTurns: number;
}
/** PUT /api/settings/memory-extraction: answers the new MemoryExtractionSettings. */
export interface UpdateMemoryExtractionRequest {
  enabled?: boolean;
  everyNTurns?: number;
}

/** What Pi's automatic compaction does (Settings > Context). Each value is a token count. */
export interface CompactionPolicySettings {
  enabled: boolean;
  /** Room kept free for the answer; compaction starts above `contextWindow - reserveTokens`. */
  reserveTokens: number;
  /** About how much recent context a summary keeps word for word. */
  keepRecentTokens: number;
  /** Background compaction starts this many tokens before the blocking threshold; 0 turns it off. */
  backgroundTokens: number;
}
/** Working budget and idle compaction timing for Home chat. */
export interface HomeContextSettings {
  idleGapMinutes: number;
  /** @deprecated Retained for older clients. Home chat uses the same token budget for all runs. */
  recentMessages: number;
  maxTokens: number;
}
/**
 * GET/PUT /api/settings/first-time-setup: whether the instance's first-time setup dialog is switched off for good ("Don't
 * show again"). Kept on the server, so it follows the instance's data rather than one browser.
 */
export interface FirstTimeSetupSettings {
  dismissed: boolean;
}
/** PUT /api/settings/first-time-setup: answers the new FirstTimeSetupSettings. */
export interface UpdateFirstTimeSetupRequest {
  dismissed: boolean;
}
/** GET/PUT /api/settings/context. `defaults` are what a reset restores; changes apply from the next model call. */
export interface ContextSettings {
  compaction: CompactionPolicySettings;
  /** Overrides for one model, keyed `provider/modelId`; a missing field uses the value above. */
  modelOverrides: Record<string, Partial<CompactionPolicySettings>>;
  home: HomeContextSettings;
  defaults: { compaction: CompactionPolicySettings; home: HomeContextSettings };
}
/** PUT /api/settings/context: any part; `null` for a part resets it to the default. */
export interface UpdateContextSettingsRequest {
  compaction?: Partial<CompactionPolicySettings> | null;
  modelOverrides?: Record<string, Partial<CompactionPolicySettings>>;
  home?: Partial<HomeContextSettings> | null;
}

/** Agent behavior limits and options (Settings > Behavior). Defaults come from the server; changes apply from the next call. */
export interface BehaviorSettings {
  runLimits: { maxModelCalls: number; maxRunMinutes: number };
  retry: { maxRetries: number; baseDelaySeconds: number };
  memory: { injectProfile: boolean; injectRecent: boolean; historyHits: number };
  /** Caps the output tokens requested per model call; null leaves each model's own limit. */
  generation: { maxOutputTokens: number | null };
  discovery: { maxConnectorTools: number; maxSkills: number };
  /** Web search: `useOpenAiNativeSearch` lets OpenAI models search with OpenAI's built-in tool instead of web_search. */
  search: { useOpenAiNativeSearch: boolean };
  /** Code mode: the model may write a short script that calls its tools, as one extra tool. Off by default. */
  codeMode: { enabled: boolean };
  /**
   * Chat: what a message you send while a reply is running does. `steer` (default) joins the running reply after its
   * current tool round; `queue` waits and starts the next reply once this one finishes.
   */
  chat: { whenBusy: SendWhenBusy };
}
/** What a message sent while a reply is running does: join it (`steer`) or wait for it to finish (`queue`). */
export type SendWhenBusy = "steer" | "queue";
export interface BehaviorSettingsResponse {
  settings: BehaviorSettings;
  defaults: BehaviorSettings;
  /** Hard ceilings the server enforces whatever is saved. */
  ceilings: { maxModelCalls: number; maxRunMinutes: number; maxRetries: number };
}
/** PUT /api/settings/behavior: any part of the settings; `null` resets the whole thing to defaults. */
export type UpdateBehaviorSettingsRequest = { [K in keyof BehaviorSettings]?: Partial<BehaviorSettings[K]> } | null;
/** GET /api/agents/:id/instructions: the current text and earlier versions, newest first. */
export interface AgentInstructionsResponse {
  instructions: string;
  maxLength: number;
  history: { at: number; author: "user" | "agent"; text: string }[];
}

/**
 * GET/PUT /api/settings/time-zone: the user's IANA time zone (Settings > General). The browser saves its own zone the first
 * time the app opens; `null` means no zone has been saved yet.
 */
export interface TimeZoneSettings {
  timeZone: string | null;
}
/** PUT /api/settings/time-zone: answers the new TimeZoneSettings. */
export interface UpdateTimeZoneRequest {
  timeZone: string;
}

/** GET /api/agents */
export interface AgentsResponse {
  agents: Agent[];
  defaultAgentId: string;
  companion: Companion;
}

/** A session's read marker: the latest transcript item the user has seen, and that item's createdAt. */
export interface ReadMarker {
  itemId: string;
  at: number;
}
/** PUT /api/sessions/:id/read-marker answers the marker now in force (it never moves backwards) and the unread count. */
export interface ReadMarkerResponse {
  marker: ReadMarker;
  unread: number;
}

/**
 * GET /api/glance: what a widget shows, in one cheap call without a stream. It answers an ETag; a request with a
 * matching If-None-Match gets 304 with no body.
 */
export interface GlanceResponse {
  companion: { agentId: string; name: string; avatar: string; homeSessionId: string };
  /** The home chat's latest message as plain text (Markdown dropped, components as their fallback), at most 200
   * characters; null when the chat is empty or previews are hidden. */
  preview: string | null;
  /** The user hid message text from notifications, and so from glances. */
  previewHidden: boolean;
  /** A run is going (or queued) in the home chat. */
  running: boolean;
  /** Approvals waiting for the user in every session. */
  pendingApprovals: number;
  /** Unread agent entries in every session. */
  unread: number;
  /** The next scheduled trigger run, if any. */
  nextTrigger: { id: string; name: string; at: number } | null;
}

/** PUT /api/settings/companion: answers CompanionResponse. */
export interface UpdateCompanionRequest {
  agentId: string;
}
export interface CompanionResponse {
  companion: Companion;
}

/** The built-in bots, `bot:<id>`. The first is the default. */
export const AGENT_BOT_AVATARS = [
  "bot:sprout",
  "bot:round",
  "bot:antenna",
  "bot:cat",
  "bot:ghost",
  "bot:astro",
] as const;
/** Longest accepted `data:` avatar, in characters (about 48 KB of image). */
export const AVATAR_IMAGE_MAX_CHARS = 65_536;

/**
 * PATCH /api/agents/:id: change an agent from the trusted UI (its look, name, model and default
 * profile). Answers `{ agent }` and sends `agent.upserted`. Every change but the avatar is written to the edit log.
 * Errors: "not_found", "bad_avatar" (not one of the forms on Agent.avatar, or too long), "bad_request" (an empty or
 * over-40-character name, an empty or over-100-character model id, an unknown profile).
 */
export interface UpdateAgentRequest extends AgentSettingsPatch {
  avatar?: string;
}
export interface UpdateAgentResponse {
  agent: Agent;
}

/** Longest description accepted by POST /api/agents, in characters. */
export const AGENT_DESCRIPTION_MAX_CHARS = 500;

/**
 * POST /api/agents: make a new agent from one sentence ("a social media manager"). A model writes the name, avatar
 * emoji and instructions. Answers `{ agent, session }` (the agent and its home chat) and sends `agent.upserted` and
 * `session.upserted`.
 * Errors: "bad_request" (an empty or over-500-character description), "design_failed" (502: the model errored, was over
 * its limit, timed out or wrote something unreadable; nothing is created). A server in faux mode has no model and makes
 * a plain design from the description instead.
 */
export interface CreateAgentRequest {
  description: string;
}
export interface CreateAgentResponse {
  agent: Agent;
  session: Session;
}

/**
 * DELETE /api/agents/:id: deletes an agent with its chats, triggers, grants and memory, and sends `agent.removed`.
 * Answers `{ ok: true }`. Errors: "not_found", "default_agent" (409: the default agent can't be deleted).
 */

/** GET /api/sessions: complete list by default. With ?paged=1&agent=<id>&before=<cursor>,
 * returns up to 30 visible history sessions ordered by updatedAt and ID descending; home chats
 * and finished trigger runs are excluded. ?triggers=1 also includes every trigger run (the sidebar's
 * "Trigger sessions" filter). Omit before for the first page. */
export interface SessionsResponse {
  sessions: Session[];
  /** Cursor for the next page when pagination is requested. */
  nextCursor?: string | null;
}

/** POST /api/sessions: New chat. Starts an empty session (and a new session tree, D29). Errors: "unknown_agent". */
export interface CreateSessionRequest {
  /** Defaults to the default agent. */
  agentId?: string;
}
export interface CreateSessionResponse {
  session: Session;
}

/**
 * GET /api/sessions/:id: the session and the newest window of its Conversation View, oldest first (`messages` are the
 * view's items). `before` pages older history. Errors: "not_found".
 */
export interface SessionDetailResponse {
  session: Session;
  messages: Message[];
  runs: Run[];
  before?: MessageId | null;
  live?: ConversationLive;
}

/**
 * GET /api/sessions/:id/transcript?before=<itemId>&limit=<n>: older items of the conversation, oldest first, ending just
 * before `before` (the newest ones without it). `before` in the response pages further back; null at the start.
 */
export interface TranscriptPageResponse {
  items: Message[];
  before: MessageId | null;
}

/**
 * POST /api/sessions/:id/messages: send a user message. Idempotent by requestId: resending the same requestId
 * returns the same ids and never starts a second run. If the session is busy the message queues behind the
 * current run (Pi steering comes later). Errors: "not_found", "empty_message", "too_long" (over 32,000 chars).
 */
export interface SendMessageRequest {
  /** Client-generated, unique per message (e.g. crypto.randomUUID()). */
  requestId: string;
  text: string;
  files?: import("./library.ts").FileReference[];
  mentions?: import("./entities.ts").MessageMention[];
  /**
   * Skills chosen with `/` for this message (at most 5, no duplicates), each pinned to a version. Rejects the whole
   * send, keeping nothing admitted, with "skill_unavailable", "too_many_skills" or "skills_too_large". A retry of an
   * already admitted `requestId` is accepted before any of those checks.
   */
  selectedSkills?: import("./skills.ts").SelectedSkill[];
  /**
   * What this message does if a reply is running: overrides Settings > Behavior `chat.whenBusy` for this one message.
   * Ignored when the chat is idle.
   */
  whenBusy?: SendWhenBusy;
}
export interface SendMessageResponse {
  messageId: MessageId;
  runId: RunId;
}

/** Where a manual compaction stands. Only `applied` means a compaction entry is in the transcript. */
export type ManualCompactionStatus =
  | "accepted"
  | "running"
  | "pending_placement"
  | "applied"
  | "no_change"
  | "stale"
  | "failed"
  | "unknown_after_restart";

/** Statuses after which a manual compaction no longer changes. */
export const MANUAL_COMPACTION_TERMINAL: readonly ManualCompactionStatus[] = [
  "applied",
  "no_change",
  "stale",
  "failed",
  "unknown_after_restart",
];

/** Longest `/compact` guidance, in Unicode code points. */
export const COMPACT_INSTRUCTIONS_MAX = 4_000;

/**
 * POST /api/sessions/:id/compact: Manual compaction (the `/compact` slash command). Not a message and not a run.
 * Idempotent by requestId. Answers with the request's status, never with whether summarizing worked.
 * Errors: "not_found", "bad_request", "too_long" (`instructions` over COMPACT_INSTRUCTIONS_MAX code points),
 * "busy" (409: a run is active or queued, or another manual compaction is in progress).
 */
export interface CompactRequest {
  requestId: string;
  instructions?: string;
}
export interface CompactResponse {
  requestId: string;
  status: ManualCompactionStatus;
  /** The Pi task, not a transcript entry. */
  taskId?: string;
  error?: { code: string; message: string };
}

/** POST /api/sessions/:id/cancel: aborts the running run, if any; the partial reply is kept as "aborted". */
export interface CancelResponse {
  cancelledRunId: RunId | null;
}

/**
 * POST /api/sessions/:id/fork: Branch in new chat. Starts a session (origin "fork", same agent, same session tree)
 * holding the conversation up to and including the given message, which must be a complete assistant message
 * (`forkable`). Only finished output can be forked, never a tool call or a step of the trace. Work still in progress in
 * the original stays there. Errors: "not_found", "not_forkable", "bad_request".
 */
export interface ForkRequest {
  messageId: MessageId;
}
export interface ForkResponse {
  session: Session;
}

/**
 * DELETE /api/sessions/:id, optionally `?withForks=1`. Answers OkResponse. Errors: "not_found", "home_chat" (a home
 * chat can't be deleted).
 * - Unfinished runs are cancelled first. The session disappears from every list and stream at once
 *   (`session.removed`), and its messages, runs, trace steps and payloads are removed.
 * - A session that shares its tree with other live sessions (forks) is only hidden until the last of them is deleted;
 *   then the tree's storage file is removed. `withForks=1` also deletes the branches taken from it (its forks, and
 *   theirs, transitively), never the session it was itself forked from.
 * - Sessions it spawned stay; they stop reporting back (their parentSessionId becomes null).
 * - Forks of a deleted session keep `forkedFrom`, which then points at a session and message that no longer exist.
 */
export interface DeleteSessionQuery {
  withForks?: "1";
}

/**
 * PATCH /api/sessions/:id: change a session's settings from the trusted UI (an agent can never do this). The session
 * gets a notice message naming the change. Errors: "not_found", "bad_profile", "bad_title", "bad_pinned".
 */
export interface UpdateSessionRequest {
  profile?: ProfileName;
  /** User-facing session title. Leading and trailing whitespace is removed. */
  title?: string;
  /** Whether the session is pinned in the sidebar. */
  pinned?: boolean;
}
export interface UpdateSessionResponse {
  session: Session;
}

// ---- approvals and grants (D28) -------------------------------------------------------------------------------------

/** GET /api/approvals: pending approvals in every session, oldest first. */
export interface ApprovalsResponse {
  approvals: Approval[];
}

/**
 * POST /api/approvals/:id/decide. Approve: creates a one-time grant for that exact call, plus a grant of the chosen
 * length when it isn't "once", then asks the agent to make the call again. Deny: the agent is told and carries on
 * without it. Errors: "not_found", "not_pending" (already decided or expired), "bad_length" (not one of `lengths`),
 * "bad_hours".
 */
export interface DecideApprovalRequest {
  decision: "approve" | "deny";
  /** Approve only; default "once". */
  length?: GrantLength;
  /** For length "hours": 1 to 168. */
  hours?: number;
}
export interface DecideApprovalResponse {
  approval: Approval;
}

export interface DecideApprovalGroupRequest {
  decisions: { id: ApprovalId; decision: "approve" | "deny" }[];
}

/** GET /api/grants: grants in force (not revoked or expired), newest first. */
export interface GrantsResponse {
  grants: Grant[];
}

/** DELETE /api/grants/:id: revoke (logged). Answers OkResponse. Errors: "not_found". */

// ---- notifications ---------------------------------------------------------------------------------------------

/** The events that notify. A notification only ever links to the app; nothing is approved from it. */
export type NotifyEvent =
  | "approval"
  | "takeover"
  | "trigger_report"
  | "trigger_failed"
  | "trigger_paused"
  | "session_done";
/**
 * What a notification carries, on every delivery channel: the event, where it points (`sessionId`, and `messageId` when it
 * is about one message; `sessionId` is "" for a test) and its plain text. A client builds its own route from the ids; the
 * web app opens `/s/<sessionId>?m=<messageId>`.
 */
export interface NotifyPayload {
  event: NotifyEvent;
  sessionId: string;
  messageId?: string;
  title: string;
  body: string;
  /** @deprecated The old web hash route (`#/s/<id>`), kept for service workers cached before path routes. Build from the ids. */
  path: string;
}

/** A browser's push subscription as `PushSubscription.toJSON()` gives it. */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** GET /api/push/key: the VAPID public key (base64url) the browser subscribes with. Error "gateway_unavailable". */
export interface PushKeyResponse {
  publicKey: string;
}
/** POST /api/push/subscriptions (upsert by endpoint; also records the app's origin for links). Answers 204. Error "bad_request". */
export interface PushSubscribeRequest {
  subscription: PushSubscriptionJson;
  label: string;
}
/** DELETE /api/push/subscriptions. Answers 204. */
export interface PushUnsubscribeRequest {
  endpoint: string;
}
/** POST /api/presence: whether a PWA window is visible right now. While one is, no notification is sent. Answers 204. */
export interface PresenceRequest {
  visible: boolean;
}
/** GET /api/notifications and the answer of PUT /api/notifications/preview. */
export interface NotificationsResponse {
  devices: number;
  /** Whether notifications show what happened; off, they carry the title and a generic body. */
  preview: boolean;
}
/** PUT /api/notifications/preview. */
export interface UpdatePreviewRequest {
  preview: boolean;
}
// POST /api/notifications/test sends to subscribed devices and answers 204, or an error: "no_destinations", "test_failed".

// ---- MCP connectors --------------------------------------------------------------------------------------------
// The gateway keeps each connector's identity, address, status and secrets; the app server adds the policy: whether the
// connector holds the user's data, and a class per tool that overrides what the server's hints say.

/** The classes a user may set for an MCP tool. */
export type ConnectorToolClass = "read_external" | "write_external" | "send" | "irreversible";
export type McpProfile = "always_ask" | "read_only" | "read_write" | "yolo";

/** A connector as the app shows it: the gateway's record plus `holdsPrivate` (default true). */
export interface Connector {
  id: string;
  name: string;
  url: string;
  auth: "oauth" | "token" | "none";
  tokenHeader?: string;
  status: "connected" | "needs_auth" | "error";
  error: string | null;
  toolCount: number | null;
  createdAt: number;
  /** Reading from it marks the chat as having read private data. */
  holdsPrivate: boolean;
  /** MCP permission profile, independent of the chat profile and holdsPrivate. */
  mcpProfile?: McpProfile;
  mcpProfileRevision?: string;
  /** Stable registered provider identity, used to confirm consent against the displayed endpoint. */
  providerIdentity?: string;
  /** The plugin that owns it; null when it is standalone. Set by GET /api/connectors. */
  plugin?: ComponentOwner | null;
}
/** GET /api/connectors. */
export interface ConnectorsResponse {
  connectors: Connector[];
}
/** POST /api/connectors. Errors: "bad_request", "bad_url" (from the gateway), "connector_unreachable". */
export interface CreateConnectorRequest {
  name: string;
  url: string;
  token?: string;
  /** Send the token as this header's value. Omit for Authorization: Bearer. */
  tokenHeader?: string;
}
/** PATCH /api/connectors/:id; `token: null` forgets the token. Answers ConnectorResponse. Errors: "not_found", "bad_request". */
export interface UpdateConnectorRequest {
  name?: string;
  token?: string | null;
  /** Null restores Authorization: Bearer. Omit to keep the current header. */
  tokenHeader?: string | null;
  holdsPrivate?: boolean;
}
export interface ConnectorResponse {
  connector: Connector;
}
/** PUT /api/connectors/:id/profile; optimistic revision and explicit YOLO confirmation. */
export interface SetMcpProfileRequest {
  profile: McpProfile;
  providerIdentity: string;
  expectedRevision: string;
  confirmYolo?: boolean;
}
// DELETE /api/connectors/:id answers 204 and revokes the grants for its tools.

/** One tool of a connector: what the server says it does, the class it gets by default, and the user's override. */
export interface ConnectorTool {
  name: string;
  title: string | null;
  description: string;
  inputSchema: object;
  outputSchema?: object;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Claimed effect: destructive, else read-only, else write. Authorization is separate. */
  defaultClass: ConnectorToolClass;
  override: ConnectorToolClass | null;
  /** Effective policy class; a destructive hint cannot be downgraded by an override. */
  effectiveClass?: ConnectorToolClass;
  /** Fingerprint of the inspected connector/tool definition; required for a manual Read override. */
  definitionFingerprint?: string;
}
/** GET /api/connectors/:id/tools[?refresh=1]. Errors: "not_found" (the connector), "needs_auth" (409), "connector_unreachable". */
export interface ConnectorToolsResponse {
  tools: ConnectorTool[];
  fetchedAt: number;
}
/** PUT /api/connectors/:id/tools/:tool; null clears the override. Answers OkResponse. */
export interface SetToolClassRequest {
  actionClass: ConnectorToolClass | null;
  definitionFingerprint?: string;
}
/**
 * POST /api/connectors/:id/oauth/start. The client fields are for servers that cannot register a client by themselves
 * (the gateway answers "client_id_required"). The redirect address is `<app origin>/api/mcp/oauth/callback`, the origin
 * from the request's Origin header, else the one saved with the notification settings.
 */
export interface ConnectorOAuthStartRequest {
  clientId?: string;
  clientSecret?: string;
}
export interface ConnectorOAuthStartResponse {
  authorizationUrl: string;
}
/**
 * GET /api/mcp/oauth/callback?code&state[&iss][&error]: where the provider sends the browser back. It needs no cookie
 * (the session cookie is SameSite=Strict, so this cross-site return carries none) and does nothing itself: it answers
 * 302 to `/settings/connectors?state=…&code=…[&iss=…]` (or `?oauth_error=…`). The app then calls the next endpoint.
 */
/** POST /api/connectors/oauth/finish (signed in): the gateway checks the state and exchanges the code. Errors: "invalid_state", "state_expired", "iss_mismatch", "oauth_failed". */
export interface ConnectorOAuthFinishRequest {
  state: string;
  code: string;
  iss?: string;
}
