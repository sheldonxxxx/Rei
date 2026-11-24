import { DEFAULT_SANDBOX_WHITELIST, normalizeWhitelist } from "@rei/network";
import type {
  BehaviorSettings,
  BehaviorSettingsResponse,
  BrowserStateResponse,
  ContextSettings,
  SkillSummary,
  UpdateModelSettingsRequest,
} from "@rei/protocol";
import {
  AGENT_DESCRIPTION_MAX_CHARS,
  type AgentSettingsPatch,
  addMemoryLineRoute,
  agentInstructionsRoute,
  authStateRoute,
  backgroundDetailRoute,
  backgroundListRoute,
  backgroundRetryRoute,
  behaviorSettingsRoute,
  CLIENT_HEADER,
  CLIENT_QUERY,
  type ClientId,
  type ClientKind,
  type ContextBreakdown,
  type ContextUsageResponse,
  CSRF_HEADER,
  cancelRoute,
  checkEmbeddingSetupRoute,
  codexImagesCancelRoute,
  codexImagesSignInRoute,
  codexImagesSignOutRoute,
  codexImagesStatusRoute,
  compactRoute,
  compactStatusRoute,
  connectorOAuthFinishRoute,
  connectorOAuthStartRoute,
  connectorsRoute,
  connectorToolsRoute,
  contextSettingsRoute,
  continueRoute,
  createAgentRoute,
  createConnectorRoute,
  createSessionRoute,
  type Device,
  decideApprovalGroupRoute,
  decideApprovalRoute,
  deleteAgentRoute,
  deleteConnectorRoute,
  deleteSessionRoute,
  deleteSkillRoute,
  deleteTriggerRoute,
  editLogRoute,
  editMessageRoute,
  embeddingSetupRoute,
  endTakeoverRoute,
  eventSourcesRoute,
  exportSkillRoute,
  filePreview,
  firstTimeSetupRoute,
  forkPreviewRoute,
  forkRoute,
  getAttachmentRoute,
  getSessionRoute,
  glanceRoute,
  globalStreamRoute,
  grantsRoute,
  healthRoute,
  historySearchRoute,
  importFileRoute,
  importLookupRoute,
  importSessionRoute,
  importSkillRoute,
  legacyPresenceRoute,
  listAgentsRoute,
  listApprovalsRoute,
  listDevicesRoute,
  listPasskeysRoute,
  listSessionsRoute,
  loginRoute,
  logoutRoute,
  MESSAGE_MAX_ATTACHMENT_BYTES,
  type MessageMention,
  MIN_CLIENT_PROTOCOL,
  mcpOAuthCallbackRoute,
  memoryExtractionRoute,
  memoryIndexRoute,
  memoryLineChangesRoute,
  memoryRoute,
  memorySetupRoute,
  modelSettingsRoute,
  modelsRoute,
  NATIVE_CLIENT_KINDS,
  notificationsRoute,
  openAiOAuthCallbackRoute,
  openAiOAuthCancelRoute,
  openAiOAuthStartRoute,
  openAiOAuthStatusRoute,
  PROTOCOL_VERSION,
  parseClientId,
  passkeyLoginOptionsRoute,
  passkeyLoginRoute,
  passkeyRegisterOptionsRoute,
  passkeyRegisterRoute,
  presenceRoute,
  previewAttachmentRoute,
  providersRoute,
  pushKeyRoute,
  pushSubscribeRoute,
  pushUnsubscribeRoute,
  type ResponseOf,
  readMarkerRoute,
  rebuildMemoryIndexRoute,
  receiveEventRoute,
  registerChannelRoute,
  relatedSessionsRoute,
  removeChannelRoute,
  removeMemoryLineRoute,
  removePasskeyRoute,
  removeProviderRoute,
  renameDeviceRoute,
  renamePasskeyRoute,
  revokeDeviceRoute,
  revokeGrantRoute,
  runTriggerRoute,
  type SandboxNetworkSettings,
  SESSION_COOKIE,
  type SelectedSkill,
  type SignedInResponse,
  sandboxNetworkRoute,
  saveEmbeddingSetupRoute,
  saveMemorySetupRoute,
  saveProviderRoute,
  saveSearchSettingsRoute,
  scanProviderLimitsRoute,
  scanProviderModelsRoute,
  searchSettingsRoute,
  searchStatusRoute,
  sendMessageRoute,
  sessionBrowserRoute,
  sessionContextRoute,
  sessionSkillsRoute,
  sessionStreamRoute,
  sessionSummaryRoute,
  sessionTraceRoute,
  setConnectorProfileRoute,
  setConnectorToolRoute,
  setupRoute,
  skillRoute,
  skillsRoute,
  startTakeoverRoute,
  stepImageRoute,
  stepRoute,
  stepWebDocumentRoute,
  storageDiagnosticsRoute,
  surfaceActionRoute,
  surfaceDetailRoute,
  switchVersionRoute,
  testNotificationsRoute,
  timeZoneRoute,
  titleSettingsRoute,
  totpConfirmRoute,
  totpDisableRoute,
  totpStartRoute,
  transcriptRoute,
  triggerRoute,
  triggersRoute,
  undoMemoryChangeRoute,
  updateAgentRoute,
  updateBehaviorSettingsRoute,
  updateCompanionRoute,
  updateConnectorRoute,
  updateContextSettingsRoute,
  updateFirstTimeSetupRoute,
  updateMemoryExtractionRoute,
  updateMemoryLineRoute,
  updateModelSettingsRoute,
  updatePreviewRoute,
  updateSandboxNetworkRoute,
  updateSessionRoute,
  updateSkillRoute,
  updateTimeZoneRoute,
  updateTitleSettingsRoute,
  updateTriggerRoute,
  uploadAttachmentRoute,
  usageRoute,
} from "@rei/protocol";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AttachmentService } from "../attachments/service.ts";
import { deviceLabel } from "../auth/device-label.ts";
import type { RelyingParty } from "../auth/passkeys.ts";
import { type AuthService, bearerToken, type DeviceRecord, type SignedIn } from "../auth/service.ts";
import type { BackgroundJob, BackgroundTaskService } from "../background/service.ts";
import type { BlobStore } from "../blobs/blob-store.ts";
import type { BrowserService } from "../browser/service.ts";
import type { TakeoverService } from "../browser/takeover-service.ts";
import { knowledgeRoutes } from "../knowledge/routes.ts";
import type { KnowledgeService } from "../knowledge/service.ts";
import { libraryRoutes } from "../library/routes.ts";
import type { McpService } from "../mcp/service.ts";
import type { BackgroundMemoryReview } from "../memory/background-review.ts";
import { embeddingBase, validateProfile } from "../memory/embedder.ts";
import { normaliseLine } from "../memory/lines.ts";
import type { MemoryService } from "../memory/service.ts";
import type { NotificationService } from "../notify/service.ts";
import type { PiAdapter } from "../pi/adapter.ts";
import type { AgentDesigner } from "../pi/agent-designer.ts";

const INSTRUCTIONS_MAX = 8_000;

import { EVENT_LIMITS, type EventReceiver, readLimited } from "../events/receive.ts";
import type { EventSources } from "../events/sources.ts";
import { type BehaviorDefaults, behaviorResponse, updateBehavior } from "../pi/behavior-settings.ts";
import type { ModelCatalog } from "../pi/catalog.ts";
import { savedTimeZone, saveTimeZone } from "../pi/clock-context.ts";
import { readContextSettings, updateContextSettings } from "../pi/context-settings.ts";
import { validLimit } from "../pi/model-config.ts";
import type { ToolCatalog } from "../pi/policy-ext.ts";
import type { TitleService } from "../pi/titles.ts";
import { pluginRoutes } from "../plugins/routes.ts";
import type { PluginService } from "../plugins/service.ts";
import { PROFILE_LABEL } from "../policy/decision.ts";
import type { ProviderService } from "../providers/service.ts";
import type { SkillStore } from "../skills/store.ts";
import { exportZip, importZip } from "../skills/zip.ts";
import type { FileObjectStore } from "../storage/file-object-store.ts";
import type { StorageMaintenance } from "../storage/maintenance.ts";
import type { ObjectRegistry } from "../storage/registry.ts";
import { GLOBAL_STREAM } from "../store/events.ts";
import { etagOf, glance, matchesEtag } from "../store/glance.ts";
import type { AppStore } from "../store/store.ts";
import { forkPreview, sessionTrace, stepDetail, stepImage, stepWebDocument } from "../trace.ts";
import { patchTrigger } from "../triggers/api.ts";
import type { TriggerScheduler } from "../triggers/scheduler.ts";
import type { TriggerStore } from "../triggers/store.ts";
import { loadedNames, readContextBreakdown } from "../usage/context-breakdown.ts";
import { readUsage } from "../usage/read.ts";
import { normalizeAvatar } from "../util/avatar.ts";
import type { Clock } from "../util/clock.ts";
import { badRequest, HttpError, notFound, unauthenticated } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { classifyError, type Logger } from "../util/log.ts";
import { knownTimeZone } from "../util/time.ts";
import { API_CSP, securityHeaders, serveWeb, type WebAssets } from "./assets.ts";
import { ContractViolation, mountRoute } from "./contract.ts";
import { withUpload } from "./multipart.ts";
import { sseResponse, viewSseResponse } from "./sse.ts";

