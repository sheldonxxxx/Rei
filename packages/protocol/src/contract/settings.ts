// Settings, models, model providers and embedding (issue 15), and the agents' own settings. Request and response types
// still live in ../api.ts and ../gateway.ts as interfaces; each schema here is checked against its interface at compile
// time.
import {
  arr,
  bool,
  int,
  lit,
  map,
  nullable,
  obj,
  oneOf,
  opt,
  type Static,
  str,
  union,
} from "@earendil-works/pi-schema";
import type {
  AgentInstructionsResponse,
  BehaviorSettings,
  BehaviorSettingsResponse,
  ContextSettings,
  CreateAgentRequest,
  CreateAgentResponse,
  FirstTimeSetupSettings,
  MemoryExtractionSettings,
  ModelSettingsResponse,
  ModelsResponse,
  TimeZoneSettings,
  TitleSettings,
  UpdateAgentRequest,
  UpdateAgentResponse,
  UpdateBehaviorSettingsRequest,
  UpdateContextSettingsRequest,
  UpdateFirstTimeSetupRequest,
  UpdateMemoryExtractionRequest,
  UpdateModelSettingsRequest,
  UpdateTimeZoneRequest,
  UpdateTitleSettingsRequest,
} from "../api.ts";
import type {
  BackupPasswordResponse,
  BackupRepositoryRequest,
  BackupRun,
  BackupSettings,
  UpdateBackupSettingsRequest,
} from "../backup.ts";
import type {
  CheckEmbeddingSetupResponse,
  EmbeddingSetupSettings,
  ModelLimits,
  ProviderConnection,
  ProviderConnectionsResponse,
  SaveEmbeddingSetupSettings,
  SaveProviderConnectionRequest,
  SaveSearchSetupSettings,
  ScanProviderModelsRequest,
  ScanProviderModelsResponse,
  SearchSetupSettings,
  WebSearchSetupStatus,
} from "../gateway.ts";
import { SANDBOX_NETWORK_MODES, type SandboxNetworkSettings, type UpdateSandboxNetworkRequest } from "../network.ts";
import { THINKING_LEVELS } from "../thinking.ts";
import { OkSchema } from "./auth.ts";
import { defineRoute } from "./define.ts";
import { AgentSchema, ProfileInputSchema, SessionSchema } from "./entities.ts";
import type { Same } from "./same.ts";

const ThinkingLevelSchema = oneOf(THINKING_LEVELS);

// ---- agents ---------------------------------------------------------------------------------------------------------

const AgentIdentitySchema = obj({
  name: str({ description: "The chosen agent name." }),
  avatar: str({ description: "The chosen agent avatar." }),
});
true satisfies Same<Static<typeof AgentIdentitySchema>, CreateAgentRequest>;
export const CreateAgentRequestSchema = union([
  AgentIdentitySchema,
  obj(
    { description: str({ description: "Legacy description used to derive a name locally." }) },
    { description: "Compatibility request for older clients." },
  ),
]);
export const CreateAgentResponseSchema = obj({ agent: AgentSchema, session: SessionSchema });
true satisfies Same<Static<typeof CreateAgentResponseSchema>, CreateAgentResponse>;
export const UpdateAgentRequestSchema = obj({
  avatar: opt(str()),
  name: opt(str()),
  model: opt(nullable(str())),
  thinkingLevel: opt(ThinkingLevelSchema),
  networkMode: opt(oneOf(SANDBOX_NETWORK_MODES)),
  defaultProfile: opt(ProfileInputSchema),
  allowedConnectorIds: opt(nullable(arr(str({ minLength: 1, maxLength: 200 }), { maxItems: 1000 }))),
  canCreateTriggersForOtherAgents: opt(bool()),
  instructions: opt(str()),
});
true satisfies Same<Static<typeof UpdateAgentRequestSchema>, UpdateAgentRequest>;
export const UpdateAgentResponseSchema = obj({ agent: AgentSchema });
true satisfies Same<Static<typeof UpdateAgentResponseSchema>, UpdateAgentResponse>;
export const AgentInstructionsResponseSchema = obj({
  instructions: str(),
  maxLength: int(),
  history: arr(obj({ at: int(), author: oneOf(["user", "agent"]), text: str() })),
});
true satisfies Same<Static<typeof AgentInstructionsResponseSchema>, AgentInstructionsResponse>;

