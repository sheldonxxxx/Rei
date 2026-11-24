// Session extras (issue 20): context use, summary, related chats, the `/` skill list, manual compaction, fork, edit,
// the trace, the browser window, and the edit log. Request and response types still live in ../api.ts, ../usage.ts,
// ../skills.ts, ../trace.ts and ../browser.ts as interfaces; each schema here is checked against its interface at compile
// time.
import {
  arr,
  bool,
  int,
  lit,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  type Static,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { CompactRequest, CompactResponse, ForkRequest, ForkResponse } from "../api.ts";
import type { BrowserStateResponse, StartTakeoverResponse } from "../browser.ts";
import type { SessionSkillsResponse } from "../skills.ts";
import type {
  EditLogEntry,
  EditLogResponse,
  EditMessageRequest,
  EditMessageResponse,
  ForkPreviewResponse,
  RunTrace,
  SessionTraceResponse,
  SwitchVersionRequest,
} from "../trace.ts";
import type { ContextBreakdown, ContextUsageResponse } from "../usage.ts";
import { OkSchema } from "./auth.ts";
import { ComponentOwnerSchema } from "./capabilities.ts";
import { defineRoute, named } from "./define.ts";
import { MessageMentionSchema, RunSchema, SelectedSkillSchema, SessionSchema, TakeoverSchema } from "./entities.ts";
import { StepSummarySchema } from "./operations.ts";
import type { Same } from "./same.ts";

const SessionResponseSchema = obj({ session: SessionSchema });

// ---- context, summary, related, skills ------------------------------------------------------------------------------

export const ContextBreakdownSchema = obj({
  method: lit("o200k_base"),
  estimatedTokens: int(),
  hasOpaqueContent: bool(),
  categories: arr(
    obj({
      id: oneOf([
        "prompt",
        "capabilities",
        "skills",
        "tools",
        "loaded_tools",
        "conversation",
        "tool_calls",
        "tool_results",
        "mcp_calls",
        "mcp_results",
        "other",
      ]),
      label: str(),
      estimatedTokens: int(),
      details: arr(obj({ label: str(), estimatedTokens: int() })),
    }),
  ),
});
true satisfies Same<Static<typeof ContextBreakdownSchema>, ContextBreakdown>;
export const ContextUsageResponseSchema = obj({
  model: nullable(str()),
  maxTokens: nullable(int()),
  inputTokens: nullable(int()),
  cachedTokens: nullable(int()),
  outputTokens: nullable(int()),
  updatedAt: nullable(num()),
  breakdown: opt(nullable(ContextBreakdownSchema)),
});
true satisfies Same<Static<typeof ContextUsageResponseSchema>, ContextUsageResponse>;
export const RelatedSessionsResponseSchema = obj({ sessions: arr(SessionSchema) });
export const SessionSkillsResponseSchema = obj({
  skills: arr(
    obj({
      id: str(),
      name: str(),
      description: str(),
      version: int(),
      bodyChars: int(),
      builtIn: opt(bool()),
      plugin: opt(nullable(ComponentOwnerSchema)),
    }),
  ),
});
true satisfies Same<Static<typeof SessionSkillsResponseSchema>, SessionSkillsResponse>;

export const sessionContextRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/context",
  tag: "chat",
  summary: "The latest completed chat model call's context use, with an estimated breakdown.",
  description: 'Errors: "not_found".',
  response: ContextUsageResponseSchema,
});
export const sessionSummaryRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/summary",
  tag: "chat",
  summary: "One session without its transcript.",
  description: 'Errors: "not_found".',
  response: SessionResponseSchema,
});
export const relatedSessionsRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/related",
  tag: "chat",
  summary: "The session's family: its parent, forks and spawned sessions.",
  response: RelatedSessionsResponseSchema,
});
export const sessionSkillsRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/skills",
  tag: "chat",
  summary: "The skills this session's agent can use now, for the composer's / list.",
  description: 'Errors: "not_found".',
  response: SessionSkillsResponseSchema,
});

// ---- compaction, fork, edit -----------------------------------------------------------------------------------------

