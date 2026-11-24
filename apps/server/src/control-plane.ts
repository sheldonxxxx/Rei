import { SURFACE_LIMITS } from "@rei/protocol";
import type { Hono } from "hono";
import { AttachmentService } from "./attachments/service.ts";
import { AuthService, type SetupCodeStore } from "./auth/service.ts";
import type { WebAuthnEngine } from "./auth/webauthn.ts";
import { BackgroundTaskService } from "./background/service.ts";
import { gatewayBackupState } from "./backup/gateway.ts";
import { BackupService, type BackupServiceDeps } from "./backup/service.ts";
import type { BlobStore } from "./blobs/blob-store.ts";
import type { BrowserDriver } from "./browser/driver.ts";
import { LiveHub } from "./browser/live.ts";
import { BrowserService } from "./browser/service.ts";
import { TakeoverService } from "./browser/takeover-service.ts";
import type { Db } from "./db/db.ts";
import { initializeDatabase } from "./db/schema.ts";
import { EventReceiver } from "./events/receive.ts";
import { EventSources, SecretBox } from "./events/sources.ts";
import type { ExecBackend } from "./exec/backend.ts";
import { type EgressListener, EgressService } from "./exec/egress.ts";
import { WorkspaceManager } from "./exec/workspaces.ts";
import { createApp } from "./http/app.ts";
import type { WebAssets } from "./http/assets.ts";
import type { ImageWorker } from "./images/worker.ts";
import { KNOWLEDGE_FUSION, KnowledgeMeaning } from "./knowledge/meaning.ts";
import { KnowledgeService } from "./knowledge/service.ts";
import { LibraryService } from "./library/service.ts";
import { ConnectorToolDirectory } from "./mcp/connector-tools.ts";
import { McpService } from "./mcp/service.ts";
import { BackgroundMemoryReview } from "./memory/background-review.ts";
import { Embedder, type EmbedderConfig, type EmbedderDeps } from "./memory/embedder.ts";
import { MemoryService, type MemoryServiceDeps } from "./memory/service.ts";
import { NotificationService } from "./notify/service.ts";
import { PiAdapter } from "./pi/adapter.ts";
import { AgentDesigner } from "./pi/agent-designer.ts";
import { type BehaviorDefaults, behaviorSettings } from "./pi/behavior-settings.ts";
import { ModelCatalog } from "./pi/catalog.ts";
import { savedTimeZone } from "./pi/clock-context.ts";
import { type CodemodeLimits, CodemodeRuntime, DEFAULT_CODEMODE_LIMITS } from "./pi/codemode.ts";
import { type ModelsConfigSource, parseModelsConfig } from "./pi/model-config.ts";
import { createModelRuntime, type StandinSource } from "./pi/models.ts";
import { createPolicyExtension, ToolCatalog } from "./pi/policy-ext.ts";
import type { PrivateSnapshots } from "./pi/private-execution.ts";
import type { SessionHostRef } from "./pi/session-tools.ts";
import { StepRecorder } from "./pi/steps.ts";
import { TitleService } from "./pi/titles.ts";
import type { TreeFiles } from "./pi/tree-files.ts";
import { type BrowserRef, TreeManager } from "./pi/trees.ts";
import type { PiStorageOpener } from "./pi/types.ts";
import { PluginService } from "./plugins/service.ts";
import { ProviderService } from "./providers/service.ts";
import type { RetrievalStore } from "./retrieval/retrieval-store.ts";
import { SkillPreparer } from "./skills/prepare.ts";
import { SkillStore } from "./skills/store.ts";
import type { FileObjectStore } from "./storage/file-object-store.ts";
import { StorageMaintenance } from "./storage/maintenance.ts";
import { ObjectRegistry } from "./storage/registry.ts";
import type { UploadSpool } from "./storage/upload-spool.ts";
import { ApprovalStore } from "./store/approvals.ts";
import { EventLog } from "./store/events.ts";
import { AppStore } from "./store/store.ts";
import { TakeoverStore } from "./store/takeovers.ts";
import { TriggerRunner } from "./triggers/runner.ts";
import { TriggerScheduler } from "./triggers/scheduler.ts";
import { processZone } from "./triggers/spec.ts";
import { TriggerStore } from "./triggers/store.ts";
import type { Clock } from "./util/clock.ts";
import type { Logger } from "./util/log.ts";
import { WebDocumentStore } from "./web/documents.ts";
import { NetworkDecisions } from "./web/tools.ts";

