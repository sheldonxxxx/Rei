import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  CommitChange,
  CommitObservation,
  Conversation,
  ConversationId,
  Extension,
  LiveState,
  ModelRef,
  RegistryReader,
} from "@earendil-works/pi-durable";
import {
  CompactionTask,
  createRegistry,
  defineExtension,
  Harness,
  hook,
  LiveDoc,
  ProviderDoc,
} from "@earendil-works/pi-durable";
import { createFitImagesExtension } from "@earendil-works/pi-durable/images/fit";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { AgentCapabilities } from "@rei/protocol";
import type { AttachmentService } from "../attachments/service.ts";
import type { BrowserService } from "../browser/service.ts";
import type { TakeoverService } from "../browser/takeover-service.ts";
import { createBrowserExtension } from "../browser/tools.ts";
import { agentAllowsTool, capabilityDroppedExtensions } from "../capabilities/agent-access.ts";
import { createCapabilitiesExtension } from "../capabilities/extension.ts";
import { ToolGroups } from "../capabilities/groups.ts";
import { COMMANDS_KIND, CommandsDoc, type Ledger } from "../conversation/ledger.ts";
import { SessionSync } from "../conversation/sync.ts";
import type { ExecBackend } from "../exec/backend.ts";
import type { EgressService } from "../exec/egress.ts";
import { createExecExtension } from "../exec/tools.ts";
import type { WorkspaceManager } from "../exec/workspaces.ts";
import { createImageExtension } from "../images/tools.ts";
import type { ImageWorker } from "../images/worker.ts";
import type { KnowledgeService } from "../knowledge/service.ts";
import { createKnowledgeExtension, createKnowledgeWriteExtension } from "../knowledge/tools.ts";
import { createLibraryExtension, createLibraryWriteExtension } from "../library/tools.ts";
import { type ConnectorToolDirectory, createConnectorToolsExtension } from "../mcp/connector-tools.ts";
import type { McpService } from "../mcp/service.ts";
import type { MemoryService } from "../memory/service.ts";
import { createHistoryExtension, createMemoryExtension, createMemoryWriteExtension } from "../memory/tools.ts";
import type { PluginService } from "../plugins/service.ts";
import { createPluginsExtension } from "../plugins/tools.ts";
import { canonicalJson } from "../policy/decision.ts";
import type { SkillStore } from "../skills/store.ts";
import { createSkillsExtension } from "../skills/tools.ts";
import type { ApprovalStore } from "../store/approvals.ts";
import { GLOBAL_STREAM } from "../store/events.ts";
import { runWaitTime } from "../store/run-waits.ts";
import type { AppStore, SessionRow } from "../store/store.ts";
import { createSurfaceExtension } from "../surfaces/tools.ts";
import type { TriggerStore } from "../triggers/store.ts";
import { createTriggerRunExtension, createTriggersExtension } from "../triggers/tools.ts";
import type { Clock } from "../util/clock.ts";
import { classifyError, type Logger } from "../util/log.ts";
import { createWebExtension, type WebToolsDeps } from "../web/tools.ts";
import { type BehaviorDefaults, behaviorSettings, defaultBehavior } from "./behavior-settings.ts";
import { createChatContextExtension } from "./chat-context.ts";
import { createChatFormatExtension } from "./chat-format.ts";
import { createClockExtension } from "./clock-context.ts";
import type { CodemodeRuntime } from "./codemode.ts";
import { compactionSettings } from "./context-settings.ts";
import { createDemoExtension } from "./demo-tools.ts";
import { createGuard, type Guard } from "./guard.ts";
import {
  enqueueHomeCompaction,
  HOME_COMPACTION_FOCUS,
  HomeBudgetCompactionDoc,
  HomeIdleCompactionDoc,
  hasIdleCompactionWork,
  IDLE_COMPACTION_FOCUS,
  latestHumanRun,
} from "./home-compaction.ts";
import { homeContextConfig, homeMessages } from "./home-context.ts";
import { instrumentModels } from "./instrument.ts";
import {
  DEFAULT_DEADLINES,
  type Deadlines,
  type ModelsConfigSource,
  modelFor,
  parseModelsConfig,
} from "./model-config.ts";
import type { ModelRuntime } from "./models.ts";
import { createPolicyExtension, type ToolCatalog } from "./policy-ext.ts";
import { createRecallRouterExtension } from "./recall-router.ts";
import {
  createHomeEventsExtension,
  createSessionExtension,
  createSessionRoleExtension,
  type SessionHostRef,
} from "./session-tools.ts";
import { RunPins } from "./stable-prefix.ts";
import type { StepRecorder } from "./steps.ts";
import type { TreeFiles } from "./tree-files.ts";
import type { PiStorageOpener } from "./types.ts";
import { createUntrustedContentExtension } from "./untrusted-content.ts";
import { createUntrustedOutputExtension } from "./untrusted-output.ts";

export const context = BACKGROUND_CONTEXT;
/** Global events after which the connector tools an agent may use can differ. */
const CONNECTOR_EVENTS = new Set(["plugins.changed", "agent.upserted", "agent.removed"]);

export interface TreeSettings {
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number };
  restartLimit?: number;
  partialIntervalMs?: number;
}

