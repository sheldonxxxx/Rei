// A search service for tests: the same interface Qdrant backs, with the parts Rei depends on actually implemented —
// points keyed by their id, filters applied inside the search, and switches to make it refuse or answer wrong.
import { bigramTokens } from "../../src/memory/keyword.ts";
import {
  COLLECTION_PREFIX,
  LEXICAL_COLLECTION,
  type RetrievalFilters,
  type RetrievalHit,
  type RetrievalPoint,
  type RetrievalStatus,
  type RetrievalStore,
  type SearchOptions,
} from "../../src/retrieval/retrieval-store.ts";

export class RetrievalDown extends Error {
  constructor(what = "the search service is not answering") {
    super(what);
    this.name = "RetrievalDown";
  }
}

const matches = (payload: RetrievalPoint["payload"], filters: RetrievalFilters): boolean =>
  (filters.agentId === undefined || payload.agentId === filters.agentId) &&
  (filters.sessionId === undefined || payload.sessionId === filters.sessionId) &&
  (filters.from === undefined || payload.createdAt >= filters.from) &&
  (filters.to === undefined || payload.createdAt <= filters.to);

export class FakeRetrieval implements RetrievalStore {
  /** collection -> point id -> point (the vector, when it has one). */
  readonly points = new Map<string, Map<string, RetrievalPoint>>();
  readonly lexicalQueries: { query: string; filters: RetrievalFilters; limit: number }[] = [];
  readonly denseQueries: { collection: string; filters: RetrievalFilters; limit: number }[] = [];
  /** Fail the next N of these; each failing call leaves the queue's intent in place, as a real outage would. */
  failUpsert = 0;
  failRemove = 0;
  failSearch = 0;
  failEnsure = 0;
  /** Every call fails, the way it does when the service is not there at all. */
  down = false;

  #check(): void {
    if (this.down) throw new RetrievalDown("the search service is not there");
  }

  #collection(name: string): Map<string, RetrievalPoint> {
    const existing = this.points.get(name);
    if (existing) return existing;
    const created = new Map<string, RetrievalPoint>();
    this.points.set(name, created);
    return created;
  }

  /** Every point in a collection, newest id first, whatever it was filtered by: what a test asserts on. */
  stored(collection = LEXICAL_COLLECTION): RetrievalPoint[] {
    return [...(this.points.get(collection)?.values() ?? [])];
  }

  /** A fake that answers a search the way Rei would want it to, ignoring what it holds: for testing SQLite's veto. */
  forced: RetrievalHit[] | undefined;

  async ensureLexical(): Promise<void> {
    this.#check();
    if (this.failEnsure-- > 0) throw new RetrievalDown();
    this.#collection(LEXICAL_COLLECTION);
  }

  async ensureDense(collection: string, dims: number): Promise<void> {
    this.#check();
    if (this.failEnsure-- > 0) throw new RetrievalDown();
    const c = this.#collection(collection);
    c.set(`__dims__${dims}`, { pointId: `__dims__${dims}`, payload: {} as never });
  }

  async upsert(collection: string, points: RetrievalPoint[]): Promise<void> {
    this.#check();
    if (this.failUpsert-- > 0) throw new RetrievalDown("upsert refused");
    const c = this.#collection(collection);
    for (const point of points) c.set(point.pointId, point);
  }

  async remove(collections: string[], pointIds: string[]): Promise<void> {
    this.#check();
    if (this.failRemove-- > 0) throw new RetrievalDown("delete refused");
    for (const collection of collections) for (const id of pointIds) this.points.get(collection)?.delete(id);
  }

  async removeWhere(
    collections: string[],
    filters: RetrievalFilters & { sourceIds?: string[]; sessionIds?: string[] },
  ): Promise<void> {
    this.#check();
    if (this.failRemove-- > 0) throw new RetrievalDown("delete refused");
    if (!filters.sourceIds?.length && !filters.sessionIds?.length && !filters.agentId && !filters.sessionId)
      throw new Error("FakeRetrieval: refusing to delete everything");
    for (const collection of collections) {
      const c = this.points.get(collection);
      if (!c) continue;
      for (const [id, point] of [...c]) {
        const payload = point.payload as RetrievalPoint["payload"] | undefined;
        if (!payload?.entryId) continue;
        if (filters.sourceIds && !filters.sourceIds.includes(payload.sourceId)) continue;
        if (filters.sessionIds && !filters.sessionIds.includes(payload.sessionId)) continue;
        if (!matches(payload, filters)) continue;
        c.delete(id);
      }
    }
  }

  async searchLexical(query: string, options: SearchOptions): Promise<RetrievalHit[]> {
    this.#check();
    if (this.failSearch-- > 0) throw new RetrievalDown("search refused");
    this.lexicalQueries.push({ query, filters: options.filters ?? {}, limit: options.limit });
    if (this.forced) return this.forced;
    const terms = new Set(bigramTokens(query));
    return this.stored()
      .map((point) => ({
        pointId: point.pointId,
        score: [...(point.payload?.tokens ?? "").split(" ")].filter((t) => terms.has(t)).length,
        payload: point.payload,
      }))
      .filter((hit) => hit.score > 0 && matches(hit.payload, options.filters ?? {}))
      .sort((a, b) => b.score - a.score || a.payload.entryId - b.payload.entryId)
      .slice(0, options.limit);
  }

  async searchDense(collection: string, vector: Float32Array, options: SearchOptions): Promise<RetrievalHit[]> {
    this.#check();
    if (this.failSearch-- > 0) throw new RetrievalDown("search refused");
    this.denseQueries.push({ collection, filters: options.filters ?? {}, limit: options.limit });
    if (this.forced) return this.forced;
    return this.stored(collection)
      .filter((point) => point.vector)
      .map((point) => {
        let dot = 0;
        for (let i = 0; i < vector.length; i++) dot += vector[i]! * point.vector![i]!;
        return { pointId: point.pointId, score: dot, payload: point.payload };
      })
      .filter((hit) => matches(hit.payload, options.filters ?? {}))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit);
  }

  async count(collection: string): Promise<number> {
    this.#check();
    return [...(this.points.get(collection)?.keys() ?? [])].filter((id) => !id.startsWith("__dims__")).length;
  }

  /** Like the real client: an unreachable service is an answer, never a thrown error. */
  async status(): Promise<RetrievalStatus> {
    if (this.down)
      return {
        ok: false,
        detail: "the search service is not there",
        lexicalCollection: null,
        lexicalPoints: null,
        dense: [],
      };
    const dense = (await this.collections()).filter((name) => name !== LEXICAL_COLLECTION);
    return {
      ok: this.points.has(LEXICAL_COLLECTION),
      detail: this.points.has(LEXICAL_COLLECTION) ? null : "the lexical collection is missing",
      lexicalCollection: this.points.has(LEXICAL_COLLECTION) ? LEXICAL_COLLECTION : null,
      lexicalPoints: await this.count(LEXICAL_COLLECTION),
      dense: await Promise.all(dense.map(async (collection) => ({ collection, points: await this.count(collection) }))),
    };
  }

  async collections(): Promise<string[]> {
    this.#check();
    return [...this.points.keys()].filter((name) => name.startsWith(COLLECTION_PREFIX));
  }

  async dropCollection(collection: string): Promise<void> {
    this.#check();
    this.points.delete(collection);
  }
}
