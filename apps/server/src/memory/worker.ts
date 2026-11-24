// The background indexer (D31): embeds entries that have no vector in the active or building set, a few per request, one
// request at a time, yielding between batches so chats and tools keep the event loop. When the embedder fails the entries
// stay queued and the worker backs off (1 s, 2 s, ... up to 60 s); keyword search never depends on it.
import type { IndexStatus } from "@rei/protocol";
import { denseCollectionFor, pointFor, pointIdOf } from "../retrieval/points.ts";
import type { RetrievalStore } from "../retrieval/retrieval-store.ts";
import type { Clock } from "../util/clock.ts";
import { classifyError, type Logger } from "../util/log.ts";
import { type Embedder, EmbedderError, type EmbedderIdentity, identityKey, vectorToBlob } from "./embedder.ts";
import type { HistoryIndex, VectorSet } from "./index.ts";

export const EMBED_BATCH = 8;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** Progress is announced at most this often while a backlog drains. */
const PROGRESS_EVERY_MS = 1_000;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  /** Gives the event loop a turn (between batches). */
  yield(): Promise<void>;
}
export const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
};

export interface WorkerDeps {
  index: HistoryIndex;
  embedder: Embedder | undefined;
  clock: Clock;
  log: Logger;
  /** Called when the status changed (the service turns it into `memory.changed`). */
  changed: () => void;
  timers?: Timers;
  batch?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /**
   * The search service. With one, the vectors go there (one collection per vector set, the active one behind an alias)
   * and SQLite's `history_vectors` rows record coverage only; without, the vectors stay in SQLite as they always did.
   */
  retrieval?: RetrievalStore;
}

const modelLabel = (i: EmbedderIdentity): string => `${i.model} ${i.quant}`;

export class IndexWorker {
  readonly #d: WorkerDeps;
  readonly #timers: Timers;
  #identity: EmbedderIdentity | undefined;
  #loop: Promise<void> | undefined;
  #retry: unknown;
  #failures = 0;
  #down = false;
  #lastError: string | null = null;
  #rebuild = false;
  #stopped = false;
  #lastProgress = 0;
  #retrievalDown = false;

  constructor(deps: WorkerDeps) {
    this.#d = deps;
    this.#timers = deps.timers ?? realTimers;
  }