export const CompactRequestSchema = obj({
  requestId: str({ minLength: 1, maxLength: 200, description: "Client-generated; the request is idempotent by it." }),
  instructions: opt(str()),
});
true satisfies Same<Static<typeof CompactRequestSchema>, CompactRequest>;
export const CompactResponseSchema = obj({
  requestId: str(),
  status: oneOf([
    "accepted",
    "running",
    "pending_placement",
    "applied",
    "no_change",
    "stale",
    "failed",
    "unknown_after_restart",
  ]),
  taskId: opt(str()),
  error: opt(obj({ code: str(), message: str() })),
});
true satisfies Same<Static<typeof CompactResponseSchema>, CompactResponse>;
export const ForkRequestSchema = obj({
  messageId: str(),
});
true satisfies Same<Static<typeof ForkRequestSchema>, ForkRequest>;
export const ForkResponseSchema = SessionResponseSchema;
true satisfies Same<Static<typeof ForkResponseSchema>, ForkResponse>;
export const EditMessageRequestSchema = obj({
  mentions: opt(arr(MessageMentionSchema)),
  selectedSkills: opt(arr(SelectedSkillSchema)),
  messageId: str(),
  text: str(),
});
true satisfies Same<Static<typeof EditMessageRequestSchema>, EditMessageRequest>;
export const EditMessageResponseSchema = obj({ session: SessionSchema, messageId: str(), runId: str() });
true satisfies Same<Static<typeof EditMessageResponseSchema>, EditMessageResponse>;

export const compactRoute = defineRoute({
  method: "POST",
  path: "/api/sessions/:id/compact",
  tag: "chat",
  summary: "Manual compaction (/compact): not a message and not a run. Answers the request's status.",
  description: 'Errors: "not_found", "bad_request", "too_long", "busy" (409).',
  body: CompactRequestSchema,
  response: CompactResponseSchema,
});
export const compactStatusRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/compact/:requestId",
  tag: "chat",
  summary: "Where a manual compaction stands.",
  description: 'Errors: "not_found".',
  response: CompactResponseSchema,
});
export const forkRoute = defineRoute({
  method: "POST",
  path: "/api/sessions/:id/fork",
  tag: "chat",
  summary: "Branch in a new chat at a complete assistant message.",
  description: 'Errors: "not_found", "not_forkable", "bad_request".',
  body: ForkRequestSchema,
  response: ForkResponseSchema,
});
export const editMessageRoute = defineRoute({
  method: "POST",
  path: "/api/sessions/:id/edit",
  tag: "chat",
  summary:
    "Edit or retry one of your messages in place: the chat is cut back to just before it and the text is sent there. The replaced conversation stays as another version of the message.",
  description: 'Errors: "not_found", "not_editable", "bad_request", "bad_mention", "busy" (409).',
  body: EditMessageRequestSchema,
  response: EditMessageResponseSchema,
});
const SwitchVersionRequestSchema = obj({ messageId: str(), to: oneOf(["prev", "next"]) });
true satisfies Same<Static<typeof SwitchVersionRequestSchema>, SwitchVersionRequest>;
export const switchVersionRoute = defineRoute({
  method: "POST",
  path: "/api/sessions/:id/version",
  tag: "chat",
  summary: "Switch to the previous or next version of a user message.",
  description: 'Errors: "not_found", "no_version" (409), "busy" (409).',
  body: SwitchVersionRequestSchema,
  response: OkSchema,
});

// ---- trace ----------------------------------------------------------------------------------------------------------