export type ExecMode = "off" | "ssh" | "local";

/** The agent computer's browser. */
export interface BrowserConfig {
  /** `off` (default): no browser tools. `cdp`: the browser container, over DevTools. */
  mode: "off" | "cdp";
  /** `cdp`: the container's DevTools address, for example `http://browser:9223`. */
  cdpUrl?: string;
  /** Windows open at once (default 3). */
  maxWindows?: number;
  /** Tests: how long a call waits for a window (default 120 s), and how long a takeover may sit without input (default 15 min). */
  busyWaitMs?: number;
  takeoverIdleMs?: number;
  /** A window unused this long is closed; 0 turns it off (default 60 min). */
  idleMs?: number;
}

/** The execution plane: where the agent's read, write, edit and bash tools run. */
export interface ExecConfig {
  /** `off` (default): no sandbox tools. `ssh`: the exec container. `local`: a folder on this machine, with no network isolation (faux mode only). */
  mode: ExecMode;
  /** ssh: the exec container's address and the folder with its keys (`id_ed25519`, `host_ed25519_key.pub`). */
  host?: string;
  port?: number;
  keysDir?: string;
  /** local: where the workspaces are (default `<dataDir>/workspaces`). */
  root?: string;
  /** The unix socket the egress proxy asks for decisions on; unset: no listener. */
  egressSocket?: string;
  /** `host:port` of the egress proxy as the sandbox reaches it (`REI_EGRESS_PROXY`); unset: bash gets no proxy variables, so no network, and web_fetch is unavailable. */
  egressProxy?: string;
}

/** Everything tunable; the Node host fills it from the environment. */
export interface ControlPlaneConfig {
  mode: "gateway" | "faux";
  gatewayUrl?: string;
  /** REI_PUBLIC_URL: the address people open Rei at (an origin, no trailing slash), for links in notifications. */
  publicUrl?: string;
  fcmEnabled?: boolean;
  androidPasskeyOrigins?: string[];
  cookieSecure: boolean;
  fauxTokensPerSecond?: number;
  idleCloseMs: number;
  /** Committed upserts while an assistant message streams. */
  commitIntervalMs: number;
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number };
  restartLimit?: number;
  partialIntervalMs?: number;
  tickMs: number;
  eventLogKeep: number;
  ssePingMs?: number;
  /** Check contract routes' answers against their schemas (tests only). */
  checkContract?: boolean;
  /** start_session refuses beyond this depth (home, user and fork chats are 0). */
  maxSessionDepth: number;
  /** start_session refuses when the caller has this many unfinished spawned sessions. */
  maxActiveChildren: number;
  /** Deleting a session waits this long for its cancelled runs to settle. */
  deleteSettleMs: number;
  /** How often worker feeds write into their surfaces (default: the protocol's feed interval, 1 s). Tests raise it. */
  surfaceFeedMs: number;
  /** The dev-only demo connector (tools with no real effect). Default: on in faux mode, off in gateway mode. */
  demoTools?: boolean;
  /** How long a pending approval waits for a decision (default 24 h). */
  approvalTtlMs: number;
  /** How long the one-time grant of an approved call stays usable (default 1 h). */
  oneTimeGrantTtlMs: number;
  /** Loop guard: model calls one run may make (default 50). */
  maxModelCallsPerRun: number;
  /** Loop guard: wall-clock time one run may take (default 30 minutes). */
  maxRunMs: number;
  /** Code mode's sandbox: script deadline, VM heap and scripts at once (the Runtime setting turns code mode on). */
  codemode: CodemodeLimits;
  exec: ExecConfig;
  browser: BrowserConfig;
  /** The embedder history search uses; unset: keyword search only (the index state is "off"). */
  embedder?: EmbedderConfig;
}

