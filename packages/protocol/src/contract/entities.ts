// Schemas of the product entities a chat client reads: agents, sessions, messages and what they carry. The TypeScript
// interfaces in ../entities.ts and its neighbours predate the contract; each schema here is checked against its
// interface at compile time (`Same`), so the two cannot drift. Times are epoch milliseconds; ids are opaque strings.
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
import type { SessionBrowser, Takeover } from "../browser.ts";
import type {
  Agent,
  Approval,
  Attachment,
  ErrorInfo,
  ForkPoint,
  McpProviderPreview,
  Message,
  MessageMention,
  Run,
  Session,
  SessionReport,
} from "../entities.ts";
import type { MemoryChange, MemorySuggestion } from "../memory.ts";
import { SANDBOX_NETWORK_MODES } from "../network.ts";
import type { PluginPreview } from "../plugins.ts";
import type { MessageSkill, SelectedSkill, SkillPreview } from "../skills.ts";
import { THINKING_LEVELS } from "../thinking.ts";
import type { TriggerMessage, TriggerPreview } from "../triggers.ts";
import { named } from "./define.ts";
import { ErrorIssueSchema } from "./errors.ts";
import type { Same } from "./same.ts";
import { MessagePartSchema, SurfaceActionRefSchema } from "./surfaces.ts";

const id = () => str();
const at = () => num();

export const ErrorInfoSchema = named(
  "ErrorInfo",
  obj({
    code: str({ description: "Stable machine-readable code." }),
    message: str({ description: "One sentence for the user." }),
    issues: opt(arr(ErrorIssueSchema)),
  }),
);
true satisfies Same<Static<typeof ErrorInfoSchema>, ErrorInfo>;

// ---- policy ---------------------------------------------------------------------------------------------------------

export const ActionClassSchema = oneOf([
  "read_internal",
  "read_external",
  "write_internal",
  "write_external",
  "send",
  "irreversible",
  "credentials",
  "memory_write",
  "configure",
]);
export const ProfileNameSchema = oneOf(["strict", "standard", "relaxed", "yolo"]);
export const TaintLabelSchema = oneOf(["external", "private"]);
export const GrantLengthSchema = oneOf(["once", "session", "web_session", "agent", "hours", "always", "trigger"]);

// ---- agents ---------------------------------------------------------------------------------------------------------

export const AgentSchema = named(
  "Agent",
  obj({
    id: id(),
    name: str(),
    avatar: str({ description: "`bot:<id>`, a `data:image/...` picture, or an emoji or short badge." }),
    model: nullable(str()),
    thinkingLevel: oneOf(THINKING_LEVELS),
    networkMode: oneOf(SANDBOX_NETWORK_MODES),
    defaultProfile: ProfileNameSchema,
    allowedConnectorIds: opt(nullable(arr(str()))),
    canCreateTriggersForOtherAgents: opt(bool()),
    homeSessionId: str({ description: "The agent's pinned home chat." }),
  }),
);
true satisfies Same<Static<typeof AgentSchema>, Agent>;

// ---- the browser ----------------------------------------------------------------------------------------------------

export const TakeoverSchema = named(
  "Takeover",
  obj({
    id: id(),
    sessionId: id(),
    requestedBy: oneOf(["agent", "user"]),
    reason: nullable(str()),
    status: oneOf(["pending", "active", "done", "cancelled"]),
    url: nullable(str()),
    title: nullable(str()),
    note: nullable(str()),
    createdAt: at(),
    endedAt: nullable(at()),
  }),
);
true satisfies Same<Static<typeof TakeoverSchema>, Takeover>;

export const SessionBrowserSchema = named(
  "SessionBrowser",
  obj({ url: str(), title: str(), takeover: nullable(TakeoverSchema) }),
);
true satisfies Same<Static<typeof SessionBrowserSchema>, SessionBrowser>;

// ---- sessions -------------------------------------------------------------------------------------------------------