export const createAgentRoute = defineRoute({
  method: "POST",
  path: "/api/agents",
  tag: "agents",
  summary: "Create an agent with a chosen name and avatar.",
  description:
    'Answers the agent and its home chat, and sends agent.upserted and session.upserted. Errors: "bad_request", "bad_avatar".',
  body: CreateAgentRequestSchema,
  response: CreateAgentResponseSchema,
});
export const updateAgentRoute = defineRoute({
  method: "PATCH",
  path: "/api/agents/:id",
  tag: "agents",
  summary:
    "Change an agent's look, name, model, thinking effort, sandbox network, profile, connectors or instructions.",
  description:
    'Everything is checked before anything changes. Sends agent.upserted. Errors: "not_found", "bad_avatar", "bad_request".',
  body: UpdateAgentRequestSchema,
  response: UpdateAgentResponseSchema,
  fieldCodes: { avatar: "bad_avatar" },
});
export const deleteAgentRoute = defineRoute({
  method: "DELETE",
  path: "/api/agents/:id",
  tag: "agents",
  summary: "Delete an agent with its chats, triggers, grants and memory.",
  description: 'Sends agent.removed. Errors: "not_found", "default_agent" (409).',
  response: OkSchema,
});
export const agentInstructionsRoute = defineRoute({
  method: "GET",
  path: "/api/agents/:id/instructions",
  tag: "agents",
  summary: "An agent's instructions and their earlier versions, newest first.",
  description: 'Errors: "not_found".',
  response: AgentInstructionsResponseSchema,
});

// ---- models ---------------------------------------------------------------------------------------------------------

export const ModelsResponseSchema = obj({
  default: str(),
  models: arr(str()),
  labels: opt(map(str())),
  thinkingLevels: opt(map(arr(ThinkingLevelSchema))),
});
true satisfies Same<Static<typeof ModelsResponseSchema>, ModelsResponse>;

const CapabilitySourceSchema = oneOf(["custom", "detected", "built_in", "unknown"]);
const LimitValueSchema = obj({ value: nullable(int()), source: CapabilitySourceSchema });
export const ModelSettingSchema = obj({ model: str(), firstEventMs: int(), idleMs: int(), totalMs: int() });
export const ModelSettingsResponseSchema = obj({
  fast: ModelSettingSchema,
  standard: ModelSettingSchema,
  capabilities: arr(obj({ id: str(), contextWindow: LimitValueSchema, maxTokens: LimitValueSchema })),
});
true satisfies Same<Static<typeof ModelSettingsResponseSchema>, ModelSettingsResponse>;

/** Chat call deadlines, in milliseconds. */
const deadline = () => opt(int({ minimum: 1_000, maximum: 7_200_000 }));
const ModelSettingPatchSchema = obj({
  model: opt(str()),
  firstEventMs: deadline(),
  idleMs: deadline(),
  totalMs: deadline(),
});
/** A token limit as the server stores it. */
const tokens = () => int({ minimum: 1, maximum: 10_000_000 });
export const UpdateModelSettingsRequestSchema = obj({
  fast: opt(ModelSettingPatchSchema),
  standard: opt(ModelSettingPatchSchema),
  capabilities: opt(
    map(obj({ contextWindow: opt(nullable(tokens())), maxTokens: opt(nullable(tokens())) }), {
      description: "Keyed by model choice; at most 500. null removes the user's value.",
    }),
  ),
});
true satisfies Same<Static<typeof UpdateModelSettingsRequestSchema>, UpdateModelSettingsRequest>;

export const modelsRoute = defineRoute({
  method: "GET",
  path: "/api/models",
  tag: "models",
  summary: "The models an agent can be set to, the default first.",
  response: ModelsResponseSchema,
});
export const modelSettingsRoute = defineRoute({
  method: "GET",
  path: "/api/settings/models",
  tag: "models",
  summary: "The fast and standard models, their call deadlines, and each offered model's limits.",
  description: 'Errors: "not_found" (no model catalog).',
  response: ModelSettingsResponseSchema,
});
export const updateModelSettingsRoute = defineRoute({
  method: "PUT",
  path: "/api/settings/models",
  tag: "models",
  summary: "Change the fast or standard model, their deadlines, or per-model limit overrides.",
  description: 'Errors: "not_found", "bad_request".',
  body: UpdateModelSettingsRequestSchema,
  response: ModelSettingsResponseSchema,
});

// ---- settings -------------------------------------------------------------------------------------------------------

