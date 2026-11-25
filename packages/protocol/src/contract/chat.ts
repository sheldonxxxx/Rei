// The chat subset (milestone 1): what a companion client needs to list agents and chats, read and send in a chat,
// answer approvals, attach files, and be notified. Request and response types still live in ../api.ts as interfaces;
// each schema here is checked against its interface at compile time.
import { arr, bool, int, lit, nullable, num, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type {
  AgentsResponse,
  ApprovalsResponse,
  CancelResponse,
  CompanionResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DecideApprovalGroupRequest,
  DecideApprovalRequest,
  DecideApprovalResponse,
  DeleteSessionQuery,
  DeleteSessionResponse,
  GlanceResponse,
  NotificationsResponse,
  PresenceRequest,
  PushKeyResponse,
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  ReadMarker,
  ReadMarkerResponse,
  SendMessageRequest,
  SendMessageResponse,
  SessionDetailResponse,
  SessionsResponse,
  TranscriptPageResponse,
  UpdateCompanionRequest,
  UpdatePreviewRequest,
  UpdateSessionRequest,
  UpdateSessionResponse,
} from "../api.ts";
import { defineRoute } from "./define.ts";
import {
  AgentSchema,
  ApprovalSchema,
  AttachmentSchema,
  FileReferenceSchema,
  GrantLengthSchema,
  MessageMentionSchema,
  MessageSchema,
  ProfileInputSchema,
  RunSchema,
  SelectedSkillSchema,
  SessionSchema,
} from "./entities.ts";
import type { Same } from "./same.ts";
import { CompanionSchema, ConversationLiveSchema } from "./stream.ts";

const flag = () => lit("1");

// ---- agents and sessions --------------------------------------------------------------------------------------------

export const AgentsResponseSchema = obj({
  agents: arr(AgentSchema),
  defaultAgentId: str(),
  companion: CompanionSchema,
});
true satisfies Same<Static<typeof AgentsResponseSchema>, AgentsResponse>;
export const UpdateCompanionRequestSchema = obj({ agentId: str({ minLength: 1 }) });
true satisfies Same<Static<typeof UpdateCompanionRequestSchema>, UpdateCompanionRequest>;
export const CompanionResponseSchema = obj({ companion: CompanionSchema });
true satisfies Same<Static<typeof CompanionResponseSchema>, CompanionResponse>;

export const SessionsQuerySchema = obj({
  paged: opt(flag()),
  agent: opt(str()),
  before: opt(str()),
  triggers: opt(flag()),
});
export const SessionsResponseSchema = obj({ sessions: arr(SessionSchema), nextCursor: opt(nullable(str())) });
true satisfies Same<Static<typeof SessionsResponseSchema>, SessionsResponse>;

export const CreateSessionRequestSchema = obj({ agentId: opt(str()) });
true satisfies Same<Static<typeof CreateSessionRequestSchema>, CreateSessionRequest>;
export const SessionResponseSchema = obj({ session: SessionSchema });
true satisfies Same<Static<typeof SessionResponseSchema>, CreateSessionResponse>;
true satisfies Same<Static<typeof SessionResponseSchema>, UpdateSessionResponse>;

export const SessionDetailResponseSchema = obj({
  session: SessionSchema,
  messages: arr(MessageSchema),
  runs: arr(RunSchema),
  before: opt(nullable(str())),
  live: opt(ConversationLiveSchema),
});
true satisfies Same<Static<typeof SessionDetailResponseSchema>, SessionDetailResponse>;

export const UpdateSessionRequestSchema = obj({
  profile: opt(ProfileInputSchema),
  title: opt(str({ description: "1 to 80 characters once whitespace is collapsed." })),
  pinned: opt(bool()),
});
true satisfies Same<Static<typeof UpdateSessionRequestSchema>, UpdateSessionRequest>;

export const DeleteSessionQuerySchema = obj({ withForks: opt(flag()), clearHome: opt(flag()) });
true satisfies Same<Static<typeof DeleteSessionQuerySchema>, DeleteSessionQuery>;
export const DeleteSessionResponseSchema = obj({ ok: lit(true), homeSessionId: opt(str()) });
true satisfies Same<Static<typeof DeleteSessionResponseSchema>, DeleteSessionResponse>;

export const TranscriptQuerySchema = obj({ before: str({ minLength: 1 }), limit: opt(int({ minimum: 1 })) });
export const TranscriptPageResponseSchema = obj({ items: arr(MessageSchema), before: nullable(str()) });
true satisfies Same<Static<typeof TranscriptPageResponseSchema>, TranscriptPageResponse>;

export const SendMessageRequestSchema = obj({
  requestId: str({ minLength: 1, maxLength: 200, description: "Client-generated and unique per message." }),
  text: str(),
  files: opt(arr(FileReferenceSchema)),
  mentions: opt(arr(MessageMentionSchema)),
  selectedSkills: opt(arr(SelectedSkillSchema)),
  whenBusy: opt(oneOf(["steer", "queue"])),
});
true satisfies Same<Static<typeof SendMessageRequestSchema>, SendMessageRequest>;
export const SendMessageResponseSchema = obj({ messageId: str(), runId: str() });
true satisfies Same<Static<typeof SendMessageResponseSchema>, SendMessageResponse>;

export const CancelResponseSchema = obj({ cancelledRunId: nullable(str()) });
true satisfies Same<Static<typeof CancelResponseSchema>, CancelResponse>;
export const ContinueResponseSchema = obj({ runId: str() });

export const AttachmentResponseSchema = obj({ attachment: AttachmentSchema });
export const AttachmentUploadSchema = obj({
  file: str({ format: "binary", description: "One file, at most 1 GiB." }),
});
export const AttachmentQuerySchema = obj({ preview: opt(flag()) });

// ---- approvals ------------------------------------------------------------------------------------------------------

export const ApprovalsResponseSchema = obj({ approvals: arr(ApprovalSchema) });
true satisfies Same<Static<typeof ApprovalsResponseSchema>, ApprovalsResponse>;
export const DecideApprovalRequestSchema = obj({
  decision: oneOf(["approve", "deny"]),
  length: opt(GrantLengthSchema),
  hours: opt(num({ description: "For length hours: 1 to 168." })),
});
true satisfies Same<Static<typeof DecideApprovalRequestSchema>, DecideApprovalRequest>;
export const DecideApprovalResponseSchema = obj({ approval: ApprovalSchema });
true satisfies Same<Static<typeof DecideApprovalResponseSchema>, DecideApprovalResponse>;
export const DecideApprovalGroupRequestSchema = obj({
  decisions: arr(obj({ id: str({ minLength: 1 }), decision: oneOf(["approve", "deny"]) }), {
    minItems: 1,
    maxItems: 64,
  }),
});
true satisfies Same<Static<typeof DecideApprovalGroupRequestSchema>, DecideApprovalGroupRequest>;

// ---- notifications --------------------------------------------------------------------------------------------------

export const PushKeyResponseSchema = obj({ publicKey: str() });
true satisfies Same<Static<typeof PushKeyResponseSchema>, PushKeyResponse>;
const BASE64URL = "^[A-Za-z0-9_-]+={0,2}$";
export const PushSubscribeRequestSchema = obj({
  subscription: obj(
    {
      endpoint: str({ maxLength: 2000, pattern: "^https://" }),
      keys: obj(
        {
          p256dh: str({ minLength: 1, maxLength: 200, pattern: BASE64URL }),
          auth: str({ minLength: 1, maxLength: 100, pattern: BASE64URL }),
        },
        { open: true },
      ),
    },
    { open: true },
  ),
  label: str(),
});
true satisfies Same<Static<typeof PushSubscribeRequestSchema>, PushSubscribeRequest>;
export const PushUnsubscribeRequestSchema = obj({ endpoint: str({ minLength: 1 }) });
true satisfies Same<Static<typeof PushUnsubscribeRequestSchema>, PushUnsubscribeRequest>;
export const PresenceRequestSchema = obj({ visible: bool() });
true satisfies Same<Static<typeof PresenceRequestSchema>, PresenceRequest>;

export const NotificationsResponseSchema = obj({
  devices: int({ minimum: 0, description: "Devices with a Web Push channel." }),
  preview: bool(),
});
true satisfies Same<Static<typeof NotificationsResponseSchema>, NotificationsResponse>;
export const UpdatePreviewRequestSchema = obj({ preview: bool() });
true satisfies Same<Static<typeof UpdatePreviewRequestSchema>, UpdatePreviewRequest>;

// ---- routes ---------------------------------------------------------------------------------------------------------

export const listAgentsRoute = defineRoute({
  method: "GET",
  path: "/api/agents",
  tag: "chat",
  summary: "Every agent, which one is the default, and the companion agent with its home chat.",
  response: AgentsResponseSchema,
});
export const updateCompanionRoute = defineRoute({
  method: "PUT",
  path: "/api/settings/companion",
  tag: "chat",
  summary: "Pick the companion agent, the agent companion clients (widgets, quick-send) talk to.",
  description:
    "Every client hears companion.changed on the global stream. When the companion agent is deleted, the default agent takes over. Errors: unknown_agent.",
  body: UpdateCompanionRequestSchema,
  response: CompanionResponseSchema,
  fieldCodes: { agentId: "unknown_agent" },
});
export const listSessionsRoute = defineRoute({
  method: "GET",
  path: "/api/sessions",
  tag: "chat",
  summary: "The sessions: all of them, or with paged=1 up to 30 history sessions of one agent per page.",
  description:
    "With paged=1, home chats and hidden trigger runs are left out unless triggers=1; `before` is the previous page's nextCursor.",
  query: SessionsQuerySchema,
  response: SessionsResponseSchema,
});
export const createSessionRoute = defineRoute({
  method: "POST",
  path: "/api/sessions",
  tag: "chat",
  summary: "Start a new chat with an agent (the default agent when none is given).",
  description: 'Errors: "unknown_agent".',
  body: CreateSessionRequestSchema,
  response: SessionResponseSchema,
});
export const getSessionRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id",
  tag: "chat",
  summary: "A session and the newest window of its conversation, oldest first.",
  description: 'Page older history with GET /api/sessions/{id}/transcript?before=<before>. Errors: "not_found".',
  response: SessionDetailResponseSchema,
});
export const updateSessionRoute = defineRoute({
  method: "PATCH",
  path: "/api/sessions/:id",
  tag: "chat",
  summary: "Rename, pin or change the permission profile of a session.",
  description: 'Errors: "not_found", "bad_title", "bad_pinned", "bad_profile".',
  body: UpdateSessionRequestSchema,
  response: SessionResponseSchema,
  fieldCodes: { title: "bad_title", pinned: "bad_pinned", profile: "bad_profile" },
});
export const ReadMarkerSchema = obj({
  itemId: str({ minLength: 1, description: "A transcript item id from the Conversation View." }),
  at: int({ minimum: 0, description: "That item's createdAt." }),
});
true satisfies Same<Static<typeof ReadMarkerSchema>, ReadMarker>;
export const ReadMarkerResponseSchema = obj({ marker: ReadMarkerSchema, unread: int({ minimum: 0 }) });
true satisfies Same<Static<typeof ReadMarkerResponseSchema>, ReadMarkerResponse>;

