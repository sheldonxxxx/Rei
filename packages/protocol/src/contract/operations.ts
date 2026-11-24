// Triggers, usage, storage diagnostics, grants, takeovers and steps (issue 19). Request and response types still live
// in ../triggers.ts, ../usage.ts, ../memory.ts, ../api.ts, ../browser.ts and ../trace.ts as interfaces; each schema here
// is checked against its interface at compile time.
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
  unknown,
} from "@earendil-works/pi-schema";
import type { GrantsResponse } from "../api.ts";
import type { EndTakeoverRequest, EndTakeoverResponse } from "../browser.ts";
import type { Grant } from "../entities.ts";
import { GATEWAY_CALLER_SCOPES, type GatewayModelUsage } from "../gateway.ts";
import type { StorageStatusResponse } from "../memory.ts";
import type { ScriptCall, StepSummary, ToolOutputPart, WebDocumentResponse, WebFetchDetails } from "../trace.ts";
import type {
  EventSourcesResponse,
  RunTriggerResponse,
  Schedule,
  Trigger,
  TriggerResponse,
  TriggerRunSummary,
  TriggerStart,
  TriggersResponse,
  TriggerUpdatedResponse,
  UpdateTriggerRequest,
} from "../triggers.ts";
import {
  type CallerUsageResponse,
  USAGE_METRICS,
  USAGE_PERIODS,
  USAGE_PURPOSES,
  type UsageCallerSummary,
  type UsageCallersResponse,
  type UsageResponse,
  type UsageTotals,
} from "../usage.ts";
import { OkSchema } from "./auth.ts";
import { defineRoute, named } from "./define.ts";
import { ActionClassSchema, ErrorInfoSchema, TakeoverSchema } from "./entities.ts";
import type { Same } from "./same.ts";

// ---- triggers -------------------------------------------------------------------------------------------------------

