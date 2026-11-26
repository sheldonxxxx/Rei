// Full mode: inspection of every run and step, editing current state, and
// retry, edit or fork from a step. Simple mode uses only tool activity summaries.

import type {
  ActionClass,
  AgentId,
  ApprovalId,
  ErrorInfo,
  MessageId,
  ProfileInput,
  Run,
  RunId,
  Session,
  SessionId,
  StepId,
} from "./entities.ts";
import type { SandboxNetworkMode } from "./network.ts";
import type { SkillId } from "./skills.ts";
import type { ThinkingLevel } from "./thinking.ts";
import type { TriggerId } from "./triggers.ts";

/** What the policy decided for a tool call: allowed by the profile, allowed by a grant, blocked for approval, or denied. */
export type StepDecision = "allow" | "granted" | "ask" | "deny";

/**
 * - llm.call: one model call (the assembled request and the response are in the payload)
 * - tool.call: one tool call with the policy's decision, its input and its output (every tool goes through
 *   the policy extension, which records it)
 */
/** `capabilities.changed`: connector tools were added, removed or changed in the open conversation while the run went on. */
export type StepType = "llm.call" | "tool.call" | "capabilities.changed";
/** `not_executed`: Pi wrote the result itself and the tool never ran (unknown tool, invalid arguments, interrupted…). */
export type StepStatus = "running" | "ok" | "error" | "blocked" | "cancelled" | "not_executed";

export interface StepTokens {
  input: number | null;
  output: number | null;
  cached: number | null;
  reasoning: number | null;
  total: number | null;
}

export interface StepSummary {
  id: StepId;
  runId: RunId | null;
  sessionId: SessionId;
  type: StepType;
  status: StepStatus;
  startedAt: number;
  latencyMs: number | null;
  /** The Pi entry the step produced (the reply, or the tool result); links the step to the transcript. */
  piEntryId: string | null;
  /** True when the step acted outside the box: a tool call whose class is write_external, send or irreversible and ran. */
  sideEffect: boolean;
  // llm.call
  provider?: string;
  /** The provider as people see it: its connection name ("Removed provider" once the connection is gone). */
  providerName?: string;
  model?: string;
  firstByteMs?: number | null;
  tokens?: StepTokens;
  /**
   * How many leading request items were identical to the previous model call of the same kind in this session, out of
   * the items sent. A low share means the provider could not reuse its prompt cache. `matched` is null for a first call.
   */
  prefix?: { matched: number | null; items: number };
  errorCode?: string | null;
  // tool.call
  toolName?: string;
  actionClass?: ActionClass;
  decision?: StepDecision;
  approvalId?: ApprovalId | null;
  /** The tool's one-line summary for the policy (destination included). */
  summary?: string;
  /** Model-provided activity label for the chat. Display only; never an approval summary or execution input. */
  activity?: string;
  /** The model's id for the tool call; a surface revision names the call that made it. */
  toolCallId?: string;
  /**
   * For a call a `codemode` script made: the id of the script's own step. The script and its calls are in the same run,
   * so they are always on the same trace page; join them by this id.
   */
  parentStepId?: StepId;
  /** For knowledge_* tools: the page it read or wrote, with its current title. */
  page?: { id: string; title: string; trashed: boolean };
  /** For web_fetch: the page it read (its title and host), for the chat's chip. */
  web?: { title: string; host: string };
}

export interface RunTrace {
  run: Run;
  /**
   * The user (or brief, report, event) message that started the run, when there is one. For a Continue run, the message
   * whose reply it went on with.
   */
  triggerMessageId: MessageId | null;
  /** A failed run that the user went on from with Continue: a later run answers it, so the failure is no longer the outcome. */
  continued?: true;
  steps: StepSummary[];
  totals: {
    modelCalls: number;
    toolCalls: number;
    tokens: number;
    durationMs: number | null;
    /** Time spent waiting for decisions in this run. */
    approvalWaitMs?: number;
  };
}

/** GET /api/sessions/:id/trace[?before=<runId>]: the newest 30 runs first, each with its steps in order. Errors: "not_found". */
export interface SessionTraceResponse {
  session: Session;
  runs: RunTrace[];
  /** Pass as `before` for older runs; null when there are none. */
  next: RunId | null;
}

/** A part of a tool's output. Images are served by GET /api/steps/:id/images/:index. */
export type ToolOutputPart = { type: "text"; text: string } | { type: "image"; index: number; mimeType: string };

/**
 * GET /api/steps/:id. The payload as recorded: for llm.call the exact request body sent to the provider (system prompt,
 * messages, tools) and the response; for tool.call the input and the output parts. Strings over 200,000 characters are
 * cut and `truncated` is true. Errors: "not_found".
 */