export const GlanceResponseSchema = obj({
  companion: obj({ agentId: str(), name: str(), avatar: str(), homeSessionId: str() }),
  preview: nullable(str({ maxLength: 200 })),
  previewHidden: bool(),
  running: bool(),
  pendingApprovals: int({ minimum: 0 }),
  unread: int({ minimum: 0 }),
  nextTrigger: nullable(obj({ id: str(), name: str(), at: int() })),
});
true satisfies Same<Static<typeof GlanceResponseSchema>, GlanceResponse>;

export const glanceRoute = defineRoute({
  method: "GET",
  path: "/api/glance",
  tag: "chat",
  summary: "What a widget shows: the companion agent, its home chat's latest message, and what waits for the user.",
  description:
    "For clients that wake briefly without a stream; cheap enough to call every few minutes. The answer carries an ETag: send it back as If-None-Match and an unchanged glance answers 304 with no body.",
  response: GlanceResponseSchema,
});

export const readMarkerRoute = defineRoute({
  method: "PUT",
  path: "/api/sessions/:id/read-marker",
  tag: "chat",
  summary: "Move the session's read marker to an item the user has seen on screen.",
  description:
    "One marker per session, shared by every device. It never moves backwards: an item older than the marker leaves it in place, and the answer says where it is. When the unread count changes, every client hears session.upserted. Errors: not_found.",
  body: ReadMarkerSchema,
  response: ReadMarkerResponseSchema,
});
export const deleteSessionRoute = defineRoute({
  method: "DELETE",
  path: "/api/sessions/:id",
  tag: "chat",
  summary: "Delete a session; withForks=1 also deletes the branches taken from it.",
  description:
    'With clearHome=1, clearing a Home chat returns its replacement as homeSessionId. Errors: "not_found", "home_chat".',
  query: DeleteSessionQuerySchema,
  response: DeleteSessionResponseSchema,
});
export const transcriptRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/transcript",
  tag: "chat",
  summary: "Older items of a conversation, ending just before `before`.",
  description: '`before` in the answer pages further back; null at the start. Errors: "not_found".',
  query: TranscriptQuerySchema,
  response: TranscriptPageResponseSchema,
});
export const sendMessageRoute = defineRoute({
  method: "POST",
  path: "/api/sessions/:id/messages",
  tag: "chat",
  summary: "Send a message. Idempotent by requestId: a resend answers the same ids and starts no second run.",
  description:
    'Errors: "not_found", "empty_message", "too_long", "bad_mention", "skill_unavailable", "too_many_skills", "skills_too_large".',
  body: SendMessageRequestSchema,
  response: SendMessageResponseSchema,
});
export const cancelRoute = defineRoute({
  method: "POST",
  path: "/api/sessions/:id/cancel",
  tag: "chat",
  summary: "Stop the running run, keeping the partial reply.",
  response: CancelResponseSchema,
});
export const continueRoute = defineRoute({
  method: "POST",
  path: "/api/sessions/:id/continue",
  tag: "chat",
  summary: "Continue after a failed run, when the conversation's live state says it can.",
  response: ContinueResponseSchema,
});
export const sessionStreamRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/stream",
  tag: "chat",
  summary: "The session's Conversation View as server-sent events.",
  raw: { kind: "event-stream", stream: "session" },
});
export const globalStreamRoute = defineRoute({
  method: "GET",
  path: "/api/stream",
  tag: "chat",
  summary: "Agents, sessions, approvals and change notices as server-sent events.",
  description: "With paged=1 the snapshot holds the sessions the sidebar shows first instead of every session.",
  query: obj({ paged: opt(flag()) }),
  raw: { kind: "event-stream", stream: "global" },
});