const WeekdaySchema = oneOf(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const ScheduleSchema = named(
  "Schedule",
  union([
    obj({ kind: lit("once"), at: str(), timeZone: str() }),
    obj({ kind: lit("daily"), times: arr(str()), days: opt(arr(WeekdaySchema)), timeZone: str() }),
    obj({ kind: lit("monthly"), day: union([int(), lit("last")]), times: arr(str()), timeZone: str() }),
    obj({
      kind: lit("interval"),
      everyMinutes: int(),
      from: opt(str()),
      until: opt(str()),
      days: opt(arr(WeekdaySchema)),
      timeZone: str(),
    }),
  ]),
);
true satisfies Same<Static<typeof ScheduleSchema>, Schedule>;
export const TriggerStartSchema = named(
  "TriggerStart",
  union([
    obj({ kind: lit("schedule"), schedule: ScheduleSchema }),
    obj({ kind: lit("event"), source: str(), types: arr(str()) }),
  ]),
);
true satisfies Same<Static<typeof TriggerStartSchema>, TriggerStart>;
const TriggerActionSchema = union([
  obj({ kind: lit("notify"), message: str() }),
  obj({ kind: lit("prompt"), prompt: str() }),
  obj({ kind: lit("skill"), skill: str(), args: opt(str()) }),
]);
const ReportSettingSchema = oneOf(["always", "on_change", "never"]);
const TriggerProfileSchema = oneOf(["strict", "standard", "relaxed"]);

const TriggerRunEventSchema = obj({ id: str(), type: str(), ref: str(), receivedAt: num() });

export const TriggerRunSummarySchema = named(
  "TriggerRunSummary",
  obj({
    id: str(),
    triggerId: str(),
    scheduledAt: num(),
    startedAt: nullable(num()),
    finishedAt: nullable(num()),
    status: oneOf(["queued", "running", "waiting", "succeeded", "failed", "skipped"]),
    reason: nullable(str()),
    manual: bool(),
    sessionId: nullable(str()),
    runId: nullable(str()),
    skillVersion: nullable(int()),
    report: nullable(str()),
    attempt: int(),
    events: arr(TriggerRunEventSchema),
    droppedEvents: int(),
  }),
);
true satisfies Same<Static<typeof TriggerRunSummarySchema>, TriggerRunSummary>;

export const TriggerSchema = named(
  "Trigger",
  obj({
    id: str(),
    name: str(),
    agentId: str(),
    start: TriggerStartSchema,
    startText: str(),
    action: TriggerActionSchema,
    landing: oneOf(["new", "ongoing"]),
    ongoingSessionId: nullable(str()),
    report: ReportSettingSchema,
    latenessMinutes: int(),
    catchUp: oneOf(["once", "skip"]),
    overlap: oneOf(["skip", "queue"]),
    profile: TriggerProfileSchema,
    allow: arr(obj({ tool: str(), destination: opt(str()), actionClass: ActionClassSchema, label: str() })),
    status: oneOf(["active", "paused", "done"]),
    pausedReason: nullable(oneOf(["user", "agent", "failures"])),
    failures: int(),
    nextRunAt: nullable(num()),
    lastEventAt: nullable(num()),
    lastRun: nullable(TriggerRunSummarySchema),
    createdAt: num(),
    updatedAt: num(),
  }),
);
true satisfies Same<Static<typeof TriggerSchema>, Trigger>;

export const EventSourcesResponseSchema = obj({
  sources: arr(
    obj({
      id: str(),
      name: str(),
      status: oneOf(["active", "disabled"]),
      lastEventAt: nullable(num()),
      types: arr(str()),
    }),
  ),
});
true satisfies Same<Static<typeof EventSourcesResponseSchema>, EventSourcesResponse>;
export const TriggersResponseSchema = obj({ triggers: arr(TriggerSchema) });
true satisfies Same<Static<typeof TriggersResponseSchema>, TriggersResponse>;
export const TriggerQuerySchema = obj({ before: opt(str({ description: "A run id: runs older than it." })) });
export const TriggerResponseSchema = obj({
  trigger: TriggerSchema,
  runs: arr(TriggerRunSummarySchema),
  next: nullable(str()),
});
true satisfies Same<Static<typeof TriggerResponseSchema>, TriggerResponse>;
export const UpdateTriggerRequestSchema = obj({
  name: opt(str()),
  start: opt(TriggerStartSchema),
  action: opt(TriggerActionSchema),
  landing: opt(oneOf(["new", "ongoing"])),
  report: opt(ReportSettingSchema),
  latenessMinutes: opt(int()),
  catchUp: opt(oneOf(["once", "skip"])),
  overlap: opt(oneOf(["skip", "queue"])),
  profile: opt(TriggerProfileSchema),
  allow: opt(arr(obj({ tool: str(), destination: opt(str()) }))),
  paused: opt(bool()),
});
true satisfies Same<Static<typeof UpdateTriggerRequestSchema>, UpdateTriggerRequest>;
export const TriggerUpdatedResponseSchema = obj({ trigger: TriggerSchema });
true satisfies Same<Static<typeof TriggerUpdatedResponseSchema>, TriggerUpdatedResponse>;
export const RunTriggerResponseSchema = obj({ run: TriggerRunSummarySchema });
true satisfies Same<Static<typeof RunTriggerResponseSchema>, RunTriggerResponse>;
export const DeleteTriggerQuerySchema = obj({ withSessions: opt(lit("1")) });

export const triggersRoute = defineRoute({
  method: "GET",
  path: "/api/triggers",
  tag: "triggers",
  summary: "Every trigger.",
  response: TriggersResponseSchema,
});
export const eventSourcesRoute = defineRoute({
  method: "GET",
  path: "/api/event-sources",
  tag: "triggers",
  summary: "The event sources, with their last event and the types they sent lately. Read-only.",
  response: EventSourcesResponseSchema,
});
export const triggerRoute = defineRoute({
  method: "GET",
  path: "/api/triggers/:id",
  tag: "triggers",
  summary: "A trigger and its newest 50 runs.",
  description: 'Errors: "not_found".',
  query: TriggerQuerySchema,
  response: TriggerResponseSchema,
});
export const updateTriggerRoute = defineRoute({
  method: "PATCH",
  path: "/api/triggers/:id",
  tag: "triggers",
  summary: "Edit, pause or resume a trigger; each changed field goes to the edit log.",
  description: 'Errors: "not_found", "bad_request".',
  body: UpdateTriggerRequestSchema,
  response: TriggerUpdatedResponseSchema,
});
export const runTriggerRoute = defineRoute({
  method: "POST",
  path: "/api/triggers/:id/run",
  tag: "triggers",
  summary: "Run a trigger now.",
  description: 'Errors: "not_found".',
  response: RunTriggerResponseSchema,
});
export const deleteTriggerRoute = defineRoute({
  method: "DELETE",
  path: "/api/triggers/:id",
  tag: "triggers",
  summary: "Remove a trigger and its run history; with withSessions=1 its sessions too.",
  description: 'Errors: "not_found".',
  query: DeleteTriggerQuerySchema,
  response: OkSchema,
});

// ---- outside events (ADR 0019) -------------------------------------------------------------------------------------

export const EventAnswerSchema = obj({ accepted: opt(lit(true)), duplicate: opt(lit(true)) });
export const receiveEventRoute = defineRoute({
  method: "POST",
  path: "/api/events/:source",
  tag: "events",
  summary: "Receive one signed event from an event source (not a device route: it is signed, not signed in).",
  description:
    'Standard Webhooks headers webhook-id, webhook-timestamp and webhook-signature; the body is JSON, at most 2 KB: { type, ref, occurredAt? }. Answers: 202 { accepted }, 200 { duplicate }, and errors with a code only: 404 "unknown_source", 413 "too_large", 401 "bad_signature" or "stale_timestamp", 400 "bad_event", 429 "too_many" with retry-after. See docs/events.md.',
  response: EventAnswerSchema,
});

// ---- usage and storage ----------------------------------------------------------------------------------------------

type Metric = (typeof USAGE_METRICS)[number];
const metrics = <S extends Parameters<typeof obj>[0][string]>(value: () => S) =>
  obj(Object.fromEntries(USAGE_METRICS.map((m) => [m, value()])) as Record<Metric, S>);
export const UsageTotalsSchema = named(
  "UsageTotals",
  obj({
    tokens: metrics(() => nullable(num())),
    unknown: metrics(() => num()),
    modelCalls: int(),
    callsReported: int(),
    callsUnreported: int(),
    cacheHitPercent: nullable(num()),
  }),
);
true satisfies Same<Static<typeof UsageTotalsSchema>, UsageTotals>;
const UsageDaySchema = (description: string) => str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", maxLength: 10, description });
export const UsageQuerySchema = obj({
  period: opt(oneOf(USAGE_PERIODS, { description: "Default 30d." })),
  from: opt(UsageDaySchema("First UTC day (YYYY-MM-DD) of a custom period.")),
  to: opt(UsageDaySchema("Last UTC day (YYYY-MM-DD) of a custom period; later days count as today.")),
});
const GatewayEmbeddingsUsageSchema = obj({
  calls: int(),
  ok: int(),
  errors: int(),
  inputTokens: nullable(num()),
  averageMs: nullable(int()),
});
const GatewayReadsUsageSchema = obj({
  calls: int(),
  ok: int(),
  errors: int(),
  averageMs: nullable(int()),
});
export const UsageResponseSchema = obj({
  period: oneOf(USAGE_PERIODS),
  timezone: lit("UTC"),
  trackingSince: str(),
  from: str(),
  to: str(),
  summary: UsageTotalsSchema,
  byPurpose: arr(obj({ purpose: oneOf(USAGE_PURPOSES), usage: UsageTotalsSchema })),
  byModel: arr(obj({ provider: str(), providerName: str(), model: str(), usage: UsageTotalsSchema })),
  byAgent: arr(obj({ agentId: nullable(str()), usage: UsageTotalsSchema })),
  daily: arr(obj({ day: str(), usage: UsageTotalsSchema })),
  search: obj({
    searches: int(),
    answered: int(),
    empty: int(),
    failed: int(),
    searchesWithFallback: int(),
    byProvider: arr(
      obj({
        provider: str(),
        providerName: str(),
        succeeded: int(),
        empty: int(),
        failed: int(),
        skipped: int(),
        fallback: int(),
        answeredAfterFallback: int(),
        averageMs: nullable(int()),
        details: arr(
          obj({
            outcome: oneOf(["succeeded", "empty", "failed", "skipped"] as const),
            reason: nullable(str()),
            fallback: bool(),
            calls: int(),
          }),
        ),
      }),
    ),
  }),
  images: obj({
    requests: int(),
    succeeded: int(),
    failed: int(),
    generated: int(),
    edited: int(),
    averageMs: nullable(int()),
    failures: arr(obj({ reason: oneOf(["rate_limited", "busy", "sign_in_required", "error"] as const), calls: int() })),
  }),
  embeddings: opt(GatewayEmbeddingsUsageSchema),
  reads: opt(GatewayReadsUsageSchema),
});
true satisfies Same<Static<typeof UsageResponseSchema>, UsageResponse>;
export const StorageStatusResponseSchema = obj({
  files: obj({
    bucket: str(),
    pending: int(),
    ready: int(),
    deletePending: int(),
    failed: int(),
    readyBytes: int(),
    lastError: nullable(str()),
  }),
  search: obj({
    configured: bool(),
    ok: nullable(bool()),
    detail: nullable(str()),
    lexicalCollection: nullable(str()),
    lexicalPoints: nullable(int()),
    dense: arr(obj({ collection: str(), points: int() })),
    queued: int(),
    queueError: nullable(str()),
  }),
});
true satisfies Same<Static<typeof StorageStatusResponseSchema>, StorageStatusResponse>;

export const UsageCallerSummarySchema = named(
  "UsageCallerSummary",
  obj({
    id: str(),
    note: str(),
    scopes: arr(oneOf(GATEWAY_CALLER_SCOPES)),
    revokedAt: nullable(num()),
    lastUsedAt: nullable(num()),
  }),
);
true satisfies Same<Static<typeof UsageCallerSummarySchema>, UsageCallerSummary>;

export const UsageCallersResponseSchema = obj({
  available: bool(),
  callers: arr(UsageCallerSummarySchema),
});
true satisfies Same<Static<typeof UsageCallersResponseSchema>, UsageCallersResponse>;

const gatewayModelUsageFields = {
  inputTotal: nullable(num()),
  inputCached: nullable(num()),
  inputUncached: nullable(num()),
  outputTotal: nullable(num()),
  totalProcessed: nullable(num()),
  cacheHitPercent: nullable(num()),
  calls: int(),
  callsReported: int(),
  callsUnreported: int(),
  ok: int(),
  errors: int(),
  upstreamLimited: int(),
};
export const GatewayModelUsageSchema = named("GatewayModelUsage", obj(gatewayModelUsageFields));
true satisfies Same<Static<typeof GatewayModelUsageSchema>, GatewayModelUsage>;

export const GatewayUsageQuerySchema = obj({
  caller: opt(str({ maxLength: 40, description: "Outside caller id; omit for all callers combined." })),
  period: opt(oneOf(USAGE_PERIODS, { description: "Default 30d." })),
  from: opt(UsageDaySchema("First UTC day (YYYY-MM-DD) of a custom period.")),
  to: opt(UsageDaySchema("Last UTC day (YYYY-MM-DD) of a custom period; later days count as today.")),
});

export const CallerUsageResponseSchema = obj({
  period: oneOf(USAGE_PERIODS),
  timezone: lit("UTC"),
  trackingSince: str(),
  from: str(),
  to: str(),
  caller: nullable(UsageCallerSummarySchema),
  models: obj({
    summary: GatewayModelUsageSchema,
    byModel: arr(obj({ provider: str(), providerName: str(), model: str(), ...gatewayModelUsageFields })),
  }),
  byCaller: arr(
    obj({
      caller: str(),
      inputTotal: nullable(num()),
      inputCached: nullable(num()),
      outputTotal: nullable(num()),
      modelCalls: int(),
      searchCalls: int(),
      embeddingCalls: int(),
      readCalls: int(),
      errors: int(),
      upstreamLimited: int(),
      refusals: int(),
    }),
  ),
  search: obj({
    calls: int(),
    ok: int(),
    errors: int(),
    averageMs: nullable(int()),
    byProvider: arr(
      obj({
        provider: str(),
        providerName: str(),
        calls: int(),
        ok: int(),
        errors: int(),
        averageMs: nullable(int()),
      }),
    ),
  }),
  embeddings: GatewayEmbeddingsUsageSchema,
  reads: GatewayReadsUsageSchema,
  refusals: arr(obj({ code: str(), count: int() })),
  errorBreakdown: arr(obj({ code: str(), count: int() })),
});
true satisfies Same<Static<typeof CallerUsageResponseSchema>, CallerUsageResponse>;

export const usageRoute = defineRoute({
  method: "GET",
  path: "/api/usage",
  tag: "usage",
  summary: "Token counters for a period, by purpose, model, agent and day (UTC).",
  description:
    'Errors: "bad_request" (any other parameter, more than one period, from or to outside a custom period, a custom period missing from or to, or from after to).',
  query: UsageQuerySchema,
  response: UsageResponseSchema,
});
export const usageCallersRoute = defineRoute({
  method: "GET",
  path: "/api/usage/callers",
  tag: "usage",
  summary: "Outside gateway callers available on the Usage page (no tokens or fingerprints).",
  response: UsageCallersResponseSchema,
});
export const gatewayUsageRoute = defineRoute({
  method: "GET",
  path: "/api/usage/gateway",
  tag: "usage",
  summary: "Gateway-recorded usage for one outside caller or all callers combined (UTC).",
  description:
    'Errors: "bad_request" (invalid period or range), "not_found" (unknown caller), "gateway_unavailable" (gateway unconfigured or unreachable).',
  query: GatewayUsageQuerySchema,
  response: CallerUsageResponseSchema,
});
export const storageDiagnosticsRoute = defineRoute({
  method: "GET",
  path: "/api/diagnostics/storage",
  tag: "usage",
  summary: "What SQLite, the object store and the retrieval service agree about: counts and states only.",
  response: StorageStatusResponseSchema,
});

// ---- grants and takeovers -------------------------------------------------------------------------------------------

export const GrantSchema = named(
  "Grant",
  obj({
    id: str(),
    connector: str(),
    operation: str(),
    destination: nullable(str()),
    length: oneOf(["session", "web_session", "agent", "hours", "always"]),
    sessionId: nullable(str()),
    agentId: nullable(str()),
    expiresAt: nullable(num()),
    approvalId: str(),
    createdAt: num(),
  }),
);
true satisfies Same<Static<typeof GrantSchema>, Grant>;
export const GrantsResponseSchema = obj({ grants: arr(GrantSchema) });
true satisfies Same<Static<typeof GrantsResponseSchema>, GrantsResponse>;
export const EndTakeoverRequestSchema = obj({
  action: oneOf(["done", "cancel"]),
  note: opt(str({ maxLength: 500 })),
});
true satisfies Same<Static<typeof EndTakeoverRequestSchema>, EndTakeoverRequest>;
export const EndTakeoverResponseSchema = obj({ takeover: TakeoverSchema });
true satisfies Same<Static<typeof EndTakeoverResponseSchema>, EndTakeoverResponse>;

export const grantsRoute = defineRoute({
  method: "GET",
  path: "/api/grants",
  tag: "approvals",
  summary: "Grants in force, newest first.",
  response: GrantsResponseSchema,
});
export const revokeGrantRoute = defineRoute({
  method: "DELETE",
  path: "/api/grants/:id",
  tag: "approvals",
  summary: "Revoke a grant (logged).",
  description: 'Errors: "not_found".',
  response: OkSchema,
});
export const endTakeoverRoute = defineRoute({
  method: "POST",
  path: "/api/takeovers/:id/end",
  tag: "browser",
  summary: "Finish or cancel a browser takeover.",
  description: 'Errors: "not_found", "not_open".',
  body: EndTakeoverRequestSchema,
  response: EndTakeoverResponseSchema,
});

// ---- steps ----------------------------------------------------------------------------------------------------------

export const StepSummarySchema = named(
  "StepSummary",
  obj({
    id: str(),
    runId: nullable(str()),
    sessionId: str(),
    type: oneOf(["llm.call", "tool.call", "capabilities.changed"]),
    status: oneOf(["running", "ok", "error", "blocked", "cancelled", "not_executed"]),
    startedAt: num(),
    latencyMs: nullable(num()),
    piEntryId: nullable(str()),
    sideEffect: bool(),
    provider: opt(str()),
    providerName: opt(str()),
    model: opt(str()),
    firstByteMs: opt(nullable(num())),
    tokens: opt(
      obj({
        input: nullable(num()),
        output: nullable(num()),
        cached: nullable(num()),
        reasoning: nullable(num()),
        total: nullable(num()),
      }),
    ),
    prefix: opt(obj({ matched: nullable(num()), items: num() })),
    errorCode: opt(nullable(str())),
    toolName: opt(str()),
    actionClass: opt(ActionClassSchema),
    decision: opt(oneOf(["allow", "granted", "ask", "deny"])),
    approvalId: opt(nullable(str())),
    summary: opt(str()),
    activity: opt(str()),
    toolCallId: opt(str()),
    parentStepId: opt(str()),
    page: opt(obj({ id: str(), title: str(), trashed: bool() })),
    web: opt(obj({ title: str(), host: str() })),
  }),
);
true satisfies Same<Static<typeof StepSummarySchema>, StepSummary>;
export const WebFetchDetailsSchema = named(
  "WebFetchDetails",
  obj({
    method: oneOf(["http", "render"]),
    cache: oneOf(["hit", "miss", "refresh"]),
    mode: opt(oneOf(["overview", "whole", "query", "section", "offset"])),
    host: str(),
    title: opt(str()),
    quality: opt(str()),
    extractor: opt(str()),
    sections: opt(arr(str())),
    status: opt(int()),
    bytes: opt(int()),
    mediaType: opt(str()),
    redirects: opt(int()),
    tokensReturned: opt(int()),
    pageTokens: opt(int()),
    pageChars: opt(int()),
    render: opt(
      named(
        "WebRenderDetails",
        obj({
          reason: oneOf(["requires_js", "low_quality", "forced"]),
          skipped: opt(oneOf(["off", "unavailable"])),
          queueMs: opt(num()),
          renderMs: opt(num()),
          ended: opt(oneOf(["stable", "deadline"])),
          connections: opt(int()),
          refused: opt(int()),
          blockedMedia: opt(int()),
          truncated: opt(lit(true)),
          failed: opt(lit(true)),
          engine: opt(oneOf(["moli", "chromium"])),
          engineVersion: opt(str()),
          fallback: opt(obj({ from: oneOf(["moli", "chromium"]), reason: oneOf(["failed", "requires_js", "thin"]) })),
        }),
      ),
    ),
    durationMs: num(),
    error: opt(lit(true)),
  }),
);
true satisfies Same<Static<typeof WebFetchDetailsSchema>, WebFetchDetails>;
const ScriptCallSchema = named(
  "ScriptCall",
  obj({
    id: int(),
    name: str(),
    args: str(),
    status: oneOf(["running", "ok", "error", "cancelled"]),
    durationMs: opt(num()),
    error: opt(str()),
  }),
);
true satisfies Same<Static<typeof ScriptCallSchema>, ScriptCall>;
export const WebDocumentResponseSchema = obj({
  title: str(),
  url: str(),
  text: str(),
  note: opt(str()),
  quality: str(),
  extractor: str(),
  fetchedAt: num(),
  expiresAt: num(),
});
true satisfies Same<Static<typeof WebDocumentResponseSchema>, WebDocumentResponse>;
export const ToolOutputPartSchema = union([
  obj({ type: lit("text"), text: str() }),
  obj({ type: lit("image"), index: int(), mimeType: str() }),
]);
true satisfies Same<Static<typeof ToolOutputPartSchema>, ToolOutputPart>;
const LoadReasonSchema = oneOf(["group", "ranked", "load"]);
/** The recorded payloads (`request`, `response`, `input`) are whatever the provider or tool exchanged. */
export const StepDetailResponseSchema = obj({
  step: StepSummarySchema,
  llm: opt(
    obj({
      request: unknown(),
      response: unknown(),
      error: opt(ErrorInfoSchema),
      tools: opt(
        obj({
          offered: arr(str()),
          previousStepId: opt(str()),
          added: arr(obj({ name: str(), loadedBy: opt(str()), reason: opt(LoadReasonSchema), group: opt(str()) })),
          removed: arr(str()),
        }),
      ),
    }),
  ),
  tool: opt(
    obj({
      input: unknown(),
      output: arr(ToolOutputPartSchema),
      isError: bool(),
      discovery: opt(
        obj({
          query: opt(str()),
          candidates: arr(obj({ name: str(), kind: oneOf(["tool", "skill"]), coverage: num(), score: num() })),
          loaded: arr(obj({ name: str(), reason: LoadReasonSchema, group: opt(str()) })),
          alreadyLoaded: arr(str()),
          alsoRelevant: arr(str()),
          skills: arr(str()),
          directory: opt(obj({ connectorId: str(), connectorName: str(), tools: int() })),
          notFound: arr(str()),
        }),
      ),
      fetch: opt(WebFetchDetailsSchema),
      script: opt(obj({ calls: arr(ScriptCallSchema) })),
    }),
  ),
  change: opt(obj({ connectors: arr(str()), added: arr(str()), removed: arr(str()), changed: arr(str()) })),
  payloadBytes: int(),
  truncated: bool(),
});

export const stepRoute = defineRoute({
  method: "GET",
  path: "/api/steps/:id",
  tag: "trace",
  summary: "One step's recorded payload; strings over 200,000 characters are cut.",
  description: 'Errors: "not_found".',
  response: StepDetailResponseSchema,
});
export const stepWebDocumentRoute = defineRoute({
  method: "GET",
  path: "/api/steps/:id/web-document",
  tag: "trace",
  summary:
    "The readable copy of the page a web_fetch step read, while the agent still stores it. For people only: it never goes to the model.",
  description: 'Errors: "not_found" (no such step, not a web_fetch step, or the copy is no longer stored).',
  response: WebDocumentResponseSchema,
});
export const stepImageRoute = defineRoute({
  method: "GET",
  path: "/api/steps/:id/images/:index",
  tag: "trace",
  summary: "A picture from a tool's output.",
  description: 'Errors: "not_found".',
  raw: { kind: "binary", contentType: "image/*" },
});

export const operationRoutes = [
  triggersRoute,
  eventSourcesRoute,
  triggerRoute,
  updateTriggerRoute,
  runTriggerRoute,
  deleteTriggerRoute,
  receiveEventRoute,
  usageRoute,
  usageCallersRoute,
  gatewayUsageRoute,
  storageDiagnosticsRoute,
  grantsRoute,
  revokeGrantRoute,
  endTakeoverRoute,
  stepRoute,
  stepImageRoute,
  stepWebDocumentRoute,
] as const;