/** Why `search_capabilities` loaded a tool: its whole group matched, it ranked for the query, or it was named in `load`. */
export type LoadReason = "group" | "ranked" | "load";

/** What one `search_capabilities` call did, as its Trace step shows it in detail mode. */
export interface CapabilitySearchDetails {
  query?: string;
  /** Ranked candidates, best first, with the share of query terms each matched and its score. */
  candidates: { name: string; kind: "tool" | "skill"; coverage: number; score: number }[];
  loaded: { name: string; reason: LoadReason; group?: string }[];
  alreadyLoaded: string[];
  /** Tools that matched but were not loaded; the model can load them by name. */
  alsoRelevant: string[];
  /** Skills suggested to read with `use_skill`. */
  skills: string[];
  /** Set when the query only named a connector: its directory was shown and nothing was loaded. */
  directory?: { connectorId: string; connectorName: string; tools: number };
  notFound: string[];
}

/** The tools a chat model call was offered, and the change since the session's previous chat model call. */
export interface OfferedToolChanges {
  offered: string[];
  /** The previous chat model call of the session; absent for the first. */
  previousStepId?: string;
  /** Newly offered tools. `loadedBy` is the `search_capabilities` step that loaded one; without it, a capability change. */
  added: { name: string; loadedBy?: string; reason?: LoadReason; group?: string }[];
  /** Tools no longer offered: their connector was removed, signed out, or the agent lost access. */
  removed: string[];
}

/** What a `capabilities.changed` step saw: the connector tools that came, went or changed for this session's agent. */
export interface CapabilityChange {
  connectors: string[];
  added: string[];
  removed: string[];
  /** Same name, new definition: a loaded one stays loaded under its new schema. */
  changed: string[];
}

/** How one web_fetch call read its page and what the result cost, as its Trace step shows it in detail mode. Never page text. */
// A type, not an interface: it is a tool result's JSON details, which must fit a JSON index signature.
export type WebFetchDetails = {
  /**
   * "http": fetched through the egress proxy (or read from a copy that was). "render": read from the page as the browser
   * rendered it in a context of its own (or from a copy that was), because it showed nothing without JavaScript.
   */
  method: "http" | "render";
  /** "hit": the agent's stored copy; "miss": fetched now; "refresh": fetched again on request. */
  cache: "hit" | "miss" | "refresh";
  /** What the result showed: an outline, the whole page, passages for a query, a section, or a raw slice. */
  mode?: "overview" | "whole" | "query" | "section" | "offset";
  host: string;
  title?: string;
  quality?: string;
  extractor?: string;
  /** Section ids the result showed (query and section modes). */
  sections?: string[];
  /** The final response, when this call fetched. */
  status?: number;
  bytes?: number;
  mediaType?: string;
  redirects?: number;
  /** o200k tokens of the result the model got. */
  tokensReturned?: number;
  /** The whole page: estimated tokens and characters. */
  pageTokens?: number;
  pageChars?: number;
  /** Set when this call got a page that needs JavaScript (or the dev diagnostic forced a render). */
  render?: WebRenderDetails;
  durationMs: number;
  /** Set when the call failed; the message is the tool's output. */
  error?: true;
};

/** How a web_fetch call rendered its page in the shared reader's browser (ADR 0017, 0020), or why it did not. */
export type WebRenderDetails = {
  /**
   * Why it rendered: the page had no text without JavaScript, only its summary or embedded data could be read without it,
   * or the read was forced to render (a diagnostic).
   */
  reason: "requires_js" | "low_quality" | "forced";
  /** Set when it did not render: the reader request disabled rendering, or no browser is available. */
  skipped?: "off" | "unavailable";
  /** Time spent waiting for one of the browser's render slots. */
  queueMs?: number;
  renderMs?: number;
  /** "stable": read once the text stopped changing; "deadline": read with what it had when time ran out. */
  ended?: "stable" | "deadline";
  /** Connections the render's egress token opened, and the ones refused. */
  connections?: number;
  refused?: number;
  /** Images, media and fonts failed in the browser before they were requested. */
  blockedMedia?: number;
  /** The HTML read back was longer than 5 MiB and was cut. */
  truncated?: true;
  /** The render failed, so the page as fetched (its summary or embedded data) was used instead. */
  failed?: true;
  /** The engine whose result was used, and its version (the shared reader's engines, ADR 0020). */
  engine?: "moli" | "chromium";
  engineVersion?: string;
  /** The result came from the fallback engine; `reason` is the rule that fired. */
  fallback?: { from: "moli" | "chromium"; reason: "failed" | "requires_js" | "thin" };
};