export interface TreeManagerDeps {
  attachments?: AttachmentService;
  images?: ImageWorker;
  store: AppStore;
  treeFiles: TreeFiles;
  openStorage: PiStorageOpener;
  runtime: ModelRuntime;
  recorder: StepRecorder;
  modelsConfig: ModelsConfigSource;
  clock: Clock;
  log: Logger;
  /** Set in gateway mode. */
  gatewayUrl?: string;
  fetchImpl?: typeof fetch;
  settings: TreeSettings;
  commitIntervalMs: number;
  /** The session tools call back into the control plane through this; the adapter fills it in. */
  sessionHost: SessionHostRef;
  approvals: ApprovalStore;
  catalog: ToolCatalog;
  /** Installs the demo connector (default on in faux mode, off in gateway mode). */
  demoTools: boolean;
  /** The sandbox tools (read, write, edit, bash); absent when execution is off. `proxy` is the egress proxy as the sandbox reaches it. */
  exec?: { backend: ExecBackend; workspaces?: WorkspaceManager; egress: EgressService; proxy?: string };
  /** The browser tools; not installed when it is off. */
  browser?: BrowserRef;
  /** How long a pending approval lives. */
  approvalTtlMs: number;
  /** Per-run limits on model calls; a run over either is refused its next call. */
  limits: RunLimits;
  /** Memory: profile docs, history search and the digest; its extension is installed in every tree. */
  memory?: MemoryService;
  /** Knowledge: its tools and prompt pointer are installed in every tree. */
  knowledge?: KnowledgeService;
  /** The web tools (always installed): what they need besides the tree's own store and catalog. */
  web: Omit<WebToolsDeps, "treeId" | "store" | "approvals" | "catalog" | "log">;
  /** Triggers and skills: their extensions are installed in every tree. */
  triggers?: TriggerStore;
  skills?: SkillStore;
  plugins?: PluginService;
  /** MCP connectors: each tree registers its agents' connector tools as deferred tools, under the directory's names. */
  mcp?: { service: McpService; directory: ConnectorToolDirectory };
  /** Code mode's sandbox. Each tree installs the `codemode` tool only while the Runtime setting is on. */
  codemode?: CodemodeRuntime;
}

/** The browser's services, filled in once the control plane has built them (the takeover service needs the trees, the tools need the takeover service). */
export interface BrowserRef {
  current: { browser: BrowserService; takeovers: TakeoverService } | undefined;
}

export interface RunLimits {
  maxModelCallsPerRun: number;
  maxRunMs: number;
}

/** One session of an open tree: its Pi conversation and the sync that keeps Rei's runs in step with it. */
export class TreeSession {
  readonly sessionId: string;
  readonly conv: Conversation;
  readonly sync: SessionSync;
  readonly home: boolean;
  providerSessionId: string | undefined;

  constructor(sessionId: string, conv: Conversation, sync: SessionSync, home: boolean) {
    this.sessionId = sessionId;
    this.conv = conv;
    this.sync = sync;
    this.home = home;
  }

  /** Resolves once every stored publication queued so far was handled. */
  drained(): Promise<void> {
    return this.sync.drained();
  }
}

/**
 * The extensions a conversation of this origin does not select: the session tools belong to the home chat only, and
 * report with the trigger-run note to the runs of a trigger only.
 */
export function droppedExtensions(origin: string | undefined, capabilities?: AgentCapabilities): string[] {
  const drop = [
    ...(origin === "home" ? [] : ["sessions", "home_events"]),
    ...(origin === "trigger" ? [] : ["trigger_run"]),
    ...(capabilities ? capabilityDroppedExtensions(capabilities) : []),
  ];
  return [...new Set(drop)];
}

export interface ExtensionDrift {
  /** What the conversation should select, in install order. */
  want: string[];
  /** Installed extensions it should select but does not. */
  added: string[];
  /** Extensions it selects but should not. */
  removed: string[];
  /** Whether the selection differs from `want` at all (members or order). */
  changed: boolean;
}

/**
 * How a conversation's resolved extension selection differs from what a conversation of its origin and agent selects:
 * every extension installed in the tree, in install order, minus `droppedExtensions(origin, capabilities)`.
 */
export function extensionDrift(
  installed: readonly string[],
  selected: readonly string[],
  origin: string | undefined,
  capabilities?: AgentCapabilities,
): ExtensionDrift {
  const drop = new Set(droppedExtensions(origin, capabilities));
  const want = installed.filter((name) => !drop.has(name));
  const added = want.filter((name) => !selected.includes(name));
  const removed = selected.filter((name) => !want.includes(name));
  const changed = want.length !== selected.length || want.some((name, i) => selected[i] !== name);
  return { want, added, removed, changed };
}

/** One session tree held open: its Harness and the sessions in it (the first one, and the forks made from it). */
export class OpenTree {
  readonly id: string;
  readonly harness: Harness;
  readonly sessions = new Map<string, TreeSession>();
  /** Pi's provider session id of each conversation (it comes with every model call) to the session it belongs to. */
  readonly providerSessions = new Map<string, string>();
  readonly guard: Guard;
  /** The tree's extensions, as installed (the policy last). */
  readonly registry: RegistryReader;
  /** Stored commits of the tree's store, routed to the session whose conversation they belong to. */
  commits: CommitObservation | undefined;
  lastActivity: number;
  deadlines: Deadlines = { ...DEFAULT_DEADLINES };
  /** Serializes dispatch, cancel and fork for this tree. */
  chain: Promise<unknown> = Promise.resolve();

  constructor(id: string, harness: Harness, guard: Guard, registry: RegistryReader, now: number) {
    this.id = id;
    this.harness = harness;
    this.guard = guard;
    this.registry = registry;
    this.lastActivity = now;
  }

  session(sessionId: string): TreeSession | undefined {
    return this.sessions.get(sessionId);
  }

  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** Opens session trees on demand, keeps them open while they have work, and closes idle ones. */
export class TreeManager {
  readonly #d: TreeManagerDeps;
  readonly #open = new Map<string, Promise<OpenTree>>();
  readonly #ready = new Map<string, OpenTree>();
  /** Keeps each run's model calls on one prefix (home window start, mid-run section updates). */
  readonly #pins = new RunPins();
  /** Each open tree's connector tool registration, replaced in place when what its agents may use changes. */
  readonly #connectorSlots = new Map<string, () => void>();
  /** Each open tree's code mode switch: installs or removes the `codemode` tool to match the setting. */
  readonly #codemodeSlots = new Map<string, () => void>();
  /** Last aligned capabilities snapshot per open session, so live Agent Settings edits realign on the next call. */
  readonly #alignedCaps = new Map<string, string>();
  /** Prepares the images tools return (one Photon worker for every tree; it exits when idle). Made at the first tree. */
  #images: ReturnType<typeof createNodePhotonImages> | undefined;
  #imageProcessor(): ReturnType<typeof createNodePhotonImages> {
    this.#images ??= createNodePhotonImages();
    return this.#images;
  }
  #syncing: Promise<void> | undefined;
  #syncAgain = false;
  #idleHomeCheck: Promise<void> | undefined;
  // The ledger and the attempt are durable in Pi. Keep only a scheduling hint so closed trees stay closed until due.
  readonly #idleHome = new Map<
    string,
    {
      conversationId: ConversationId;
      human: ReturnType<typeof latestHumanRun>;
      checked: boolean;
    }
  >();