export const TitleSettingsSchema = obj({ enabled: bool(), model: nullable(str()), default: str() });
true satisfies Same<Static<typeof TitleSettingsSchema>, TitleSettings>;
export const UpdateTitleSettingsRequestSchema = obj({ enabled: opt(bool()), model: opt(nullable(str())) });
true satisfies Same<Static<typeof UpdateTitleSettingsRequestSchema>, UpdateTitleSettingsRequest>;
export const MemoryExtractionSettingsSchema = obj({ enabled: bool(), everyNTurns: int({ minimum: 2, maximum: 100 }) });
true satisfies Same<Static<typeof MemoryExtractionSettingsSchema>, MemoryExtractionSettings>;
export const UpdateMemoryExtractionSchema = obj({
  enabled: opt(bool()),
  everyNTurns: opt(int({ minimum: 2, maximum: 100 })),
});
true satisfies Same<Static<typeof UpdateMemoryExtractionSchema>, UpdateMemoryExtractionRequest>;
export const FirstTimeSetupSettingsSchema = obj({ dismissed: bool() });
true satisfies Same<Static<typeof FirstTimeSetupSettingsSchema>, FirstTimeSetupSettings>;
export const UpdateFirstTimeSetupSchema = obj({ dismissed: bool() });
true satisfies Same<Static<typeof UpdateFirstTimeSetupSchema>, UpdateFirstTimeSetupRequest>;

const CompactionSchema = obj({
  enabled: bool(),
  reserveTokens: int(),
  keepRecentTokens: int(),
  backgroundTokens: int(),
});
const CompactionPatchSchema = obj({
  enabled: opt(bool()),
  reserveTokens: opt(int()),
  keepRecentTokens: opt(int()),
  backgroundTokens: opt(int()),
});
const HomeContextSchema = obj({ idleGapMinutes: int(), recentMessages: int(), maxTokens: int() });
const HomeContextPatchSchema = obj({
  idleGapMinutes: opt(int()),
  recentMessages: opt(int()),
  maxTokens: opt(int()),
});
export const ContextSettingsSchema = obj({
  compaction: CompactionSchema,
  modelOverrides: map(CompactionPatchSchema),
  home: HomeContextSchema,
  defaults: obj({ compaction: CompactionSchema, home: HomeContextSchema }),
});
true satisfies Same<Static<typeof ContextSettingsSchema>, ContextSettings>;
export const UpdateContextSettingsRequestSchema = obj({
  compaction: opt(nullable(CompactionPatchSchema)),
  modelOverrides: opt(map(CompactionPatchSchema)),
  home: opt(nullable(HomeContextPatchSchema)),
});
true satisfies Same<Static<typeof UpdateContextSettingsRequestSchema>, UpdateContextSettingsRequest>;

const BehaviorSettingsSchema = obj({
  runLimits: obj({ maxModelCalls: int(), maxRunMinutes: int() }),
  retry: obj({ maxRetries: int(), baseDelaySeconds: int() }),
  memory: obj({ injectProfile: bool(), injectRecent: bool(), historyHits: int() }),
  generation: obj({ maxOutputTokens: nullable(int()) }),
  discovery: obj({ maxConnectorTools: int(), maxSkills: int() }),
  search: obj({ useOpenAiNativeSearch: bool() }),
  codeMode: obj({ enabled: bool() }),
  chat: obj({ whenBusy: oneOf(["steer", "queue"]) }),
});
true satisfies Same<Static<typeof BehaviorSettingsSchema>, BehaviorSettings>;
export const BehaviorSettingsResponseSchema = obj({
  settings: BehaviorSettingsSchema,
  defaults: BehaviorSettingsSchema,
  ceilings: obj({ maxModelCalls: int(), maxRunMinutes: int(), maxRetries: int() }),
});
true satisfies Same<Static<typeof BehaviorSettingsResponseSchema>, BehaviorSettingsResponse>;
export const UpdateBehaviorSettingsRequestSchema = nullable(
  obj({
    runLimits: opt(obj({ maxModelCalls: opt(int()), maxRunMinutes: opt(int()) })),
    retry: opt(obj({ maxRetries: opt(int()), baseDelaySeconds: opt(int()) })),
    memory: opt(obj({ injectProfile: opt(bool()), injectRecent: opt(bool()), historyHits: opt(int()) })),
    generation: opt(obj({ maxOutputTokens: opt(nullable(int())) })),
    discovery: opt(obj({ maxConnectorTools: opt(int()), maxSkills: opt(int()) })),
    search: opt(obj({ useOpenAiNativeSearch: opt(bool()) })),
    codeMode: opt(obj({ enabled: opt(bool()) })),
    chat: opt(obj({ whenBusy: opt(oneOf(["steer", "queue"])) })),
  }),
);
true satisfies Same<Static<typeof UpdateBehaviorSettingsRequestSchema>, UpdateBehaviorSettingsRequest>;

export const TimeZoneSettingsSchema = obj({ timeZone: nullable(str()) });
true satisfies Same<Static<typeof TimeZoneSettingsSchema>, TimeZoneSettings>;
export const UpdateTimeZoneRequestSchema = obj({
  timeZone: str({ description: "An IANA time zone, such as Asia/Macau." }),
});
true satisfies Same<Static<typeof UpdateTimeZoneRequestSchema>, UpdateTimeZoneRequest>;