/** GET /api/steps/:id/web-document: the readable copy a web_fetch step read, while it is still stored. Errors: "not_found". */
export interface WebDocumentResponse {
  title: string;
  /** Where the page ended up after redirects. */
  url: string;
  text: string;
  note?: string;
  quality: string;
  extractor: string;
  fetchedAt: number;
  expiresAt: number;
}

/** One tool call a `codemode` script made: its arguments as compact JSON cut for display, status, time and error text. */
export interface ScriptCall {
  id: number;
  name: string;
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
}

export interface StepDetailResponse {
  step: StepSummary;
  llm?: { request: unknown; response: unknown; error?: ErrorInfo; tools?: OfferedToolChanges };
  tool?: {
    input: unknown;
    output: ToolOutputPart[];
    isError: boolean;
    /** What a `search_capabilities` call searched, ranked and loaded. */
    discovery?: CapabilitySearchDetails;
    /** How a `web_fetch` call read its page. */
    fetch?: WebFetchDetails;
    /**
     * What a `codemode` script called, in the order it made the calls. Kept with the script's own step, so the list is
     * there even when the nested steps are on another page. `id` is the script's number for the call: the nested call's id
     * is `<script call id>/c<id>`.
     */
    script?: { calls: ScriptCall[] };
  };
  change?: CapabilityChange;
  payloadBytes: number;
  truncated: boolean;
}

/**
 * GET /api/sessions/:id/fork-preview?messageId=<id>: what a fork at that reply would leave behind. The steps listed ran
 * after the cut and had an effect outside the box, which a fork does not undo. Errors: "not_found", "not_forkable" (not
 * a complete reply).
 */
export interface ForkPreviewResponse {
  laterEffects: StepSummary[];
}

/**
 * POST /api/sessions/:id/edit: "Edit" and "Retry" on one of your messages, in place. The same chat is cut back to just
 * before that message (its conversation is forked there and the fork swapped in), then `text` is sent there (the same
 * text for Retry) and starts a run. The conversation it replaced stays as another version of the message (see
 * `Message.versions`). `session` is the same session. Errors: "not_found", "not_editable" (not a user message you typed,
 * or one still being answered), "bad_request" (empty text), "busy" (409: a run is going or queued, or an approval
 * waits; "Wait for the reply to finish, or stop it.").
 *
 * Chats made by the earlier Retry and Edit, which opened a new chat, keep `forkedFrom` with `edited` (and `retried`).
 */
export interface EditMessageRequest {
  /** Updated positions of existing mentions, when the message contains mentions. */
  mentions?: import("./entities.ts").MessageMention[];
  /** The skills the new message carries. Absent: keep the original's (a Retry); `[]`: send without any. */
  selectedSkills?: import("./skills.ts").SelectedSkill[];
  messageId: MessageId;
  text: string;
}
export interface EditMessageResponse {
  session: Session;
  messageId: MessageId;
  runId: RunId;
}

/** POST /api/sessions/:id/version: show the neighboring version and its most recently active conversation. */
export interface SwitchVersionRequest {
  messageId: MessageId;
  to: "prev" | "next";
}

/**
 * PATCH /api/agents/:id now also takes these (see UpdateAgentRequest). Every change to an agent's settings is written
 * to the edit log with you as its author.
 */
export interface AgentSettingsPatch {
  name?: string;
  /** A model id, or null to go back to the default model. */
  model?: string | null;
  thinkingLevel?: ThinkingLevel;
  /** What the agent's sandbox may reach outside (see SandboxNetworkMode). */
  networkMode?: SandboxNetworkMode;
  /** "relaxed" is accepted as an older name for "standard". */
  defaultProfile?: ProfileInput;
  /** Null allows all connectors; an empty list disables connector use. */
  allowedConnectorIds?: string[] | null;
  /** Null allows all Knowledge; a list limits access to those pages and their live descendants; empty disables pages. */
  allowedKnowledgePageIds?: string[] | null;
  canCreateTriggersForOtherAgents?: boolean;
  capabilities?: import("./capabilities.ts").AgentCapabilitiesPatch;
  /** The agent's system instructions; applied from its next model call. */
  instructions?: string;
}

/** One edit of current state made in the app. Memory edits stay in their own versions list and are not repeated here. */
export interface EditLogEntry {
  id: string;
  at: number;
  /** Who made the change: you, or an agent through an approved tool (triggers). */
  author: "user" | "agent";
  target:
    | { kind: "agent"; agentId: AgentId }
    | { kind: "session"; sessionId: SessionId }
    | { kind: "trigger"; triggerId: TriggerId }
    | { kind: "skill"; skillId: SkillId };
  field: string;
  before: string | null;
  after: string | null;
}
/** GET /api/edits?limit=<1..200>: newest first. */
export interface EditLogResponse {
  entries: EditLogEntry[];
}
