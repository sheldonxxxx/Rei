import type {
  AddMemoryLineRequest,
  AgentInstructionsResponse,
  AgentsResponse,
  ApprovalsResponse,
  Attachment,
  AuthStateResponse,
  BehaviorSettingsResponse,
  CancelResponse,
  ChannelResponse,
  CompactRequest,
  CompactResponse,
  CompanionResponse,
  ConnectorOAuthFinishRequest,
  ConnectorOAuthStartRequest,
  ConnectorOAuthStartResponse,
  ConnectorResponse,
  ConnectorsResponse,
  ConnectorToolClass,
  ConnectorToolsResponse,
  ContextSettings,
  CreateAgentRequest,
  CreateAgentResponse,
  CreateConnectorRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  DecideApprovalGroupRequest,
  DecideApprovalRequest,
  DecideApprovalResponse,
  Device,
  DevicePresenceRequest,
  DevicesResponse,
  EditLogResponse,
  EditMessageRequest,
  EditMessageResponse,
  EndTakeoverRequest,
  EndTakeoverResponse,
  ErrorBody,
  ErrorInfo,
  EventSourcesResponse,
  FileReference,
  FirstTimeSetupSettings,
  ForkPreviewResponse,
  ForkRequest,
  ForkResponse,
  GrantsResponse,
  HistorySearchResponse,
  ImportSkillRequest,
  IndexStatusResponse,
  KnowledgeOverview,
  KnowledgePageDetail,
  KnowledgeRevision,
  KnowledgeSearchHit,
  KnowledgeTreeNode,
  LibraryDetail,
  LibraryFile,
  LibraryFolder,
  LibraryList,
  LoginRequest,
  MemoryChange,
  MemoryChangesResponse,
  MemoryExtractionSettings,
  MemoryLineResponse,
  MemoryResponse,
  MessageContext,
  ModelSettingsResponse,
  ModelsResponse,
  NotificationsResponse,
  OkResponse,
  PluginDetail,
  PluginInstallationRequest,
  PluginSummary,
  ProviderConnection,
  ProviderConnectionsResponse,
  PushKeyResponse,
  ReadMarker,
  ReadMarkerResponse,
  RegisterChannelRequest,
  RunTriggerResponse,
  SandboxNetworkSettings,
  SavePluginRequest,
  SaveProviderConnectionRequest,
  ScanProviderModelsRequest,
  ScanProviderModelsResponse,
  SendMessageRequest,
  SendMessageResponse,
  SendWhenBusy,
  SessionDetailResponse,
  SessionSkillsResponse,
  SessionsResponse,
  SessionTraceResponse,
  SetupStartRequest,
  SetupStartResponse,
  SkillFile,
  SkillResponse,
  SkillSavedResponse,
  SkillsResponse,
  StartTakeoverResponse,
  StepDetailResponse,
  SurfaceActionRequest,
  SurfaceActionResponse,
  SurfaceDetailResponse,
  SwitchVersionRequest,
  TimeZoneSettings,
  TitleSettings,
  TranscriptPageResponse,
  TriggerResponse,
  TriggersResponse,
  TriggerUpdatedResponse,
  UndoMemoryChangeResponse,
  UpdateAgentRequest,
  UpdateAgentResponse,
  UpdateBehaviorSettingsRequest,
  UpdateCompanionRequest,
  UpdateConnectorRequest,
  UpdateContextSettingsRequest,
  UpdateFirstTimeSetupRequest,
  UpdateMemoryExtractionRequest,
  UpdateMemoryLineRequest,
  UpdateModelSettingsRequest,
  UpdatePreviewRequest,
  UpdateSandboxNetworkRequest,
  UpdateSessionRequest,
  UpdateSessionResponse,
  UpdateSkillRequest,
  UpdateTimeZoneRequest,
  UpdateTitleSettingsRequest,
  UpdateTriggerRequest,
  UsagePeriod,
  UsageResponse,
  WebDocumentResponse,
  WebSearchSetupStatus,
} from "@rei/protocol";
import {
  CLIENT_HEADER,
  COMPACT_INSTRUCTIONS_MAX,
  CSRF_HEADER,
  clientIdHeader,
  MEMORY_LINE_MAX_CHARS,
} from "@rei/protocol";

export const NETWORK_ERROR = "network_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface ApiOptions {
  fetch?: typeof fetch;
  /** Called for any 401 outside the login and setup endpoints. */
  onUnauthorized?: () => void;
  /** Retries for idempotent sends after a network error or a 502/503/504. Default 4. */
  sendRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  retries?: number;
}