const BackupRetentionSchema = obj({
  daily: int({ minimum: 0, maximum: 999 }),
  weekly: int({ minimum: 0, maximum: 999 }),
  monthly: int({ minimum: 0, maximum: 999 }),
});
export const BackupRunSchema = obj({
  id: str(),
  trigger: oneOf(["schedule", "manual"]),
  status: oneOf(["running", "ok", "failed"]),
  startedAt: int(),
  finishedAt: nullable(int()),
  snapshotId: nullable(str()),
  bytesAdded: nullable(int()),
  counts: nullable(map(int())),
  error: nullable(str()),
  maintenance: nullable(str()),
});
true satisfies Same<Static<typeof BackupRunSchema>, BackupRun>;
export const BackupSettingsSchema = obj({
  available: bool(),
  enabled: bool(),
  time: str(),
  timeZone: str(),
  retention: BackupRetentionSchema,
  repository: oneOf(["none", "pending", "ready"]),
  path: str(),
  running: bool(),
  lastRun: nullable(BackupRunSchema),
  lastSuccessAt: nullable(int()),
  nextRunAt: nullable(int()),
  stale: bool(),
  snapshots: nullable(int()),
  repositoryBytes: nullable(int()),
  history: arr(BackupRunSchema),
});
true satisfies Same<Static<typeof BackupSettingsSchema>, BackupSettings>;
export const UpdateBackupSettingsRequestSchema = obj({
  enabled: opt(bool()),
  time: opt(str({ description: "A 24-hour time, HH:mm, in the user's time zone." })),
  retention: opt(BackupRetentionSchema),
});
true satisfies Same<Static<typeof UpdateBackupSettingsRequestSchema>, UpdateBackupSettingsRequest>;
export const BackupPasswordResponseSchema = obj({ password: str() });
true satisfies Same<Static<typeof BackupPasswordResponseSchema>, BackupPasswordResponse>;
export const BackupRepositoryRequestSchema = union([
  obj({ mode: lit("create"), confirmed: lit(true) }),
  obj({ mode: lit("connect"), password: str({ minLength: 1, maxLength: 1000 }) }),
]);
true satisfies Same<Static<typeof BackupRepositoryRequestSchema>, BackupRepositoryRequest>;

export const SandboxNetworkSettingsSchema = obj({ whitelist: arr(str()), defaults: arr(str()) });
true satisfies Same<Static<typeof SandboxNetworkSettingsSchema>, SandboxNetworkSettings>;
export const UpdateSandboxNetworkRequestSchema = union([
  obj({ whitelist: arr(str(), { maxItems: 200 }) }),
  obj({ reset: lit(true) }),
]);
true satisfies Same<Static<typeof UpdateSandboxNetworkRequestSchema>, UpdateSandboxNetworkRequest>;