  constructor(deps: TreeManagerDeps) {
    this.#d = deps;
    if (deps.mcp) {
      deps.mcp.service.onChange(() => void this.syncConnectors());
      deps.store.events.subscribe(GLOBAL_STREAM, (event) => {
        if (CONNECTOR_EVENTS.has(event.type)) void this.syncConnectors();
      });
    }
  }

  /**
   * Re-reads the connectors and re-registers the connector tools of every open tree whose set changed: install, remove
   * or replace, in place (Pi's `registry.install`), so it lands between model requests and no tree reopens. Calls that
   * arrive while one runs are folded into one more pass.
   */
  /**
   * A "capabilities changed" Trace step on each running run of the tree, listing the connector tools that came, went or
   * changed for that session's agent. A session with no running run sees the change in its next model call's tools.
   */
  #traceCapabilityChange(
    sessions: readonly { id: string; agent_id: string }[],
    before: ReadonlyMap<string, { connectorId: string; connectorName: string; definition: string }>,
    after: ReadonlyMap<string, { connectorId: string; connectorName: string; definition: string }>,
    directory: ConnectorToolDirectory,
  ): void {
    for (const session of sessions) {
      const run = this.#d.store.runningRun(session.id);
      if (!run) continue;
      const mine = (m: typeof before) =>
        new Map([...m].filter(([, e]) => directory.allowed(session.agent_id, e.connectorId)));
      const had = mine(before);
      const has = mine(after);
      const added = [...has.keys()].filter((n) => !had.has(n));
      const removed = [...had.keys()].filter((n) => !has.has(n));
      const changed = [...has]
        .filter(([n, e]) => had.has(n) && had.get(n)!.definition !== e.definition)
        .map(([n]) => n);
      if (added.length + removed.length + changed.length === 0) continue;
      const connectors = [
        ...new Set(
          [...added, ...changed]
            .map((n) => has.get(n)!.connectorName)
            .concat(removed.map((n) => had.get(n)!.connectorName)),
        ),
      ].sort();
      this.#d.recorder
        .recordCapabilityChange({
          sessionId: session.id,
          runId: run.id,
          change: { connectors, added, removed, changed },
        })
        .catch(() => this.#d.log.warn("trace.capability_change_failed", { sessionId: session.id }));
    }
  }

  syncConnectors(): Promise<void> {
    const mcp = this.#d.mcp;
    // Nothing to re-register while no tree is open; the next tree reads the connectors when it opens.
    if (!mcp || this.#connectorSlots.size === 0) return Promise.resolve();
    if (this.#syncing) {
      this.#syncAgain = true;
      return this.#syncing;
    }
    this.#syncing = (async () => {
      do {
        this.#syncAgain = false;
        await mcp.directory.refresh();
        for (const [treeId, sync] of this.#connectorSlots) if (this.#ready.has(treeId)) sync();
      } while (this.#syncAgain);
    })()
      .catch((error) => {
        this.#d.log.warn("connectors.sync_failed", { error: error instanceof Error ? error.name : "error" });
      })
      .finally(() => {
        this.#syncing = undefined;
      });
    return this.#syncing;
  }

  /** Makes every open tree match the Code mode setting. Nothing changes in a tree whose state already matches. */
  syncCodemode(): void {
    for (const [treeId, sync] of this.#codemodeSlots) if (this.#ready.has(treeId)) sync();
  }

  openIds(): string[] {
    return [...this.#ready.keys()];
  }
  get(treeId: string): OpenTree | undefined {
    return this.#ready.get(treeId);
  }
  all(): OpenTree[] {
    return [...this.#ready.values()];
  }

  open(treeId: string): Promise<OpenTree> {
    let pending = this.#open.get(treeId);
    if (!pending) {
      pending = this.#openNow(treeId).then(
        (tree) => {
          this.#ready.set(treeId, tree);
          return tree;
        },
        (error) => {
          this.#open.delete(treeId);
          throw error;
        },
      );
      this.#open.set(treeId, pending);
    }
    return pending;
  }

  async #openNow(treeId: string): Promise<OpenTree> {
    const d = this.#d;
    const row = d.store.treeRow(treeId);
    if (!row || row.state !== "live") throw new Error(`tree ${treeId} is not a live tree`);
    const rows = d.store.treeSessions(treeId);
    if (rows.length === 0) throw new Error(`tree ${treeId} has no live session`);
    await d.runtime.ensureProviders?.();
    if (!d.treeFiles.exists(treeId)) d.treeFiles.create(treeId);
    d.treeFiles.cleanStrays(treeId);

    const holder: { tree?: OpenTree } = {};
    // Each extension's tools are one tool group; the deferred groups' tools are registered `deferred`, so the model is
    // offered them only once search_capabilities loads the group.
    const groups = new ToolGroups();
    const deferred = (name: string) =>
      groups.isDeferred(name) || d.mcp?.directory.registered(treeId, name) !== undefined;
    const models = instrumentModels(d.runtime.models, {
      recorder: d.recorder,
      resolveCall: (options, completion) => {
        const tree = holder.tree;
        const fromProvider =
          typeof options.sessionId === "string" ? tree?.providerSessions.get(options.sessionId) : undefined;
        // The provider session id says which conversation is calling; without it, the session that has a run going.
        const sessionId =
          fromProvider ??
          [...(tree?.sessions.keys() ?? [])].find((id) =>
            d.store.nonTerminalRuns(id).some((r) => r.status === "running"),
          ) ??
          rows[0]!.id;
        const run = completion ? undefined : d.store.runningRun(sessionId);
        const session = d.store.getSessionRow(sessionId);
        // Only a direct user input in a user-facing session is chat. Reports/notices/agent messages are automated work.
        const chat =
          run?.direct === 1 &&
          !run.assigned_by &&
          !run.trigger_run_id &&
          run.role === "user" &&
          (session?.origin === "home" ||
            session?.origin === "user" ||
            session?.origin === "fork" ||
            session?.origin === "import");
        return {
          sessionId,
          runId: run?.id,
          agentId: session?.agent_id,
          purpose: chat ? "chat" : run ? "agent_task" : "other",
          deadlines: tree?.deadlines ?? DEFAULT_DEADLINES,
          deferred,
        };
      },
      prepareMessages: (info, messages, other, window, midConversationSystem) => {
        const { runId, sessionId } = info;
        const ts = sessionId ? holder.tree?.session(sessionId) : undefined;
        return homeMessages(
          d.store,
          sessionId,
          runId,
          runId && !midConversationSystem && Array.isArray(messages)
            ? this.#pins.deferSectionUpdates(runId, messages)
            : messages,
          other,
          window,
          this.#pins,
          {
            midConversationSystem: midConversationSystem === true,
            ...(ts?.home && runId ? { compact: () => this.#checkHomeBudget(ts, true) } : {}),
          },
        );
      },
      refuse: (info) => this.loopGuard(info.runId),
      ...(d.gatewayUrl !== undefined ? { gatewayUrl: d.gatewayUrl } : {}),
      ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
      syntheticPayload: d.runtime.mode === "faux",
      beforeCall: () => d.runtime.arm(),
      scrub: (text) => d.runtime.scrub(text),
      nativeSearch: (info) =>
        d.runtime.nativeSearch() && (info.agentId ? d.store.agentCapabilities(info.agentId).web : true),
    });

    const registry = createRegistry();
    const install = (extension: Extension) => registry.install(groups.mark(extension));
    const execBackend = d.exec?.workspaces?.forTree(treeId) ?? d.exec?.backend;
    install(createClockExtension(d.store));
    install(createSessionRoleExtension(treeId, d.store));
    install(createChatContextExtension(treeId, d.store, d.catalog));
    install(
      defineExtension({
        name: "home_compaction",
        hooks: [
          hook(CompactionTask, {
            async beforeCompact(compaction, api) {
              if (![HOME_COMPACTION_FOCUS, IDLE_COMPACTION_FOCUS].includes(compaction.instructions ?? "")) return;
              const conv = [...(holder.tree?.sessions.values() ?? [])].find(
                (ts) => ts.conv.id === api.conversationId,
              )?.conv;
              if (!conv) return { decline: true };
              // A background summary can be selected after tools have started. Keep the entire in-flight run.
              const first = await conv.commit(async (tx) => (await tx.doc(LiveDoc, conv.id)).run?.first, context);
              if (first !== undefined && compaction.firstKept > first) return { decline: true };
            },
          }),
        ],
      }),
    );
    install(createChatFormatExtension());
    install(createUntrustedContentExtension());
    // Every tool result's images are fitted to the model's limits before they are stored. Before the policy, whose
    // hook records the Trace step: the Trace holds what the model got, not what the tool sent.
    install(createFitImagesExtension(await this.#imageProcessor()));
    // Code mode: a script's output is fenced when it read outside content. Before the policy, for the same reason.
    install(createUntrustedOutputExtension(d.catalog));
    install(createSessionExtension(treeId, d.store, d.sessionHost, d.catalog));
    install(createHomeEventsExtension(treeId, d.store, d.catalog));
    if (d.demoTools) install(createDemoExtension(treeId, d.store, d.approvals, d.catalog));
    if (d.exec && execBackend)
      install(
        createExecExtension({
          treeId,
          store: d.store,
          backend: execBackend,
          egress: d.exec.egress,
          catalog: d.catalog,
          proxy: d.exec.proxy,
        }),
      );
    const browser = d.browser?.current;
    if (browser)
      install(
        createBrowserExtension({
          treeId,
          store: d.store,
          catalog: d.catalog,
          log: d.log,
          browser: browser.browser,
          takeovers: browser.takeovers,
          library: d.attachments?.library,
          workspaces: d.attachments?.workspaces,
        }),
      );
    install(
      createWebExtension({ treeId, store: d.store, approvals: d.approvals, catalog: d.catalog, log: d.log, ...d.web }),
    );
    if (d.memory) {
      install(createMemoryExtension({ treeId, store: d.store, memory: d.memory, catalog: d.catalog }));
      install(createMemoryWriteExtension({ treeId, store: d.store, memory: d.memory, catalog: d.catalog }));
      install(createHistoryExtension({ treeId, store: d.store, memory: d.memory, catalog: d.catalog }));
    }
    if (d.mcp) {
      const { service, directory } = d.mcp;
      await directory.refresh();
      let registered: string | undefined;
      let definitions: Map<string, { connectorId: string; connectorName: string; definition: string }> | undefined;
      // Not a tool group: installed as it is, so search loads connector tools one by one.
      const sync = () => {
        const sessions = d.store.treeSessions(treeId);
        const entries = directory.register(treeId, [...new Set(sessions.map((r) => r.agent_id))]);
        const signature = canonicalJson(entries.map((e) => [e.name, e.tool]));
        if (signature === registered) return;
        registered = signature;
        const before = definitions;
        definitions = new Map(
          entries.map((e) => [
            e.name,
            { connectorId: e.connectorId, connectorName: e.connectorName, definition: canonicalJson(e.tool) },
          ]),
        );
        if (before) this.#traceCapabilityChange(sessions, before, definitions, directory);
        registry.install(
          createConnectorToolsExtension({
            treeId,
            store: d.store,
            mcp: service,
            catalog: d.catalog,
            directory,
            library: d.attachments?.library,
            entries,
          }),
        );
      };
      sync();
      this.#connectorSlots.set(treeId, sync);
    }
    if (d.attachments?.library) {
      install(createLibraryExtension(treeId, d.attachments.library, d.catalog));
      install(createLibraryWriteExtension(treeId, d.attachments.library, d.catalog));
    }
    if (d.images && d.attachments) install(createImageExtension(treeId, d.attachments, d.catalog, d.images));
    if (d.knowledge) {
      install(createKnowledgeExtension({ treeId, store: d.store, knowledge: d.knowledge, catalog: d.catalog }));
      install(createKnowledgeWriteExtension({ treeId, store: d.store, knowledge: d.knowledge, catalog: d.catalog }));
    }
    install(createSurfaceExtension({ treeId, store: d.store, catalog: d.catalog, now: () => d.clock.now() }));
    if (d.plugins) install(createPluginsExtension({ treeId, store: d.store, plugins: d.plugins, catalog: d.catalog }));
    if (d.skills) install(createSkillsExtension({ treeId, store: d.store, skills: d.skills, catalog: d.catalog }));
    if (d.triggers && d.skills)
      install(
        createTriggersExtension({ treeId, store: d.store, triggers: d.triggers, catalog: d.catalog, skills: d.skills }),
      );
    // report and the trigger-run note: only conversations of trigger runs keep this extension (see attachSession).
    if (d.triggers)
      install(createTriggerRunExtension({ treeId, store: d.store, triggers: d.triggers, catalog: d.catalog }));
    install(
      createCapabilitiesExtension({
        treeId,
        store: d.store,
        catalog: d.catalog,
        groups,
        ...(d.skills ? { skills: d.skills } : {}),
        ...(d.plugins ? { plugins: d.plugins } : {}),
        ...(d.mcp ? { connectors: d.mcp.directory } : {}),
      }),
    );
    // After the memory and Knowledge notes: where things go, and the check before the final answer.
    install(
      createRecallRouterExtension({
        treeId,
        store: d.store,
        memory: Boolean(d.memory),
        knowledge: Boolean(d.knowledge),
      }),
    );
    // Code mode, when its setting is on: the tool and its prompt section. Here so the policy declaration is in the
    // catalog before the policy runs. Turning the setting on or off later installs or removes it in place (Pi's
    // registry publishes between model requests); a tree whose state already matches is left alone, so the prompt
    // cache holds. Off, the tree has no trace of it.
    if (d.codemode) {
      const codemode = d.codemode;
      let extension: Extension | undefined;
      let on = false;
      const sync = () => {
        const want = behaviorSettings(d.store, this.#defaults()).codeMode.enabled;
        if (want === on) return;
        if (want) {
          extension ??= codemode.extension(d.catalog, {
            // A tree registers the connector tools of every agent in it; a script sees only its own agent's, as
            // search_capabilities does.
            visible: (conversationId, name) => {
              const session = d.store.sessionByConversation(treeId, String(conversationId));
              if (session && !agentAllowsTool(d.store.agentCapabilities(session.agent_id), name)) return false;
              const connectors = d.mcp?.directory;
              if (!connectors?.info(name)) return true;
              return !!session && connectors.visibleTo(name, session.agent_id);
            },
          });
          install(extension);
        } else if (extension) registry.uninstall(extension);
        on = want;
        d.log.info("codemode.tree_synced", { treeId, enabled: want });
      };
      sync();
      this.#codemodeSlots.set(treeId, sync);
    }
    // Last, so its hook sees the arguments every other hook settled on (and every conversation selects it by default).
    const policy = createPolicyExtension({
      treeId,
      store: d.store,
      approvals: d.approvals,
      catalog: d.catalog,
      log: d.log,
      approvalTtlMs: d.approvalTtlMs,
      recorder: d.recorder,
      ...(d.triggers ? { triggerAllow: (id) => d.triggers!.allowOf(id) } : {}),
    });
    install(policy);
    const guard = createGuard(policy);
    const storage = await d.openStorage(d.treeFiles.dbPath(treeId));
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        // Built at each model call and tool use, so it does no I/O; the tools check the sandbox before they run.
        ...(execBackend ? { env: () => execBackend.env(treeId) } : {}),
        // A function, so edits in Settings > Context reach conversations that are already open at their next model call.
        settings: () => ({
          compaction: compactionSettings(d.store),
          retry: this.#retry(),
          afterFailedRun: "continue",
          ...(d.settings.restartLimit !== undefined ? { restartLimit: d.settings.restartLimit } : {}),
          ...(d.settings.partialIntervalMs !== undefined
            ? { progress: { partialIntervalMs: d.settings.partialIntervalMs } }
            : {}),
        }),
        onReport: (report) => {
          const error = "error" in report ? report.error : undefined;
          d.log.warn("pi.report", { treeId, kind: report.kind, error: error instanceof Error ? error.name : "error" });
        },
      },
      context,
    );
    try {
      const config = parseModelsConfig(await d.modelsConfig.read().catch(() => undefined));
      const tree = new OpenTree(treeId, harness, guard, registry, d.clock.now());
      tree.deadlines = config.standard.deadlines;
      holder.tree = tree;
      tree.commits = harness.observeCommits({
        advance: (publication) => {
          const bySession = new Map<TreeSession, CommitChange[]>();
          for (const change of publication.changes) {
            const conversationId = changeConversation(change);
            if (conversationId === undefined) continue;
            const ts = [...tree.sessions.values()].find((s) => s.conv.id === conversationId);
            if (!ts) continue;
            const list = bySession.get(ts) ?? [];
            list.push(change);
            bySession.set(ts, list);
          }
          for (const [ts, changes] of bySession) {
            for (const change of changes) {
              if (change.type === "document" && change.kind === "change" && change.record.kind === COMMANDS_KIND)
                this.#noteHomeActivity(ts, change.value as unknown as Ledger);
            }
            ts.sync.enqueue(changes);
            if (
              ts.home &&
              changes.some(
                (change) =>
                  change.type === "document" &&
                  change.kind === "change" &&
                  change.record.kind === LiveDoc.definition.kind &&
                  !(change.value as LiveState).run &&
                  !(change.value as LiveState).compactions?.length,
              )
            )
              this.#checkHomeBudget(ts);
          }
        },
        end: () => undefined,
      });
      d.store.markTreeOpened(treeId);
      for (const session of rows) {
        let conv: Conversation | undefined;
        if (session.pi_conversation_id === null) {
          // The first session of the tree: its root conversation, made with the agent's model and instructions.
          const agentRow = d.store.getAgentRow(session.agent_id);
          conv = await guard.root(harness, context, {
            model: d.runtime.ref(modelFor(config, agentRow?.model ?? null)),
            thinkingLevel: agentRow?.thinking_level ?? "off",
            instructions: agentRow?.instructions ?? "",
          });
          d.store.setConversation(session.id, String(conv.id));
        } else {
          conv = await harness.conversation(Number(session.pi_conversation_id) as ConversationId, context);
          if (!conv)
            throw new Error(
              `conversation ${session.pi_conversation_id} of session ${session.id} is missing from tree ${treeId}`,
            );
        }
        await this.attachSession(tree, session, conv);
      }
      await this.auditPolicy(tree);
      harness.resume();
      d.log.debug("tree.opened", { treeId, sessions: tree.sessions.size });
      return tree;
    } catch (error) {
      holder.tree?.commits?.detach();
      for (const ts of holderSessions(holder.tree)) ts.sync.dispose();
      d.store.runs.dropTree(treeId);
      await harness.close(context).catch(() => undefined);
      throw error;
    }
  }

  #homeCompactionPolicy(model: ModelRef) {
    const { modelOverrides, ...policy } = compactionSettings(this.#d.store);
    return { ...policy, ...modelOverrides[`${model.provider}/${model.modelId}`] };
  }

  #checkHomeBudget(ts: TreeSession, crossed = false): void {
    const { store, log } = this.#d;
    const conv = ts.conv;
    void (async () => {
      const { model } = await conv.agent(context);
      await conv.commit(async (tx) => {
        const head = (await tx.latestHeadMarker(conv.id))?.id ?? 0;
        const budget = await tx.doc(HomeBudgetCompactionDoc, conv.id);
        if (!model || !this.#homeCompactionPolicy(model).enabled) {
          delete budget.pending;
          return;
        }
        if (crossed) {
          budget.pending = true;
          budget.head = head;
        }
        if (!budget.pending) return;
        // A summary or reset placed since the crossing replaced what was measured. The next model call measures again.
        if (budget.head !== head) {
          delete budget.pending;
          return;
        }
        const live = await tx.doc(LiveDoc, conv.id);
        if (live.run || live.compactions?.length || store.manualCompactions.open(ts.sessionId).length) return;
        await enqueueHomeCompaction(tx, conv.id, HOME_COMPACTION_FOCUS);
        delete budget.pending;
      }, context);
    })().catch((error) => log.warn("home.compaction_start_failed", classifyError(error)));
  }

  #noteHomeActivity(ts: TreeSession, ledger: Ledger): void {
    if (!ts.home) return;
    const human = latestHumanRun(ledger);
    const old = this.#idleHome.get(ts.sessionId);
    if (old?.conversationId === ts.conv.id && old.human?.id === human?.id) return;
    this.#idleHome.set(ts.sessionId, { conversationId: ts.conv.id, human, checked: false });
  }

  /** Catch up after restart and wake closed Home chats once their latest human input has gone quiet. */
  compactIdleHomes(): Promise<void> {
    this.#idleHomeCheck ??= this.#checkIdleHomes().finally(() => {
      this.#idleHomeCheck = undefined;
    });
    return this.#idleHomeCheck;
  }

  async #checkIdleHomes(): Promise<void> {
    const { store, clock, log } = this.#d;
    const policy = compactionSettings(store);
    if (!policy.enabled && !Object.values(policy.modelOverrides).some((override) => override.enabled)) return;
    const { idleGapMs } = homeContextConfig(store);
    const agents = store.listAgents();
    const homes = new Set(agents.map((agent) => agent.homeSessionId));
    for (const id of this.#idleHome.keys()) if (!homes.has(id)) this.#idleHome.delete(id);
    for (const id of homes) {
      const hint = this.#idleHome.get(id);
      if (hint && (!hint.human || hint.checked || clock.now() - hint.human.at < idleGapMs)) continue;
      const row = store.getSessionRow(id);
      if (!row?.pi_conversation_id) continue;
      try {
        const tree = await this.open(row.tree_id);
        await tree.serial(async () => {
          const ts = tree.session(id);
          if (ts) await this.#checkIdleHome(tree, ts, idleGapMs);
        });
      } catch (error) {
        log.warn("home.idle_compaction_check_failed", { sessionId: id, ...classifyError(error) });
      }
    }
  }

  async #checkIdleHome(tree: OpenTree, ts: TreeSession, idleGapMs: number): Promise<void> {
    const { store, clock, modelsConfig, runtime } = this.#d;
    const { conv, sessionId } = ts;
    if (store.nonTerminalRuns(sessionId).length || store.manualCompactions.open(sessionId).length) return;
    const hint = this.#idleHome.get(sessionId);
    if (!hint?.human || hint.checked || clock.now() - hint.human.at < idleGapMs) return;
    const runId = hint.human.id;
    const alreadyChecked = await conv.commit(
      async (tx) => (await tx.doc(HomeIdleCompactionDoc, conv.id)).checkedRun === runId,
      context,
    );
    if (alreadyChecked) {
      hint.checked = true;
      return;
    }

    const view = await conv.context(context);
    const tail = view.entries.reduce<number | undefined>(
      (latest, entry) => (latest === undefined || entry.id > latest ? entry.id : latest),
      undefined,
    );
    const config = parseModelsConfig(await modelsConfig.read().catch(() => undefined));
    const model = runtime.ref(modelFor(config, store.modelOf(sessionId)));
    const policy = this.#homeCompactionPolicy(model);
    if (!policy.enabled) return;
    const compact = hasIdleCompactionWork(view, ts.sync.ledger, policy.keepRecentTokens);
    // Only eligible idle chats need provider discovery or a credential refresh.
    if (compact) await this.prepareCall(tree, ts);
    const checked = await conv.commit(async (tx) => {
      const idle = await tx.doc(HomeIdleCompactionDoc, conv.id);
      if (idle.checkedRun === runId) return true;
      const ledger = (await tx.doc(CommandsDoc, conv.id)) as unknown as Ledger;
      const live = await tx.doc(LiveDoc, conv.id);
      // A concurrent input or summary changed the snapshot. Leave this quiet period eligible for the next tick.
      if (
        latestHumanRun(ledger)?.id !== runId ||
        live.run ||
        live.compactions?.length ||
        (await tx.latestEntryId(conv.id)) !== tail
      )
        return false;
      if (compact) await enqueueHomeCompaction(tx, conv.id, IDLE_COMPACTION_FOCUS);
      idle.checkedRun = runId;
      return true;
    }, context);
    if (checked) hint.checked = true;
    if (checked && compact) tree.lastActivity = clock.now();
  }

  /**
   * Loop guard: the message to refuse a run's next model call with when it already made `maxModelCallsPerRun` calls or has
   * been going for `maxRunMs`. Counted from the trace steps (durable), so a restart does not reset it. It only ever runs
   * between model calls, never in the middle of a tool call.
   */
  loopGuard(runId: string | undefined): string | undefined {
    if (runId === undefined) return undefined;
    const d = this.#d;
    const defaults = this.#defaults();
    const { runLimits } = behaviorSettings(d.store, defaults);
    const base = defaultBehavior(defaults).runLimits;
    // An unchanged setting keeps the server's own value exactly (it may be finer than a minute); an edit replaces it.
    const maxModelCallsPerRun =
      runLimits.maxModelCalls === base.maxModelCalls ? d.limits.maxModelCallsPerRun : runLimits.maxModelCalls;
    const maxRunMs =
      runLimits.maxRunMinutes === base.maxRunMinutes ? d.limits.maxRunMs : runLimits.maxRunMinutes * 60_000;
    const calls =
      d.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM steps WHERE run_id = ? AND type = 'llm.call'", runId)
        ?.n ?? 0;
    if (maxModelCallsPerRun > 0 && calls >= maxModelCallsPerRun)
      return "This run reached its limit on model calls, so it was stopped before making another.";
    const run = d.store.getRun(runId);
    if (maxRunMs > 0 && run && d.clock.now() - run.started_at - runWaitTime(d.store.db, run.id) >= maxRunMs)
      return "This run reached its time limit, so it was stopped before making another model call.";
    return undefined;
  }

  /** Every conversation of the tree must select the policy extension; any that does not is repaired and logged. */
  async auditPolicy(tree: OpenTree): Promise<number> {
    const missing = await tree.guard.audit(tree.harness, context);
    for (const m of missing) {
      this.#d.log.error("policy.missing_on_conversation", {
        treeId: tree.id,
        conversationId: String(m.id),
        extensions: m.extensions.join(","),
      });
      const conv = await tree.harness.conversation(m.id, context);
      if (conv) {
        await tree.guard.repair(conv, context);
        // Repair restores the host defaults, so reapply the per-origin and per-agent extension selection too.
        const session = this.#d.store.sessionByConversation(tree.id, String(conv.id));
        await this.alignExtensions(tree, conv, session?.origin, session?.id, session?.agent_id);
      }
    }
    return missing.length;
  }

  /**
   * Brings a conversation's extension selection to what its origin selects (`extensionDrift`): every installed
   * extension minus `droppedExtensions`, the policy last. Pi stores a selection as an edit of the installed set, so an
   * extension installed later reaches existing conversations by itself; this restores one that an explicit list or a
   * stale remove left out. A `{ remove }` change replaces the whole stored edit, so the full remove list is written each
   * time (writing part of it would bring the rest back). Nothing is written when the selection already matches, so
   * opening a conversation does not touch its prompt. Never throws: a conversation that cannot be reconfigured keeps its
   * selection and is logged. Returns whether it reconfigured.
   */
  async alignExtensions(
    tree: OpenTree,
    conv: Conversation,
    origin: string | undefined,
    sessionId?: string,
    agentId?: string,
  ): Promise<boolean> {
    const d = this.#d;
    const conversationId = String(conv.id);
    try {
      const resolvedAgentId =
        agentId ??
        (sessionId
          ? d.store.getSessionRow(sessionId)?.agent_id
          : d.store.sessionByConversation(tree.id, conversationId)?.agent_id);
      const capabilities = resolvedAgentId ? d.store.agentCapabilities(resolvedAgentId) : undefined;
      const installed = tree.registry.snapshot().installed();
      const agent = await conv.agent(context);
      const selected = agent.extensions.map((e) => e.name);
      const drift = extensionDrift(
        installed.map((e) => e.name),
        selected,
        origin,
        capabilities,
      );
      if (!drift.changed) return false;
      // Guarded reconfiguration also repairs the policy. Keep the same audit evidence as auditPolicy.
      if (!selected.includes(tree.guard.policy.name)) {
        d.log.error("policy.missing_on_conversation", {
          treeId: tree.id,
          conversationId,
          extensions: selected.join(","),
        });
      }
      const drop = droppedExtensions(origin, capabilities);
      const remove = installed.filter((e) => drop.includes(e.name));
      await tree.guard.reconfigure(conv, { extensions: { remove } }, context);
      d.log.info("conversation.extensions_aligned", {
        treeId: tree.id,
        conversationId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        // Joined with "+": log values must be token-shaped (a comma would drop the field).
        added: drift.added.join("+"),
        removed: drift.removed.join("+"),
        addedCount: drift.added.length,
        removedCount: drift.removed.length,
      });
      return true;
    } catch (error) {
      d.log.warn("conversation.extensions_align_failed", { treeId: tree.id, conversationId, ...classifyError(error) });
      return false;
    }
  }

  /** Starts syncing one session's conversation (a session of the tree's first open, or a fork made while it is open). */
  async attachSession(tree: OpenTree, session: SessionRow, conv: Conversation): Promise<TreeSession> {
    const d = this.#d;
    // A session of another agent may bring connectors the tree has not registered.
    this.#connectorSlots.get(tree.id)?.();
    // A setting saved while the tree was opening.
    this.#codemodeSlots.get(tree.id)?.();
    // Applies to existing conversations and forks too, before they resume. The store also refuses non-home spawns.
    await this.alignExtensions(tree, conv, session.origin, session.id, session.agent_id);
    this.#alignedCaps.set(session.id, JSON.stringify(d.store.agentCapabilities(session.agent_id)));
    const sync = new SessionSync({
      store: d.store,
      approvals: d.approvals,
      recorder: d.recorder,
      clock: d.clock,
      log: d.log,
      treeId: tree.id,
      sessionId: session.id,
      conv,
      ...(d.memory ? { onToolResult: (input) => d.memory!.history.indexToolResult(input) } : {}),
    });
    const ts = new TreeSession(session.id, conv, sync, session.origin === "home");
    ts.providerSessionId = await conv
      .commit(async (tx) => (await tx.doc(ProviderDoc, conv.id)).sessionId, context)
      .catch(() => undefined);
    if (ts.providerSessionId) tree.providerSessions.set(ts.providerSessionId, session.id);
    tree.sessions.set(session.id, ts);
    await sync.hydrate();
    this.#noteHomeActivity(ts, sync.ledger);
    if (ts.home) this.#checkHomeBudget(ts);
    return ts;
  }

  /** Stops syncing a session that was deleted while its tree stays (forks still use the tree). */
  async detachSession(tree: OpenTree, sessionId: string): Promise<void> {
    const ts = tree.sessions.get(sessionId);
    if (!ts) return;
    this.#alignedCaps.delete(sessionId);
    tree.sessions.delete(sessionId);
    if (ts.providerSessionId) tree.providerSessions.delete(ts.providerSessionId);
    ts.sync.dispose();
    this.#d.store.runs.dropSession(sessionId);
  }

  /**
   * Puts another conversation of the tree under a session (a rewind or a version switch): stops syncing the one it had,
   * which stays in the tree, and syncs `conv` instead. The caller holds `tree.serial` and has made `conv` the session's
   * conversation in the store. The session's runs are rebuilt from the new conversation's ledger.
   */
  async swapConversation(tree: OpenTree, sessionId: string, conv: Conversation): Promise<TreeSession> {
    const row = this.#d.store.getSessionRow(sessionId);
    if (!row) throw new Error(`session ${sessionId} is gone`);
    const old = tree.sessions.get(sessionId);
    if (old) {
      await old.drained();
      await this.detachSession(tree, sessionId);
    }
    return this.attachSession(tree, row, conv);
  }

  #defaults(): BehaviorDefaults {
    const d = this.#d;
    return { maxModelCalls: d.limits.maxModelCallsPerRun, maxRunMs: d.limits.maxRunMs, retry: d.settings.retry };
  }

  /** Retry policy from Settings > Behavior over the server default; read at each model call. */
  #retry() {
    const { retry } = behaviorSettings(this.#d.store, this.#defaults());
    return {
      ...this.#d.settings.retry,
      enabled: retry.maxRetries > 0,
      maxRetries: retry.maxRetries,
      baseDelayMs: retry.baseDelaySeconds * 1000,
    };
  }

  /** The context window of the model a session's next call uses, in tokens; null when it is not known. */
  async contextWindowOf(sessionId: string): Promise<number | null> {
    const d = this.#d;
    const config = parseModelsConfig(await d.modelsConfig.read().catch(() => undefined));
    const value = d.runtime.limits(modelFor(config, d.store.modelOf(sessionId))).contextWindow.value;
    return typeof value === "number" && value > 0 ? value : null;
  }

  async prepareCall(tree: OpenTree, ts: TreeSession): Promise<void> {
    const d = this.#d;
    const session = d.store.getSessionRow(ts.sessionId);
    if (session) {
      const capsJson = JSON.stringify(d.store.agentCapabilities(session.agent_id));
      if (this.#alignedCaps.get(ts.sessionId) !== capsJson) {
        await this.alignExtensions(tree, ts.conv, session.origin, session.id, session.agent_id);
        this.#alignedCaps.set(ts.sessionId, capsJson);
      }
    }
    await d.runtime.ensureProviders?.();
    const config = parseModelsConfig(await d.modelsConfig.read().catch(() => undefined));
    tree.deadlines = config.standard.deadlines;
    await d.runtime.refreshCredential();
    const want = d.runtime.ref(modelFor(config, d.store.modelOf(ts.sessionId)));
    const thinkingLevel = d.store.thinkingLevelOf(ts.sessionId);
    const instructions = d.store.instructionsOf(ts.sessionId);
    const agent = await ts.conv.agent(context);
    if (
      agent.model?.provider !== want.provider ||
      agent.model?.modelId !== want.modelId ||
      agent.thinkingLevel !== thinkingLevel ||
      // Edited instructions apply here, at the start of the next model call: never in the middle of one.
      (instructions !== undefined && (agent.instructions ?? "") !== instructions)
    ) {
      await tree.guard.reconfigure(
        ts.conv,
        { model: want, thinkingLevel, ...(instructions !== undefined ? { instructions } : {}) },
        context,
      );
    }
  }

  /** Closes a tree. Refuses (returns false) while a run is unfinished, unless `force` (shutdown: Pi resumes it next start). */
  async close(treeId: string, force = false): Promise<boolean> {
    const tree = this.#ready.get(treeId);
    if (!tree) {
      await this.#open.get(treeId)?.catch(() => undefined);
      if (!this.#ready.has(treeId)) return true;
      return this.close(treeId, force);
    }
    if (!force && (this.#d.store.hasWork(treeId) || tree.harness.wake().active)) return false;
    await tree.chain.catch(() => undefined);
    this.#ready.delete(treeId);
    this.#open.delete(treeId);
    this.#d.mcp?.directory.forget(treeId);
    this.#connectorSlots.delete(treeId);
    this.#codemodeSlots.delete(treeId);
    tree.commits?.detach();
    for (const ts of tree.sessions.values()) {
      this.#alignedCaps.delete(ts.sessionId);
      await ts.drained();
      ts.sync.dispose();
    }
    const working = this.#d.store.hasWork(treeId);
    this.#d.store.runs.dropTree(treeId);
    // Pi keeps its own timers for sleeping tasks while the tree is open; once closed, the tick reopens it when due.
    const wake = tree.harness.wake();
    this.#d.store.recordTreeClose(treeId, wake.at ?? null, working || wake.active);
    await tree.harness.close(context);
    this.#d.log.debug("tree.closed", { treeId });
    return true;
  }

  async closeAll(force: boolean): Promise<void> {
    await this.#idleHomeCheck?.catch(() => undefined);
    await Promise.all(this.openIds().map((id) => this.close(id, force).catch(() => undefined)));
  }

  /** Closes trees that have had no activity for `idleMs` and no unfinished run. */
  async closeIdle(idleMs: number): Promise<string[]> {
    const now = this.#d.clock.now();
    const closed: string[] = [];
    for (const tree of this.all()) {
      if (now - tree.lastActivity < idleMs) continue;
      if (await this.close(tree.id)) closed.push(tree.id);
    }
    return closed;
  }
}

const holderSessions = (tree: OpenTree | undefined): TreeSession[] => [...(tree?.sessions.values() ?? [])];

/** The conversation a stored change belongs to; undefined for Session-scoped documents and conversation records. */
function changeConversation(change: CommitChange): ConversationId | undefined {
  switch (change.type) {
    case "entry":
    case "submission":
      return change.value.conversationId;
    case "task":
      return undefined;
    case "conversation":
      return undefined;
    default:
      return change.conversationId;
  }
}