/** How this app names itself to the server (docs/adr/0009). */
const WEB_CLIENT = clientIdHeader("web");

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export function createApi(options: ApiOptions = {}) {
  const sleep = options.sleep ?? defaultSleep;
  const call = (input: string, init: RequestInit) => (options.fetch ?? globalThis.fetch)(input, init);

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", [CLIENT_HEADER]: WEB_CLIENT };
    if (method !== "GET") headers[CSRF_HEADER] = "1";
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const retries = opts.retries ?? 0;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await call(path, { method, headers, body: payload, credentials: "same-origin" });
      } catch {
        if (attempt < retries) {
          await sleep(Math.min(8000, 500 * 2 ** attempt));
          continue;
        }
        throw new ApiError(0, NETWORK_ERROR, "Can't reach the server.");
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await sleep(Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const err = await toApiError(res);
      const isAuthEndpoint =
        path.startsWith("/api/auth/login") ||
        path.startsWith("/api/auth/passkeys/login") ||
        path.startsWith("/api/auth/setup") ||
        path.startsWith("/api/auth/totp/");
      if (res.status === 401 && !isAuthEndpoint) options.onUnauthorized?.();
      throw err;
    }
  }

  const post = <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, body ?? {}, opts);
  const enc = encodeURIComponent;

  return {
    getBackground: (query: Record<string, string> = {}) =>
      request<import("@rei/protocol").BackgroundList>("GET", `/api/background?${new URLSearchParams(query)}`),
    getBackgroundDetail: (id: string) =>
      request<import("@rei/protocol").BackgroundDetail>("GET", `/api/background/${enc(id)}`),
    retryBackground: (id: string) => post<{ retried: boolean }>(`/api/background/${enc(id)}/retry`),
    getAuthState: () => request<AuthStateResponse>("GET", "/api/auth/state"),
    setupStart: (req: SetupStartRequest) => post<SetupStartResponse>("/api/auth/setup", req),
    startTotp: (password: string) =>
      post<import("@rei/protocol").TotpSetupResponse>("/api/auth/totp/start", { password }),
    confirmTotp: (password: string, totpCode: string) => post<void>("/api/auth/totp/confirm", { password, totpCode }),
    disableTotp: (password: string, totpCode: string) => post<void>("/api/auth/totp/disable", { password, totpCode }),
    login: (req: LoginRequest) => post<void>("/api/auth/login", req),
    logout: () => post<void>("/api/auth/logout"),
    passkeyLoginOptions: () => post<import("@rei/protocol").PasskeyOptionsResponse>("/api/auth/passkeys/login/options"),
    passkeyLogin: (req: import("@rei/protocol").PasskeyLoginRequest) => post<void>("/api/auth/passkeys/login", req),
    passkeyRegisterOptions: (password: string) =>
      post<import("@rei/protocol").PasskeyOptionsResponse>("/api/auth/passkeys/register/options", { password }),
    passkeyRegister: (req: import("@rei/protocol").PasskeyRegisterRequest) =>
      post<import("@rei/protocol").Passkey>("/api/auth/passkeys/register", req),
    listPasskeys: () => request<import("@rei/protocol").PasskeysResponse>("GET", "/api/auth/passkeys"),
    removePasskey: (id: string) => request<void>("DELETE", `/api/auth/passkeys/${enc(id)}`),
    getAgents: () => request<AgentsResponse>("GET", "/api/agents"),
    /** Make an agent from one sentence; a model writes its name, look and instructions. Answers the agent and its home chat; the global stream announces both. */
    createAgent: (description: string) =>
      post<CreateAgentResponse>("/api/agents", { description } satisfies CreateAgentRequest),
    /** Delete an agent with its chats, triggers, grants and memory (not the default agent). The global stream sends `agent.removed` and a `session.removed` per chat. */
    deleteAgent: (agentId: string) => request<OkResponse>("DELETE", `/api/agents/${enc(agentId)}`),
    /** Change an agent: its look (avatar), name, model and default profile. The global stream announces the change as `agent.upserted`. */
    updateAgent: (agentId: string, req: UpdateAgentRequest) =>
      request<UpdateAgentResponse>("PATCH", `/api/agents/${enc(agentId)}`, req),
    /** The models an agent can be set to, and the default one. */
    getModels: () => request<ModelsResponse>("GET", "/api/models"),
    getModelSettings: () => request<ModelSettingsResponse>("GET", "/api/settings/models"),
    updateModelSettings: (req: UpdateModelSettingsRequest) =>
      request<ModelSettingsResponse>("PUT", "/api/settings/models", req),
    getProviders: () => request<ProviderConnectionsResponse>("GET", "/api/providers"),
    getSearchSetup: () => request<import("@rei/protocol").SearchSetupSettings>("GET", "/api/providers/search-settings"),
    saveSearchSetup: (req: import("@rei/protocol").SaveSearchSetupSettings) =>
      post<import("@rei/protocol").SearchSetupSettings>("/api/providers/search-settings", req),
    checkEmbeddingSetup: (settings: import("@rei/protocol").SaveEmbeddingSetupSettings) =>
      post<import("@rei/protocol").CheckEmbeddingSetupResponse>("/api/embedding/check", settings),
    getEmbeddingSetup: () =>
      request<import("@rei/protocol").EmbeddingSetupSettings | null>("GET", "/api/embedding/setup"),
    saveEmbeddingSetup: (settings: import("@rei/protocol").SaveEmbeddingSetupSettings) =>
      post<import("@rei/protocol").EmbeddingSetupSettings>("/api/embedding/setup", settings),
    getMemorySetup: () => request<import("@rei/protocol").MemorySetupSettings>("GET", "/api/memory/setup"),
    saveMemorySetup: (enabled: boolean) =>
      post<import("@rei/protocol").MemorySetupSettings>("/api/memory/setup", { enabled }),
    getWebSearchStatus: () => request<WebSearchSetupStatus>("GET", "/api/providers/search-status"),
    scanProviderModels: (req: ScanProviderModelsRequest) =>
      post<ScanProviderModelsResponse>("/api/providers/scan", req),
    saveProvider: (req: SaveProviderConnectionRequest) => post<ProviderConnection>("/api/providers", req),
    scanModelLimits: (id: string) => post<ProviderConnection>(`/api/providers/${enc(id)}/limits/scan`),
    removeProvider: (id: string) => request<void>("DELETE", `/api/providers/${enc(id)}`),
    startOpenAiOAuth: () => post<{ authorizationUrl: string }>("/api/providers/openai/oauth/start"),
    getOpenAiOAuthStatus: () =>
      request<{ pending: boolean; authorizationUrl?: string; error?: string }>(
        "GET",
        "/api/providers/openai/oauth/status",
      ),
    submitOpenAiOAuthCallback: (url: string) => post<{ ok: boolean }>("/api/providers/openai/oauth/callback", { url }),
    cancelOpenAiOAuth: () => request<void>("DELETE", "/api/providers/openai/oauth"),
    getCodexImages: () => request<import("@rei/protocol").CodexImagesStatus>("GET", "/api/providers/codex-images"),
    startCodexImagesSignIn: () =>
      post<{ userCode: string; verificationUrl: string }>("/api/providers/codex-images/signin"),
    cancelCodexImagesSignIn: () => request<void>("DELETE", "/api/providers/codex-images/signin"),
    signOutCodexImages: () => request<void>("DELETE", "/api/providers/codex-images/credential"),
    /** How chats you start get their title: the first message, or a short model call after the first reply. */
    getTitleSettings: () => request<TitleSettings>("GET", "/api/settings/titles"),
    updateTitleSettings: (req: UpdateTitleSettingsRequest) =>
      request<TitleSettings>("PUT", "/api/settings/titles", req),
    getFirstTimeSetup: () => request<FirstTimeSetupSettings>("GET", "/api/settings/first-time-setup"),
    updateFirstTimeSetup: (req: UpdateFirstTimeSetupRequest) =>
      request<FirstTimeSetupSettings>("PUT", "/api/settings/first-time-setup", req),
    /** Whether finished chats are reviewed in the background for memory (off by default; it costs model calls). */
    getMemoryExtraction: () => request<MemoryExtractionSettings>("GET", "/api/settings/memory-extraction"),
    updateMemoryExtraction: (req: UpdateMemoryExtractionRequest) =>
      request<MemoryExtractionSettings>("PUT", "/api/settings/memory-extraction", req),
    getBehaviorSettings: () => request<BehaviorSettingsResponse>("GET", "/api/settings/behavior"),
    updateBehaviorSettings: (req: UpdateBehaviorSettingsRequest) =>
      request<BehaviorSettingsResponse>("PUT", "/api/settings/behavior", req),
    getAgentInstructions: (id: string) =>
      request<AgentInstructionsResponse>("GET", `/api/agents/${encodeURIComponent(id)}/instructions`),
    /** Pi compaction and home-chat context trimming. */
    getContextSettings: () => request<ContextSettings>("GET", "/api/settings/context"),
    updateContextSettings: (req: UpdateContextSettingsRequest) =>
      request<ContextSettings>("PUT", "/api/settings/context", req),
    /** The user's time zone; null until the browser saves its own on first open. */
    getTimeZone: () => request<TimeZoneSettings>("GET", "/api/settings/time-zone"),
    updateTimeZone: (req: UpdateTimeZoneRequest) => request<TimeZoneSettings>("PUT", "/api/settings/time-zone", req),
    /** Picks the companion agent: the one companion clients (widgets, quick-send) talk to. */
    updateCompanion: (req: UpdateCompanionRequest) => request<CompanionResponse>("PUT", "/api/settings/companion", req),
    /** The sandbox whitelist that restricted agents reach without asking, and the defaults a reset restores. */
    getSandboxNetwork: () => request<SandboxNetworkSettings>("GET", "/api/settings/sandbox-network"),
    updateSandboxNetwork: (req: UpdateSandboxNetworkRequest) =>
      request<SandboxNetworkSettings>("PUT", "/api/settings/sandbox-network", req),
    knowledgeTree: () => request<{ pages: KnowledgeTreeNode[] }>("GET", "/api/knowledge/tree"),
    knowledgeOverview: () => request<KnowledgeOverview>("GET", "/api/knowledge/overview"),
    knowledgeTrash: () => request<{ pages: KnowledgeTreeNode[] }>("GET", "/api/knowledge/trash"),
    knowledgeTags: () => request<{ tags: string[] }>("GET", "/api/knowledge/tags"),
    searchKnowledge: (q: string, under?: string, tags?: string[]) =>
      request<{ hits: KnowledgeSearchHit[] }>(
        "GET",
        `/api/knowledge/search?${new URLSearchParams({ q, ...(under ? { under } : {}), ...(tags?.length ? { tags: JSON.stringify(tags) } : {}) })}`,
      ),
    /** Live pages that link to a Library file. */
    knowledgeFileUsage: (fileId: string) =>
      request<{ pages: { id: string; title: string; path: string }[] }>(
        "GET",
        `/api/knowledge/file-usage/${enc(fileId)}`,
      ),
    getKnowledgePage: (id: string) => request<KnowledgePageDetail>("GET", `/api/knowledge/pages/${enc(id)}`),
    getKnowledgeRevision: (id: string, revision: number) =>
      request<KnowledgeRevision & { body: string }>("GET", `/api/knowledge/pages/${enc(id)}/revisions/${revision}`),
    createKnowledgePage: (page: {
      parentId: string | null;
      title?: string;
      description?: string;
      body?: string;
      metadata?: { tags: string[] };
      sourceMarkdown?: string;
    }) => post<KnowledgePageDetail>("/api/knowledge/pages", page),
    /** The editor's save, against the revision it opened; a 409 carries the current revision and text. */
    saveKnowledgePage: (
      id: string,
      baseRevision: number,
      change: {
        title?: string;
        description?: string;
        body?: string;
        metadata?: { tags: string[] };
        sourceMarkdown?: string;
      },
    ) => request<KnowledgePageDetail>("PUT", `/api/knowledge/pages/${enc(id)}`, { ...change, baseRevision }),
    patchKnowledgePage: (
      id: string,
      patch: { task?: { index: number; done: boolean }; parentId?: string | null; locked?: boolean; pinned?: boolean },
    ) => request<KnowledgePageDetail>("PATCH", `/api/knowledge/pages/${enc(id)}`, patch),
    restoreKnowledgeRevision: (id: string, revision: number, baseRevision: number) =>
      post<KnowledgePageDetail>(`/api/knowledge/pages/${enc(id)}/restore-revision`, { revision, baseRevision }),
    trashKnowledgePage: (id: string) => post<{ trashed: number }>(`/api/knowledge/pages/${enc(id)}/trash`),
    restoreKnowledgePage: (id: string) => post<KnowledgePageDetail>(`/api/knowledge/pages/${enc(id)}/restore`),
    purgeKnowledgePage: (id: string) =>
      request<{ deleted: number }>("DELETE", `/api/knowledge/pages/${enc(id)}`, { confirm: true }),
    knowledgeMarkdownUrl: (id: string) => `/api/knowledge/pages/${enc(id)}/markdown`,
    listFiles: (query: Record<string, string> = {}) =>
      request<LibraryList>("GET", `/api/files?${new URLSearchParams(query)}`),
    getFile: (id: string) => request<LibraryDetail>("GET", `/api/files/${enc(id)}`),
    patchFile: (
      id: string,
      patch: { name?: string; favorite?: boolean; folderId?: string | null; trashed?: boolean },
    ) => request<{ file: LibraryFile }>("PATCH", `/api/files/${enc(id)}`, patch),
    purgeFile: (id: string) => request<OkResponse>("DELETE", `/api/files/${enc(id)}`, { confirm: true }),
    restoreFileVersion: (id: string, versionId: string, baseVersionId: string) =>
      post<{ file: LibraryFile }>(`/api/files/${enc(id)}/restore-version`, { versionId, baseVersionId }),
    saveLibraryFolder: (name: string, parentId: string | null, id?: string) =>
      request<{ folder: LibraryFolder }>(id ? "PATCH" : "POST", `/api/library/folders${id ? `/${enc(id)}` : ""}`, {
        name,
        parentId,
      }),
    deleteLibraryFolder: (id: string) => request<OkResponse>("DELETE", `/api/library/folders/${enc(id)}`),
    uploadLibraryFile: async (
      file: File,
      selection: { folderId?: string; fileId?: string; baseVersionId?: string } = {},
    ): Promise<LibraryFile> => {
      const form = new FormData();
      form.append("file", file);
      const path = selection.fileId
        ? `/api/files/${enc(selection.fileId)}/versions?baseVersionId=${enc(selection.baseVersionId ?? "")}`
        : `/api/files${selection.folderId ? `?folder=${enc(selection.folderId)}` : ""}`;
      const res = await call(path, {
        method: "POST",
        headers: { [CSRF_HEADER]: "1", [CLIENT_HEADER]: WEB_CLIENT },
        body: form,
        credentials: "same-origin",
      });
      if (res.status === 401) options.onUnauthorized?.();
      if (!res.ok) throw await toApiError(res);
      return ((await res.json()) as { file: LibraryFile }).file;
    },
    getSessions: (options?: { agent?: string; before?: string; triggers?: "1" }) => {
      const query = options ? `?${new URLSearchParams({ paged: "1", ...options })}` : "";
      return request<SessionsResponse>("GET", `/api/sessions${query}`);
    },
    /** The skills this session's agent can use now, for the `/` list. */
    getSessionSkills: (id: string) => request<SessionSkillsResponse>("GET", `/api/sessions/${enc(id)}/skills`),
    /** Starts a manual compaction (`/compact`); idempotent by requestId. The answer is accepted or running, not done. */
    compact: (id: string, req: CompactRequest) => post<CompactResponse>(`/api/sessions/${enc(id)}/compact`, req),
    getCompactStatus: (id: string, requestId: string) =>
      request<CompactResponse>("GET", `/api/sessions/${enc(id)}/compact/${enc(requestId)}`),
    getContextUsage: (id: string) =>
      request<import("@rei/protocol").ContextUsageResponse>("GET", `/api/sessions/${enc(id)}/context`),
    getSessionSummary: (id: string) =>
      request<Pick<SessionDetailResponse, "session">>("GET", `/api/sessions/${enc(id)}/summary`),
    getRelatedSessions: (id: string) => request<SessionsResponse>("GET", `/api/sessions/${enc(id)}/related`),
    createSession: (req: CreateSessionRequest = {}) => post<CreateSessionResponse>("/api/sessions", req),
    uploadAttachment: async (sessionId: string, file: File): Promise<Attachment> => {
      const form = new FormData();
      form.append("file", file);
      const res = await call(`/api/sessions/${enc(sessionId)}/attachments`, {
        method: "POST",
        headers: { [CSRF_HEADER]: "1", [CLIENT_HEADER]: WEB_CLIENT },
        body: form,
        credentials: "same-origin",
      });
      if (res.status === 401) options.onUnauthorized?.();
      if (!res.ok) throw await toApiError(res);
      return ((await res.json()) as { attachment: Attachment }).attachment;
    },
    getSession: (id: string) => request<SessionDetailResponse>("GET", `/api/sessions/${enc(id)}`),
    /** Idempotent by requestId, so a network failure is retried with the same body. */
    sendMessage: (
      sessionId: string,
      requestId: string,
      text: string,
      context: MessageContext = {},
      sendOptions: { whenBusy?: SendWhenBusy } = {},
    ) => {
      if (context.attachments?.some((a) => !a.fileId || !a.versionId))
        throw new Error("An attachment is missing its saved file version. Upload it again.");
      const req: SendMessageRequest = {
        requestId,
        text,
        ...(context.attachments?.some((a) => a.fileId && a.versionId)
          ? {
              files: context.attachments
                .filter((a) => a.fileId && a.versionId)
                .map(
                  (a): FileReference => ({
                    fileId: a.fileId!,
                    versionId: a.versionId!,
                    ...(a.location ? { location: a.location } : {}),
                  }),
                ),
            }
          : {}),
        ...(context.mentions?.length ? { mentions: context.mentions } : {}),
        ...(context.selectedSkills?.length
          ? { selectedSkills: context.selectedSkills.map(({ id, version }) => ({ id, version })) }
          : {}),
        ...(sendOptions.whenBusy ? { whenBusy: sendOptions.whenBusy } : {}),
      };
      return post<SendMessageResponse>(`/api/sessions/${enc(sessionId)}/messages`, req, {
        retries: options.sendRetries ?? 4,
      });
    },
    /** A button press or a form submit in a component; it becomes a user message and starts a run. */
    /** Sends a surface action (a button press or a form submit); it becomes the next user input. */
    surfaceAction: (sessionId: string, surfaceId: string, req: SurfaceActionRequest) =>
      post<SurfaceActionResponse>(`/api/sessions/${enc(sessionId)}/surfaces/${enc(surfaceId)}/actions`, req),
    /** A surface's revisions, failures and action decisions, for the Inspector. */
    surfaceDetail: (sessionId: string, surfaceId: string) =>
      request<SurfaceDetailResponse>("GET", `/api/sessions/${enc(sessionId)}/surfaces/${enc(surfaceId)}`),
    cancel: (sessionId: string) => post<CancelResponse>(`/api/sessions/${enc(sessionId)}/cancel`),
    /** Starts a new run after a failed one (409 "busy" while a run is going). */
    continueRun: (sessionId: string) => post<{ runId: string }>(`/api/sessions/${enc(sessionId)}/continue`),
    /** Items older than `before`, oldest first, and where the next older page starts (null at the start). */
    getTranscript: (sessionId: string, before: string, limit?: number) =>
      request<TranscriptPageResponse>(
        "GET",
        `/api/sessions/${enc(sessionId)}/transcript?before=${enc(before)}${limit ? `&limit=${limit}` : ""}`,
      ),
    /** Branch at a finished reply. */
    forkSession: (sessionId: string, messageId: string) =>
      post<ForkResponse>(`/api/sessions/${enc(sessionId)}/fork`, { messageId } satisfies ForkRequest),
    /** Edit or Retry one of your messages in the same chat. */
    editMessage: (sessionId: string, req: EditMessageRequest) =>
      post<EditMessageResponse>(`/api/sessions/${enc(sessionId)}/edit`, req),
    switchVersion: (sessionId: string, req: SwitchVersionRequest) =>
      post<OkResponse>(`/api/sessions/${enc(sessionId)}/version`, req),
    /** `withForks` also deletes every other session in the same fork tree; `clearHome` clears an agent's home chat (it gets a fresh one). */
    deleteSession: (sessionId: string, opts: { withForks?: boolean; clearHome?: boolean } = {}) => {
      const query = [opts.withForks && "withForks=1", opts.clearHome && "clearHome=1"].filter(Boolean).join("&");
      return request<OkResponse>("DELETE", `/api/sessions/${enc(sessionId)}${query ? `?${query}` : ""}`);
    },
    /** Moves the session's read marker (shared by every device) to an item seen on screen; it never moves backwards. */
    markRead: (sessionId: string, req: ReadMarker) =>
      request<ReadMarkerResponse>("PUT", `/api/sessions/${enc(sessionId)}/read-marker`, req),
    /** Change a session's settings, title, or sidebar pin. */
    updateSession: (sessionId: string, req: UpdateSessionRequest) =>
      request<UpdateSessionResponse>("PATCH", `/api/sessions/${enc(sessionId)}`, req),
    /** Take over the session's browser window now; accepts the agent's pending request too. */
    startTakeover: (sessionId: string) =>
      post<StartTakeoverResponse>(`/api/sessions/${enc(sessionId)}/browser/takeover`),
    /** "done" hands the page back (the agent carries on if it asked); "cancel" declines or gives up. */
    endTakeover: (takeoverId: string, req: EndTakeoverRequest) =>
      post<EndTakeoverResponse>(`/api/takeovers/${enc(takeoverId)}/end`, req),
    listApprovals: () => request<ApprovalsResponse>("GET", "/api/approvals"),
    decideApproval: (approvalId: string, req: DecideApprovalRequest) =>
      post<DecideApprovalResponse>(`/api/approvals/${enc(approvalId)}/decide`, req),
    decideApprovalGroup: (groupId: string, req: DecideApprovalGroupRequest) =>
      post<ApprovalsResponse>(`/api/approval-groups/${enc(groupId)}/decide`, req),
    listGrants: () => request<GrantsResponse>("GET", "/api/grants"),
    revokeGrant: (grantId: string) => request<OkResponse>("DELETE", `/api/grants/${enc(grantId)}`),

    // ---- Full mode ----
    /** The newest runs first, 30 a page; `before` is the previous page's `next`. */
    getTrace: (sessionId: string, before?: string) =>
      request<SessionTraceResponse>(
        "GET",
        `/api/sessions/${enc(sessionId)}/trace${before ? `?before=${enc(before)}` : ""}`,
      ),
    getStep: (stepId: string) => request<StepDetailResponse>("GET", `/api/steps/${enc(stepId)}`),
    /** The stored readable copy of the page a web_fetch step read, for people only; 404 once it is gone. */
    getStepWebDocument: (stepId: string) =>
      request<WebDocumentResponse>("GET", `/api/steps/${enc(stepId)}/web-document`),
    /** What a fork at a reply would leave behind. */
    forkPreview: (sessionId: string, messageId: string) =>
      request<ForkPreviewResponse>("GET", `/api/sessions/${enc(sessionId)}/fork-preview?messageId=${enc(messageId)}`),
    getEdits: (limit = 50) => request<EditLogResponse>("GET", `/api/edits?limit=${limit}`),

    // ---- memory ----
    getUsage: (period: UsagePeriod = "30d", range?: { from: string; to: string }) =>
      request<UsageResponse>(
        "GET",
        `/api/usage?${new URLSearchParams({ period, ...(period === "custom" && range ? range : {}) })}`,
      ),
    getMemory: () => request<MemoryResponse>("GET", "/api/memory"),
    addMemoryLine: (req: AddMemoryLineRequest) => post<MemoryLineResponse>("/api/memory/lines", req),
    /** An edit by you; it also confirms the line. */
    updateMemoryLine: (lineId: string, req: UpdateMemoryLineRequest) =>
      request<MemoryLineResponse>("PATCH", `/api/memory/lines/${enc(lineId)}`, req),
    deleteMemoryLine: (lineId: string) =>
      request<{ change: MemoryChange }>("DELETE", `/api/memory/lines/${enc(lineId)}`),
    /** A line's versions, oldest first. */
    getMemoryChanges: (lineId: string) =>
      request<MemoryChangesResponse>("GET", `/api/memory/lines/${enc(lineId)}/changes`),
    undoMemoryChange: (changeId: string) => post<UndoMemoryChangeResponse>(`/api/memory/changes/${enc(changeId)}/undo`),
    /** `from` and `to` are epoch ms; `agent` limits the search to that agent's chats. */
    searchHistory: (params: {
      q: string;
      from?: number | undefined;
      to?: number | undefined;
      agent?: string | undefined;
      limit?: number | undefined;
    }) => {
      const qs = new URLSearchParams({ q: params.q });
      if (params.from !== undefined) qs.set("from", String(params.from));
      if (params.to !== undefined) qs.set("to", String(params.to));
      if (params.agent !== undefined) qs.set("agent", params.agent);
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      return request<HistorySearchResponse>("GET", `/api/history/search?${qs}`);
    },
    getIndexStatus: () => request<IndexStatusResponse>("GET", "/api/memory/index"),
    rebuildIndex: () => post<IndexStatusResponse>("/api/memory/index/rebuild"),

    // ---- triggers and skills ----
    getTriggers: () => request<TriggersResponse>("GET", "/api/triggers"),
    /** The event sources (read-only), with the last event and the types seen lately. */
    getEventSources: () => request<EventSourcesResponse>("GET", "/api/event-sources"),
    /** The trigger and its newest 50 runs; `before` is the previous page's `next`. */
    getTrigger: (id: string, before?: string) =>
      request<TriggerResponse>("GET", `/api/triggers/${enc(id)}${before ? `?before=${enc(before)}` : ""}`),
    updateTrigger: (id: string, req: UpdateTriggerRequest) =>
      request<TriggerUpdatedResponse>("PATCH", `/api/triggers/${enc(id)}`, req),
    runTrigger: (id: string) => post<RunTriggerResponse>(`/api/triggers/${enc(id)}/run`),
    deleteTrigger: (id: string, opts: { withSessions?: boolean } = {}) =>
      request<OkResponse>("DELETE", `/api/triggers/${enc(id)}${opts.withSessions ? "?withSessions=1" : ""}`),
    getPlugins: () => request<{ plugins: PluginSummary[] }>("GET", "/api/plugins"),
    getPlugin: (id: string, revision?: number) =>
      request<{ plugin: PluginDetail }>("GET", `/api/plugins/${enc(id)}${revision ? `?revision=${revision}` : ""}`),
    createPlugin: (req: SavePluginRequest) => post<{ plugin: PluginDetail }>("/api/plugins", req),
    updatePlugin: (id: string, req: SavePluginRequest) =>
      request<{ plugin: PluginDetail }>("PATCH", `/api/plugins/${enc(id)}`, req),
    installPlugin: (id: string, req: PluginInstallationRequest) =>
      request<{ plugin: PluginDetail }>("PATCH", `/api/plugins/${enc(id)}/installation`, req),
    retryPlugin: (id: string) => post<{ plugin: PluginDetail }>(`/api/plugins/${enc(id)}/retry`, {}),
    deletePlugin: (id: string) => request<{ ok: boolean }>("DELETE", `/api/plugins/${enc(id)}`),
    importPlugin: (req: { zip?: string; files?: SkillFile[]; expectedRevision?: number }) =>
      post<{ plugin: PluginDetail }>("/api/plugins/import", req),
    getSkills: () => request<SkillsResponse>("GET", "/api/skills"),
    getSkill: (id: string, version?: number) =>
      request<SkillResponse>("GET", `/api/skills/${enc(id)}${version ? `?version=${version}` : ""}`),
    /** A skill of the same name gets a new version. */
    importSkill: (req: ImportSkillRequest) => post<SkillSavedResponse>("/api/skills", req),
    updateSkill: (id: string, req: UpdateSkillRequest) =>
      request<SkillSavedResponse>("PATCH", `/api/skills/${enc(id)}`, req),
    deleteSkill: (id: string) => request<OkResponse>("DELETE", `/api/skills/${enc(id)}`),

    // ---- notifications ----
    getPushKey: () => request<PushKeyResponse>("GET", "/api/push/key"),

    // ---- devices: every sign-in, its delivery channels, and whether it is in use ----
    getDevices: () => request<DevicesResponse>("GET", "/api/devices"),
    renameDevice: (id: string, label: string) => request<Device>("PATCH", `/api/devices/${enc(id)}`, { label }),
    /** Signs that device out; revoking this one signs you out here too. */
    revokeDevice: (id: string) => request<OkResponse>("DELETE", `/api/devices/${enc(id)}`),
    registerChannel: (req: RegisterChannelRequest) => post<ChannelResponse>("/api/devices/current/channels", req),
    removeChannel: (id: string) => request<OkResponse>("DELETE", `/api/devices/current/channels/${enc(id)}`),
    /** Whether this device is in use; while any device is, no notification is sent. */
    postPresence: (report: DevicePresenceRequest) => post<OkResponse>("/api/devices/current/presence", report),
    getNotifications: () => request<NotificationsResponse>("GET", "/api/notifications"),
    updatePreview: (preview: boolean) =>
      request<NotificationsResponse>("PUT", "/api/notifications/preview", { preview } satisfies UpdatePreviewRequest),
    /** Sends a test to every subscribed device; fails with the reason (the error's message is a sentence to show). */
    testNotifications: () => post<void>("/api/notifications/test"),

    // ---- MCP connectors ----
    getConnectors: () => request<ConnectorsResponse>("GET", "/api/connectors"),
    createConnector: (req: CreateConnectorRequest) => post<ConnectorResponse>("/api/connectors", req),
    updateConnector: (id: string, req: UpdateConnectorRequest) =>
      request<ConnectorResponse>("PATCH", `/api/connectors/${enc(id)}`, req),
    deleteConnector: (id: string) => request<void>("DELETE", `/api/connectors/${enc(id)}`),
    setMcpProfile: (
      id: string,
      profile: "always_ask" | "read_only" | "read_write" | "yolo",
      providerIdentity: string,
      expectedRevision: string,
      confirmYolo = false,
    ) =>
      request<ConnectorResponse>("PUT", `/api/connectors/${enc(id)}/profile`, {
        profile,
        providerIdentity,
        expectedRevision,
        confirmYolo,
      }),
    getConnectorTools: (id: string, refresh = false) =>
      request<ConnectorToolsResponse>("GET", `/api/connectors/${enc(id)}/tools${refresh ? "?refresh=1" : ""}`),
    /** null clears the override; a manual Read override requires the inspected definition fingerprint. */
    setToolClass: (id: string, tool: string, actionClass: ConnectorToolClass | null, definitionFingerprint?: string) =>
      request<OkResponse>("PUT", `/api/connectors/${enc(id)}/tools/${enc(tool)}`, {
        actionClass,
        ...(definitionFingerprint ? { definitionFingerprint } : {}),
      }),
    /** The address to send this tab to for signing in; the provider sends the browser back to the app. */
    startConnectorSignIn: (id: string, req: ConnectorOAuthStartRequest = {}) =>
      post<ConnectorOAuthStartResponse>(`/api/connectors/${enc(id)}/oauth/start`, req),
    finishConnectorSignIn: (req: ConnectorOAuthFinishRequest) =>
      post<ConnectorResponse>("/api/connectors/oauth/finish", req),
  };
}