export const titleSettingsRoute = defineRoute({
  method: "GET",
  path: "/api/settings/titles",
  tag: "settings",
  summary: "Whether a model writes chat titles, and with which model.",
  description: 'Errors: "not_found".',
  response: TitleSettingsSchema,
});
export const updateTitleSettingsRoute = defineRoute({
  method: "PUT",
  path: "/api/settings/titles",
  tag: "settings",
  summary: "Turn model-written chat titles on or off, or pick their model.",
  description: 'Errors: "not_found", "bad_request" (a model id that is empty, over 100 characters or has spaces).',
  body: UpdateTitleSettingsRequestSchema,
  response: TitleSettingsSchema,
});
export const memoryExtractionRoute = defineRoute({
  method: "GET",
  path: "/api/settings/memory-extraction",
  tag: "settings",
  summary: "Whether finished chats are reviewed in the background to save durable facts.",
  description: 'Errors: "not_found".',
  response: MemoryExtractionSettingsSchema,
});
export const updateMemoryExtractionRoute = defineRoute({
  method: "PUT",
  path: "/api/settings/memory-extraction",
  tag: "settings",
  summary: "Turn background memory extraction on or off.",
  description: 'Errors: "not_found".',
  body: UpdateMemoryExtractionSchema,
  response: MemoryExtractionSettingsSchema,
});
export const firstTimeSetupRoute = defineRoute({
  method: "GET",
  path: "/api/settings/first-time-setup",
  tag: "settings",
  summary: "Whether the first-time setup dialog is switched off for this instance.",
  description: "Errors: none.",
  response: FirstTimeSetupSettingsSchema,
});
export const updateFirstTimeSetupRoute = defineRoute({
  method: "PUT",
  path: "/api/settings/first-time-setup",
  tag: "settings",
  summary: "Switch the first-time setup dialog off for good, or back on.",
  description: "Errors: none.",
  body: UpdateFirstTimeSetupSchema,
  response: FirstTimeSetupSettingsSchema,
});
export const behaviorSettingsRoute = defineRoute({
  method: "GET",
  path: "/api/settings/behavior",
  tag: "settings",
  summary: "Agent behavior limits and options, their defaults and the server's ceilings.",
  description: 'Errors: "not_found".',
  response: BehaviorSettingsResponseSchema,
});
export const updateBehaviorSettingsRoute = defineRoute({
  method: "PUT",
  path: "/api/settings/behavior",
  tag: "settings",
  summary: "Change any part of the behavior settings; null resets them all.",
  description: 'Changes apply from the next model call. Errors: "not_found", "bad_request" (a value out of range).',
  body: UpdateBehaviorSettingsRequestSchema,
  response: BehaviorSettingsResponseSchema,
});
export const contextSettingsRoute = defineRoute({
  method: "GET",
  path: "/api/settings/context",
  tag: "settings",
  summary: "Automatic compaction, per-model overrides and home chat trimming, with their defaults.",
  response: ContextSettingsSchema,
});
export const updateContextSettingsRoute = defineRoute({
  method: "PUT",
  path: "/api/settings/context",
  tag: "settings",
  summary: "Change any part of the context settings; null for a part resets it.",
  description: 'Errors: "bad_request" (a value out of range).',
  body: UpdateContextSettingsRequestSchema,
  response: ContextSettingsSchema,
});
export const timeZoneRoute = defineRoute({
  method: "GET",
  path: "/api/settings/time-zone",
  tag: "settings",
  summary: "The user's saved IANA time zone, or null before one is saved.",
  response: TimeZoneSettingsSchema,
});
export const updateTimeZoneRoute = defineRoute({
  method: "PUT",
  path: "/api/settings/time-zone",
  tag: "settings",
  summary: "Save the user's time zone.",
  description: 'Errors: "bad_request" (not an IANA time zone).',
  body: UpdateTimeZoneRequestSchema,
  response: TimeZoneSettingsSchema,
});
export const backupSettingsRoute = defineRoute({
  method: "GET",
  path: "/api/settings/backups",
  tag: "settings",
  summary: "Backups: the schedule, the repository, the last runs and whether they are stale.",
  response: BackupSettingsSchema,
});
export const updateBackupSettingsRoute = defineRoute({
  method: "PUT",
  path: "/api/settings/backups",
  tag: "settings",
  summary: "Turn backups on or off, set the daily time and the retention.",
  description: 'Errors: "bad_request", "backups_unavailable", "repository_missing".',
  body: UpdateBackupSettingsRequestSchema,
  response: BackupSettingsSchema,
});
export const backupPasswordRoute = defineRoute({
  method: "POST",
  path: "/api/settings/backups/password",
  tag: "settings",
  summary: "Generate the password of a repository to be created. It is shown once and never again.",
  description: 'Errors: "backups_unavailable", "repository_exists".',
  response: BackupPasswordResponseSchema,
});
export const backupRepositoryRoute = defineRoute({
  method: "POST",
  path: "/api/settings/backups/repository",
  tag: "settings",
  summary: "Create the repository with the generated password, or connect one that already exists.",
  description: 'Errors: "backups_unavailable", "bad_request", "repository_exists", "repository_failed".',
  body: BackupRepositoryRequestSchema,
  response: BackupSettingsSchema,
});
export const forgetBackupRepositoryRoute = defineRoute({
  method: "DELETE",
  path: "/api/settings/backups/repository",
  tag: "settings",
  summary:
    "Forget the repository and its password and turn backups off. The repository's files are left where they are.",
  response: BackupSettingsSchema,
});
export const runBackupRoute = defineRoute({
  method: "POST",
  path: "/api/settings/backups/run",
  tag: "settings",
  summary: "Start a backup now.",
  description: 'Errors: "backups_unavailable", "repository_missing", "backup_running".',
  response: BackupSettingsSchema,
});
export const sandboxNetworkRoute = defineRoute({
  method: "GET",
  path: "/api/settings/sandbox-network",
  tag: "settings",
  summary: "The hosts restricted agents reach without asking, and the defaults a reset restores.",
  response: SandboxNetworkSettingsSchema,
});
export const updateSandboxNetworkRoute = defineRoute({
  method: "PUT",
  path: "/api/settings/sandbox-network",
  tag: "settings",
  summary: "Replace the whitelist, or restore the defaults with { reset: true }.",
  description: 'Errors: "bad_request" (an entry that is not valid, or more than 200).',
  body: UpdateSandboxNetworkRequestSchema,
  response: SandboxNetworkSettingsSchema,
});

// ---- model providers ------------------------------------------------------------------------------------------------