export interface AppDeps {
  attachments?: AttachmentService;
  auth: AuthService;
  store: AppStore;
  adapter: PiAdapter;
  clock: Clock;
  log: Logger;
  web?: WebAssets;
  /** The blob store, for the trace's payloads and pictures. */
  /** Trace payloads only: file bytes are served by the attachment service. */
  traceBlobs: BlobStore;
  /** The object store, so the file diagnostics can say what SQLite owes the service. */
  storage: { registry: ObjectRegistry; maintenance: StorageMaintenance; objects: FileObjectStore };
  /** The agent computer's browser; absent when it is off: no window, no takeovers. */
  browser?: { service: BrowserService; takeovers: TakeoverService };
  /** The models an agent can be set to (GET /api/models). */
  modelCatalog?: ModelCatalog;
  /** How chats get their titles (GET and PUT /api/settings/titles). */
  titles?: TitleService;
  /** Whether finished chats are reviewed in the background for memory (GET and PUT /api/settings/memory-extraction). */
  memoryExtraction?: Pick<BackgroundMemoryReview, "enabled" | "setEnabled" | "everyNTurns" | "setEveryNTurns">;
  background?: BackgroundTaskService;
  /** Defaults behind Settings > Behavior, and what to do when it changes (GET and PUT /api/settings/behavior). */
  behavior?: { defaults: BehaviorDefaults; onChange?: (settings: BehaviorSettings) => void };
  /** Writes a new agent's name, avatar and instructions (POST /api/agents). */
  designer?: AgentDesigner;
  /** Profile docs and history search. */
  memory?: MemoryService;
  /** Knowledge: shared long-term pages. */
  knowledge?: KnowledgeService;
  /** Receives signed outside events (POST /api/events/:source); without it every source is unknown. */
  events?: EventReceiver;
  /** The event sources, for the read-only list on the Triggers page. */
  eventSources?: EventSources;
  /** Triggers and skills. */
  triggers?: { store: TriggerStore; scheduler: TriggerScheduler; catalog: ToolCatalog };
  skills?: SkillStore;
  plugins?: PluginService;
  /** Web Push notifications. */
  notifications?: NotificationService;
  /** MCP connectors. */
  mcp?: McpService;
  providers?: ProviderService;
  /** Always set the Secure flag on the cookie (otherwise: when the request is https). */
  cookieSecure?: boolean;
  /** The address people reach this server at (REI_PUBLIC_URL); the passkey relying party when set. */
  publicUrl?: string | undefined;
  androidPasskeyOrigins?: string[] | undefined;
  /** Test hook. */
  ssePingMs?: number;
  /** Check every contract route's answer against its schema (tests only). */
  checkContract?: boolean;
}

const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A model id the user chose: 1 to 100 characters, no spaces. */
function modelId(value: unknown): string {
  const model = typeof value === "string" ? value.trim() : "";
  if (model === "" || model.length > 100 || /\s/.test(model))
    throw badRequest("bad_request", "The model must be a model id of 1 to 100 characters, without spaces.");
  return model;
}

/** Context and output limits per model id, as a provider scan reports them or a save sends them back. */
function modelLimitsInput(value: unknown): Record<string, import("@rei/protocol").ModelLimits> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw badRequest("bad_request", "modelInfo must be an object keyed by model id.");
  const out: Record<string, import("@rei/protocol").ModelLimits> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 200) throw badRequest("bad_request", "modelInfo can list up to 200 models.");
  for (const [id, raw] of entries) {
    if (id.trim() === "" || id.length > 100 || !raw || typeof raw !== "object" || Array.isArray(raw))
      throw badRequest(
        "bad_request",
        "Each modelInfo entry must be an object keyed by a model id of up to 100 characters.",
      );
    const fields = raw as Record<string, unknown>;
    const limits: import("@rei/protocol").ModelLimits = {};
    for (const field of ["contextWindow", "maxTokens"] as const) {
      if (fields[field] === undefined) continue;
      if (!validLimit(fields[field]))
        throw badRequest("bad_request", `${field} for ${id} must be a whole number of tokens.`);
      limits[field] = fields[field];
    }
    if (Object.keys(limits).length > 0) out[id] = limits;
  }
  return out;
}

/** The Embeddings form, checked the same way by Test and Save. Anything the form got wrong is a 400. */
function embeddingSetupInput(
  input: import("@rei/protocol").SaveEmbeddingSetupSettings,
): import("@rei/protocol").SaveEmbeddingSetupSettings {
  if (input.provider !== "off") {
    try {
      if (input.profile || input.provider === "omlx")
        input.profile = validateProfile(input.profile) as NonNullable<typeof input.profile>;
      embeddingBase(input.baseUrl);
    } catch {
      throw badRequest("bad_request", "Enter a valid embedding URL and model settings.");
    }
    if (typeof input.apiModel !== "string" || !input.apiModel.trim())
      throw badRequest("bad_request", "Enter an embedding model ID.");
  }
  if (input.provider === "openai") {
    if (
      input.advanced &&
      (!Number.isInteger(input.advanced.contextTokens) ||
        input.advanced.contextTokens! < 1 ||
        typeof input.advanced.docTemplate !== "string" ||
        input.advanced.docTemplate.split("$" + "{t}").length !== 2 ||
        typeof input.advanced.queryTemplate !== "string" ||
        input.advanced.queryTemplate.split("$" + "{q}").length !== 2)
    )
      throw badRequest("bad_request", "Enter a positive token limit and keep one placeholder in each template.");
  }
  return input;
}

async function _jsonBody(c: Context): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw badRequest("bad_request", "The request body must be JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw badRequest("bad_request", "The request body must be a JSON object.");
  return value as Record<string, unknown>;
}

const _str = (value: unknown): string => (typeof value === "string" ? value : "");

