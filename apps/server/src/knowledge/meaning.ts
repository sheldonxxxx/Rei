// Meaning search for Knowledge. Every distinct section text of a live page gets one vector, made by the embedding model
// history search uses (HistoryIndexing.semanticModel) and kept in SQLite beside the page (`knowledge_vectors`). A query
// is compared with all of them in memory and the result is fused with the keyword ranking the way history search does
// it (memory/fusion.ts).
//
// Why not the search service history uses: Knowledge is hundreds or a few thousand sections, a size brute force answers
// in milliseconds, and keeping the vectors in SQLite lets a page write drop the vectors of the sections it changed in
// the same transaction (KnowledgeService.#index). There is no queue to keep in step, nothing to recover after a crash,
// and the same code runs with or without Qdrant. The vectors are derived data: dropping the table loses nothing.
//
// SQLite still decides what may be found: a vector is only ever a lead, re-checked against the live sections of live
// pages before it can become a hit.
import type { KnowledgeMeaningStatus, KnowledgeSearchHit } from "@rei/protocol";
import { blobToVector, EmbedderError, vectorToBlob } from "../memory/embedder.ts";
import { FUSION, type FusionConfig, fuse } from "../memory/fusion.ts";
import { realTimers, type SemanticModel, type Timers } from "../memory/history-indexing.ts";
import { VectorCache } from "../memory/vectors.ts";
import { GLOBAL_STREAM } from "../store/events.ts";
import { classifyError, type Logger } from "../util/log.ts";
import type { KnowledgeSearchOptions, KnowledgeSection, KnowledgeService } from "./service.ts";

export const MEANING_BATCH = 8;
/**
 * History's fusion with equal weights (see search), a higher cosine floor and a band under the best hit. Knowledge has no
 * relevance pass after fusion the way history does (memory/relevance.ts), so these two keep unrelated pages out.
 *
 * Measured with embeddinggemma-2 (6-bit) on the live stack: unrelated queries, nonsense words included, scored
 * 0.52–0.65 against every page, and genuine matches 0.72–0.87. The floor sits between them. The earlier EmbeddingGemma
 * scored unrelated queries lower (0.41–0.52), so a floor of 0.55 let every page through on the new model: recalibrate
 * it whenever the embedding model changes.
 */
export const KNOWLEDGE_FUSION: FusionConfig = { ...FUSION, vectorWeight: 1, cosineFloor: 0.7 };
/**
 * A meaning hit must also be within this much of the best one: a floor alone cannot tell "the second page is related
 * too" from "the best page scored 0.84 and everything else is noise a little above the floor" (0.67 against 0.84 on the
 * live stack). Keyword hits are not held to it.
 */
export const MEANING_BAND = 0.1;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** The text a section's vector is made from: its heading path and text, under the page title. */
export function embedText(title: string, path: string, text: string): string {
  if (path) return `${title} › ${path}\n${text}`;
  // The title-and-description row already starts with the title.
  return text === title || text.startsWith(`${title}\n`) ? text : `${title}\n${text}`;
}

/** The key a section's vector is stored under: a hash of the text that was embedded, so an edit tells which changed. */
export function sectionKey(title: string, path: string, text: string): string {
  // cyrb53: 53 bits are plenty to tell apart the sections of one page (keys are only compared within a page).
  const input = embedText(title, path, text);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface KnowledgeMeaningDeps {
  knowledge: KnowledgeService;
  /** The model meaning search uses now; undefined while it is off. Read on every pass, so switching it takes effect. */
  model: () => SemanticModel | undefined;
  log: Logger;
  timers?: Timers;
  batch?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  fusion?: FusionConfig;
  /** Overrides MEANING_BAND (tests with a fake embedder on another scale). */
  band?: number;
}

type Pending = { pageId: string; key: string; text: string };
/** One model's vectors in memory: slot n of the cache is ids[n]. */
type Loaded = { key: string; cache: VectorCache; ids: { pageId: string; key: string }[]; slots: Map<string, number> };

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : "The embedding model failed.").slice(0, 200);

