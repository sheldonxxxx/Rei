// Owns history ingestion, indexing lifecycle, lookup and deletion visibility. Ranking and memory profile editing live outside.
import type { IndexStatus, StorageStatusResponse } from "@rei/protocol";
import { RetrievalOutbox } from "../retrieval/outbox.ts";
import { denseCollectionFor } from "../retrieval/points.ts";
import type { RetrievalFilters, RetrievalStore } from "../retrieval/retrieval-store.ts";
import { RetrievalSyncer } from "../retrieval/syncer.ts";
import { GLOBAL_STREAM } from "../store/events.ts";
import type { AppStore } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import { badRequest } from "../util/errors.ts";
import { classifyError, type Logger } from "../util/log.ts";
import { type Embedder, EmbedderError, semanticKey } from "./embedder.ts";
import { FUSION } from "./fusion.ts";
import { HistoryIndex, type IndexableItem, indexableToolText, type SearchFilters } from "./index.ts";
import { IndexWorker, realTimers, type Timers } from "./worker.ts";

export type { IndexableItem, SearchFilters } from "./index.ts";
/** The background loops' timers, for other indexes that pace themselves the same way (Knowledge). */
export { realTimers, type Timers } from "./worker.ts";

/**
 * The embedding model, as another index of Rei's own text sees it (Knowledge). `key` names what makes two vectors
 * comparable: a vector stored under another key must never be compared with a query embedded under this one.
 */
export interface SemanticModel {
  key: string;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface HistoryIndexingDeps {
  store: AppStore;
  clock: Clock;
  log: Logger;
  embedder: Embedder | undefined;
  onPurgeSession: (sessionId: string) => void;
  retrieval?: RetrievalStore;
  timers?: Timers;
  worker?: { batch?: number; backoffBaseMs?: number; backoffMaxMs?: number };
}

/** How often the worker and the syncer are woken for work no hook told us about. */
const RESCAN_MS = 5 * 60_000;

/** The same filters, in the shape the search service takes them. SQLite applies them again when the hits are checked. */
const filtersFor = (f: SearchFilters): RetrievalFilters => ({
  ...(f.agentId !== undefined ? { agentId: f.agentId } : {}),
  ...(f.from !== undefined ? { from: f.from } : {}),
  ...(f.to !== undefined ? { to: f.to } : {}),
});

/** Index status events are sent at most this often while messages arrive. */
const STATUS_EVERY_MS = 500;

export class HistoryIndexing {
  readonly #store: AppStore;
  readonly #clock: Clock;
  readonly #log: Logger;
  #embedder: Embedder | undefined;
  #configuredEmbedder: Embedder | undefined;
  readonly #onPurgeSession: (sessionId: string) => void;
  readonly #workerDeps: HistoryIndexingDeps;
  #configuring = false;
  readonly #index: HistoryIndex;
  readonly #retrieval: RetrievalStore | undefined;
  readonly #outbox: RetrievalOutbox | undefined;
  readonly #syncer: RetrievalSyncer | undefined;
  #worker: IndexWorker;
  readonly #timers: Timers;
  #rescan: unknown;
  #statusTimer: unknown;
  #lastStatus = 0;

  constructor(deps: HistoryIndexingDeps) {
    this.#store = deps.store;
    this.#onPurgeSession = deps.onPurgeSession;
    this.#clock = deps.clock;
    this.#log = deps.log;
    this.#configuredEmbedder = deps.embedder;
    this.#workerDeps = deps;
    this.#embedder =
      deps.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'memory_search_enabled'")?.value ===
      "false"
        ? undefined
        : deps.embedder;
    this.#timers = deps.timers ?? realTimers;
    this.#retrieval = deps.retrieval;
    this.#outbox = deps.retrieval ? new RetrievalOutbox(deps.store.db, deps.clock) : undefined;
    this.#index = new HistoryIndex(deps.store.db, deps.clock, this.#outbox);
    this.#syncer =
      deps.retrieval && this.#outbox
        ? new RetrievalSyncer({
            index: this.#index,
            outbox: this.#outbox,
            store: deps.retrieval,
            clock: deps.clock,
            log: deps.log,
            timers: this.#timers,
          })
        : undefined;
    this.#worker = new IndexWorker({
      index: this.#index,
      embedder: this.#embedder,
      clock: deps.clock,
      log: deps.log,
      changed: () => this.#announceIndex(),
      timers: this.#timers,
      ...(this.#retrieval ? { retrieval: this.#retrieval } : {}),
      ...deps.worker,
    });
  }