export const DEFAULT_CONFIG: ControlPlaneConfig = {
  mode: "gateway",
  cookieSecure: false,
  idleCloseMs: 10 * 60_000,
  commitIntervalMs: 2_000,
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 2_000, maxAgentDelayMs: 15_000 },
  tickMs: 30_000,
  eventLogKeep: 10_000,
  maxSessionDepth: 2,
  maxActiveChildren: 5,
  deleteSettleMs: 10_000,
  surfaceFeedMs: SURFACE_LIMITS.feedIntervalMs,
  approvalTtlMs: 24 * 3_600_000,
  oneTimeGrantTtlMs: 3_600_000,
  maxModelCallsPerRun: 50,
  maxRunMs: 30 * 60_000,
  codemode: DEFAULT_CODEMODE_LIMITS,
  exec: { mode: "off" },
  browser: { mode: "off" },
};

/** The web tools' outside connections: (tests) another base URL for /search and /read than the gateway's, and a shorter read deadline. */
export interface WebHostOptions {
  searchUrl?: string;
  readTimeoutMs?: number;
}

/** Host-provided pieces: the only things that touch the operating system. */
export interface ControlPlaneDeps {
  images?: ImageWorker;
  db: Db;
  /**
   * Trace payloads: step bodies, context breakdowns, browser screenshots. Content-addressed and redactable in place,
   * and they stay on the local folder store (M11 moved *file* bytes to the object store, not the trace evidence).
   */
  traceBlobs: BlobStore;
  /** Passkey cryptography (ADR 0016); the Node host supplies SimpleWebAuthn's. */
  webauthn: WebAuthnEngine;
  /** File bytes: uploads, Library versions, published agent files, retained tool media. Garage in a deployment. */
  fileObjects: FileObjectStore;
  /** Where an upload is written down and hashed before it is put in the object store (a folder on disk, on a server). */
  uploadSpool?: UploadSpool;
  /** The search index (BM25 + dense vectors). Absent only in faux mode, where history search stays keyword-only... today. */
  retrieval?: RetrievalStore;
  treeFiles: TreeFiles;
  openPiStorage: PiStorageOpener;
  privateSnapshots: PrivateSnapshots;
  clock: Clock;
  log: Logger;
  setupCodes: SetupCodeStore;
  modelsConfig: ModelsConfigSource;
  standin: StandinSource;
  web?: WebAssets;
  /** Shown to the operator when a setup code is needed (stdout in the Node host). */
  announceSetupCode(code: string): void;
  config: ControlPlaneConfig;
  /** The key event sources' secrets are encrypted with (REI_EVENTS_KEY, 32 bytes); without it no event is accepted. */
  eventsKey?: Uint8Array<ArrayBuffer>;
  /** Test hook: the fetch the gateway client uses. */
  fetchImpl?: typeof fetch;
  /** Backups: the data directory, where the repository folder and the staging volume are, and how restic is run (tests pass a fake). */
  backup?: Pick<
    BackupServiceDeps,
    "repositoryDir" | "stagingDir" | "dataDir" | "restic" | "appVersion" | "extraSkip" | "tickMs" | "bundle" | "folder"
  >;
  /** Where the sandbox tools run; set when `config.exec.mode` is not `off` (the Node host builds it). */
  exec?: ExecBackend;
  /** Where the egress proxy's questions arrive (a unix socket in the Node host). */
  egressListener?: EgressListener;
  /** The browser's driver, when `config.browser.mode` is not `off` (the Node host builds the DevTools one; tests pass a fake). */
  browserDriver?: BrowserDriver;
  /** The web tools' outside connections (the Node host builds the egress client from `exec.egressProxy`). */
  webTools?: WebHostOptions;
  /** Tests: the gateway address MCP connectors use instead of `config.gatewayUrl` (faux mode has none). */
  mcp?: { gatewayUrl?: string };
  /**
   * The embedder's outside pieces (the Node host reads its key file; tests pass a fake fetch) and, for tests, the
   * indexer's timers and batch sizes, and the cosine floor Knowledge meaning search uses with a fake embedder (whose
   * scores are not on a real model's scale).
   */
  memory?: EmbedderDeps &
    Pick<MemoryServiceDeps, "timers" | "worker"> & {
      knowledgeCosineFloor?: number;
      knowledgeMeaningBand?: number;
    };
}