export function createApp(deps: AppDeps): Hono {
  const { auth, store, adapter, log } = deps;
  // Connection names by id, so people see a provider by its name; a removed connection reads as "Removed provider".
  const providerNames = () => deps.modelCatalog?.providerNames() ?? {};
  const app = new Hono();

  const secureFor = (c: Context): boolean =>
    deps.cookieSecure === true ||
    new URL(c.req.url).protocol === "https:" ||
    c.req.header("x-forwarded-proto") === "https";
  const bearer = (c: Context): string | undefined => bearerToken(c.req.header("authorization"));
  const credential = (c: Context): string | undefined => bearer(c) ?? getCookie(c, SESSION_COOKIE);
  const issue = (c: Context, token: string): void => {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: COOKIE_MAX_AGE_S,
      secure: secureFor(c),
    });
  };

  // ---- every request: log ids only, never bodies ---------------------------------------------------------------------
  // Each request gets its own id for its log lines. An id a request arrives with is ignored, and ids never authorize.
  const requestIds = new WeakMap<Request, string>();
  // The client a request named in x-rei-client; unnamed requests are the web app at the oldest supported protocol.
  const clients = new WeakMap<Request, ClientId>();
  // The device a signed-in request came from.
  const devices = new WeakMap<Request, DeviceRecord>();
  const clientKind = (c: Context): ClientKind => clients.get(c.req.raw)?.kind ?? "web";
  const labelFor = (c: Context): string => deviceLabel(c.req.header("user-agent"), clientKind(c));
  /** The device of a signed-in request (every route behind the auth middleware has one). */
  const currentDevice = (c: Context): DeviceRecord => {
    const device = devices.get(c.req.raw);
    if (!device) throw unauthenticated();
    return device;
  };
  app.use("*", async (c, next) => {
    const started = deps.clock.now();
    const requestId = newId("req", started);
    requestIds.set(c.req.raw, requestId);
    await next();
    const path = new URL(c.req.url).pathname;
    if (path === "/api/health") return;
    const status = c.res.status;
    // Successes are routine; client errors are worth seeing by default; server errors are warnings (the error event
    // that caused one is logged where it was thrown).
    const level = status >= 500 ? "warn" : status >= 400 ? "info" : "debug";
    log[level]("http.request", {
      requestId,
      method: c.req.method,
      route: path.startsWith("/api") ? c.req.routePath : "static",
      status,
      durationMs: deps.clock.now() - started,
    });
  });

  // ---- /api: no caching, CSRF header on writes, cookie on everything except the open endpoints -----------------------
  const OPEN = new Set([
    "GET /api/auth/state",
    "GET /api/health",
    "POST /api/auth/login",
    "POST /api/auth/passkeys/login/options",
    "POST /api/auth/passkeys/login",
    "POST /api/auth/setup",
    "GET /api/mcp/oauth/callback",
  ]);
  // An outside event is signed, not signed in: no device credential and no CSRF header (it has no cookie). Everything else
  // about it is checked by the route, in a fixed order (events/receive.ts).
  const isEvent = (c: Context): boolean =>
    c.req.method === "POST" && /^\/api\/events\/[^/]+\/?$/.test(new URL(c.req.url).pathname);
  app.use("/api/*", async (c, next) => {
    c.header("cache-control", "no-store");
    for (const [name, value] of Object.entries(securityHeaders(API_CSP))) c.header(name, value);
    const client = parseClientId(c.req.header(CLIENT_HEADER) ?? c.req.query(CLIENT_QUERY));
    if (client) clients.set(c.req.raw, client);
    if (client && client.protocol < MIN_CLIENT_PROTOCOL && new URL(c.req.url).pathname !== healthRoute.path) {
      throw new HttpError(
        426,
        "client_outdated",
        `This app speaks protocol ${client.protocol}; the server needs ${MIN_CLIENT_PROTOCOL} or newer. Update the app.`,
      );
    }
    // Another site's page cannot send a custom header without a preflight this server never answers. So a bearer
    // credential, or a native app naming itself in the client header (its sign-in has no credential yet), proves the
    // request is not cross-site, and only the web app's cookie requests need the CSRF header.
    const nativeHeader = NATIVE_CLIENT_KINDS.includes(parseClientId(c.req.header(CLIENT_HEADER))?.kind ?? "web");
    if (isEvent(c)) return next();
    if (MUTATING.has(c.req.method) && bearer(c) === undefined && !nativeHeader && c.req.header(CSRF_HEADER) !== "1") {
      throw new HttpError(403, "csrf", `Missing ${CSRF_HEADER} header.`);
    }
    if (!OPEN.has(`${c.req.method} ${new URL(c.req.url).pathname.replace(/\/+$/, "")}`)) {
      const device = await auth.device(credential(c), labelFor(c));
      if (!device) throw unauthenticated();
      devices.set(c.req.raw, device);
    }
    await next();
  });

  const contract = { checkResponses: deps.checkContract === true };
  libraryRoutes(app, deps, contract);
  knowledgeRoutes(app, deps, contract);
  if (deps.plugins) pluginRoutes(app, deps.plugins, contract);

  /** A path parameter of the matched route (always present for a route that declares it). */
  const param = (c: Context, name: string): string => c.req.param(name) ?? "";
  mountRoute(app, healthRoute, contract, () => ({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    minClientProtocol: MIN_CLIENT_PROTOCOL,
  }));

  // ---- auth and devices (ADR 0011) ----------------------------------------------------------------------------------
  mountRoute(app, authStateRoute, contract, async (c) => {
    const device = await auth.device(credential(c));
    return {
      setupRequired: !auth.hasAccount(),
      signedIn: device !== undefined,
      totpEnabled: auth.totpEnabled(),
      passkeys: auth.hasPasskeys() && (clientKind(c) !== "android" || Boolean(androidRelyingParty)),
      ...(device ? { deviceId: device.id } : {}),
    };
  });
  /** A browser keeps its credential in the cookie; a native client gets it in the answer, once. */
  const signedIn = (c: Context, result: SignedIn): SignedInResponse => {
    if (NATIVE_CLIENT_KINDS.includes(clientKind(c)))
      return { ok: true, deviceId: result.deviceId, token: result.token };
    issue(c, result.token);
    return { ok: true, deviceId: result.deviceId };
  };
  const newDevice = (c: Context, label: string | undefined) => ({ kind: clientKind(c), label: label ?? labelFor(c) });
  mountRoute(app, setupRoute, contract, async (c, { body }) =>
    signedIn(c, await auth.setupStart(body.setupCode, body.password, newDevice(c, body.deviceLabel))),
  );
  mountRoute(app, totpStartRoute, contract, async (_c, { body }) => auth.startTotp(body.password));
  mountRoute(app, totpConfirmRoute, contract, async (_c, { body }) => {
    await auth.confirmTotp(body.password, body.totpCode);
    return { ok: true };
  });
  mountRoute(app, totpDisableRoute, contract, async (_c, { body }) => {
    await auth.disableTotp(body.password, body.totpCode);
    return { ok: true };
  });
  mountRoute(app, loginRoute, contract, async (c, { body }) =>
    signedIn(c, await auth.login(body.password, body.totpCode ?? "", newDevice(c, body.deviceLabel))),
  );
  /**
   * Where the browser is, for WebAuthn: the configured public URL, else the host the request came to. The origin the
   * browser signed must be this host (any port, so the Vite dev proxy works) or the check fails.
   */
  const configured = deps.publicUrl ? new URL(deps.publicUrl) : undefined;
  const androidRelyingParty: RelyingParty | undefined =
    configured?.protocol === "https:" && deps.androidPasskeyOrigins?.length
      ? { id: configured.hostname, origin: deps.androidPasskeyOrigins }
      : undefined;
  const relyingParty = (c: Context): RelyingParty => {
    if (clientKind(c) === "android") {
      if (!androidRelyingParty)
        throw new HttpError(403, "android_passkeys_disabled", "This Rei server has not enabled Android passkeys.");
      return androidRelyingParty;
    }
    const host =
      configured?.hostname ??
      new URL(c.req.header("x-forwarded-host") ? `http://${c.req.header("x-forwarded-host")}` : c.req.url).hostname;
    const id = host.replace(/^\[|\]$/g, "");
    if (configured) return { id, origin: configured.origin };
    const origin = c.req.header("origin") ?? "";
    let originHost = "";
    try {
      originHost = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    } catch {}
    // An Origin that is not this host never matches; the library then fails the sign-in.
    return { id, origin: originHost === id ? origin : `${secureFor(c) ? "https" : "http"}://${id}` };
  };
  mountRoute(app, passkeyLoginOptionsRoute, contract, async (c) => auth.passkeyLoginOptions(relyingParty(c)));
  mountRoute(app, passkeyLoginRoute, contract, async (c, { body }) =>
    signedIn(
      c,
      await auth.passkeyLogin(relyingParty(c), body.challengeId, body.response, newDevice(c, body.deviceLabel)),
    ),
  );
  mountRoute(app, passkeyRegisterOptionsRoute, contract, async (c, { body }) =>
    auth.passkeyRegisterOptions(body.password, relyingParty(c)),
  );
  mountRoute(app, passkeyRegisterRoute, contract, async (c, { body }) =>
    auth.passkeyRegister(relyingParty(c), body.challengeId, body.response, body.label ?? ""),
  );
  mountRoute(app, listPasskeysRoute, contract, () => ({ passkeys: auth.passkeys() }));
  mountRoute(app, renamePasskeyRoute, contract, (c, { body }) => auth.renamePasskey(param(c, "id"), body.label));
  mountRoute(app, removePasskeyRoute, contract, (c) => {
    auth.removePasskey(param(c, "id"));
    return { ok: true };
  });
  mountRoute(app, logoutRoute, contract, async (c) => {
    const device = currentDevice(c);
    await auth.logout(credential(c));
    deps.notifications?.removeDevice(device.id);
    if (bearer(c) === undefined) deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureFor(c) });
    return { ok: true };
  });

  const deviceView = (c: Context, device: DeviceRecord): Device => ({
    id: device.id,
    label: device.label,
    kind: device.kind,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    current: device.id === currentDevice(c).id,
    active: deps.notifications?.active(device.id) ?? false,
    channels: deps.notifications?.channels(device.id) ?? [],
  });
  mountRoute(app, listDevicesRoute, contract, (c) => ({ devices: auth.devices().map((d) => deviceView(c, d)) }));
  mountRoute(app, renameDeviceRoute, contract, (c, { body }) =>
    deviceView(c, auth.renameDevice(param(c, "id") ?? "", body.label)),
  );
  mountRoute(app, revokeDeviceRoute, contract, (c) => {
    const id = param(c, "id") ?? "";
    auth.revokeDevice(id);
    deps.notifications?.removeDevice(id);
    if (id === currentDevice(c).id && bearer(c) === undefined)
      deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureFor(c) });
    return { ok: true };
  });

  // ---- agents and sessions -------------------------------------------------------------------------------------------
  mountRoute(app, usageRoute, contract, (c, { query }) => {
    if (c.req.query("period") === "" || (c.req.queries("period")?.length ?? 0) > 1)
      throw badRequest("bad_request", "Only one period is supported.");
    return readUsage(store.db, query.period, deps.clock.now(), providerNames(), { from: query.from, to: query.to });
  });

  mountRoute(app, listAgentsRoute, contract, () => ({
    agents: store.listAgents(),
    defaultAgentId: store.defaultAgentId() ?? "",
    companion: store.companion(),
  }));
  mountRoute(app, glanceRoute, contract, async (c) => {
    const body = glance(store, deps.notifications?.previewShown() ?? true);
    const etag = await etagOf(body);
    c.header("ETag", etag);
    c.header("Cache-Control", "private, no-cache");
    if (matchesEtag(c.req.header("if-none-match"), etag)) return c.body(null, 304);
    return body;
  });
  mountRoute(app, readMarkerRoute, contract, (c, { body }) => store.markRead(param(c, "id"), body));
  mountRoute(app, updateCompanionRoute, contract, (_c, { body }) => ({
    companion: store.setCompanionAgent(body.agentId),
  }));
  mountRoute(app, listSessionsRoute, contract, (_c, { query }) =>
    query.paged === "1"
      ? store.sessionPage(query.agent, query.before, 30, { triggers: query.triggers === "1" })
      : { sessions: store.listSessions() },
  );
  mountRoute(app, createSessionRoute, contract, (_c, { body }) => {
    const target = body.agentId ?? store.defaultAgentId();
    if (!target || !store.getAgent(target)) throw badRequest("unknown_agent", "That agent does not exist.");
    return { session: adapter.createSession(target) };
  });
  mountRoute(app, createAgentRoute, contract, async (_c, { body }) => {
    if (!deps.designer) throw notFound("Creating agents is not available.");
    const description = body.description.trim();
    if (description === "" || description.length > AGENT_DESCRIPTION_MAX_CHARS)
      throw badRequest("bad_request", `The description must be 1 to ${AGENT_DESCRIPTION_MAX_CHARS} characters.`);
    return adapter.createAgent(await deps.designer.design(description));
  });
  mountRoute(app, deleteAgentRoute, contract, async (c) => {
    await adapter.deleteAgent(param(c, "id"));
    return { ok: true as const };
  });
  mountRoute(app, updateAgentRoute, contract, (c, { body: b }) => {
    const id = param(c, "id");
    if (!store.getAgent(id)) throw notFound("That agent does not exist.");
    // Everything is checked before anything is changed.
    let avatar: string | undefined;
    if (b.avatar !== undefined) {
      const normalised = normalizeAvatar(b.avatar);
      if (normalised === null)
        throw badRequest(
          "bad_avatar",
          "The avatar must be a built-in bot (bot:<id>), a small png, jpeg or webp picture, or an emoji of at most 8 characters.",
        );
      avatar = normalised;
    }
    const settings: AgentSettingsPatch = {};
    if (b.name !== undefined) {
      const name = b.name.trim();
      if (name === "" || name.length > 40) throw badRequest("bad_request", "The name must be 1 to 40 characters.");
      settings.name = name;
    }
    if (b.model !== undefined) {
      // null goes back to the default model; anything else is a model id the gateway is asked for by name.
      if (b.model !== null) {
        settings.model = modelId(b.model);
      } else settings.model = null;
    }
    if (b.thinkingLevel !== undefined) settings.thinkingLevel = b.thinkingLevel;
    if (b.networkMode !== undefined) settings.networkMode = b.networkMode;
    if (b.allowedConnectorIds !== undefined) {
      if (b.allowedConnectorIds?.some((id) => !id.trim()))
        throw badRequest("bad_request", "Connectors must be null or a list of connector IDs.");
      settings.allowedConnectorIds = b.allowedConnectorIds === null ? null : [...new Set(b.allowedConnectorIds)];
    }
    if (b.instructions !== undefined) {
      if (b.instructions.length > INSTRUCTIONS_MAX)
        throw badRequest("bad_request", `Instructions must be text of at most ${INSTRUCTIONS_MAX} characters.`);
      settings.instructions = b.instructions.trim();
    }
    if (b.defaultProfile !== undefined) settings.defaultProfile = b.defaultProfile;
    if (avatar !== undefined) {
      store.setAgentAvatar(id, avatar);
      log.info("agent.avatar_changed", { agentId: id });
    }
    if (Object.keys(settings).length > 0) {
      store.updateAgentSettings(id, settings);
      log.info("agent.settings_changed", { agentId: id, fields: Object.keys(settings).join(",") });
    }
    return { agent: store.getAgent(id)! };
  });
  mountRoute(app, titleSettingsRoute, contract, async () => {
    if (!deps.titles) throw notFound("Chat titles are not available.");
    return deps.titles.settings();
  });
  mountRoute(app, updateTitleSettingsRoute, contract, async (_c, { body: b }) => {
    if (!deps.titles) throw notFound("Chat titles are not available.");
    const patch: { enabled?: boolean; model?: string | null } = {};
    if (b.enabled !== undefined) patch.enabled = b.enabled;
    if (b.model !== undefined) patch.model = b.model === null ? null : modelId(b.model);
    const body = await deps.titles.update(patch);
    log.info("titles.settings_changed", { fields: Object.keys(patch).join(",") });
    return body;
  });
  mountRoute(app, firstTimeSetupRoute, contract, () => ({ dismissed: store.firstTimeSetupDismissed() }));
  mountRoute(app, updateFirstTimeSetupRoute, contract, (_c, { body }) => {
    store.setFirstTimeSetupDismissed(body.dismissed);
    return { dismissed: store.firstTimeSetupDismissed() };
  });
  mountRoute(app, memoryExtractionRoute, contract, () => {
    if (!deps.memoryExtraction) throw notFound("Memory extraction is not available.");
    return { enabled: deps.memoryExtraction.enabled(), everyNTurns: deps.memoryExtraction.everyNTurns() };
  });
  mountRoute(app, updateMemoryExtractionRoute, contract, (_c, { body }) => {
    if (!deps.memoryExtraction) throw notFound("Memory extraction is not available.");
    if (body.everyNTurns !== undefined) deps.memoryExtraction.setEveryNTurns(body.everyNTurns);
    if (body.enabled !== undefined) deps.memoryExtraction.setEnabled(body.enabled);
    log.info("memory.extraction_settings_changed", { enabled: body.enabled });
    return { enabled: deps.memoryExtraction.enabled(), everyNTurns: deps.memoryExtraction.everyNTurns() };
  });
  mountRoute(app, backgroundListRoute, contract, (_c, { query }) => {
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 30) || 30));
    const before = Number(query.before ?? Number.MAX_SAFE_INTEGER);
    const rows = store.db.all<BackgroundJob & { position: number }>(
      "SELECT j.*,j.rowid AS position FROM background_jobs j WHERE j.rowid<? AND (? IS NULL OR kind=?) AND (? IS NULL OR status=?) AND (? IS NULL OR session_id=?) ORDER BY j.rowid DESC LIMIT ?",
      before,
      query.kind ?? null,
      query.kind ?? null,
      query.status ?? null,
      query.status ?? null,
      query.sessionId ?? null,
      query.sessionId ?? null,
      Math.floor(limit),
    );
    return {
      jobs: rows.map(({ position: _position, ...job }) => {
        const last = store.db.get<{ provider: string | null; model: string | null; usage: string | null }>(
          "SELECT provider,model,usage FROM background_attempts WHERE job_id=? ORDER BY attempt DESC LIMIT 1",
          job.id,
        );
        const count = store.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM memory_review_sources WHERE job_id=?",
          job.id,
        )!.n;
        return {
          ...job,
          summary: {
            sessionTitle: job.session_id ? (store.getSessionRow(job.session_id)?.title ?? null) : null,
            agentName: store.getAgent(job.agent_id)?.name ?? null,
            provider: last?.provider ?? null,
            model: last?.model ?? null,
            eligibleTurns: count,
            usage: last?.usage ?? null,
            durationMs: job.finished_at === null ? null : Math.max(0, job.finished_at - job.created_at),
          },
        };
      }),
      next: rows.length === limit ? String(rows.at(-1)!.position) : null,
    };
  });
  mountRoute(app, backgroundDetailRoute, contract, (c) => {
    const id = c.req.param("id")!;
    const job = store.db.get<BackgroundJob>("SELECT * FROM background_jobs WHERE id=?", id);
    if (!job) throw notFound("That background task does not exist.");
    const result = job.result ? (JSON.parse(job.result) as { changeIds?: string[] }) : {};
    const changes = job.session_id
      ? (result.changeIds ?? []).flatMap((id) => {
          const change = deps.memory?.lines.change(id);
          return change ? [change] : [];
        })
      : [];
    const attempts = store.db.all<{
      job_id: string;
      attempt: number;
      started_at: number;
      finished_at: number | null;
      provider: string | null;
      model: string | null;
      usage: string | null;
      outcome: string | null;
    }>("SELECT * FROM background_attempts WHERE job_id=? ORDER BY attempt", id);
    const sources = store.db.all<{ messageId: string; runId: string; entryId: string }>(
      "SELECT message_id AS messageId,run_id AS runId,entry_id AS entryId FROM memory_review_sources WHERE job_id=? ORDER BY seq",
      id,
    );
    return { job, attempts, changes, sources };
  });
  mountRoute(app, backgroundRetryRoute, contract, (c) => ({
    retried: deps.background?.retry(c.req.param("id")!) ?? false,
  }));
  mountRoute(app, behaviorSettingsRoute, contract, () => {
    if (!deps.behavior) throw notFound("Behavior settings are not available.");
    return behaviorResponse(store, deps.behavior.defaults);
  });
  mountRoute(app, updateBehaviorSettingsRoute, contract, (_c, { body: b }) => {
    if (!deps.behavior) throw notFound("Behavior settings are not available.");
    let body: BehaviorSettingsResponse;
    try {
      body = updateBehavior(store, deps.behavior.defaults, b);
    } catch (e) {
      throw badRequest("bad_request", e instanceof Error ? e.message : "Check the behavior settings.");
    }
    deps.behavior.onChange?.(body.settings);
    log.info("behavior.settings_changed", {});
    return body;
  });
  mountRoute(app, agentInstructionsRoute, contract, (c) => {
    const id = param(c, "id");
    const row = store.getAgentRow(id);
    if (!row) throw notFound("That agent does not exist.");
    return { instructions: row.instructions, maxLength: INSTRUCTIONS_MAX, history: store.instructionHistory(id) };
  });
  mountRoute(app, contextSettingsRoute, contract, () => readContextSettings(store));
  mountRoute(app, updateContextSettingsRoute, contract, (_c, { body: b }) => {
    let body: ContextSettings;
    try {
      body = updateContextSettings(store, b);
    } catch (e) {
      throw badRequest("bad_request", e instanceof Error ? e.message : "Check the context settings.");
    }
    log.info("context.settings_changed", { fields: Object.keys(b).join(",") });
    return body;
  });
  mountRoute(app, timeZoneRoute, contract, () => ({ timeZone: savedTimeZone(store) }));
  mountRoute(app, updateTimeZoneRoute, contract, (_c, { body }) => {
    const timeZone = knownTimeZone(body.timeZone);
    if (!timeZone) throw badRequest("bad_request", "timeZone must be an IANA time zone, such as Asia/Macau.");
    saveTimeZone(store, timeZone);
    log.info("settings.time_zone_changed", {});
    return { timeZone };
  });
  const sandboxNetwork = (): SandboxNetworkSettings => ({
    whitelist: store.sandboxWhitelist(),
    defaults: [...DEFAULT_SANDBOX_WHITELIST],
  });
  mountRoute(app, sandboxNetworkRoute, contract, sandboxNetwork);
  mountRoute(app, updateSandboxNetworkRoute, contract, (_c, { body }) => {
    const reset = "reset" in body;
    if (reset) {
      store.setSandboxWhitelist(null);
    } else {
      const entries = normalizeWhitelist(body.whitelist);
      if (entries === null)
        throw badRequest(
          "bad_request",
          "The whitelist must be a list of host names, wildcards (*.example.com), IP addresses or networks (at most 200).",
        );
      store.setSandboxWhitelist(entries);
    }
    log.info("settings.sandbox_network_changed", { entries: store.sandboxWhitelist().length, reset });
    return sandboxNetwork();
  });
  mountRoute(app, modelsRoute, contract, async () =>
    deps.modelCatalog ? deps.modelCatalog.list() : { default: "", models: [] },
  );
  mountRoute(app, modelSettingsRoute, contract, async () => {
    if (!deps.modelCatalog) throw notFound("Model settings are not available.");
    return deps.modelCatalog.settings();
  });
  mountRoute(app, updateModelSettingsRoute, contract, async (_c, { body: b }) => {
    if (!deps.modelCatalog) throw notFound("Model settings are not available.");
    const patch: UpdateModelSettingsRequest = {};
    for (const tier of ["fast", "standard"] as const) {
      const item = b[tier];
      if (item === undefined) continue;
      patch[tier] = { ...item, ...(item.model !== undefined ? { model: modelId(item.model) } : {}) };
    }
    if (b.capabilities !== undefined) {
      const entries = Object.entries(b.capabilities);
      if (entries.length > 500) throw badRequest("bad_request", "capabilities can list up to 500 models.");
      if (entries.some(([id]) => id.trim() === "" || id.length > 200))
        throw badRequest("bad_request", "Each capability must be an object keyed by a model id.");
      patch.capabilities = b.capabilities;
    }
    const body = await deps.modelCatalog.update(patch);
    log.info("models.settings_changed", { fields: Object.keys(b).join(",") });
    return body;
  });
  const providers = (what = "Provider settings"): NonNullable<AppDeps["providers"]> => {
    if (!deps.providers) throw new HttpError(503, "gateway_unavailable", `${what} need the gateway.`);
    return deps.providers;
  };
  mountRoute(app, providersRoute, contract, async () => (await deps.providers?.list()) ?? { connections: [] });
  mountRoute(app, searchStatusRoute, contract, async () => (await deps.providers?.searchStatus()) ?? { providers: [] });
  mountRoute(app, searchSettingsRoute, contract, () => providers("Search settings").searchSettings());
  mountRoute(app, saveSearchSettingsRoute, contract, (_c, { body }) =>
    providers("Search settings").saveSearchSettings(body),
  );
  mountRoute(app, scanProviderModelsRoute, contract, (_c, { body }) => providers().scanModels(body));
  // Re-reads one custom endpoint's limits and saves them with its models unchanged; the user's own overrides are not touched.
  mountRoute(app, scanProviderLimitsRoute, contract, async (c) => {
    if (!deps.providers) throw new HttpError(503, "gateway_unavailable", "Provider settings need the gateway.");
    const id = param(c, "id");
    const connection = (await deps.providers.list()).connections.find((row) => row.id === id);
    if (connection?.kind !== "openai-compatible" || !connection.baseUrl)
      throw badRequest("bad_request", "Only a custom endpoint reports model limits.");
    const scanned = await deps.providers.scanModels({ id, baseUrl: connection.baseUrl });
    const saved = await deps.providers.save({
      id,
      name: connection.name,
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      ...(connection.api ? { api: connection.api } : {}),
      models: connection.models,
      modelInfo: scanned.modelInfo ?? {},
    });
    log.info("providers.limits_scanned", { id, reported: Object.keys(scanned.modelInfo ?? {}).length });
    return saved;
  });
  mountRoute(app, saveProviderRoute, contract, (_c, { body }) =>
    providers().save({
      ...body,
      ...(body.modelInfo !== undefined ? { modelInfo: modelLimitsInput(body.modelInfo) } : {}),
    }),
  );
  mountRoute(app, removeProviderRoute, contract, async (c) => {
    await providers().remove(param(c, "id"));
    return undefined;
  });
  mountRoute(app, openAiOAuthStartRoute, contract, () => providers().startOpenAiOAuth());
  mountRoute(app, openAiOAuthStatusRoute, contract, () => providers().openAiOAuthStatus());
  mountRoute(app, openAiOAuthCallbackRoute, contract, async (_c, { body }) => {
    await providers().submitOpenAiOAuthCallback(body.url);
    return { ok: true as const };
  });
  mountRoute(app, openAiOAuthCancelRoute, contract, async () => {
    await deps.providers?.cancelOpenAiOAuth();
    return undefined;
  });
  mountRoute(app, codexImagesStatusRoute, contract, async () =>
    deps.providers ? deps.providers.codexImagesStatus() : { enabled: false, signedIn: false, pending: false },
  );
  mountRoute(app, codexImagesSignInRoute, contract, () => providers("Codex Images").startCodexImagesSignIn());
  mountRoute(app, codexImagesCancelRoute, contract, async () => {
    await deps.providers?.cancelCodexImagesSignIn();
    return undefined;
  });
  mountRoute(app, codexImagesSignOutRoute, contract, async () => {
    await providers("Codex Images").signOutCodexImages();
    return undefined;
  });
  mountRoute(app, editLogRoute, contract, (_c, { query }) => ({ entries: store.editLog(query.limit ?? 50) }));
  mountRoute(app, sessionContextRoute, contract, async (c) => {
    const id = param(c, "id");
    if (!store.getSession(id)) throw notFound("That session does not exist.");
    type ContextStep = {
      payload_blob: string | null;
      loaded_tools: string | null;
      provider: string;
      model: string;
      status: string;
      context_window: number | null;
      context_input: number | null;
      context_cached: number | null;
      context_output: number | null;
      started_at: number;
    };
    const contextSteps = `SELECT payload_blob, loaded_tools, provider, model, status, context_window, context_input,
      context_cached, context_output, started_at FROM steps
      WHERE session_id = ? AND type = 'llm.call' AND usage_purpose IN ('chat', 'agent_task') AND status <> 'running'`;
    const latest = store.db.get<ContextStep>(`${contextSteps} ORDER BY started_at DESC, id DESC LIMIT 1`, id);
    const row =
      latest?.status === "aborted" &&
      latest.context_input === null &&
      latest.context_cached === null &&
      latest.context_output === null
        ? (store.db.get<ContextStep>(
            `${contextSteps} AND provider = ? AND model = ? AND context_window IS ?
             AND context_input IS NOT NULL AND context_output IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1`,
            id,
            latest.provider,
            latest.model,
            latest.context_window,
          ) ?? latest)
        : latest;
    let breakdown: ContextBreakdown | null = null;
    if (row?.payload_blob) breakdown = await readContextBreakdown(deps.traceBlobs, row.payload_blob, loadedNames(row));
    const body: ContextUsageResponse = {
      model: row?.model ?? null,
      maxTokens: row?.context_window ?? null,
      inputTokens: row?.context_input ?? null,
      cachedTokens: row?.context_cached ?? null,
      outputTokens: row?.context_output ?? null,
      updatedAt: row?.started_at ?? null,
      breakdown,
    };
    if (!store.getSession(id)) throw notFound("That session does not exist.");
    return body;
  });
  mountRoute(app, sessionSummaryRoute, contract, (c) => {
    const session = store.getSession(param(c, "id"));
    if (!session) throw notFound("That session does not exist.");
    return { session };
  });
  mountRoute(app, relatedSessionsRoute, contract, (c) => ({ sessions: store.relatedSessions(param(c, "id")) }));
  mountRoute(app, getSessionRoute, contract, async (c) => {
    const id = param(c, "id");
    const session = store.getSession(id);
    if (!session) throw notFound("That session does not exist.");
    const view = await adapter.views.view(id);
    return {
      session: await adapter.views.withForkSource(store.getSession(id) ?? session),
      messages: view.items,
      runs: view.runs,
      before: view.before,
      live: view.live,
    };
  });
  mountRoute(app, transcriptRoute, contract, async (c, { query }) => {
    const id = param(c, "id");
    if (!store.getSession(id)) throw notFound("That session does not exist.");
    const view = await adapter.views.view(id, {
      before: query.before,
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    return { items: view.items, before: view.before };
  });
  mountRoute(app, continueRoute, contract, async (c) => {
    const id = param(c, "id");
    if (!store.getSession(id)) throw notFound("That session does not exist.");
    return adapter.continueRun(id);
  });
  mountRoute(app, uploadAttachmentRoute, contract, async (c) => {
    if (!deps.attachments) throw new HttpError(503, "unavailable", "Uploads are unavailable.");
    const id = param(c, "id");
    if (!store.getSessionRow(id)) throw notFound("That session does not exist.");
    const attachments = deps.attachments;
    return { attachment: await withUpload(c, (file) => attachments.upload(id, file)) };
  });
  // Importing past conversations (docs/importing.md): a file of a chat about to be imported belongs to no chat yet.
  mountRoute(app, importFileRoute, contract, async (c) => {
    if (!deps.attachments) throw new HttpError(503, "unavailable", "Uploads are unavailable.");
    const attachments = deps.attachments;
    return {
      attachment: await withUpload(c, (file) => attachments.upload("", file, undefined, "You", undefined, false)),
    };
  });
  mountRoute(app, importLookupRoute, contract, (_c, { body }) => adapter.imports.lookup(body.source, body.sourceIds));
  mountRoute(app, importSessionRoute, contract, (_c, { body }) =>
    adapter.imports.importSession(body.agentId, body.transcript),
  );
  mountRoute(app, getAttachmentRoute, contract, async (c, { query }) => {
    const row = deps.attachments?.accessible(param(c, "attachmentId"), param(c, "id"));
    if (!row || !deps.attachments) throw notFound("That attachment is unavailable.");
    const preview =
      query.preview === "1" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(row.media_type);
    c.header("content-type", preview ? row.media_type : "application/octet-stream");
    c.header(
      "content-disposition",
      `${preview ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, (x) => `%${x.charCodeAt(0).toString(16)}`)}`,
    );
    c.header("content-security-policy", "default-src 'none'; sandbox");
    const { size, body } = await deps.attachments.open(row);
    c.header("content-length", String(size));
    return c.body(body);
  });

  mountRoute(app, previewAttachmentRoute, contract, async (c) => {
    const sessionId = param(c, "id");
    const row = deps.attachments?.accessible(param(c, "attachmentId"), sessionId);
    if (!row || !deps.attachments) throw notFound("That attachment is unavailable.");
    const format = filePreview({ name: row.name, mediaType: row.media_type });
    if (format.kind !== "office")
      throw new HttpError(415, "preview_unsupported", "This file does not need Office conversion.");
    const bytes = await deps.attachments.previewOffice(row, sessionId);
    // Recheck after conversion: the chat may have been deleted while the sandbox worked.
    if (!deps.attachments.accessible(row.id, sessionId)) throw notFound("That attachment is unavailable.");
    c.header("cache-control", "no-store");
    c.header("content-type", "application/pdf");
    c.header("content-disposition", "inline; filename=preview.pdf");
    c.header("content-security-policy", "default-src 'none'; sandbox");
    return c.body(bytes);
  });

  mountRoute(app, sendMessageRoute, contract, async (c, { body: b }) => {
    const id = param(c, "id");
    const requestId = b.requestId;
    // The shape is checked at once; whether each skill is available now is checked at admission, after a retry of an
    // accepted request has been answered.
    const selectedSkills = adapter.skillPreparer?.parse(b.selectedSkills) ?? [];
    if (b.selectedSkills !== undefined && !adapter.skillPreparer)
      throw new HttpError(503, "unavailable", "Skills are unavailable.");
    // An accepted retry remains idempotent even when its referenced chat/connector has since disappeared.
    if (!store.getSessionRow(id)) throw notFound("That session does not exist.");
    const existing = await adapter.commands.knownRequest(id, requestId);
    if (existing) return { messageId: `u:${existing}`, runId: existing };
    if (!deps.attachments && (b.files !== undefined || b.mentions !== undefined))
      throw new HttpError(503, "unavailable", "Message context is unavailable.");
    let selected = deps.attachments?.validate(id, b.text, b.mentions) ?? {};
    if (selected.mentions?.some((m) => m.kind === "connector")) {
      const connectors = await mcp().list();
      // A connector that is not ready, or that this agent can't use, is still accepted: the model gets one line
      // saying so (issue 06). Only a connector that does not exist is refused.
      for (const mention of selected.mentions)
        if (mention.kind === "connector" && !connectors.some((x) => x.id === mention.id))
          throw badRequest("bad_mention", "The mentioned connector no longer exists. Remove it from the message.");
    }
    // Connector lookup yields to other work, including attachment expiry and chat deletion.
    const accepted = await adapter.commands.knownRequest(id, requestId);
    if (accepted) return { messageId: `u:${accepted}`, runId: accepted };
    selected = deps.attachments?.validate(id, b.text, b.mentions) ?? {};
    if (b.files !== undefined) {
      const files = deps.attachments?.library?.select(id, b.files);
      if (!files) throw new HttpError(503, "unavailable", "The file library is unavailable.");
      const all = [...(selected.attachments ?? []), ...files];
      if (
        all.length > 10 ||
        new Set(all.map((f) => f.id)).size !== all.length ||
        all.reduce((n, f) => n + f.size, 0) > MESSAGE_MAX_ATTACHMENT_BYTES
      )
        throw badRequest("bad_request", "Choose at most 10 distinct files totaling at most 2 GiB.");
      selected = { ...selected, attachments: all };
    }
    const result = await adapter.send({
      sessionId: id,
      requestId,
      text: b.text,
      ...selected,
      ...(selectedSkills.length ? { selectedSkills } : {}),
      ...(b.whenBusy ? { whenBusy: b.whenBusy } : {}),
    });
    return { messageId: result.messageId, runId: result.runId };
  });
  // The skills the composer's `/` list offers: what this session's agent can use now (not the global list).
  mountRoute(app, sessionSkillsRoute, contract, (c) => {
    const row = store.getSessionRow(param(c, "id"));
    if (!row) throw notFound("That session does not exist.");
    if (!adapter.skillPreparer) throw new HttpError(404, "not_found", "Skills are not available.");
    return { skills: adapter.skillPreparer.options(row.agent_id) };
  });
  // Manual compaction (`/compact`): not a message, not a run. Answers with the request's status.
  mountRoute(app, compactRoute, contract, (c, { body: b }) => {
    const id = param(c, "id");
    if (!store.getSessionRow(id)) throw notFound("That session does not exist.");
    return adapter.compactions.request(id, b.requestId, b.instructions);
  });
  mountRoute(app, compactStatusRoute, contract, (c) => {
    if (!store.getSessionRow(param(c, "id"))) throw notFound("That session does not exist.");
    return adapter.compactions.status(param(c, "id"), param(c, "requestId"));
  });
  mountRoute(app, cancelRoute, contract, async (c) => {
    const id = param(c, "id");
    if (!store.getSession(id)) throw notFound("That session does not exist.");
    return adapter.cancel(id);
  });

  mountRoute(app, forkRoute, contract, async (c, { body: b }) => {
    const id = param(c, "id");
    return { session: await adapter.forkSession(id, b.messageId) };
  });
  mountRoute(app, editMessageRoute, contract, async (c, { body: b }) => {
    if (b.messageId === "") throw badRequest("bad_request", "messageId is required.");
    let mentions: MessageMention[] | undefined;
    if (b.mentions !== undefined) {
      const original = await adapter.views.findItem(param(c, "id"), b.messageId);
      if (!original) throw notFound("That message does not exist.");
      mentions = deps.attachments?.validate(param(c, "id"), b.text, b.mentions).mentions ?? [];
      if (mentions.some((m) => !original.mentions?.some((old) => old.kind === m.kind && old.id === m.id)))
        throw badRequest("bad_mention", "Editing can only retain existing mentions.");
    }
    let skills: SelectedSkill[] | undefined;
    if (b.selectedSkills !== undefined) {
      skills = adapter.skillPreparer?.parse(b.selectedSkills) ?? [];
      // Before the fork: a skill that is gone must not leave an empty chat behind.
      await adapter.checkSkills(param(c, "id"), skills);
    } else {
      const original = await adapter.views.findItem(param(c, "id"), b.messageId);
      const kept = original?.selectedSkills?.map(({ id, version }) => ({ id, version })) ?? [];
      await adapter.checkSkills(param(c, "id"), kept);
    }
    return adapter.editMessage(param(c, "id"), b.messageId, b.text, mentions, skills);
  });
  mountRoute(app, switchVersionRoute, contract, async (c, { body }) => {
    await adapter.switchVersion(param(c, "id"), body);
    return { ok: true as const };
  });
  mountRoute(app, surfaceActionRoute, contract, (c, { body }) =>
    adapter.surfaceAction(param(c, "id"), param(c, "surfaceId"), body),
  );
  mountRoute(app, surfaceDetailRoute, contract, (c) =>
    adapter.views.surfaceDetail(param(c, "id"), param(c, "surfaceId")),
  );

  // ---- Full mode: the trace of a chat, a step in full, and what a fork would leave behind ------------------------
  mountRoute(app, sessionTraceRoute, contract, async (c, { query }) => {
    // The runs come from the session's open tree.
    if (store.getSessionRow(param(c, "id"))) await adapter.views.ensureOpen(param(c, "id"));
    return sessionTrace(store, param(c, "id"), query.before, providerNames());
  });
  mountRoute(app, forkPreviewRoute, contract, async (c, { query: { messageId } }) => {
    const cut = await adapter.forkCut(param(c, "id"), messageId);
    return forkPreview(store, param(c, "id"), cut, providerNames());
  });
  mountRoute(app, stepRoute, contract, (c) => stepDetail(store, deps.traceBlobs, param(c, "id"), providerNames()));
  mountRoute(app, stepWebDocumentRoute, contract, (c) => stepWebDocument(store, param(c, "id")));
  mountRoute(app, stepImageRoute, contract, async (c) => {
    const index = Number(param(c, "index"));
    if (!Number.isInteger(index) || index < 0) throw notFound("That picture does not exist.");
    const image = await stepImage(store, deps.traceBlobs, param(c, "id"), index);
    return new Response(image.bytes, {
      status: 200,
      headers: {
        "content-type": image.mime,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": API_CSP,
        "referrer-policy": "no-referrer",
      },
    });
  });
  mountRoute(app, updateSessionRoute, contract, (c, { body: b }) => {
    const id = param(c, "id");
    const session = store.getSession(id);
    if (!session) throw notFound("That session does not exist.");
    let title: string | undefined;
    if (b.title !== undefined) {
      title = b.title.replace(/\s+/g, " ").trim();
      if (!title || title.length > 80)
        throw badRequest("bad_title", "A chat name must be between 1 and 80 characters.");
    }
    const pinned = b.pinned;
    const profile = b.profile === "relaxed" && session.origin !== "trigger" ? "standard" : b.profile;
    if (title !== undefined) store.setSessionTitle(id, title);
    if (pinned !== undefined) store.setSessionPinned(id, pinned);
    if (profile !== undefined && profile !== session.profile) {
      store.tx(() => {
        store.setProfile(id, profile!);
        store.addNotice(id, `Permissions changed to ${PROFILE_LABEL[profile!]}.`);
      });
      log.info("session.profile_changed", { sessionId: id, from: session.profile, to: profile });
    }
    return { session: store.getSession(id)! };
  });
  mountRoute(app, deleteSessionRoute, contract, async (c, { query }) => {
    await adapter.deleteSession(param(c, "id"), query.withForks === "1", query.clearHome === "1");
    return { ok: true };
  });

  // ---- approvals and grants ------------------------------------------------------------------------------------------
  mountRoute(app, listApprovalsRoute, contract, () => ({ approvals: adapter.approvals.list() }));
  mountRoute(app, decideApprovalRoute, contract, async (c, { body }) => ({
    approval: await adapter.approvals.decide(param(c, "id"), body),
  }));
  mountRoute(app, decideApprovalGroupRoute, contract, async (c, { body }) => ({
    approvals: await adapter.approvals.decideGroup(param(c, "id"), body),
  }));
  mountRoute(app, grantsRoute, contract, () => ({ grants: adapter.approvals.grants() }));
  mountRoute(app, revokeGrantRoute, contract, (c) => {
    adapter.approvals.revokeGrant(param(c, "id"));
    return { ok: true } as const;
  });

  // ---- memory ---------------------------------------------------------------------------------------------------
  const memory = (): MemoryService => {
    if (!deps.memory) throw new HttpError(404, "not_found", "Memory is not available.");
    return deps.memory;
  };
  const you = { by: "user", sessionId: null } as const;
  mountRoute(app, memoryRoute, contract, () => memory().lines.response());
  mountRoute(app, addMemoryLineRoute, contract, (_c, { body }) =>
    memory().lines.add(
      { doc: body.doc, text: body.text, ...(body.agentId !== undefined ? { agentId: body.agentId } : {}) },
      you,
    ),
  );
  mountRoute(app, updateMemoryLineRoute, contract, (c, { body }) => {
    const { lines } = memory();
    const id = param(c, "id");
    const line = lines.line(id);
    if (!line) throw notFound("No such line.");
    // The same text is "still true": it moves the date and changes nothing else.
    return normaliseLine(body.text) === line.text ? lines.confirm(id, you) : lines.replace(id, body.text, you);
  });
  mountRoute(app, removeMemoryLineRoute, contract, (c) => memory().lines.remove(param(c, "id"), you));
  mountRoute(app, memoryLineChangesRoute, contract, (c) => ({ changes: memory().lines.changesOf(param(c, "id")) }));
  mountRoute(app, undoMemoryChangeRoute, contract, (c) => memory().lines.undo(param(c, "id")));
  mountRoute(app, historySearchRoute, contract, async (_c, { query }) => {
    const svc = memory();
    const { q, from, to, agent: agentId, limit } = query;
    if (from !== undefined && !Number.isFinite(from))
      throw badRequest("bad_query", "from must be a time in epoch milliseconds.");
    if (to !== undefined && !Number.isFinite(to))
      throw badRequest("bad_query", "to must be a time in epoch milliseconds.");
    if (agentId !== undefined && !svc.store.getAgent(agentId))
      throw badRequest("unknown_agent", "That agent does not exist.");
    const hits = await svc.search({
      query: q ?? "",
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(agentId ? { agentId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { hits, index: svc.history.status() };
  });
  mountRoute(app, memoryIndexRoute, contract, () => ({ index: memory().history.status() }));
  mountRoute(app, storageDiagnosticsRoute, contract, async () => {
    const service = memory();
    const files = deps.storage.registry.counts();
    return {
      files: {
        bucket: deps.storage.objects.bucket,
        pending: files.pending,
        ready: files.ready,
        deletePending: files.deletePending,
        failed: files.failed,
        readyBytes: files.readyBytes,
        lastError: files.lastError,
      },
      search: await service.history.diagnostics(),
    };
  });
  // Tests the connection exactly as the form has it, without saving anything; Save is enabled only after this passes.
  mountRoute(app, checkEmbeddingSetupRoute, contract, async (_c, { body }) => {
    if (!deps.providers) throw badRequest("unavailable", "Embedding settings need the gateway.");
    const input = embeddingSetupInput(body);
    if (input.provider === "off") throw badRequest("bad_request", "Choose oMLX or an OpenAI-compatible API to test.");
    const { dims } = await deps.providers.detectEmbedding(input);
    if (input.profile && input.profile.dims !== dims)
      throw badRequest(
        "embedding_failed",
        `The model returned ${dims} dimensions, but this profile expects ${input.profile.dims}.`,
      );
    return { ok: true as const, dims };
  });
  mountRoute(app, embeddingSetupRoute, contract, async () => {
    if (!deps.providers) throw badRequest("unavailable", "Embedding settings need the gateway.");
    const settings = await deps.providers.embeddingSettings();
    const existing = memory().history.embeddingInfo();
    return settings && !settings.profile && existing
      ? {
          ...settings,
          provider: existing.provider,
          profile: existing.profile as import("@rei/protocol").EmbeddingSetupSettings["profile"],
        }
      : settings;
  });
  let savingEmbedding = false;
  mountRoute(app, saveEmbeddingSetupRoute, contract, async (_c, { body }) => {
    if (savingEmbedding) throw badRequest("setup_busy", "Embedding settings are being saved. Try again.");
    savingEmbedding = true;
    try {
      if (!deps.providers) throw badRequest("unavailable", "Embedding settings need the gateway.");
      const input = embeddingSetupInput(body);
      if (input.provider === "openai") {
        const { dims } = await deps.providers.detectEmbedding(input);
        const model = input.apiModel.trim();
        input.profile = validateProfile(
          input.profile
            ? { ...input.profile, dims }
            : {
                id: model,
                repository: `${embeddingBase(input.baseUrl)}/${model}`,
                revision: "api-managed",
                quant: "provider-managed",
                pooling: "provider",
                dims,
                docTemplate: input.advanced?.docTemplate ?? "$" + "{t}",
                queryTemplate: input.advanced?.queryTemplate ?? "$" + "{q}",
                maxInputTokens: input.advanced?.contextTokens ?? 512,
                contextTokens: input.advanced?.contextTokens ?? 512,
              },
        ) as NonNullable<typeof input.profile>;
      }
      try {
        deps.providers.embeddingClient(input);
      } catch {
        throw badRequest("bad_request", "Invalid embedding model or vector profile.");
      }
      const saved = await deps.providers.saveEmbeddingSettings(input);
      await memory().history.configureEnabled(saved.provider !== "off", deps.providers.embeddingClient(saved));
      memory().store.db.run(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_setup', ?)",
        JSON.stringify(saved),
      );
      return saved;
    } finally {
      savingEmbedding = false;
    }
  });
  mountRoute(app, memorySetupRoute, contract, () => memory().history.setupSettings());
  mountRoute(app, saveMemorySetupRoute, contract, (_c, { body }) => memory().history.configureEnabled(body.enabled));
  mountRoute(app, rebuildMemoryIndexRoute, contract, () => ({ index: memory().history.rebuild() }));

  // ---- streams -------------------------------------------------------------------------------------------------------
  mountRoute(app, globalStreamRoute, contract, (c, { query }) =>
    sseResponse({
      events: store.events,
      stream: GLOBAL_STREAM,
      lastEventId: c.req.header("last-event-id"),
      ...(deps.ssePingMs ? { pingMs: deps.ssePingMs } : {}),
      snapshot: () => ({
        agents: store.listAgents(),
        defaultAgentId: store.defaultAgentId() ?? "",
        companion: store.companion(),
        sessions: query.paged === "1" ? store.sessionSeed() : store.listSessions(),
        approvals: adapter.approvals.list(),
        takeovers: deps.browser?.takeovers.list() ?? [],
      }),
    }),
  );
  mountRoute(app, sessionStreamRoute, contract, (c) => {
    const id = param(c, "id");
    if (!store.getSession(id)) throw notFound("That session does not exist.");
    return viewSseResponse({
      subscribe: (listener) => adapter.views.subscribe(id, listener),
      ...(deps.ssePingMs ? { pingMs: deps.ssePingMs } : {}),
    });
  });

  // ---- the browser window: state, takeover (the live view itself is a WebSocket, see node/browser-live.ts) ----------------
  mountRoute(app, sessionBrowserRoute, contract, async (c) => {
    const id = param(c, "id");
    if (!store.getSession(id)) throw notFound("That session does not exist.");
    const browser = deps.browser;
    const body: BrowserStateResponse = browser
      ? browser.takeovers.state(id)
      : { window: false, url: null, title: null, viewport: null, takeover: null };
    if (browser && body.window) body.viewport = await browser.service.driver.viewport(id).catch(() => null);
    return body;
  });
  mountRoute(app, startTakeoverRoute, contract, async (c) => {
    const id = param(c, "id");
    if (!store.getSession(id)) throw notFound("That session does not exist.");
    const browser = deps.browser;
    if (!browser) throw new HttpError(409, "no_window", "The browser is not available.");
    try {
      return { takeover: await browser.takeovers.start(id) };
    } catch (error) {
      if (error instanceof HttpError && error.code === "already_active") {
        const open = browser.takeovers.state(id).takeover;
        return c.json({ error: error.info(), ...(open ? { takeover: open } : {}) }, 409);
      }
      throw error;
    }
  });
  mountRoute(app, endTakeoverRoute, contract, async (c, { body: b }) => {
    const browser = deps.browser;
    if (!browser) throw notFound("That takeover does not exist.");
    return { takeover: await browser.takeovers.end(param(c, "id"), b.action, b.note) };
  });

  // ---- triggers and skills ---------------------------------------------------------------------------------------
  const triggers = () => {
    if (!deps.triggers) throw new HttpError(404, "not_found", "Triggers are not available.");
    return deps.triggers;
  };
  const skills = (): SkillStore => {
    if (!deps.skills) throw new HttpError(404, "not_found", "Skills are not available.");
    return deps.skills;
  };
  const triggerOr404 = (id: string) => {
    const trigger = triggers().store.get(id);
    if (!trigger) throw notFound("That trigger does not exist.");
    return trigger;
  };
  mountRoute(app, receiveEventRoute, contract, async (c) => {
    const receiver = deps.events;
    const source = param(c, "source");
    // The same answer for a server that takes no events as for a source it does not know.
    const answer = receiver
      ? await receiver.receive({
          source,
          webhookId: c.req.header("webhook-id") ?? null,
          timestamp: c.req.header("webhook-timestamp") ?? null,
          signature: c.req.header("webhook-signature") ?? null,
          body: await readLimited(c.req.raw, EVENT_LIMITS.bodyBytes),
        })
      : { status: 404 as const, code: "unknown_source" as const };
    if (answer.body) return c.json(answer.body, answer.status as 200);
    if (answer.retryAfterSeconds) c.header("retry-after", String(answer.retryAfterSeconds));
    return c.json(
      { error: { code: answer.code ?? "bad_event", message: answer.code ?? "bad_event" } },
      answer.status as 400,
    );
  });
  mountRoute(app, eventSourcesRoute, contract, () => ({
    sources: (deps.eventSources?.list() ?? []).map(({ id, name, status, lastEventAt, types }) => ({
      id,
      name,
      status,
      lastEventAt,
      types,
    })),
  }));
  mountRoute(app, triggersRoute, contract, () => ({ triggers: triggers().store.list() }));
  mountRoute(app, triggerRoute, contract, (c, { query }) => {
    const trigger = triggerOr404(param(c, "id"));
    const page = triggers().store.runsPage(trigger.id, query.before);
    return { trigger, runs: page.runs, next: page.next };
  });
  mountRoute(app, updateTriggerRoute, contract, (c, { body }) => {
    const t = triggers();
    const trigger = patchTrigger(
      { app: store, triggers: t.store, catalog: t.catalog, skills: skills() },
      param(c, "id"),
      body as Record<string, unknown>,
    );
    return { trigger };
  });
  mountRoute(app, runTriggerRoute, contract, (c) => ({ run: triggers().scheduler.runNow(param(c, "id")) }));
  mountRoute(app, deleteTriggerRoute, contract, async (c, { query }) => {
    const removed = triggers().store.remove(param(c, "id"));
    if (!removed) throw notFound("That trigger does not exist.");
    if (query.withSessions === "1")
      for (const id of removed.sessionIds) await adapter.deleteSession(id, false).catch(() => undefined);
    return { ok: true } as const;
  });

  const SKILL_IMPORT_MAX_BYTES = 8_000_000;
  /** A skill with the plugin that owns it (null: standalone); built-in skills have no owner. */
  const owned = (s: SkillSummary): SkillSummary =>
    s.builtIn ? s : { ...s, plugin: deps.plugins?.owner("skill", s.id) ?? null };
  // The one route that takes a large body (a zip, as base64): bounded before the contract parses it.
  app.post("/api/skills", async (c, next) => {
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > SKILL_IMPORT_MAX_BYTES) throw new HttpError(413, "too_large", "That skill is too large to import.");
    if ((await c.req.text()).length > SKILL_IMPORT_MAX_BYTES)
      throw new HttpError(413, "too_large", "That skill is too large to import.");
    await next();
  });
  mountRoute(app, skillsRoute, contract, () => ({ skills: skills().list().map(owned) }));
  mountRoute(app, exportSkillRoute, contract, (c, { query }) => {
    const found = skills().get(param(c, "id"), query.version);
    if (!found) throw notFound("That skill does not exist.");
    const zip = exportZip(found.skill.name, found.files, deps.clock.now());
    return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${found.skill.name}.zip"`,
    });
  });
  mountRoute(app, skillRoute, contract, (c, { query }) => {
    const found = skills().get(param(c, "id"), query.version);
    if (!found) throw notFound("That skill does not exist.");
    return { ...found, skill: owned(found.skill) };
  });
  mountRoute(app, importSkillRoute, contract, (_c, { body }) => {
    let files: unknown;
    if (typeof body.zip === "string") {
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(body.zip.replace(/\s+/g, "")), (ch) => ch.charCodeAt(0));
      } catch {
        throw badRequest("bad_request", "The zip must be base64.");
      }
      files = importZip(bytes);
    } else files = body.files;
    const saved = skills().save({ files, author: "user", note: "Imported", log: true });
    return { skill: owned(saved.skill) };
  });
  mountRoute(app, updateSkillRoute, contract, (c, { body: b }) => {
    const id = param(c, "id");
    const store_ = skills();
    if (!store_.get(id)) throw notFound("That skill does not exist.");
    if (b.files !== undefined && b.restore !== undefined)
      throw badRequest("bad_request", "Send either files or restore, not both.");
    if (b.files !== undefined)
      store_.save({ files: b.files, author: "user", note: "Edited on the Skills page", log: true, expectId: id });
    if (b.restore !== undefined) {
      store_.restore(id, b.restore);
      deps.plugins?.syncSkill(id);
    }
    if (b.agents !== undefined) store_.setAgents(id, b.agents);
    return { skill: owned(store_.get(id)!.skill) };
  });
  mountRoute(app, deleteSkillRoute, contract, (c) => {
    if (!skills().remove(param(c, "id"))) throw notFound("That skill does not exist.");
    deps.plugins?.removeComponent("skill", param(c, "id"));
    return { ok: true } as const;
  });

  // ---- notifications --------------------------------------------------------------------------------------------
  const notifications = (): NotificationService => {
    if (!deps.notifications) throw notFound("Notifications are not available.");
    return deps.notifications;
  };
  /** The app's public origin for OAuth redirects and its stored fallback: use the browser Origin, then forwarded host. */
  const appOrigin = (c: Context): string | undefined => {
    const candidates = [
      c.req.header("origin"),
      c.req.header("x-forwarded-host")
        ? `${c.req.header("x-forwarded-proto") ?? "https"}://${c.req.header("x-forwarded-host")}`
        : undefined,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
      } catch {
        // try the next one
      }
    }
    return undefined;
  };
  mountRoute(app, pushKeyRoute, contract, async () => ({ publicKey: await notifications().vapidKey() }));
  /** Deprecated (docs/adr/0009): POST /api/devices/current/channels registers a Web Push channel. */
  mountRoute(app, pushSubscribeRoute, contract, (c, { body }) => {
    const label = body.label.replace(/\s+/g, " ").trim().slice(0, 60);
    if (label === "") throw badRequest("bad_request", "Give the device a label.");
    const { endpoint, keys } = body.subscription;
    notifications().subscribe(
      { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
      label,
      appOrigin(c),
      currentDevice(c).id,
    );
    return undefined;
  });
  mountRoute(app, registerChannelRoute, contract, (c, { body }) => {
    const device = currentDevice(c);
    return { channel: notifications().registerChannel(device.id, device.label, body, appOrigin(c)) };
  });
  mountRoute(app, removeChannelRoute, contract, (c) => {
    notifications().removeChannel(currentDevice(c).id, param(c, "channelId") ?? "");
    return { ok: true };
  });
  mountRoute(app, presenceRoute, contract, (c, { body }) => {
    notifications().presence(currentDevice(c).id, body.visible, body.idleMs ?? 0);
    return { ok: true };
  });
  mountRoute(app, pushUnsubscribeRoute, contract, (_c, { body }) => {
    notifications().unsubscribe(body.endpoint);
    return undefined;
  });
  /** Deprecated (docs/adr/0009): POST /api/devices/current/presence reports idle time too. */
  mountRoute(app, legacyPresenceRoute, contract, (c, { body }) => {
    notifications().presence(currentDevice(c).id, body.visible);
    return undefined;
  });
  mountRoute(app, notificationsRoute, contract, (c) => notifications().state(appOrigin(c)));
  mountRoute(app, updatePreviewRoute, contract, (c, { body }) =>
    notifications().setPreview(body.preview, appOrigin(c)),
  );
  mountRoute(app, testNotificationsRoute, contract, async () => {
    await notifications().test();
    return undefined;
  });

  // ---- MCP connectors -------------------------------------------------------------------------------------------
  const mcp = (): McpService => {
    if (!deps.mcp) throw notFound("Connectors are not available.");
    return deps.mcp;
  };
  const text = (value: unknown, what: string, max: number, required = true): string | undefined => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || value.trim() === "" || value.length > max)
      throw badRequest("bad_request", `${what} must be text of 1 to ${max} characters.`);
    return value.trim();
  };
  mountRoute(app, connectorsRoute, contract, async () => ({
    connectors: (await mcp().list()).map((c) => ({ ...c, plugin: deps.plugins?.owner("connection", c.id) ?? null })),
  }));
  mountRoute(app, createConnectorRoute, contract, async (_c, { body: b }) => {
    const token = b.token === undefined || b.token === "" ? undefined : text(b.token, "token", 4_000);
    const connector = await mcp().create({
      name: text(b.name, "name", 80)!,
      url: text(b.url, "url", 2_000)!,
      ...(token !== undefined ? { token } : {}),
      ...(b.tokenHeader !== undefined ? { tokenHeader: text(b.tokenHeader, "token header", 128)! } : {}),
    });
    return { connector };
  });
  mountRoute(app, updateConnectorRoute, contract, async (c, { body: b }) => {
    if (b.token !== undefined && b.token !== null) text(b.token, "token", 4_000);
    const name = text(b.name, "name", 80, false);
    return {
      connector: await mcp().update(param(c, "id"), {
        ...(name !== undefined ? { name } : {}),
        ...(b.token !== undefined ? { token: b.token } : {}),
        ...(b.tokenHeader !== undefined
          ? { tokenHeader: b.tokenHeader === null ? null : text(b.tokenHeader, "token header", 128)! }
          : {}),
        ...(b.holdsPrivate !== undefined ? { holdsPrivate: b.holdsPrivate } : {}),
      }),
    };
  });
  mountRoute(app, deleteConnectorRoute, contract, async (c) => {
    await mcp().remove(param(c, "id"));
    deps.plugins?.removeComponent("connection", param(c, "id"));
    return undefined;
  });
  mountRoute(app, setConnectorProfileRoute, contract, async (c, { body: b }) => ({
    connector: await mcp().setProfile(
      param(c, "id"),
      b.profile,
      b.providerIdentity,
      b.expectedRevision,
      b.confirmYolo === true,
    ),
  }));
  // A tool's JSON Schemas are objects the gateway passes through as they came.
  mountRoute(
    app,
    connectorToolsRoute,
    contract,
    async (c, { query }) =>
      (await mcp().tools(param(c, "id"), query.refresh === "1")) as ResponseOf<typeof connectorToolsRoute>,
  );
  mountRoute(app, setConnectorToolRoute, contract, async (c, { body: b }) => {
    if (
      b.actionClass === "read_external" &&
      (typeof b.definitionFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(b.definitionFingerprint))
    )
      throw badRequest(
        "bad_request",
        "Read trust requires the definitionFingerprint of the tool you inspected. Refresh the tools first.",
      );
    const id = param(c, "id");
    const tool = param(c, "tool");
    const { tools } = await mcp().tools(id, false);
    if (!tools.some((t) => t.name === tool)) throw notFound("That connector has no such tool.");
    await mcp().setOverride(id, tool, b.actionClass, b.definitionFingerprint);
    return { ok: true } as const;
  });
  mountRoute(app, connectorOAuthStartRoute, contract, async (c, { body: b }) => {
    const clientId = b.clientId === undefined || b.clientId === "" ? undefined : text(b.clientId, "clientId", 500);
    const clientSecret =
      b.clientSecret === undefined || b.clientSecret === "" ? undefined : text(b.clientSecret, "clientSecret", 2_000);
    const origin =
      appOrigin(c) ??
      store.db.get<{ app_url: string | null }>("SELECT app_url FROM notification_settings WHERE id = 1")?.app_url ??
      undefined;
    if (!origin)
      throw badRequest(
        "no_app_origin",
        "The app's address isn't known here. Open the app from its own address and try again.",
      );
    const authorizationUrl = await mcp().oauthStart(param(c, "id"), {
      redirectUri: `${origin.replace(/\/+$/, "")}/api/mcp/oauth/callback`,
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    });
    return { authorizationUrl };
  });
  // The provider sends the browser back here. The session cookie is SameSite=Strict, so this cross-site return carries
  // none: the route needs no sign-in and does nothing but hand the parameters to the app, which finishes signed in.
  mountRoute(app, mcpOAuthCallbackRoute, contract, (c, { query: q }) => {
    const params = new URLSearchParams();
    if (q.error) params.set("oauth_error", String(q.error_description ?? q.error).slice(0, 200));
    else if (q.state && q.code) {
      params.set("state", q.state.slice(0, 500));
      params.set("code", q.code.slice(0, 4_000));
      if (q.iss) params.set("iss", q.iss.slice(0, 500));
    } else params.set("oauth_error", "The sign-in did not come back with a code.");
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return c.redirect(`/settings/connectors?${params.toString()}`, 302);
  });
  mountRoute(app, connectorOAuthFinishRoute, contract, async (_c, { body: b }) => {
    const iss = b.iss === undefined || b.iss === "" ? undefined : text(b.iss, "iss", 500);
    return {
      connector: await mcp().oauthFinish({
        state: text(b.state, "state", 500)!,
        code: text(b.code, "code", 4_000)!,
        ...(iss ? { iss } : {}),
      }),
    };
  });

  app.all("/api/*", () => {
    throw notFound("No such endpoint.");
  });

  // ---- the PWA -------------------------------------------------------------------------------------------------------
  app.get("*", (c) => serveWeb(deps.web, new URL(c.req.url).pathname, c.req.method));

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.info() }, error.status as 400);
    if (error instanceof ContractViolation) {
      log.error("http.contract_violation", { requestId: requestIds.get(c.req.raw), route: c.req.routePath });
      return c.json({ error: { code: "contract_violation", message: error.message } }, 500);
    }
    log.error("http.error", { requestId: requestIds.get(c.req.raw), route: c.req.routePath, ...classifyError(error) });
    return c.json({ error: { code: "internal_error", message: "Something went wrong on the server." } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));

  return app;
}