  setupSettings(): import("@rei/protocol").MemorySetupSettings {
    return {
      enabled: !!this.#embedder,
      available: !!this.#configuredEmbedder,
      model: this.#configuredEmbedder?.apiModel ?? null,
    };
  }

  async configureEnabled(
    enabled: boolean,
    replacement?: Embedder,
  ): Promise<import("@rei/protocol").MemorySetupSettings> {
    if (this.#configuring) throw badRequest("setup_busy", "Memory settings are being saved. Try again.");
    if (enabled && !replacement && !this.#configuredEmbedder)
      throw badRequest("embedding_unavailable", "No embedding service is installed. Keyword search is ready to use.");
    this.#configuring = true;
    try {
      if (replacement) this.#configuredEmbedder = replacement;
      this.#worker.stop();
      await this.#worker.settle();
      this.#store.db.run(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('memory_search_enabled', ?)",
        String(enabled),
      );
      this.#embedder = enabled ? this.#configuredEmbedder : undefined;
      this.#worker = new IndexWorker({
        index: this.#index,
        embedder: this.#embedder,
        clock: this.#clock,
        log: this.#log,
        changed: () => this.#announceIndex(),
        timers: this.#timers,
        ...(this.#retrieval ? { retrieval: this.#retrieval } : {}),
        ...this.#workerDeps.worker,
      });
      this.#worker.kick();
      this.#announceIndex();
      return this.setupSettings();
    } finally {
      this.#configuring = false;
    }
  }