export const RunTraceSchema = named(
  "RunTrace",
  obj({
    run: RunSchema,
    triggerMessageId: nullable(str()),
    continued: opt(lit(true)),
    steps: arr(StepSummarySchema),
    totals: obj({
      modelCalls: int(),
      toolCalls: int(),
      tokens: num(),
      durationMs: nullable(num()),
      approvalWaitMs: opt(num()),
    }),
  }),
);
true satisfies Same<Static<typeof RunTraceSchema>, RunTrace>;
export const SessionTraceQuerySchema = obj({ before: opt(str({ description: "A run id: runs older than it." })) });
export const SessionTraceResponseSchema = obj({
  session: SessionSchema,
  runs: arr(RunTraceSchema),
  next: nullable(str()),
});
true satisfies Same<Static<typeof SessionTraceResponseSchema>, SessionTraceResponse>;
export const ForkPreviewQuerySchema = obj({ messageId: str() });
export const ForkPreviewResponseSchema = obj({ laterEffects: arr(StepSummarySchema) });
true satisfies Same<Static<typeof ForkPreviewResponseSchema>, ForkPreviewResponse>;

export const sessionTraceRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/trace",
  tag: "trace",
  summary: "The newest 30 runs of a session, each with its steps in order.",
  description: 'Errors: "not_found".',
  query: SessionTraceQuerySchema,
  response: SessionTraceResponseSchema,
});
export const forkPreviewRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/fork-preview",
  tag: "trace",
  summary: "What a fork at a finished reply would leave behind: later steps with effects outside the box.",
  description: 'Errors: "not_found", "not_forkable", "bad_request".',
  query: ForkPreviewQuerySchema,
  response: ForkPreviewResponseSchema,
});

// ---- browser --------------------------------------------------------------------------------------------------------

export const BrowserStateResponseSchema = obj({
  window: bool(),
  url: nullable(str()),
  title: nullable(str()),
  viewport: nullable(obj({ width: num(), height: num() })),
  takeover: nullable(TakeoverSchema),
});
true satisfies Same<Static<typeof BrowserStateResponseSchema>, BrowserStateResponse>;
export const StartTakeoverResponseSchema = obj({ takeover: TakeoverSchema });
true satisfies Same<Static<typeof StartTakeoverResponseSchema>, StartTakeoverResponse>;

export const sessionBrowserRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/browser",
  tag: "browser",
  summary: "The session's browser window, if it has one.",
  description: 'Errors: "not_found".',
  response: BrowserStateResponseSchema,
});
export const startTakeoverRoute = defineRoute({
  method: "POST",
  path: "/api/sessions/:id/browser/takeover",
  tag: "browser",
  summary: "Take over the session's browser window.",
  description: 'Errors: "not_found", "no_window" (409), "already_active" (409, with the active one in `takeover`).',
  response: StartTakeoverResponseSchema,
});

// ---- edit log -------------------------------------------------------------------------------------------------------

export const EditLogEntrySchema = named(
  "EditLogEntry",
  obj({
    id: str(),
    at: num(),
    author: oneOf(["user", "agent"]),
    target: union([
      obj({ kind: lit("agent"), agentId: str() }),
      obj({ kind: lit("session"), sessionId: str() }),
      obj({ kind: lit("trigger"), triggerId: str() }),
      obj({ kind: lit("skill"), skillId: str() }),
    ]),
    field: str(),
    before: nullable(str()),
    after: nullable(str()),
  }),
);
true satisfies Same<Static<typeof EditLogEntrySchema>, EditLogEntry>;
export const EditLogQuerySchema = obj({ limit: opt(int({ minimum: 1, maximum: 200, description: "Default 50." })) });
export const EditLogResponseSchema = obj({ entries: arr(EditLogEntrySchema) });
true satisfies Same<Static<typeof EditLogResponseSchema>, EditLogResponse>;

export const editLogRoute = defineRoute({
  method: "GET",
  path: "/api/edits",
  tag: "trace",
  summary: "Edits of current state made in the app, newest first.",
  query: EditLogQuerySchema,
  response: EditLogResponseSchema,
});

export const sessionExtraRoutes = [
  sessionContextRoute,
  sessionSummaryRoute,
  relatedSessionsRoute,
  sessionSkillsRoute,
  compactRoute,
  compactStatusRoute,
  forkRoute,
  editMessageRoute,
  switchVersionRoute,
  sessionTraceRoute,
  forkPreviewRoute,
  sessionBrowserRoute,
  startTakeoverRoute,
  editLogRoute,
] as const;