export class KnowledgeMeaning {
  readonly #d: KnowledgeMeaningDeps;
  readonly #timers: Timers;
  readonly #batch: number;
  #loop: Promise<void> | undefined;
  #retry: unknown;
  #failures = 0;
  #down = false;
  #lastError: string | null = null;
  /** Why the last search could not embed its query, until a later call to the model works: the header tells the truth. */
  #queryError: string | null = null;
  #stopped = false;
  #unsubscribe: (() => void) | undefined;
  /** The model key whose vectors are complete, until a page changes or the model does. */
  #settledKey: string | undefined;
  /** Sections the model refused (a 4xx for that input): skipped until their text changes, not retried forever. */
  readonly #refused = new Set<string>();
  #cache: Loaded | undefined;
  #cacheStale = true;

  constructor(deps: KnowledgeMeaningDeps) {
    this.#d = deps;
    this.#timers = deps.timers ?? realTimers;
    this.#batch = deps.batch ?? MEANING_BATCH;
  }

  get #db() {
    return this.#d.knowledge.store.db;
  }

  /** Follows page writes and model switches on the event stream, and catches up on what is missing. */
  start(): void {
    this.#stopped = false;
    this.#unsubscribe = this.#d.knowledge.store.events.subscribe(GLOBAL_STREAM, (event) => {
      if (event.type === "knowledge.changed") {
        this.#settledKey = undefined;
        this.#cacheStale = true;
        this.kick();
      } else if (event.type === "memory.changed" && this.#d.model()?.key !== this.#settledKey) this.kick();
    });
    this.kick();
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#retry !== undefined) this.#timers.clear(this.#retry);
    this.#retry = undefined;
  }

  /** Work may be waiting: start the loop unless it runs, is backing off, or has nothing to do. */
  kick(): void {
    if (this.#stopped || this.#loop || this.#retry !== undefined) return;
    const model = this.#d.model();
    if (!model || model.key === this.#settledKey) return;
    this.#loop = this.#run().finally(() => {
      this.#loop = undefined;
    });
  }

  /** Resolves when nothing is left to embed (or the model is down and waiting out its backoff). Tests and the eval. */
  async settle(): Promise<void> {
    this.kick();
    while (this.#loop) await this.#loop;
  }

  async #run(): Promise<void> {
    for (;;) {
      if (this.#stopped) return;
      const model = this.#d.model();
      if (!model) return;
      let outcome: "more" | "done" | "down";
      try {
        outcome = await this.#step(model);
      } catch (error) {
        this.#d.log.error("knowledge.meaning_failed", classifyError(error));
        return;
      }
      if (outcome === "done") {
        this.#settledKey = model.key;
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
      await this.#timers.yield();
    }
  }

  /** The sections of live pages that have no vector from this model (refused ones aside). */
  #pending(modelKey: string): { pending: Pending[]; sections: number; embedded: number } {
    const have = new Set(
      this.#db
        .all<{ page_id: string; hash: string }>(
          "SELECT page_id, hash FROM knowledge_vectors WHERE model_key = ?",
          modelKey,
        )
        .map((r) => `${r.page_id}\u0000${r.hash}`),
    );
    const seen = new Set<string>();
    const pending: Pending[] = [];
    let embedded = 0;
    for (const s of this.#d.knowledge.indexedSections()) {
      const id = `${s.pageId}\u0000${s.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (have.has(id)) embedded++;
      else if (!this.#refused.has(`${modelKey}\u0000${id}`))
        pending.push({ pageId: s.pageId, key: s.key, text: embedText(s.title, s.path, s.text) });
    }
    return { pending, sections: seen.size, embedded };
  }

  async #step(model: SemanticModel): Promise<"more" | "done" | "down"> {
    // Vectors of another model can never be compared with this one's queries.
    if (this.#db.run("DELETE FROM knowledge_vectors WHERE model_key <> ?", model.key).changes > 0)
      this.#cacheStale = true;
    const batch = this.#pending(model.key).pending.slice(0, this.#batch);
    if (batch.length === 0) {
      this.#ok();
      return "done";
    }
    let vectors: Float32Array[];
    try {
      vectors = await model.embedDocuments(batch.map((p) => p.text));
    } catch (error) {
      if (!(error instanceof EmbedderError)) throw error;
      if (error.kind !== "client") return this.#fail(error);
      // The model refused something in the batch: find which, one at a time, and set those aside.
      vectors = [];
      for (const p of batch) {
        try {
          const [v] = await model.embedDocuments([p.text]);
          vectors.push(v!);
        } catch (one) {
          if (!(one instanceof EmbedderError)) throw one;
          if (one.kind !== "client") return this.#fail(one);
          this.#refused.add(`${model.key}\u0000${p.pageId}\u0000${p.key}`);
          this.#d.log.warn("knowledge.meaning_refused", { pageId: p.pageId });
          vectors.push(new Float32Array(0));
        }
      }
    }
    if (this.#d.model()?.key !== model.key) return "more"; // switched while embedding: start again with the new one
    this.#store(model.key, batch, vectors);
    this.#ok();
    return "more";
  }

  /** Stores what is still current: a page may have been edited or trashed while the model was working. */
  #store(modelKey: string, batch: Pending[], vectors: Float32Array[]): void {
    const pageIds = [...new Set(batch.map((p) => p.pageId))];
    const live = new Set(this.#d.knowledge.indexedSections(pageIds).map((s) => `${s.pageId}\u0000${s.key}`));
    this.#db.transaction(() => {
      batch.forEach((p, i) => {
        const v = vectors[i];
        if (!v || v.length === 0 || !live.has(`${p.pageId}\u0000${p.key}`)) return;
        this.#db.run(
          "INSERT OR REPLACE INTO knowledge_vectors (page_id, hash, model_key, vec) VALUES (?, ?, ?, ?)",
          p.pageId,
          p.key,
          modelKey,
          vectorToBlob(v),
        );
        this.#cacheSet(modelKey, p.pageId, p.key, v);
      });
    });
  }

  #fail(error: unknown): "down" {
    this.#down = true;
    this.#failures++;
    this.#lastError = errorText(error);
    this.#d.log.warn("knowledge.meaning_down", { failures: this.#failures, ...classifyError(error) });
    return "down";
  }

  #ok(): void {
    this.#down = false;
    this.#failures = 0;
    this.#lastError = null;
    this.#queryError = null;
  }

  status(): KnowledgeMeaningStatus {
    const model = this.#d.model();
    if (!model) return { state: "off", sections: 0, embedded: 0, lastError: null };
    const { pending, sections, embedded } = this.#pending(model.key);
    const state = this.#down || this.#queryError ? "down" : pending.length > 0 ? "indexing" : "ready";
    return { state, sections, embedded, lastError: this.#lastError ?? this.#queryError };
  }

  // ---- search ------------------------------------------------------------------------------------------------------

  #cacheSet(modelKey: string, pageId: string, key: string, vector: Float32Array): void {
    const c = this.#cache;
    if (!c || c.key !== modelKey || c.cache.dims !== vector.length) {
      this.#cacheStale = true;
      return;
    }
    const id = `${pageId}\u0000${key}`;
    let slot = c.slots.get(id);
    if (slot === undefined) {
      slot = c.ids.length;
      c.ids.push({ pageId, key });
      c.slots.set(id, slot);
    }
    c.cache.set(slot, vector);
  }

  /** The vectors of this model, in memory. Reloaded after a page change, since a write may have dropped some. */
  #vectors(modelKey: string): Loaded | undefined {
    if (this.#cache && this.#cache.key === modelKey && !this.#cacheStale) return this.#cache;
    const rows = this.#db.all<{ page_id: string; hash: string; vec: Uint8Array }>(
      "SELECT page_id, hash, vec FROM knowledge_vectors WHERE model_key = ?",
      modelKey,
    );
    this.#cacheStale = false;
    const first = rows[0];
    if (!first) {
      this.#cache = undefined;
      return undefined;
    }
    const cache = new VectorCache(first.vec.byteLength / 4, Math.max(16, rows.length));
    const ids: { pageId: string; key: string }[] = [];
    const slots = new Map<string, number>();
    for (const r of rows) {
      const v = blobToVector(r.vec);
      if (v.length !== cache.dims) continue;
      slots.set(`${r.page_id}\u0000${r.hash}`, ids.length);
      cache.set(ids.length, v);
      ids.push({ pageId: r.page_id, key: r.hash });
    }
    this.#cache = { key: modelKey, cache, ids, slots };
    return this.#cache;
  }

  /** The meaning ranking: best section per live page, best first, with its cosine. Empty when the model is off or down. */
  async #meaningSections(
    query: string,
    allowed: Set<string> | undefined,
  ): Promise<(KnowledgeSection & { cosine: number })[]> {
    const model = this.#d.model();
    if (!model) return [];
    let q: Float32Array;
    try {
      q = await model.embedQuery(query);
      this.#queryError = null;
    } catch (error) {
      if (!(error instanceof EmbedderError)) throw error;
      this.#queryError = errorText(error);
      this.#d.log.warn("knowledge.meaning_query_failed", { kind: error.kind });
      return [];
    }
    const vectors = this.#vectors(model.key);
    if (!vectors || q.length !== vectors.cache.dims) return [];
    const near = vectors.cache
      .search(q, vectors.ids.length, (slot) => {
        const id = vectors.ids[slot];
        return !!id && (!allowed || allowed.has(id.pageId));
      })
      .flatMap((n) => {
        const id = vectors.ids[n.id];
        return id && (!allowed || allowed.has(id.pageId)) ? [{ ...id, cosine: n.cosine }] : [];
      });
    // SQLite decides: the section must still be there, with the text the vector was made from, on a live page.
    const live = new Map<string, KnowledgeSection>();
    for (const s of this.#d.knowledge.indexedSections([...new Set(near.map((n) => n.pageId))]))
      if (!live.has(`${s.pageId}\u0000${s.key}`)) live.set(`${s.pageId}\u0000${s.key}`, s);
    const out: (KnowledgeSection & { cosine: number })[] = [];
    const seen = new Set<string>();
    for (const n of near) {
      const s = live.get(`${n.pageId}\u0000${n.key}`);
      if (!s || seen.has(n.pageId)) continue;
      seen.add(n.pageId);
      out.push({ pageId: s.pageId, section: s.section, path: s.path, text: s.text, cosine: n.cosine });
    }
    return out;
  }

  /** Keyword and meaning rankings fused by page. Keyword alone when the model is off, down or has nothing yet. */
  async search(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeSearchHit[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 8, 30));
    const knowledge = this.#d.knowledge;
    const config = this.#d.fusion ?? KNOWLEDGE_FUSION;
    // An unknown or trashed subtree fails here, before the model is asked anything.
    let allowed = knowledge.searchPages(options);
    const meaning = await this.#meaningSections(query, allowed);
    // Everything after the await is synchronous, and a page trashed while the query was embedded is dropped.
    allowed = knowledge.searchPages(options);
    const keyword = knowledge.keywordSections(query, allowed, config.top);
    const live = meaning.filter(
      (m) => knowledge.page(m.pageId)?.trashed_at === null && (!allowed || allowed.has(m.pageId)),
    );
    // Best first, so the first hit above the floor sets the band the rest must stay within.
    const best = live.find((m) => m.cosine >= config.cosineFloor)?.cosine;
    const vector = best === undefined ? [] : live.filter((m) => m.cosine >= best - (this.#d.band ?? MEANING_BAND));
    const ids = new Map<string, number>();
    const idOf = (pageId: string): number => {
      const known = ids.get(pageId);
      if (known !== undefined) return known;
      ids.set(pageId, ids.size);
      return ids.size - 1;
    };
    const fused = fuse(
      query,
      vector.map((m) => ({ id: idOf(m.pageId), cosine: m.cosine })),
      keyword.map((k) => ({ id: idOf(k.pageId) })),
      { kind: "fusion" },
      config,
    );
    const pageOf = [...ids.keys()];
    const out: KnowledgeSearchHit[] = [];
    for (const f of fused) {
      const pageId = pageOf[f.id]!;
      const page = knowledge.page(pageId);
      if (!page || page.trashed_at !== null) continue;
      const section = f.keywordRank !== null ? keyword[f.keywordRank - 1]! : vector.find((m) => m.pageId === pageId)!;
      const matched: KnowledgeSearchHit["matched"] = [];
      if (f.keywordRank !== null) matched.push("keyword");
      if (f.vectorRank !== null) matched.push("meaning");
      out.push(knowledge.hitFor(section, query, matched));
      if (out.length >= limit) break;
    }
    return out;
  }
}