export const uploadAttachmentRoute = defineRoute({
  method: "POST",
  path: "/api/sessions/:id/attachments",
  tag: "chat",
  summary: "Upload one file to attach to the next message.",
  description: 'Multipart with one `file` field. Errors: "not_found", "attachment_too_large" (413), "unavailable".',
  multipart: AttachmentUploadSchema,
  response: AttachmentResponseSchema,
});
export const getAttachmentRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/attachments/:attachmentId",
  tag: "chat",
  summary: "An attachment's bytes; preview=1 shows an image inline.",
  query: AttachmentQuerySchema,
  raw: { kind: "binary", contentType: "application/octet-stream" },
});
export const previewAttachmentRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/attachments/:attachmentId/preview",
  tag: "chat",
  summary: "An Office attachment converted to PDF for viewing.",
  description: 'Errors: "not_found", "preview_unsupported" (415).',
  raw: { kind: "binary", contentType: "application/pdf" },
});

export const listApprovalsRoute = defineRoute({
  method: "GET",
  path: "/api/approvals",
  tag: "chat",
  summary: "Pending approvals in every session, oldest first.",
  response: ApprovalsResponseSchema,
});
export const decideApprovalRoute = defineRoute({
  method: "POST",
  path: "/api/approvals/:id/decide",
  tag: "chat",
  summary: "Approve (optionally for longer than once) or deny a blocked call.",
  description: 'Errors: "not_found", "not_pending", "bad_length", "bad_hours".',
  body: DecideApprovalRequestSchema,
  response: DecideApprovalResponseSchema,
});