const ProviderKindSchema = oneOf(["openai", "openai-compatible"]);
const CustomEndpointApiSchema = oneOf(["chat", "responses"]);
export const ModelLimitsSchema = obj({ contextWindow: opt(int()), maxTokens: opt(int()) });
true satisfies Same<Static<typeof ModelLimitsSchema>, ModelLimits>;
export const ProviderConnectionSchema = obj({
  id: str(),
  name: str(),
  kind: ProviderKindSchema,
  auth: oneOf(["oauth", "api_key"]),
  connected: bool(),
  baseUrl: opt(str()),
  api: opt(CustomEndpointApiSchema),
  models: arr(str()),
  modelInfo: opt(map(ModelLimitsSchema)),
  replacedModels: opt(arr(obj({ from: str(), to: str() }))),
});
true satisfies Same<Static<typeof ProviderConnectionSchema>, ProviderConnection>;
export const ProviderConnectionsResponseSchema = obj({ connections: arr(ProviderConnectionSchema) });
true satisfies Same<Static<typeof ProviderConnectionsResponseSchema>, ProviderConnectionsResponse>;
export const ScanProviderModelsRequestSchema = obj({ id: opt(str()), baseUrl: str(), apiKey: opt(str()) });
true satisfies Same<Static<typeof ScanProviderModelsRequestSchema>, ScanProviderModelsRequest>;
export const ScanProviderModelsResponseSchema = obj({ models: arr(str()), modelInfo: opt(map(ModelLimitsSchema)) });
true satisfies Same<Static<typeof ScanProviderModelsResponseSchema>, ScanProviderModelsResponse>;
export const SaveProviderConnectionRequestSchema = obj({
  id: opt(str()),
  name: str(),
  kind: ProviderKindSchema,
  auth: opt(oneOf(["oauth", "api_key"])),
  apiKey: opt(str()),
  baseUrl: opt(str()),
  api: opt(CustomEndpointApiSchema),
  models: opt(arr(str())),
  modelInfo: opt(map(ModelLimitsSchema, { description: "Keyed by model id; at most 200." })),
});
true satisfies Same<Static<typeof SaveProviderConnectionRequestSchema>, SaveProviderConnectionRequest>;

const SearchProviderSchema = oneOf(["brave", "tavily", "searxng", "exa", "exa-api", "codex-subscription"]);
export const WebSearchSetupStatusSchema = obj({
  providers: arr(obj({ id: SearchProviderSchema, configured: bool() })),
});
true satisfies Same<Static<typeof WebSearchSetupStatusSchema>, WebSearchSetupStatus>;
export const SearchSetupSettingsSchema = obj({
  providers: arr(SearchProviderSchema),
  searxngUrl: str(),
  exaAuth: opt(oneOf(["keyless", "api_key"])),
  codexModel: opt(str()),
  providerOrder: opt(arr(SearchProviderSchema)),
  providerStatus: opt(
    arr(obj({ id: SearchProviderSchema, configured: bool(), limitedUntil: nullable(int()), lastError: opt(str()) })),
  ),
});
true satisfies Same<Static<typeof SearchSetupSettingsSchema>, SearchSetupSettings>;
export const SaveSearchSetupSettingsSchema = obj({
  providers: arr(SearchProviderSchema),
  searxngUrl: str(),
  exaAuth: opt(oneOf(["keyless", "api_key"])),
  codexModel: opt(str()),
  providerOrder: opt(arr(SearchProviderSchema)),
  providerStatus: opt(
    arr(obj({ id: SearchProviderSchema, configured: bool(), limitedUntil: nullable(int()), lastError: opt(str()) })),
  ),
  apiKeys: opt(obj({ brave: opt(str()), tavily: opt(str()), searxng: opt(str()), exa: opt(str()) })),
});
true satisfies Same<Static<typeof SaveSearchSetupSettingsSchema>, SaveSearchSetupSettings>;

export const OpenAiOAuthStartResponseSchema = obj({ authorizationUrl: str() });
export const OpenAiOAuthStatusSchema = obj({
  pending: bool(),
  authorizationUrl: opt(str()),
  error: opt(str()),
});
export type OpenAiOAuthStatus = Static<typeof OpenAiOAuthStatusSchema>;
export const OpenAiOAuthCallbackRequestSchema = obj({
  url: str({ description: "The address the sign-in page ended on, pasted by the user." }),
});

export const CodexImagesStatusSchema = obj({
  enabled: bool({ description: "False when Rei has no gateway connection for Codex Images." }),
  signedIn: bool(),
  pending: bool({ description: "A device-code sign-in is waiting for approval." }),
  userCode: opt(str()),
  verificationUrl: opt(str()),
  error: opt(str({ description: "Why the last sign-in did not finish." })),
});
export type CodexImagesStatus = Static<typeof CodexImagesStatusSchema>;
export const CodexImagesSignInResponseSchema = obj({ userCode: str(), verificationUrl: str() });