export interface ControlPlane {
  app: Hono;
  store: AppStore;
  approvals: ApprovalStore;
  auth: AuthService;
  adapter: PiAdapter;
  egress: EgressService;
  workspaces: WorkspaceManager | undefined;
  /** The browser and its takeovers and live view; undefined when it is off. */
  browser: { service: BrowserService; takeovers: TakeoverService; live: LiveHub } | undefined;
  /** The profile docs, the history index and search. */
  memory: MemoryService;
  /** Knowledge: shared long-term pages. */
  knowledge: KnowledgeService;
  memoryMaintenance: BackgroundMemoryReview;
  background: BackgroundTaskService;
  /** The file store: SQLite's ledger of the objects, the worker that deletes them, and the service itself. */
  storage: { registry: ObjectRegistry; maintenance: StorageMaintenance; objects: FileObjectStore };
  /** The search index, when one is configured. */
  retrieval: RetrievalStore | undefined;
  /** Triggers: their rows, the scheduler that fires them and the runner that starts and ends their runs. */
  triggers: { store: TriggerStore; scheduler: TriggerScheduler; runner: TriggerRunner };
  /** Outside events: the sources and the receiver of their signed requests; undefined without an events key. */
  events: { sources: EventSources; receiver: EventReceiver } | undefined;
  /** Scheduled and manual backups of the database, the files and the gateway's state. */
  backup: BackupService;
  /** Skills. */
  skills: SkillStore;
  plugins: PluginService;
  /** Web Push settings and the worker that sends the outbox's notify rows. */
  notifications: NotificationService;
  /** MCP connectors: the gateway's connectors with the app's policy on them. */
  mcp: McpService;
  /** The connectors' tools under their tool names, as trees register them. */
  connectorTools: ConnectorToolDirectory;
  /** The policy declarations of every tool (the same whatever connectors exist). */
  catalog: ToolCatalog;
  /** Code mode's sandbox: the scripts running now (workers) and when every worker has exited. */
  codemode: CodemodeRuntime;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createControlPlane(deps: ControlPlaneDeps): Promise<ControlPlane> {
  const { config, db, clock, log } = deps;
  initializeDatabase(db, () => clock.now());
  const events = new EventLog(clock, config.eventLogKeep);
  const store = new AppStore(db, clock, events);
  const webDocuments = new WebDocumentStore(db, () => clock.now());
  const approvals = new ApprovalStore(store);
  const catalog = new ToolCatalog();
  const auth = new AuthService(db, clock, deps.setupCodes, log, deps.webauthn);
  const usedModels = async (id: string): Promise<string[]> => {
    const modelConfig = parseModelsConfig(await deps.modelsConfig.read().catch(() => undefined));
    const choices = [
      ...store.modelsInUse(),
      modelConfig.fast.model,
      modelConfig.standard.model,
      store.metaGet("title_model"),
    ].filter((value): value is string => !!value);
    return [
      ...new Set(
        choices.flatMap((choice) => {
          const slash = choice.indexOf("/");
          const providerId = slash > 0 ? choice.slice(0, slash) : "openai";
          return providerId === id ? [slash > 0 ? choice.slice(slash + 1) : choice] : [];
        }),
      ),
    ];
  };
  const providers = new ProviderService({
    gatewayUrl: config.gatewayUrl,
    token: () => deps.standin.read(),
    fetchImpl: deps.fetchImpl,
    isInUse: async (id) => (await usedModels(id)).length > 0,
    usedModels,
    replaceModels: async (id, from, to) => {
      const swap = (choice: string | undefined, old: string) => choice === `${id}/${old}`;
      const target = `${id}/${to}`;
      for (const old of from) {
        for (const agentId of store.agentIdsUsingModel(`${id}/${old}`))
          store.updateAgentSettings(agentId, { model: target });
        if (swap(store.metaGet("title_model"), old)) store.metaSet("title_model", target);
      }
      const current = parseModelsConfig(await deps.modelsConfig.read().catch(() => undefined));
      let touched = false;
      for (const tier of ["fast", "standard"] as const)
        if (from.some((old) => swap(current[tier].model, old))) {
          current[tier] = { ...current[tier], model: target };
          touched = true;
        }
      if (touched) await deps.modelsConfig.write?.(current);
    },
  });
  const runtime = await createModelRuntime({
    mode: config.mode,
    standin: deps.standin,
    ...(config.mode === "gateway"
      ? {
          providerLoader: async () => (await providers.read()).connections,
          onProviderLoadError: () => log.warn("providers.discovery_failed"),
        }
      : {}),
    ...(config.fauxTokensPerSecond !== undefined ? { fauxTokensPerSecond: config.fauxTokensPerSecond } : {}),
  });
  providers.onChanged = async (connections) => runtime.configureProviders(connections);
  const behaviorDefaults: BehaviorDefaults = {
    maxModelCalls: config.maxModelCallsPerRun,
    maxRunMs: config.maxRunMs,
    retry: config.retry,
    // Rendering is the shared reader's: available whenever web reading is (the gateway is configured).
  };
  runtime.setOutputCap(behaviorSettings(store, behaviorDefaults).generation.maxOutputTokens);
  runtime.setNativeSearch(behaviorSettings(store, behaviorDefaults).search.useOpenAiNativeSearch);
  runtime.setModelOverrides(parseModelsConfig(await deps.modelsConfig.read().catch(() => undefined)).overrides);
  const egress = new EgressService({ store, log });
  const workspaces = deps.exec ? new WorkspaceManager(db, deps.exec, clock, log) : undefined;
  // The object store's ledger and its background half: SQLite owns the state, this drains the deletions SQLite has
  // already agreed to. Built here so every caller (faux tests included) gets the same state machine.
  const registry = new ObjectRegistry(db, clock);
  const storage = new StorageMaintenance({ registry, objects: deps.fileObjects, log });
  const attachments = new AttachmentService(store, deps.fileObjects, registry, workspaces, deps.uploadSpool);
  attachments.maintenance = storage;
  const library = new LibraryService(store, attachments);
  attachments.library = library;
  const knowledge = new KnowledgeService(store);
  const recorder = new StepRecorder(db, deps.traceBlobs, clock, log);
  const sessionHost: SessionHostRef = { current: undefined };
  const browserRef: BrowserRef = { current: undefined };
  const takeoverStore = new TakeoverStore(store);
  const savedEmbeddingJson = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'embedding_setup'")?.value;
  const savedEmbedding = savedEmbeddingJson
    ? (JSON.parse(savedEmbeddingJson) as import("@rei/protocol").EmbeddingSetupSettings)
    : null;
  const embedder = savedEmbedding
    ? providers.embeddingClient(savedEmbedding)
    : config.embedder
      ? new Embedder(config.embedder, deps.memory)
      : undefined;
  const memory = new MemoryService({
    store,
    clock,
    log,
    embedder,
    traceBlobs: deps.traceBlobs,
    ...(deps.retrieval ? { retrieval: deps.retrieval } : {}),
    ...(deps.memory?.timers ? { timers: deps.memory.timers } : {}),
    ...(deps.memory?.worker ? { worker: deps.memory.worker } : {}),
  });
  // Meaning search over Knowledge pages, with the model and on/off switch history search uses.
  knowledge.meaning = new KnowledgeMeaning({
    knowledge,
    model: () => memory.history.semanticModel(),
    log,
    ...(deps.memory?.timers ? { timers: deps.memory.timers } : {}),
    ...(deps.memory?.worker?.backoffBaseMs !== undefined ? { backoffBaseMs: deps.memory.worker.backoffBaseMs } : {}),
    ...(deps.memory?.worker?.backoffMaxMs !== undefined ? { backoffMaxMs: deps.memory.worker.backoffMaxMs } : {}),
    ...(deps.memory?.knowledgeCosineFloor !== undefined
      ? {
          fusion: { ...KNOWLEDGE_FUSION, cosineFloor: deps.memory.knowledgeCosineFloor },
          // The fake embedder's cosines are on another scale, so the band is off unless the test asks for one.
          band: deps.memory.knowledgeMeaningBand ?? 1,
        }
      : {}),
  });
  const eventSources = deps.eventsKey ? new EventSources(db, deps.eventsKey, () => clock.now()) : undefined;
  const triggerStore = new TriggerStore(store, catalog, eventSources);
  approvals.onTriggerAllow = (id, entry) => triggerStore.addAllow(id, entry);
  const skillStore = new SkillStore(store, { browser: !!deps.browserDriver && config.browser.mode !== "off" });
  const mcp = new McpService({
    store,
    approvals,
    clock,
    log,
    gatewayUrl: deps.mcp?.gatewayUrl ?? config.gatewayUrl,
    token: () => deps.standin.read(),
    fetchImpl: deps.fetchImpl,
  });
  const plugins = new PluginService(store, skillStore, mcp);
  const connectorTools = new ConnectorToolDirectory({ mcp, store, plugins });
  attachments.connectors = connectorTools;
  // One sandbox for the process; made at the first tree that has code mode on, closed on shutdown.
  const codemode = new CodemodeRuntime(config.codemode, log);
  const trees = new TreeManager({
    plugins,
    attachments,
    store,
    treeFiles: deps.treeFiles,
    openStorage: deps.openPiStorage,
    runtime,
    recorder,
    modelsConfig: deps.modelsConfig,
    clock,
    log,
    ...(config.gatewayUrl !== undefined ? { gatewayUrl: config.gatewayUrl } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    settings: {
      retry: config.retry,
      ...(config.restartLimit !== undefined ? { restartLimit: config.restartLimit } : {}),
      ...(config.partialIntervalMs !== undefined ? { partialIntervalMs: config.partialIntervalMs } : {}),
    },
    commitIntervalMs: config.commitIntervalMs,
    sessionHost,
    approvals,
    catalog,
    browser: browserRef,
    ...(deps.images ? { images: deps.images } : {}),
    memory,
    knowledge,
    demoTools: config.demoTools ?? config.mode === "faux",
    ...(deps.exec
      ? {
          exec: {
            backend: deps.exec,
            workspaces,
            egress,
            ...(config.exec.egressProxy !== undefined ? { proxy: config.exec.egressProxy } : {}),
          },
        }
      : {}),
    approvalTtlMs: config.approvalTtlMs,
    triggers: triggerStore,
    skills: skillStore,
    mcp: { service: mcp, directory: connectorTools },
    limits: { maxModelCallsPerRun: config.maxModelCallsPerRun, maxRunMs: config.maxRunMs },
    codemode,
    web: {
      egress,
      documents: webDocuments,
      networkDecisions: new NetworkDecisions(),
      searchUrl: deps.webTools?.searchUrl ?? config.gatewayUrl,
      searchToken: () => deps.standin.read(),
      fetchImpl: deps.fetchImpl,
      ...(deps.webTools?.readTimeoutMs !== undefined ? { readTimeoutMs: deps.webTools.readTimeoutMs } : {}),
    },
  });
  const adapter = new PiAdapter(
    store,
    trees,
    deps.treeFiles,
    deps.traceBlobs,
    clock,
    log,
    sessionHost,
    {
      idleCloseMs: config.idleCloseMs,
      tickMs: config.tickMs,
      maxSessionDepth: config.maxSessionDepth,
      maxActiveChildren: config.maxActiveChildren,
      deleteSettleMs: config.deleteSettleMs,
      surfaceFeedMs: config.surfaceFeedMs,
    },
    approvals,
    { approvalTtlMs: config.approvalTtlMs, oneTimeGrantTtlMs: config.oneTimeGrantTtlMs },
    workspaces,
    attachments,
    new SkillPreparer({ skills: skillStore, plugins, workspaces }),
  );
  // Triggers: the runner starts and ends runs through the adapter, and hears when a run of a trigger ends.
  const triggerRunner = new TriggerRunner({
    store: triggerStore,
    app: store,
    host: {
      treeCreated: (treeId) => adapter.createTreeFolder(treeId),
      kick: (id) => adapter.kick(id),
      noteInHome: (id, requestId, text, trigger) => adapter.noteInHome(id, requestId, text, trigger),
    },
    skills: skillStore,
    clock,
    log,
  });
  store.onTriggerRunFinished = (triggerRunId) => triggerRunner.onRunFinished(triggerRunId);
  const triggerScheduler = new TriggerScheduler(triggerStore, triggerRunner, clock, log);
  // The browser: built once the trees and the adapter exist. Its tools are installed per tree as the trees open.
  let browser: ControlPlane["browser"];
  if (deps.browserDriver && config.browser.mode !== "off") {
    const service = new BrowserService({
      driver: deps.browserDriver,
      store,
      approvals,
      takeovers: takeoverStore,
      clock,
      log,
      config: {
        ...(config.browser.maxWindows !== undefined ? { maxWindows: config.browser.maxWindows } : {}),
        ...(config.browser.idleMs !== undefined ? { idleMs: config.browser.idleMs } : {}),
        ...(config.browser.busyWaitMs !== undefined
          ? { busyWaitMs: config.browser.busyWaitMs, busyPollMs: Math.min(1_000, config.browser.busyWaitMs) }
          : {}),
      },
    });
    const takeovers = new TakeoverService({
      store,
      takeovers: takeoverStore,
      browser: service,
      trees,
      kick: (id) => adapter.kick(id),
      clock,
      log,
      ...(config.browser.takeoverIdleMs !== undefined ? { config: { idleMs: config.browser.takeoverIdleMs } } : {}),
    });
    const live = new LiveHub({ driver: deps.browserDriver, browser: service, takeovers });
    service.watched = (sessionId) => live.viewerCount(sessionId) > 0;
    browserRef.current = { browser: service, takeovers };
    // The proxy lets the browser out only while someone is using it.
    egress.setBrowserGate(() => service.inUse());
    adapter.onSessionsDeleting = (ids) => {
      takeovers.cancelForSessions(ids);
      for (const id of ids) void service.closeSession(id);
    };
    browser = { service, takeovers, live };
  }
  const notifications = new NotificationService({
    fcmEnabled: config.fcmEnabled === true,
    store,
    clock,
    log,
    gatewayUrl: config.gatewayUrl,
    token: () => deps.standin.read(),
    fetchImpl: deps.fetchImpl,
    tickMs: Math.min(config.tickMs, 15_000),
  });
  const background = new BackgroundTaskService(store);
  const memoryMaintenance = new BackgroundMemoryReview({
    store,
    lines: memory.lines,
    runtime,
    recorder,
    background,
    snapshots: deps.privateSnapshots,
    openStorage: deps.openPiStorage,
    blobs: deps.traceBlobs,
    policy: (authorize) =>
      createPolicyExtension({
        treeId: "background",
        store,
        approvals,
        catalog,
        log,
        approvalTtlMs: config.approvalTtlMs,
        internalExecution: { authorize },
      }),
    gatewayUrl: config.gatewayUrl,
    fetchImpl: deps.fetchImpl,
  });
  const titles = new TitleService({
    store,
    runtime,
    recorder,
    modelsConfig: deps.modelsConfig,
    background,
    clock,
    log,
    gatewayUrl: config.gatewayUrl,
    fetchImpl: deps.fetchImpl,
  });
  // A new agent is written by the chat-titles model (Settings), else the fast default.
  const designer = new AgentDesigner({
    runtime,
    recorder,
    clock,
    log,
    gatewayUrl: config.gatewayUrl,
    fetchImpl: deps.fetchImpl,
    model: async () => {
      const settings = await titles.settings();
      return settings.model ?? settings.default;
    },
  });
  const modelCatalog = new ModelCatalog({ store, modelsConfig: deps.modelsConfig, runtime });
  let knowledgeSweep: ReturnType<typeof setInterval> | undefined;
  const eventReceiver = eventSources
    ? new EventReceiver({
        db,
        sources: eventSources,
        now: () => clock.now(),
        log,
        onAccepted: (event) => triggerScheduler.onEvent(event),
        afterAccepted: () => triggerScheduler.tick(),
      })
    : undefined;
  const backup = new BackupService({
    store,
    db,
    clock,
    log,
    repositoryDir: deps.backup?.repositoryDir,
    stagingDir: deps.backup?.stagingDir,
    dataDir: deps.backup?.dataDir ?? "/data",
    ...(deps.backup?.extraSkip ? { extraSkip: deps.backup.extraSkip } : {}),
    objects: deps.fileObjects,
    ...(config.gatewayUrl
      ? { gatewayState: () => gatewayBackupState(config.gatewayUrl!, () => deps.standin.read(), deps.fetchImpl) }
      : {}),
    secrets: deps.eventsKey ? new SecretBox(deps.eventsKey) : undefined,
    appVersion: deps.backup?.appVersion ?? "unknown",
    host: "rei",
    timeZone: () => savedTimeZone(store) ?? processZone(),
    restic:
      deps.backup?.restic ??
      (() => {
        throw new Error("restic is not available.");
      }),
    bundle:
      deps.backup?.bundle ??
      (() => {
        throw new Error("This host cannot write backups.");
      }),
    folder: deps.backup?.folder ?? { exists: () => false, bytes: () => null },
    ...(deps.backup?.tickMs ? { tickMs: deps.backup.tickMs } : {}),
  });
  const app = createApp({
    backup,
    ...(eventReceiver ? { events: eventReceiver } : {}),
    ...(eventSources ? { eventSources } : {}),
    plugins,
    attachments,
    auth,
    notifications,
    titles,
    memoryExtraction: memoryMaintenance,
    background,
    behavior: {
      defaults: behaviorDefaults,
      onChange: (s) => {
        runtime.setOutputCap(s.generation.maxOutputTokens);
        runtime.setNativeSearch(s.search.useOpenAiNativeSearch);
        // Open trees install or drop the codemode tool between model requests.
        trees.syncCodemode();
      },
    },
    designer,
    modelCatalog,
    mcp,
    providers,
    store,
    adapter,
    clock,
    log,
    memory,
    knowledge,
    triggers: { store: triggerStore, scheduler: triggerScheduler, catalog },
    skills: skillStore,
    traceBlobs: deps.traceBlobs,
    storage: { registry, maintenance: storage, objects: deps.fileObjects },
    cookieSecure: config.cookieSecure,
    publicUrl: config.publicUrl,
    androidPasskeyOrigins: config.androidPasskeyOrigins,
    ...(deps.web ? { web: deps.web } : {}),
    ...(browser ? { browser: { service: browser.service, takeovers: browser.takeovers } } : {}),
    ...(config.ssePingMs ? { ssePingMs: config.ssePingMs } : {}),
    ...(config.checkContract ? { checkContract: true } : {}),
  });

  return {
    plugins,
    app,
    store,
    approvals,
    auth,
    adapter,
    egress,
    workspaces,
    browser,
    memory,
    knowledge,
    memoryMaintenance,
    background,
    storage: { registry, maintenance: storage, objects: deps.fileObjects },
    retrieval: deps.retrieval,
    triggers: { store: triggerStore, scheduler: triggerScheduler, runner: triggerRunner },
    events: eventSources && eventReceiver ? { sources: eventSources, receiver: eventReceiver } : undefined,
    backup,
    skills: skillStore,
    notifications,
    mcp,
    connectorTools,
    catalog,
    codemode,
    async start() {
      for (const pending of db.all<{ plugin_id: string }>(
        "SELECT DISTINCT plugin_id FROM plugin_connections WHERE status <> 'ready' UNION SELECT plugin_id FROM plugin_retired_connections",
      )) {
        void plugins.reconcile(pending.plugin_id).catch(() => log.warn("plugin.reconcile_failed"));
      }
      const seeded = store.seedDefaultAgent();
      if (seeded.created) log.info("agent.seeded", { agentId: seeded.agent.id, sessionId: seeded.session.id });
      const code = auth.prepareSetupCode();
      if (code) deps.announceSetupCode(code);
      await deps.egressListener?.start((request) => egress.decide(request));
      memory.start();
      knowledge.ensureInbox();
      if (knowledge.indexLooksEmpty()) knowledge.reindexAll();
      knowledge.meaning?.start();
      const purgeKnowledge = () => {
        try {
          knowledge.purgeExpired();
        } catch {
          log.warn("knowledge.purge_failed");
        }
      };
      purgeKnowledge();
      try {
        webDocuments.purgeExpired();
      } catch {
        log.warn("web.purge_failed");
      }
      knowledgeSweep = setInterval(purgeKnowledge, 6 * 3_600_000);
      knowledgeSweep.unref?.();
      titles.start();
      await memoryMaintenance.start();
      await adapter.start();
      background.start();
      if (browser) {
        browser.service.start();
        await browser.takeovers.boot();
      }
      // After the trees are recovered: the first tick catches up on triggers missed while the process was down.
      triggerScheduler.start();
      notifications.start();
      backup.begin();
      log.info("control_plane.started", { mode: config.mode, exec: config.exec.mode, browser: config.browser.mode });
    },
    async stop() {
      await deps.egressListener?.stop();
      triggerScheduler.stop();
      await backup.end();
      if (knowledgeSweep) clearInterval(knowledgeSweep);
      knowledge.meaning?.stop();
      await notifications.stop();
      await memoryMaintenance.stop();
      await background.stop();
      await titles.stop();
      browser?.takeovers.stop();
      await adapter.stop();
      await codemode.close();
      await recorder.drain();
      memory.stop();
      await browser?.service.stop();
      await deps.exec?.close();
      await plugins.drain();
    },
  };
}