  /** Work may be waiting: start the loop if it is not running (a no-op while backing off, so a busy chat does not hammer a dead embedder). */
  kick(): void {
    if (this.#stopped || !this.#d.embedder || this.#loop || this.#retry !== undefined) return;
    this.#loop = this.#run().finally(() => {
      this.#loop = undefined;
    });
  }

  /** Try the embedder now, whatever the backoff says. */
  retryNow(): void {
    if (this.#retry !== undefined) {
      this.#timers.clear(this.#retry);
      this.#retry = undefined;
    }
    this.kick();
  }

  /** Resolves when the loop has nothing to do (or the embedder is down and waiting out its backoff). */
  async settle(): Promise<void> {
    while (this.#loop) await this.#loop;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retry !== undefined) this.#timers.clear(this.#retry);
    this.#retry = undefined;
  }

  /** Builds a new vector set from scratch in the background; the active one keeps serving until it covers everything. */
  requestRebuild(): void {
    this.#rebuild = true;
    // The identity is re-read too: the server may have been replaced by one with another build.
    this.#identity = undefined;
    this.#d.index.clearEmbedFailures();
    this.retryNow();
  }

  async #run(): Promise<void> {
    for (;;) {
      if (this.#stopped) return;
      let outcome: "more" | "idle" | "down";
      try {
        outcome = await this.#step();
      } catch (error) {
        this.#d.log.error("memory.worker_failed", classifyError(error));
        outcome = "idle";
      }
      if (outcome === "idle") {
        this.#d.changed();
        return;
      }
      if (outcome === "down") {
        const delay = Math.min(
          this.#d.backoffMaxMs ?? BACKOFF_MAX_MS,
          (this.#d.backoffBaseMs ?? BACKOFF_BASE_MS) * 2 ** Math.max(0, this.#failures - 1),
        );
        this.#retry = this.#timers.set(() => {
          this.#retry = undefined;
          this.kick();
        }, delay);
        return;
      }
      this.#progress();
      await this.#timers.yield();
    }
  }

  #progress(): void {
    const now = this.#d.clock.now();
    if (now - this.#lastProgress < PROGRESS_EVERY_MS) return;
    this.#lastProgress = now;
    this.#d.changed();
  }

  #fail(error: unknown): "down" {
    const message = error instanceof EmbedderError ? error.message : "The embedder failed.";
    const wasDown = this.#down;
    this.#down = true;
    // Whatever answers next may be another build: look again before embedding.
    this.#identity = undefined;
    this.#failures++;
    this.#lastError = message;
    this.#d.log.warn("memory.embedder_down", { failures: this.#failures, ...classifyError(error) });
    if (!wasDown) this.#d.changed();
    return "down";
  }

  #ok(): void {
    this.#failures = 0;
    this.#lastError = null;
    if (this.#down || this.#retrievalDown) {
      this.#down = false;
      this.#retrievalDown = false;
      this.#d.changed();
    }
  }

  /** Drops a vector set: the search service's collection first, so SQLite never points at a generation that is gone. */
  async #drop(set: VectorSet): Promise<void> {
    if (this.#d.retrieval) await this.#d.retrieval.dropCollection(denseCollectionFor(set.id));
    this.#d.index.dropSet(set.id);
  }

  /** The active/building sets the configured identity calls for. Returns the set to fill. */
  async #reconcile(identity: EmbedderIdentity): Promise<VectorSet> {
    const { index, embedder } = this.#d;
    const remote = embedder?.remote ?? false;
    const key = identityKey(identity);
    let active = index.activeSet();
    let building = index.buildingSet();
    if (!active) {
      // The first set serves as it fills: vectors that exist are searched, the rest is found by keyword.
      if (building) await this.#drop(building);
      active = index.createSet(identity, "active", remote);
      this.#d.changed();
      return active;
    }
    const wantBuilding = identityKey(active.identity) !== key || this.#rebuild;
    if (wantBuilding) {
      if (building && identityKey(building.identity) !== key) {
        await this.#drop(building);
        building = undefined;
      }
      if (!building) {
        const retained = !this.#rebuild ? index.retainedSet(identity) : undefined;
        building = retained ? index.stageRetained(retained.id) : index.createSet(identity, "building", remote);
        this.#d.log.info("memory.vector_set_building", { setId: building.id });
        this.#d.changed();
      }
      this.#rebuild = false;
      return building;
    }
    if (building && identityKey(building.identity) !== key) await this.#drop(building);
    else if (building) return building; // a rebuild that was under way before a restart
    return active;
  }

  async #step(): Promise<"more" | "idle" | "down"> {
    const { index, embedder } = this.#d;
    if (!embedder) return "idle";
    if (!this.#identity) {
      try {
        this.#identity = embedder.identity(await embedder.probe());
      } catch (error) {
        return this.#fail(error);
      }
    }
    let target: VectorSet;
    try {
      target = await this.#reconcile(this.#identity);
      if (this.#d.retrieval) {
        const collection = denseCollectionFor(target.id);
        if (!(await this.#d.retrieval.collections()).includes(collection)) index.resetCoverage(target.id);
        await this.#d.retrieval.ensureDense(collection, target.identity.dims);
      }
    } catch (error) {
      // The search service is what the vectors live in now: without it there is nothing to fill.
      return this.#retrievalFail(error);
    }
    const pending = index.pendingEntries(target.id, this.#d.batch ?? EMBED_BATCH);
    if (pending.length === 0) {
      if (target.status === "building") {
        this.#promote(target);
        this.#d.log.info("memory.vector_set_active", { setId: target.id });
        this.#d.changed();
      }
      return "idle";
    }
    try {
      const vectors = await embedder.embedDocuments(
        pending.map((p) => p.text),
        { docTemplate: target.identity.docTemplate },
      );
      await this.#storeVectors(target, pending, vectors);
    } catch (error) {
      if (!(error instanceof EmbedderError) || error.kind !== "client") return this.#fail(error);
      // The server refused this batch (an input it will not take). Find the one it refuses; the rest goes in.
      for (const p of pending) {
        try {
          const [v] = await embedder.embedDocuments([p.text], { docTemplate: target.identity.docTemplate });
          await this.#storeVectors(target, [p], [v!]);
        } catch (single) {
          if (single instanceof EmbedderError && single.kind === "client") {
            index.markEmbedFailed(p.id);
            this.#d.log.warn("memory.entry_not_embeddable", { entryId: p.id, status: single.status ?? 0 });
          } else if (single instanceof EmbedderError) return this.#fail(single);
          else return this.#retrievalFail(single);
        }
      }
    }
    this.#ok();
    return "more";
  }

  /**
   * One entry's vectors, in the order that keeps SQLite honest about what is searchable: the vector goes to wherever
   * it lives, and only then does `history_vectors` say this entry is embedded. A write that failed therefore stays
   * pending and is tried again, instead of leaving an entry counted as embedded with nothing to search.
   */
  async #storeVectors(
    set: VectorSet,
    pending: {
      id: number;
      session_id: string;
      text: string;
      message_id: string | null;
      pi_entry_id: string | null;
      chunk_index: number;
    }[],
    vectors: Float32Array[],
  ): Promise<void> {
    const { index, retrieval } = this.#d;
    if (retrieval) {
      const rows = index.entriesForRetrieval(pending.map((p) => p.id));
      const live = new Map(rows.map((row) => [row.id, row]));
      const points = pending.flatMap((p, i) => {
        const row = live.get(p.id);
        if (!row) return [];
        const point = pointFor(row, `vectors:${set.id}`);
        return point ? [{ ...point, vector: vectors[i]! }] : [];
      });
      if (points.length > 0) await retrieval.upsert(denseCollectionFor(set.id), points);
      // Deleted while its vector was computed: make sure nothing was left pointing at it, then let SQLite skip it.
      const visible = new Set(index.entriesForRetrieval(pending.map((p) => p.id)).map((row) => row.id));
      const gone = pending.filter((p) => !visible.has(p.id)).map((p) => ({ entryId: p.id, pointId: pointIdOf(p) }));
      if (gone.length > 0) {
        // A purge may already have drained its delete before this write completed. Keep another durable intent if removal fails.
        index.outbox?.enqueueDelete(gone);
        await retrieval.remove(
          [denseCollectionFor(set.id)],
          gone.flatMap((p) => (p.pointId ? [p.pointId] : [])),
        );
      }
      index.storeVectors(
        set.id,
        pending.map((p, i) => ({ entryId: p.id, vector: vectors[i]! })),
      );
      return;
    }
    index.storeVectors(
      set.id,
      pending.map((p, i) => ({ entryId: p.id, vector: vectors[i]!, vec: vectorToBlob(vectors[i]!) })),
    );
  }

  /**
   * A finished set takes over. There is nothing to tell the search service: the collection is named after the vector
   * set, so switching is one SQLite write, and a query can only ever ask for the generation SQLite says is active.
   */
  #promote(set: VectorSet): void {
    this.#d.index.promote(set.id);
  }

  /** The search service, not the embedder, could not be reached: say so, and back off without claiming a model is down. */
  #retrievalFail(error: unknown): "down" {
    this.#retrievalDown = true;
    this.#failures++;
    this.#lastError = error instanceof Error ? error.message.slice(0, 200) : "the search service failed";
    this.#d.log.warn("memory.retrieval_write_failed", { failures: this.#failures, ...classifyError(error) });
    this.#d.changed();
    return "down";
  }

  /** The state of the index as the PWA and the doctor see it. */
  status(): IndexStatus {
    const { index, embedder } = this.#d;
    const entries = index.countEntries();
    if (!embedder)
      return {
        state: "off",
        model: null,
        dimensions: null,
        entries,
        embedded: 0,
        building: null,
        lastError: null,
        remote: false,
      };
    const active = index.activeSet();
    const building = index.buildingSet();
    const cover = (set: VectorSet) => index.coverage(set.id);
    const activeCover = active ? cover(active) : undefined;
    const buildingCover = building ? cover(building) : undefined;
    const embedded = activeCover?.embedded ?? 0;
    const waiting = !active || embedded + (activeCover?.failed ?? 0) < entries || building !== undefined;
    const blocked = this.#down || this.#retrievalDown;
    return {
      state: blocked ? "down" : waiting ? "indexing" : "ready",
      model: active ? modelLabel(active.identity) : null,
      dimensions: active?.identity.dims ?? null,
      entries,
      embedded,
      building:
        building && buildingCover
          ? { model: modelLabel(building.identity), embedded: buildingCover.embedded, total: entries }
          : null,
      lastError: blocked ? this.#lastError : null,
      remote: active?.remote ?? embedder.remote,
    };
  }
}