const gateway = 'Errors: "gateway_unavailable" (503) when the server has no gateway.';
export const providersRoute = defineRoute({
  method: "GET",
  path: "/api/providers",
  tag: "providers",
  summary: "The model provider connections, without their credentials.",
  response: ProviderConnectionsResponseSchema,
});
export const saveProviderRoute = defineRoute({
  method: "POST",
  path: "/api/providers",
  tag: "providers",
  summary: "Add or change a provider connection (OpenAI or a custom OpenAI-compatible endpoint).",
  description: `Credentials are write-only. ${gateway}`,
  body: SaveProviderConnectionRequestSchema,
  response: ProviderConnectionSchema,
  status: 201,
});
export const removeProviderRoute = defineRoute({
  method: "DELETE",
  path: "/api/providers/:id",
  tag: "providers",
  summary: "Remove a provider connection.",
  description: `Errors: "provider_in_use" (409). ${gateway}`,
  status: 204,
});
export const scanProviderModelsRoute = defineRoute({
  method: "POST",
  path: "/api/providers/scan",
  tag: "providers",
  summary: "List the models a custom endpoint offers, and the limits it reports, without saving anything.",
  description: gateway,
  body: ScanProviderModelsRequestSchema,
  response: ScanProviderModelsResponseSchema,
});
export const scanProviderLimitsRoute = defineRoute({
  method: "POST",
  path: "/api/providers/:id/limits/scan",
  tag: "providers",
  summary: "Re-read a custom endpoint's model limits and save them, models unchanged.",
  description: `Errors: "bad_request" (not a custom endpoint). ${gateway}`,
  response: ProviderConnectionSchema,
});
export const searchStatusRoute = defineRoute({
  method: "GET",
  path: "/api/providers/search-status",
  tag: "providers",
  summary: "Which web search providers are configured.",
  response: WebSearchSetupStatusSchema,
});
export const searchSettingsRoute = defineRoute({
  method: "GET",
  path: "/api/providers/search-settings",
  tag: "providers",
  summary: "The web search providers in the order they are tried, without their keys.",
  description: gateway,
  response: SearchSetupSettingsSchema,
});
export const saveSearchSettingsRoute = defineRoute({
  method: "POST",
  path: "/api/providers/search-settings",
  tag: "providers",
  summary: "Save the web search setup; a blank key keeps the stored one.",
  description: gateway,
  body: SaveSearchSetupSettingsSchema,
  response: SearchSetupSettingsSchema,
});
export const openAiOAuthStartRoute = defineRoute({
  method: "POST",
  path: "/api/providers/openai/oauth/start",
  tag: "providers",
  summary: "Start a ChatGPT sign-in; answers the page to open.",
  description: gateway,
  response: OpenAiOAuthStartResponseSchema,
});
export const openAiOAuthStatusRoute = defineRoute({
  method: "GET",
  path: "/api/providers/openai/oauth/status",
  tag: "providers",
  summary: "Whether a ChatGPT sign-in is waiting, and why the last one failed.",
  description: gateway,
  response: OpenAiOAuthStatusSchema,
});
export const openAiOAuthCallbackRoute = defineRoute({
  method: "POST",
  path: "/api/providers/openai/oauth/callback",
  tag: "providers",
  summary: "Finish a ChatGPT sign-in with the address its page ended on.",
  description: gateway,
  body: OpenAiOAuthCallbackRequestSchema,
  response: OkSchema,
});
export const openAiOAuthCancelRoute = defineRoute({
  method: "DELETE",
  path: "/api/providers/openai/oauth",
  tag: "providers",
  summary: "Cancel a ChatGPT sign-in that is waiting.",
  status: 204,
});

export const codexImagesStatusRoute = defineRoute({
  method: "GET",
  path: "/api/providers/codex-images",
  tag: "providers",
  summary: "Whether Codex Images is enabled and signed in, and any sign-in waiting for approval.",
  description: gateway,
  response: CodexImagesStatusSchema,
});
export const codexImagesSignInRoute = defineRoute({
  method: "POST",
  path: "/api/providers/codex-images/signin",
  tag: "providers",
  summary: "Start a Codex Images device-code sign-in; answers the code and the page to enter it on.",
  description: gateway,
  response: CodexImagesSignInResponseSchema,
});
export const codexImagesCancelRoute = defineRoute({
  method: "DELETE",
  path: "/api/providers/codex-images/signin",
  tag: "providers",
  summary: "Cancel a Codex Images sign-in that is waiting.",
  status: 204,
});
export const codexImagesSignOutRoute = defineRoute({
  method: "DELETE",
  path: "/api/providers/codex-images/credential",
  tag: "providers",
  summary: "Remove the saved Codex Images sign-in.",
  status: 204,
});