export const ForkPointSchema = named(
  "ForkPoint",
  obj({
    sessionId: id(),
    messageId: id(),
    stepId: opt(str()),
    edited: opt(bool()),
    retried: opt(bool()),
    onAnotherVersion: opt(bool()),
  }),
);
true satisfies Same<Static<typeof ForkPointSchema>, ForkPoint>;

export const SessionSchema = named(
  "Session",
  obj({
    id: id(),
    agentId: id(),
    origin: oneOf(["home", "user", "spawned", "trigger", "fork", "import"]),
    pinned: bool(),
    title: str(),
    status: oneOf(["idle", "running", "waiting_for_user", "completed", "failed", "cancelled"]),
    preview: str({ description: "Plain text of the last message, at most 200 characters." }),
    parentSessionId: nullable(id()),
    forkedFrom: nullable(ForkPointSchema),
    depth: int({ minimum: 0 }),
    profile: ProfileNameSchema,
    taint: arr(TaintLabelSchema),
    pendingApprovals: int({ minimum: 0 }),
    unread: int({ minimum: 0, description: "Agent entries after the read marker every device shares." }),
    browser: nullable(SessionBrowserSchema),
    triggerId: opt(nullable(id())),
    createdAt: at(),
    updatedAt: at(),
  }),
);
true satisfies Same<Static<typeof SessionSchema>, Session>;

// ---- approvals ------------------------------------------------------------------------------------------------------

const TriggerActionSchema = union([
  obj({ kind: lit("notify"), message: str() }),
  obj({ kind: lit("prompt"), prompt: str() }),
  obj({ kind: lit("skill"), skill: str(), args: opt(str()) }),
]);
const TriggerAllowViewSchema = obj({
  tool: str(),
  destination: opt(str()),
  actionClass: ActionClassSchema,
  label: str(),
});
const triggerPreviewFields = {
  name: str(),
  agentName: str(),
  startText: str(),
  startKind: oneOf(["schedule", "event"]),
  nextRuns: arr(at()),
  action: TriggerActionSchema,
  landing: oneOf(["new", "ongoing"]),
  report: oneOf(["always", "on_change", "never"]),
  latenessMinutes: int(),
  catchUp: oneOf(["once", "skip"]),
  overlap: oneOf(["skip", "queue"]),
  profile: oneOf(["strict", "standard", "relaxed"]),
  allow: arr(TriggerAllowViewSchema),
  skillNeeds: opt(arr(str())),
} as const;
export const TriggerPreviewSchema = named(
  "TriggerPreview",
  obj({
    kind: lit("trigger"),
    op: oneOf(["create", "update", "delete"]),
    ...triggerPreviewFields,
    before: opt(obj(triggerPreviewFields)),
  }),
);
true satisfies Same<Static<typeof TriggerPreviewSchema>, TriggerPreview>;

export const SkillPreviewSchema = named(
  "SkillPreview",
  obj({
    kind: lit("skill"),
    op: oneOf(["create", "update"]),
    name: str(),
    description: str(),
    skillMd: str(),
    files: arr(str()),
    fromVersion: opt(int()),
    diff: opt(str()),
  }),
);
true satisfies Same<Static<typeof SkillPreviewSchema>, SkillPreview>;

export const SkillFileSchema = obj({ path: str(), encoding: oneOf(["text", "base64"]), content: str() });
export const PluginPackageSchema = obj({
  formatVersion: lit(1),
  name: str(),
  description: str(),
  skills: arr(obj({ name: str(), files: arr(SkillFileSchema) })),
  mcp: arr(obj({ name: str(), url: str(), auth: oneOf(["none", "token", "oauth"]), skills: arr(str()) })),
});
export const PluginPreviewSchema = named(
  "PluginPreview",
  obj({
    kind: lit("plugin"),
    op: oneOf(["create", "update"]),
    name: str(),
    package: PluginPackageSchema,
    fromRevision: opt(int()),
    diff: opt(str()),
  }),
);
true satisfies Same<Static<typeof PluginPreviewSchema>, PluginPreview>;

