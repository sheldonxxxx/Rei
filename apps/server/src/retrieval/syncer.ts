// The part that keeps the search service in step with SQLite: it works off the outbox (see outbox.ts) and nothing else.
// It has its own backoff, deliberately separate from the embedding worker's — keyword search has to keep working when
// no embedding model is configured, and a busy embedder must not delay it either.
//
// The rule that makes this safe to run at any time, twice, or after a crash: a point is only ever written from what
// SQLite says is searchable *right now*, and every hit is re-checked against SQLite before anyone sees it. So a point
// that briefly reappears in the service during a race can still never be returned.
import type { HistoryIndex } from "../memory/index.ts";
import { realTimers, type Timers } from "../memory/worker.ts";
import type { Clock } from "../util/clock.ts";
import { classifyError, type Logger } from "../util/log.ts";
import type { OutboxRow, RetrievalOutbox } from "./outbox.ts";
import { pointFor, pointIdOf } from "./points.ts";
import type { RetrievalStore } from "./retrieval-store.ts";
import { LEXICAL_COLLECTION } from "./retrieval-store.ts";

export const SYNC_BATCH = 100;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export interface SyncSummary {
  attempted: number;
  upserted: number;
  removed: number;
  failed: number;
}

export interface SyncerDeps {
  index: HistoryIndex;
  outbox: RetrievalOutbox;
  store: RetrievalStore;
  clock: Clock;
  log: Logger;
  timers?: Timers;
  batch?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export class RetrievalSyncer {
  readonly #d: SyncerDeps;
  readonly #timers: Timers;
  readonly batch: number;
  #loop: Promise<void> | undefined;
  #retry: unknown;
  #failures = 0;
  #down = false;
  #lastError: string | null = null;
  #stopped = false;
  #ready = false;
  #initializing: Promise<void> | undefined;

  constructor(deps: SyncerDeps) {
    this.#d = deps;
    this.#timers = deps.timers ?? realTimers;
    this.batch = deps.batch ?? SYNC_BATCH;
  }

  /** Create the collections Rei expects. Safe to repeat; the server runs it at every start. */
  async ensureCollections(): Promise<void> {
    if (this.#ready) return;
    this.#initializing ??= this.#initialize().finally(() => {
      this.#initializing = undefined;
    });
    await this.#initializing;
  }

  async #initialize(): Promise<void> {
    const collections = await this.#d.store.collections();
    const legacy = this.#d.index.legacyToolPointIds();
    if (legacy.length > 0) await this.#d.store.remove(collections, legacy);
    this.#d.index.finishToolNamespaceUpgrade();
    this.#d.index.recoverRetrieval(collections, LEXICAL_COLLECTION);
    await this.#d.store.ensureLexical();
    this.#ready = true;
  }

  kick(): void {
    if (this.#stopped || this.#loop || this.#retry !== undefined) return;
    if (this.#ready && this.#d.outbox.due(1).length === 0) return;
    this.#loop = this.#run().finally(() => {
      this.#loop = undefined;
    });
  }

  retryNow(): void {
    if (this.#retry !== undefined) {
      this.#timers.clear(this.#retry);
      this.#retry = undefined;
    }
    this.kick();
  }

  async settle(): Promise<void> {
    while (this.#loop) await this.#loop;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retry !== undefined) this.#timers.clear(this.#retry);
    this.#retry = undefined;
  }

  /** Every Rei collection, so a removal cannot miss the generation a vector happens to sit in. */
  async collections(): Promise<string[]> {
    return this.#d.store.collections();
  }

  /** Work off the queue now (the tests want the points gone before the answer comes back). */
  async drainNow(limit = this.batch): Promise<SyncSummary> {
    await this.settle();
    return this.#drain(limit);
  }

  async #run(): Promise<void> {
    for (;;) {
      if (this.#stopped) return;
      const summary = await this.#drain(this.batch).catch((error: unknown) => {
        this.#fail(error);
        return { attempted: 0, upserted: 0, removed: 0, failed: 0 } satisfies SyncSummary;
      });
      if (this.#down) {
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
      if (summary.attempted === 0) return;
      if (summary.failed === summary.attempted) {
        // Everything in this batch failed: the service is not answering. Back off rather than spin.
        this.#fail(new Error("every retrieval update in the batch failed"));
        continue;
      }
      await this.#timers.yield();
    }
  }

  async #drain(limit: number): Promise<SyncSummary> {
    const summary: SyncSummary = { attempted: 0, upserted: 0, removed: 0, failed: 0 };
    await this.ensureCollections();
    const rows = this.#d.outbox.due(limit);
    if (rows.length === 0) {
      this.#ok();
      return summary;
    }
    let collections: string[] | undefined;
    const all = async (): Promise<string[]> => (collections ??= await this.#d.store.collections());
    for (const row of rows) {
      if (this.#stopped) break;
      if (!this.#d.outbox.claim(row.entry_id, row.seq)) continue;
      summary.attempted++;
      try {
        if (row.op === "delete") await this.#remove(row, await all());
        else await this.#upsert(row);
        this.#d.outbox.succeed(row.entry_id, row.seq);
        if (row.op === "delete") summary.removed++;
        else summary.upserted++;
      } catch (error) {
        this.#d.outbox.requeue(row.entry_id, row.seq, error);
        this.#fail(error);
        summary.failed++;
      }
    }
    if (summary.failed === 0) this.#ok();
    return summary;
  }

  async #upsert(row: OutboxRow): Promise<void> {
    const entry = this.#d.index.entryForRetrieval(row.entry_id);
    if (!entry) {
      // Hidden, or its chat deleted since: the only correct answer is to make sure nothing is left indexed.
      await this.#remove(row, await this.#d.store.collections());
      return;
    }
    const point = pointFor(entry, `outbox:${row.seq}`);
    if (!point) {
      this.#d.log.warn("retrieval.entry_unidentifiable", { entryId: row.entry_id });
      return;
    }
    await this.#d.store.upsert(LEXICAL_COLLECTION, [point]);
  }

  async #remove(row: OutboxRow, collections: string[]): Promise<void> {
    const pointId = row.point_id ?? (await this.#currentPointId(row.entry_id));
    if (!pointId) return; // nothing was ever indexed for it
    await this.#d.store.remove(collections, [pointId]);
  }

  /** A delete queued before this build recorded point ids (or a row the caller could not name): ask SQLite, then the entry. */
  async #currentPointId(entryId: number): Promise<string | undefined> {
    const entry = this.#d.index.entryForRetrieval(entryId);
    return entry ? pointIdOf(entry) : undefined;
  }

  #fail(error: unknown): void {
    this.#ready = false;
    this.#down = true;
    this.#failures++;
    this.#lastError = error instanceof Error ? error.message.slice(0, 200) : "the retrieval service failed";
    this.#d.log.warn("retrieval.sync_failed", { failures: this.#failures, ...classifyError(error) });
  }

  #ok(): void {
    if (!this.#down) return;
    this.#down = false;
    this.#failures = 0;
    this.#lastError = null;
  }

  /** What the queue and the service look like from outside, for the status endpoint and `rei doctor`. */
  status(): { pending: number; oldestAgeMs: number | null; lastError: string | null; service: string | null } {
    const counts = this.#d.outbox.counts();
    return {
      pending: counts.pending,
      oldestAgeMs: counts.oldestAgeMs,
      lastError: counts.lastError ?? (this.#down ? this.#lastError : null),
      service: null,
    };
  }
}