// ---- embedding ------------------------------------------------------------------------------------------------------

const EmbeddingProfileSchema = obj({
  id: str(),
  repository: str(),
  revision: str(),
  quant: str(),
  dims: int(),
  pooling: oneOf(["mean", "cls", "last", "provider"]),
  docTemplate: str(),
  queryTemplate: str(),
  maxInputTokens: int(),
  contextTokens: int(),
});
export const EmbeddingSetupSettingsSchema = obj({
  provider: oneOf(["off", "omlx", "openai"]),
  baseUrl: str(),
  apiModel: str(),
  profile: nullable(EmbeddingProfileSchema),
});
true satisfies Same<Static<typeof EmbeddingSetupSettingsSchema>, EmbeddingSetupSettings>;
export const SaveEmbeddingSetupSettingsSchema = obj({
  provider: oneOf(["off", "omlx", "openai"]),
  baseUrl: str(),
  apiModel: str(),
  profile: nullable(EmbeddingProfileSchema),
  advanced: opt(obj({ docTemplate: opt(str()), queryTemplate: opt(str()), contextTokens: opt(int()) })),
  apiKey: opt(str()),
});
true satisfies Same<Static<typeof SaveEmbeddingSetupSettingsSchema>, SaveEmbeddingSetupSettings>;
export const CheckEmbeddingSetupResponseSchema = obj({ ok: lit(true), dims: int() });
true satisfies Same<Static<typeof CheckEmbeddingSetupResponseSchema>, CheckEmbeddingSetupResponse>;

const embeddingErrors = '"unavailable" (no gateway), "bad_request"';
export const embeddingSetupRoute = defineRoute({
  method: "GET",
  path: "/api/embedding/setup",
  tag: "embedding",
  summary: "The embedding connection Memory search uses, without its key; null when the gateway has none.",
  description: 'Errors: "unavailable".',
  response: nullable(EmbeddingSetupSettingsSchema),
});
export const saveEmbeddingSetupRoute = defineRoute({
  method: "POST",
  path: "/api/embedding/setup",
  tag: "embedding",
  summary: "Save the embedding connection and re-index Memory search with it.",
  description: `Errors: ${embeddingErrors}, "setup_busy" (a save is already running), "embedding_failed".`,
  body: SaveEmbeddingSetupSettingsSchema,
  response: EmbeddingSetupSettingsSchema,
});
export const checkEmbeddingSetupRoute = defineRoute({
  method: "POST",
  path: "/api/embedding/check",
  tag: "embedding",
  summary: "Test an embedding connection exactly as entered, saving nothing.",
  description: `Errors: ${embeddingErrors}, "embedding_failed" (the model answered with other dimensions than the profile).`,
  body: SaveEmbeddingSetupSettingsSchema,
  response: CheckEmbeddingSetupResponseSchema,
});

export const settingsRoutes = [
  createAgentRoute,
  updateAgentRoute,
  deleteAgentRoute,
  agentInstructionsRoute,
  modelsRoute,
  modelSettingsRoute,
  updateModelSettingsRoute,
  titleSettingsRoute,
  updateTitleSettingsRoute,
  memoryExtractionRoute,
  updateMemoryExtractionRoute,
  firstTimeSetupRoute,
  updateFirstTimeSetupRoute,
  behaviorSettingsRoute,
  updateBehaviorSettingsRoute,
  contextSettingsRoute,
  updateContextSettingsRoute,
  timeZoneRoute,
  updateTimeZoneRoute,
  backupSettingsRoute,
  updateBackupSettingsRoute,
  backupPasswordRoute,
  backupRepositoryRoute,
  forgetBackupRepositoryRoute,
  runBackupRoute,
  sandboxNetworkRoute,
  updateSandboxNetworkRoute,
  providersRoute,
  saveProviderRoute,
  removeProviderRoute,
  scanProviderModelsRoute,
  scanProviderLimitsRoute,
  searchStatusRoute,
  searchSettingsRoute,
  saveSearchSettingsRoute,
  openAiOAuthStartRoute,
  openAiOAuthStatusRoute,
  openAiOAuthCallbackRoute,
  openAiOAuthCancelRoute,
  codexImagesStatusRoute,
  codexImagesSignInRoute,
  codexImagesCancelRoute,
  codexImagesSignOutRoute,
  embeddingSetupRoute,
  saveEmbeddingSetupRoute,
  checkEmbeddingSetupRoute,
];