export type Api = ReturnType<typeof createApi>;

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as Partial<ErrorBody>;
    if (body?.error && typeof body.error.code === "string") {
      return new ApiError(res.status, body.error.code, body.error.message ?? "");
    }
  } catch {
    // not JSON (a proxy error page); fall through
  }
  return new ApiError(
    res.status,
    res.status === 401 ? "unauthenticated" : `http_${res.status}`,
    `Request failed (${res.status}).`,
  );
}

const MESSAGES: Record<string, string> = {
  bad_credentials: "Wrong password or code",
  rate_limited: "Too many attempts. Wait a few minutes, then try again.",
  bad_setup_code: "That setup code isn't right. Check the code printed on the server.",
  weak_password: "Choose a password of at least 12 characters.",
  already_set_up: "This assistant is already set up. Sign in instead.",
  bad_totp: "That code didn't match. Check your authenticator app and try again.",
  bad_passkey: "That passkey wasn't accepted. Try again, or sign in with your password.",
  passkey_expired: "The passkey request timed out. Try again.",
  no_passkeys: "No passkey is set up yet. Sign in with your password.",
  passkey_exists: "That passkey is already added.",
  unauthenticated: "Your session has ended. Sign in again.",
  csrf: "The request was rejected. Reload the page and try again.",
  not_found: "That chat no longer exists.",
  empty_message: "Type a message first.",
  too_long: "That message is too long (over 32,000 characters).",
  unknown_agent: "That agent doesn't exist.",
  default_agent: "The default agent can't be deleted.",
  not_forkable: "That reply can't be branched yet.",
  not_editable: "That message can't be edited right now.",
  already_submitted: "This form was already submitted.",
  bad_event: "That didn't match the component. Try the latest message.",
  home_chat: "A home chat can't be deleted.",
  not_pending: "Already decided.",
  bad_length: "That choice isn't available for this request.",
  bad_hours: "Enter a whole number of hours from 1 to 168.",
  bad_profile: "That permission level doesn't exist.",
  bad_title: "Choose a chat name between 1 and 80 characters.",
  bad_pinned: "The pin setting couldn't be saved.",
  no_window: "The browser window is closed.",
  bad_avatar: "That look can't be used. Pick a bot, a short emoji or text, or a smaller picture.",
  already_active: "You're already in control.",
  not_open: "This request is already over.",
  no_destinations: "Turn on notifications on this device first.",
  needs_auth: "This connector needs you to sign in again.",
  connector_unreachable: "The connector's server didn't answer. Try again in a moment.",
  connector_not_found: "That connector no longer exists.",
  invalid_state: "That sign-in link isn't valid any more. Start the sign-in again.",
  state_expired: "That sign-in took too long. Start it again.",
  iss_mismatch: "The sign-in came back from an unexpected server, so it was refused.",
  oauth_failed: "The sign-in didn't complete. Try again.",
  oauth_unsupported: "This server's sign-in isn't supported. Try a token instead.",
  bad_url: "That isn't an address the connector can use. It starts with https://",
  no_app_origin: "The app's address isn't known here. Open the app from its own address and try again.",
  gateway_unavailable: "The gateway isn't reachable right now. Try again in a moment.",
  [NETWORK_ERROR]: "Can't reach the server. Check your connection.",
};