  /** Hooks into the store, catches up on messages that were never indexed, and starts the worker. */
  start(): void {
    this.#store.memoryHooks = {
      indexable: (item) => this.#indexItem(item),
      purgeSession: (sessionId) => {
        this.#index.purgeSession(sessionId);
        this.#onPurgeSession(sessionId);
        this.#syncer?.kick();
      },
      afterPurge: () => this.#index.optimize(),
      branchVisibility: (sessionId, visible) => {
        try {
          const changed = this.#index.setBranchVisibility(sessionId, visible);
          if (changed.hidden + changed.shown === 0) return;
          this.#announceIndex();
          this.#worker.kick();
          this.#syncer?.kick();
        } catch (error) {
          this.#log.error("memory.index_failed", classifyError(error));
        }
      },
    };
    this.#syncer?.kick();
    this.catchUp();
    const loop = () => {
      this.#rescan = this.#timers.set(() => {
        this.catchUp();
        loop();
      }, RESCAN_MS);
    };
    loop();
  }

  stop(): void {
    this.#worker.stop();
    this.#syncer?.stop();
    if (this.#rescan !== undefined) this.#timers.clear(this.#rescan);
    if (this.#statusTimer !== undefined) this.#timers.clear(this.#statusTimer);
    if (this.#store.memoryHooks) this.#store.memoryHooks = undefined;
  }

  /**
   * Wakes the worker and the syncer. Items reach the index when their run settles (a settlement that a crash interrupted
   * runs again when the tree opens), so there is no transcript to rescan.
   */
  catchUp(): void {
    this.#worker.kick();
    this.#syncer?.kick();
  }

  #indexItem(item: IndexableItem): void {
    try {
      if (this.#index.indexItem(item) > 0) {
        this.#announceIndex();
        this.#worker.kick();
        this.#syncer?.kick();
      }
    } catch (error) {
      this.#log.error("memory.index_failed", classifyError(error));
    }
  }

  /** A finished tool result (the projector): indexed as chunks linked to the run's reply. */
  indexToolResult(input: {
    sessionId: string;
    runId: string | null;
    piEntryId: string;
    toolName: string;
    parts: readonly { type: string; text?: unknown }[];
    conversationId?: string;
  }): void {
    const text = indexableToolText(input.toolName, input.parts);
    if (text === undefined) return;
    try {
      if (
        this.#index.addToolResult({
          sessionId: input.sessionId,
          runId: input.runId,
          piEntryId: input.piEntryId,
          toolName: input.toolName,
          text,
          ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        }) > 0
      ) {
        this.#announceIndex();
        this.#worker.kick();
        this.#syncer?.kick();
      }
    } catch (error) {
      this.#log.error("memory.index_failed", classifyError(error));
    }
  }

  /** `memory.changed` for the index, at most every STATUS_EVERY_MS (with a trailing one so the last state is announced). */
  #announceIndex(): void {
    const now = this.#clock.now();
    if (now - this.#lastStatus >= STATUS_EVERY_MS) {
      this.#lastStatus = now;
      this.#store.tx(() => {
        const active = this.#index.activeSet();
        const e = this.#embedder;
        const snapshot = {
          at: now,
          ...this.status(),
          provider: e?.provider ?? "off",
          apiModel: e?.apiModel ?? null,
          profile: e?.profile ?? null,
          compatible: e && active ? e.compatible(active.identity) : false,
        };
        this.#store.db.run(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('memory_embedding_status', ?)",
          JSON.stringify(snapshot),
        );
        this.#store.events.append(GLOBAL_STREAM, { type: "memory.changed", what: "index" });
      });
      return;
    }
    if (this.#statusTimer !== undefined) return;
    this.#statusTimer = this.#timers.set(() => {
      this.#statusTimer = undefined;
      this.#announceIndex();
    }, STATUS_EVERY_MS);
  }

  status(): IndexStatus {
    const status = this.#worker.status();
    if (!this.#syncer) return status;
    const behind = this.#syncer.status();
    // The queue between SQLite and the search service: how far behind it is, and the last thing that went wrong there.
    return { ...status, indexing: { pending: behind.pending, lastError: behind.lastError } };
  }

  /** Builds a new vector set in the background; the active one keeps serving until it covers every entry. */
  rebuild(): IndexStatus {
    this.#worker.requestRebuild();
    return this.status();
  }

  /** Resolves when indexing has nothing left to do (or the embedder is down and waiting out its backoff). For tests and the eval. */
  async settle(): Promise<void> {
    this.catchUp();
    await this.#worker.settle();
    if (this.#syncer)
      for (;;) {
        const summary = await this.#syncer.drainNow();
        if (summary.attempted === 0) break;
      }
  }

  /**
   * The keyword side, ranked best first. Qdrant's BM25 over Rei's own tokens; if the service does not answer, the
   * ranking comes from Rei's copy of the index in SQLite instead and the search still works (more slowly).
   */
  async keywordSearch(query: string, filters: SearchFilters): Promise<{ id: number }[]> {
    const local = (): { id: number }[] => this.#index.keywordSearch(query, filters, FUSION.top).map((id) => ({ id }));
    if (!this.#retrieval) return local();
    try {
      const hits = await this.#retrieval.searchLexical(query, {
        filters: filtersFor(filters),
        limit: FUSION.top,
      });
      // SQLite decides what a lead may become: a hidden placeholder, a deleted chat, outside the dates.
      return this.#index
        .validIds(
          hits.map((hit) => hit.payload.entryId),
          filters,
        )
        .map((id) => ({ id }));
    } catch (error) {
      this.#log.warn("memory.retrieval_search_failed", { side: "lexical", ...classifyError(error) });
      return local();
    }
  }

  /** The vector side: nearest entries to the query in the active generation, valid ones only, best first. */
  async vectorSearch(query: string, filters: SearchFilters): Promise<{ id: number; cosine: number }[]> {
    const embedder = this.#embedder;
    if (!embedder) return [];
    if (this.#retrieval) return this.#denseSearch(query, filters);
    const active = this.#index.activeCache();
    if (!active || active.cache.size === 0) return [];
    // Only an endpoint that serves the set's own model can embed a query into it.
    if (!embedder.compatible(active.set.identity)) return [];
    let q: Float32Array;
    try {
      q = await embedder.embedQuery(query, active.set.identity.queryTemplate);
    } catch (error) {
      if (!(error instanceof EmbedderError)) throw error;
      this.#log.warn("memory.query_embedding_failed", { kind: error.kind });
      return [];
    }
    const near = active.cache.search(q, FUSION.top * 4);
    const ids = near.map((n) => n.id);
    const alive = new Set(this.#index.validIds(ids));
    // A vector whose entry is gone (hidden, deleted) should not linger in memory either.
    for (const id of ids) if (!alive.has(id)) active.cache.delete(id);
    const ok =
      filters.from === undefined && filters.to === undefined && filters.agentId === undefined
        ? alive
        : new Set(this.#index.validIds(ids, filters));
    return near.filter((n) => ok.has(n.id));
  }

  /** The vector side when the vectors live in the search service: one dense query, checked against SQLite afterwards. */
  async #denseSearch(query: string, filters: SearchFilters): Promise<{ id: number; cosine: number }[]> {
    const embedder = this.#embedder!;
    const set = this.#index.activeSet();
    // Only an endpoint that serves this set's own model can embed a query into it.
    if (!set || !embedder.compatible(set.identity)) return [];
    let q: Float32Array;
    try {
      q = await embedder.embedQuery(query, set.identity.queryTemplate);
    } catch (error) {
      if (!(error instanceof EmbedderError)) throw error;
      this.#log.warn("memory.query_embedding_failed", { kind: error.kind });
      return [];
    }
    try {
      const hits = await this.#retrieval!.searchDense(denseCollectionFor(set.id), q, {
        filters: filtersFor(filters),
        limit: FUSION.top * 4,
      });
      return this.#index
        .validIds(
          hits.map((hit) => hit.payload.entryId),
          filters,
        )
        .map((id) => ({ id, cosine: hits.find((hit) => hit.payload.entryId === id)?.score ?? 0 }));
    } catch (error) {
      // Meaning search is the optional half: without it the keyword ranking still answers, and the status says why.
      this.#log.warn("memory.retrieval_search_failed", { side: "dense", ...classifyError(error) });
      return [];
    }
  }

  /** Await work already running, without starting catch-up or draining retries. */
  async settleRunning(): Promise<void> {
    await Promise.all([this.#worker.settle(), this.#syncer?.settle()]);
  }

  retry(): void {
    this.#worker.retryNow();
    this.#syncer?.retryNow();
  }

  /**
   * The model meaning search uses right now, for another index (Knowledge): the same connection and the same on/off
   * switch as history, with the adapter kept inside this module. Undefined while meaning search is off.
   */
  semanticModel(): SemanticModel | undefined {
    const embedder = this.#embedder;
    if (!embedder) return undefined;
    const identity = embedder.identity({ build: "", quant: embedder.profile.quant });
    return {
      key: semanticKey(identity),
      embedDocuments: (texts) => embedder.embedDocuments(texts, { docTemplate: identity.docTemplate }),
      embedQuery: (text) => embedder.embedQuery(text, identity.queryTemplate),
    };
  }

  /** Metadata only; the embedding adapter stays inside the module. */
  embeddingInfo() {
    const e = this.#embedder;
    return e ? { provider: e.provider, profile: e.profile, apiModel: e.apiModel, remote: e.remote } : null;
  }

  remoteEmbedderSaw(): boolean {
    return this.#index.activeSet()?.remote ?? this.#embedder?.remote ?? false;
  }

  /** Hydration preserves the existing read contract; lookup validates visibility before ranking. */
  hydrate(entryIds: number[]) {
    return this.#index.hydrate(entryIds);
  }

  async diagnostics(): Promise<StorageStatusResponse["search"]> {
    const behind = this.#syncer?.status();
    const status = this.#retrieval ? await this.#retrieval.status() : null;
    return {
      configured: !!this.#retrieval,
      ok: status?.ok ?? null,
      detail: status?.detail ?? null,
      lexicalCollection: status?.lexicalCollection ?? null,
      lexicalPoints: status?.lexicalPoints ?? null,
      dense: status?.dense ?? [],
      queued: behind?.pending ?? 0,
      queueError: behind?.lastError ?? null,
    };
  }
}