export const McpProviderPreviewSchema = named(
  "McpProviderPreview",
  obj({
    kind: lit("mcp-provider"),
    connectorId: str(),
    connectorName: str(),
    url: str(),
    tool: str(),
    claimedReadOnly: bool(),
    actionClass: opt(ActionClassSchema),
    mcpProfile: opt(oneOf(["always_ask", "read_only", "read_write", "yolo"])),
  }),
);
true satisfies Same<Static<typeof McpProviderPreviewSchema>, McpProviderPreview>;

export const ApprovalSchema = named(
  "Approval",
  obj({
    id: id(),
    number: int(),
    sessionId: id(),
    sessionTitle: str(),
    agentId: id(),
    tool: str(),
    connector: str(),
    operation: str(),
    actionClass: ActionClassSchema,
    destination: nullable(str()),
    summary: str({ description: "One line for the card." }),
    argsPreview: str(),
    preview: opt(union([TriggerPreviewSchema, SkillPreviewSchema, PluginPreviewSchema, McpProviderPreviewSchema])),
    taint: arr(TaintLabelSchema),
    lengths: arr(GrantLengthSchema),
    status: oneOf(["pending", "approved", "denied", "expired", "cancelled"]),
    groupId: opt(str()),
    resumesTool: opt(bool()),
    parentCallId: opt(str()),
    cancelReason: opt(oneOf(["script_ended"])),
    execution: opt(oneOf(["ran", "failed", "needs_approval", "interrupted"])),
    grantLength: opt(GrantLengthSchema),
    grantExpiresAt: opt(at()),
    createdAt: at(),
    expiresAt: at(),
    decidedAt: nullable(at()),
  }),
);
true satisfies Same<Static<typeof ApprovalSchema>, Approval>;

// ---- messages -------------------------------------------------------------------------------------------------------

export const FileLocationSchema = obj({
  sheet: opt(str()),
  cell: opt(str()),
  slide: opt(int()),
  page: opt(int()),
});
export const FileReferenceSchema = named(
  "FileReference",
  obj({ fileId: str(), versionId: str(), location: opt(FileLocationSchema) }),
);

export const AttachmentSchema = named(
  "Attachment",
  obj({
    fileId: opt(str()),
    versionId: opt(str()),
    location: opt(FileLocationSchema),
    id: id(),
    name: str(),
    mediaType: str(),
    size: int({ minimum: 0 }),
    unavailable: opt(str({ description: "Only the name is known (an imported file the import did not carry): why." })),
  }),
);
true satisfies Same<Static<typeof AttachmentSchema>, Attachment>;

export const MessageMentionSchema = named(
  "MessageMention",
  obj({
    kind: oneOf(["connector", "chat", "page"]),
    id: str(),
    label: str(),
    start: int({ minimum: 0, description: "UTF-16 offset into the message text." }),
    end: int({ minimum: 0 }),
  }),
);
true satisfies Same<Static<typeof MessageMentionSchema>, MessageMention>;

export const SelectedSkillSchema = named("SelectedSkill", obj({ id: str(), version: int({ minimum: 1 }) }));
true satisfies Same<Static<typeof SelectedSkillSchema>, SelectedSkill>;
export const MessageSkillSchema = named("MessageSkill", obj({ id: str(), version: int(), name: str() }));
true satisfies Same<Static<typeof MessageSkillSchema>, MessageSkill>;

const MemoryDocSchema = oneOf(["profile", "agent"]);
export const MemorySuggestionSchema = named(
  "MemorySuggestion",
  obj({
    id: id(),
    doc: MemoryDocSchema,
    agentId: nullable(id()),
    op: oneOf(["add", "replace", "remove"]),
    lineId: nullable(id()),
    current: nullable(str()),
    text: nullable(str()),
    sessionId: id(),
    status: oneOf(["pending", "reported"]),
    createdAt: at(),
    reportedAt: nullable(at()),
  }),
);
true satisfies Same<Static<typeof MemorySuggestionSchema>, MemorySuggestion>;