/** User-facing text for an error; falls back to the server's own message. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError && ERROR_INFO_TEXT[e.code]) return ERROR_INFO_TEXT[e.code]!;
  if (e instanceof ApiError) return MESSAGES[e.code] ?? (e.message || `Something went wrong (${e.code}).`);
  return "Something went wrong.";
}

/** Codes the memory endpoints use with their own meaning ("too_long" there is a line, not a message). */
const MEMORY_MESSAGES: Record<string, string> = {
  too_long: `That line is too long (over ${MEMORY_LINE_MAX_CHARS} characters).`,
  over_budget: "Memory is full. Delete or shorten a line first.",
  empty: "Write something first.",
  unknown_agent: "That agent doesn't exist.",
  not_found: "That no longer exists.",
  not_undoable: "Can't undo this: the line was changed afterwards, or it was already undone.",
  already_decided: "Already decided.",
  line_changed: "That line was changed or removed since. Dismiss this and edit the line instead.",
  bad_query: "Type a word or phrase first.",
};

/** User-facing text for an error from a memory endpoint. */
export function describeMemoryError(e: unknown): string {
  if (e instanceof ApiError && MEMORY_MESSAGES[e.code]) return MEMORY_MESSAGES[e.code]!;
  return describeError(e);
}

/** User-facing text for an error from `/compact` ("too_long" there is the guidance, not a message). */
export function describeCompactError(e: unknown): string {
  if (e instanceof ApiError && e.code === "too_long")
    return `Compaction guidance can be at most ${COMPACT_INSTRUCTIONS_MAX} characters.`;
  if (e instanceof ApiError && e.code === "busy") return e.message || "Session busy. Try /compact again in a moment.";
  return describeError(e);
}

