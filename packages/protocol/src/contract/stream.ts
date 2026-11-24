// Schemas of the two chat streams. docs/contract.md describes the SSE framing around them (`id:`, `event:`, `data:`,
// `retry:`, Last-Event-ID replay), which a schema cannot express; these schemas describe each frame's `data`.
import { arr, bool, int, lit, nullable, obj, oneOf, opt, type Static, str, union } from "@earendil-works/pi-schema";
import type {
  Companion,
  ConversationLive,
  ConversationOverlay,
  GlobalEvent,
  ReiConversationViewV2,
  SessionEvent,
} from "../stream.ts";
import { defineStream, named, type Schema } from "./define.ts";
import {
  AgentSchema,
  ApprovalSchema,
  ErrorInfoSchema,
  MessageSchema,
  RunSchema,
  SessionSchema,
  TakeoverSchema,
} from "./entities.ts";
import type { Same } from "./same.ts";

// ---- global stream --------------------------------------------------------------------------------------------------

export const CompanionSchema = named(
  "Companion",
  obj({
    agentId: str({ description: "The companion agent: the user's pick, or the default agent when none is set." }),
    homeSessionId: str({ description: "The companion agent's home chat, where a companion client quick-sends." }),
  }),
);
true satisfies Same<Static<typeof CompanionSchema>, Companion>;

export const GlobalSnapshotSchema = named(
  "GlobalSnapshot",
  obj({
    type: lit("snapshot"),
    cursor: str({ description: "The cursor this snapshot is at; a reconnect resumes after it." }),
    agents: arr(AgentSchema),
    defaultAgentId: str(),
    companion: CompanionSchema,
    sessions: arr(SessionSchema),
    approvals: arr(ApprovalSchema),
    takeovers: arr(TakeoverSchema),
  }),
);

const SessionRemovedSchema = obj({ type: lit("session.removed"), sessionId: str() });

export const GlobalEventSchema = union([
  GlobalSnapshotSchema,
  obj({ type: lit("agent.upserted"), agent: AgentSchema }),
  obj({ type: lit("agent.removed"), agentId: str() }),
  obj({ type: lit("session.upserted"), session: SessionSchema }),
  SessionRemovedSchema,
  obj({ type: lit("approval.upserted"), approval: ApprovalSchema }),
  obj({ type: lit("takeover.upserted"), takeover: TakeoverSchema }),
  obj({ type: lit("memory.changed"), what: oneOf(["lines", "index"]) }),
  obj({ type: lit("triggers.changed"), triggerId: nullable(str()) }),
  obj({ type: lit("skills.changed") }),
  obj({ type: lit("plugins.changed") }),
  obj({ type: lit("knowledge.changed"), pageId: nullable(str()) }),
  obj({ type: lit("background.changed") }),
  obj({ type: lit("companion.changed"), companion: CompanionSchema }),
]);
true satisfies Same<Static<typeof GlobalEventSchema>, GlobalEvent>;

/** The keep-alive frame of both streams, sent every PING_INTERVAL_MS. */
export const PingSchema = obj({});

// ---- session stream: the Conversation View --------------------------------------------------------------------------

export const ConversationLiveSchema = named(
  "ConversationLive",
  obj({
    runId: nullable(str()),
    turns: opt(int()),
    generation: opt(
      obj({
        attempt: int(),
        text: str(),
        retry: opt(obj({ attempt: int(), error: opt(str()) })),
      }),
    ),
    tools: opt(
      arr(
        obj({
          callId: str(),
          name: str(),
          status: oneOf(["pending", "running", "sleeping", "waiting", "done"]),
          nested: opt(bool()),
          parentCallId: opt(str()),
        }),
      ),
    ),
    compaction: opt(obj({ status: oneOf(["running", "failed"]), error: opt(str()) })),
    manualCompaction: opt(
      obj({
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
        error: opt(str()),
      }),
    ),
    runFailure: opt(obj({ runId: nullable(str()), reason: str(), error: ErrorInfoSchema, canContinue: bool() })),
  }),
);
true satisfies Same<Static<typeof ConversationLiveSchema>, ConversationLive>;

export const ConversationOverlaySchema = named(
  "ConversationOverlay",
  obj({
    itemId: str(),
    kind: oneOf(["approval", "takeover", "memory"]),
    anchor: union([obj({ taskId: str(), parentCallId: opt(str()) }), obj({ entryId: str() }), obj({ runId: str() })]),
  }),
);
true satisfies Same<Static<typeof ConversationOverlaySchema>, ConversationOverlay>;

export const ConversationViewSchema = named(
  "ConversationView",
  obj({
    version: lit(2),
    session: SessionSchema,
    items: arr(MessageSchema),
    runs: arr(RunSchema),
    before: nullable(str()),
    live: ConversationLiveSchema,
    overlays: arr(ConversationOverlaySchema),
  }),
);
true satisfies Same<Static<typeof ConversationViewSchema>, ReiConversationViewV2>;

const envelope = { epoch: str(), rev: int({ minimum: 0 }) } as const;
export const SessionEventSchema = union([
  obj({ type: lit("snapshot"), ...envelope, view: ConversationViewSchema }),
  obj({
    type: lit("patch"),
    ...envelope,
    upsert: opt(arr(MessageSchema)),
    remove: opt(arr(str())),
    order: opt(arr(str())),
    runs: opt(arr(RunSchema)),
    live: opt(ConversationLiveSchema),
    overlays: opt(arr(ConversationOverlaySchema)),
    session: opt(SessionSchema),
    before: opt(nullable(str())),
  }),
  obj({ type: lit("resync_required"), ...envelope }),
  SessionRemovedSchema,
]);
true satisfies Same<Static<typeof SessionEventSchema>, SessionEvent>;

// ---- the streams ----------------------------------------------------------------------------------------------------

/** One schema per `event:` name, from the union tagged by `type` (the event name is the frame's `type`). */
function byType(events: readonly { readonly properties?: unknown }[]): Record<string, Schema> {
  const out: Record<string, Schema> = {};
  for (const event of events) {
    const type = (event.properties as { type?: { const?: string } } | undefined)?.type?.const;
    if (typeof type !== "string") throw new Error("A stream event schema has no literal type.");
    out[type] = event as Schema;
  }
  return out;
}
const members = (schema: object): readonly { readonly properties?: unknown }[] =>
  ((schema as { anyOf?: unknown[] }).anyOf ?? []) as { readonly properties?: unknown }[];

export const globalStream = defineStream({
  name: "global",
  path: "/api/stream",
  summary: "Agents, the session list, pending approvals and takeovers, and change notices.",
  events: { ...byType(members(GlobalEventSchema)), ping: PingSchema },
});

export const sessionStream = defineStream({
  name: "session",
  path: "/api/sessions/:id/stream",
  summary: "One session's Conversation View: a snapshot, then patches.",
  events: { ...byType(members(SessionEventSchema)), ping: PingSchema },
});

export const streamContracts = [globalStream, sessionStream];