export const MemoryChangeSchema = named(
  "MemoryChange",
  obj({
    id: id(),
    lineId: id(),
    doc: MemoryDocSchema,
    agentId: nullable(id()),
    op: oneOf(["add", "replace", "remove", "confirm"]),
    before: nullable(str()),
    after: nullable(str()),
    by: oneOf(["agent", "user"]),
    sessionId: nullable(id()),
    at: at(),
    undoneAt: nullable(at()),
    undoable: bool(),
  }),
);
true satisfies Same<Static<typeof MemoryChangeSchema>, MemoryChange>;

export const SessionReportSchema = named(
  "SessionReport",
  obj({
    files: opt(arr(AttachmentSchema)),
    sessionId: id(),
    title: str(),
    outcome: oneOf(["completed", "failed", "cancelled"]),
    summary: str(),
    resultId: opt(str()),
    resultChars: opt(int()),
    memorySuggestions: opt(arr(MemorySuggestionSchema)),
  }),
);
true satisfies Same<Static<typeof SessionReportSchema>, SessionReport>;

export const TriggerMessageSchema = named(
  "TriggerMessage",
  obj({
    kind: oneOf(["notify", "report", "failed", "paused"]),
    triggerId: id(),
    triggerName: str(),
    triggerRunId: nullable(id()),
    sessionId: nullable(id()),
    text: str(),
  }),
);
true satisfies Same<Static<typeof TriggerMessageSchema>, TriggerMessage>;

export const MessageSchema = named(
  "Message",
  obj({
    attachments: opt(arr(AttachmentSchema)),
    mentions: opt(arr(MessageMentionSchema)),
    selectedSkills: opt(arr(MessageSkillSchema)),
    internal: opt(bool()),
    id: id(),
    sessionId: id(),
    role: oneOf([
      "user",
      "assistant",
      "report",
      "approval",
      "notice",
      "takeover",
      "memory",
      "trigger",
      "compaction",
      "reset",
    ]),
    runId: nullable(id()),
    text: str({ description: "Markdown in the Rei dialect (docs/rendering.md) for user and assistant items." }),
    status: oneOf(["pending", "streaming", "complete", "aborted", "error"]),
    error: opt(ErrorInfoSchema),
    from: opt(obj({ sessionId: id(), title: str() })),
    report: opt(SessionReportSchema),
    approval: opt(ApprovalSchema),
    takeover: opt(TakeoverSchema),
    memory: opt(
      obj({
        change: MemoryChangeSchema,
        review: opt(obj({ jobId: str(), changeIds: arr(str()), undoneCount: opt(int()) })),
      }),
    ),
    trigger: opt(TriggerMessageSchema),
    forkable: opt(bool()),
    parts: opt(arr(MessagePartSchema)),
    surfaceAction: opt(SurfaceActionRefSchema),
    editable: opt(bool()),
    versions: opt(obj({ index: int(), count: int() })),
    entryId: opt(str()),
    requestId: opt(str()),
    steer: opt(bool()),
    thinking: opt(arr(str(), { description: "An imported reply's reasoning, for detail mode; never model context." })),
    createdAt: at(),
  }),
);
true satisfies Same<Static<typeof MessageSchema>, Message>;

export const RunSchema = named(
  "Run",
  obj({
    id: id(),
    sessionId: id(),
    status: oneOf(["queued", "running", "completed", "failed", "cancelled"]),
    error: opt(ErrorInfoSchema),
    startedAt: at(),
    endedAt: nullable(at()),
  }),
);
true satisfies Same<Static<typeof RunSchema>, Run>;