/** User-facing text for an error from the create or delete agent endpoints ("not_found" there is an agent, not a chat). */
export function describeAgentError(e: unknown): string {
  if (e instanceof ApiError && e.code === "not_found") return "That agent no longer exists.";
  if (e instanceof ApiError && e.code === "bad_request") return "Describe the agent in 1 to 500 characters.";
  if (e instanceof ApiError && e.code === "design_failed")
    return "The model couldn't design the agent just now (it may be busy or over its limit). Nothing was created; try again in a moment.";
  return describeError(e);
}

/** Codes the trigger and skill endpoints use; "bad_request" carries the server's own sentence about which rule failed. */
const SETUP_MESSAGES: Record<string, string> = {
  not_found: "That no longer exists.",
};

/** User-facing text for an error from a trigger or skill endpoint. */
export function describeSetupError(e: unknown): string {
  if (e instanceof ApiError && SETUP_MESSAGES[e.code]) return SETUP_MESSAGES[e.code]!;
  return describeError(e);
}

const ERROR_INFO_TEXT: Record<string, string> = {
  loop_guard: "Stopped: this reply hit its step or time limit.",
};

/** User-facing text for an error stored on a message or run; a few stable codes get app wording, the rest keep the server's sentence. */
export function describeErrorInfo(
  error: ErrorInfo | undefined,
  fallback = "Something went wrong while replying.",
): string {
  if (!error) return fallback;
  return ERROR_INFO_TEXT[error.code] ?? (error.message || fallback);
}