export const decideApprovalGroupRoute = defineRoute({
  method: "POST",
  path: "/api/approval-groups/:id/decide",
  tag: "chat",
  summary: "Resolve the pending reads in a tool round together so its original run resumes.",
  body: DecideApprovalGroupRequestSchema,
  response: ApprovalsResponseSchema,
});

export const pushKeyRoute = defineRoute({
  method: "GET",
  path: "/api/push/key",
  tag: "notifications",
  summary: "The Web Push public key (VAPID).",
  response: PushKeyResponseSchema,
});
export const pushSubscribeRoute = defineRoute({
  method: "POST",
  path: "/api/push/subscriptions",
  tag: "notifications",
  summary: "Register a Web Push subscription for the current device.",
  body: PushSubscribeRequestSchema,
  status: 204,
  deprecated: "POST /api/devices/current/channels",
});
export const pushUnsubscribeRoute = defineRoute({
  method: "DELETE",
  path: "/api/push/subscriptions",
  tag: "notifications",
  summary: "Remove a Web Push subscription by endpoint.",
  body: PushUnsubscribeRequestSchema,
  status: 204,
  deprecated: "DELETE /api/devices/current/channels/{channelId}",
});
export const legacyPresenceRoute = defineRoute({
  method: "POST",
  path: "/api/presence",
  tag: "notifications",
  summary: "Report whether this device is visible.",
  body: PresenceRequestSchema,
  status: 204,
  deprecated: "POST /api/devices/current/presence",
});
export const notificationsRoute = defineRoute({
  method: "GET",
  path: "/api/notifications",
  tag: "notifications",
  summary: "Web Push device count and whether notification previews show.",
  response: NotificationsResponseSchema,
});
export const updatePreviewRoute = defineRoute({
  method: "PUT",
  path: "/api/notifications/preview",
  tag: "notifications",
  summary: "Show or hide what happened in notifications, on every channel.",
  body: UpdatePreviewRequestSchema,
  response: NotificationsResponseSchema,
});
export const testNotificationsRoute = defineRoute({
  method: "POST",
  path: "/api/notifications/test",
  tag: "notifications",
  summary: "Send a test to every destination now.",
  description: 'Errors: "no_destinations", "test_failed" (the message says which one).',
  status: 204,
});

export const chatRoutes = [
  listAgentsRoute,
  updateCompanionRoute,
  listSessionsRoute,
  createSessionRoute,
  getSessionRoute,
  updateSessionRoute,
  readMarkerRoute,
  glanceRoute,
  deleteSessionRoute,
  transcriptRoute,
  sendMessageRoute,
  cancelRoute,
  continueRoute,
  sessionStreamRoute,
  globalStreamRoute,
  uploadAttachmentRoute,
  getAttachmentRoute,
  previewAttachmentRoute,
  listApprovalsRoute,
  decideApprovalRoute,
  decideApprovalGroupRoute,
  pushKeyRoute,
  pushSubscribeRoute,
  pushUnsubscribeRoute,
  legacyPresenceRoute,
  notificationsRoute,
  updatePreviewRoute,
  testNotificationsRoute,
];
