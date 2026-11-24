// The search index, as the rest of the server sees it. SQLite decides what may be found; this is the part that finds
// it fast. Two families of points, both derived from the same `history_entries` rows:
//
//   lexical  BM25 over the passage, with Rei's own tokenising (so a Chinese or Japanese query behaves the way it does
//            today), and it works with no embedding provider running at all.
//   dense    the configured embedding model's vectors, one collection per model generation, one active alias.
//
// A hit is a lead, never an answer: the caller re-reads every one from SQLite and drops what is hidden, deleted,
// deleted or outside the filter before anyone sees it (see MemoryService.search).
import type { EntryKind } from "../memory/index.ts";

/** The BM25 collection. One per Rei installation: its points are derived from the entries table, not owned by it. */
export const LEXICAL_COLLECTION = "rei_history_lexical_v1";
/** Every Rei collection carries this prefix, so a listing or a delete can be sure it is only touching its own. */
export const COLLECTION_PREFIX = "rei_history_";

/** What a point carries. `text` is the passage as indexed; the caller still has to believe SQLite before showing it. */
export interface RetrievalPayload {
  /** The `history_entries` row this chunk came from, for hydration. */
  entryId: number;
  sourceType: "message" | "tool";
  /** The stable identity of the source: a message id, or the Pi entry id of a tool result. */
  sourceId: string;
  chunkId: string;
  sessionId: string;
  agentId: string;
  kind: EntryKind;
  toolName: string | null;
  createdAt: number;
  text: string;
  /** What BM25 is actually scored on: Rei's tokens for the passage, space separated. */
  tokens: string;
  /** Which write produced this point ("outbox:12", "vectors:3"): enough to tell a stale point's story in a log. */
  writtenBy: string;
}

export interface RetrievalFilters {
  agentId?: string;
  sessionId?: string;
  from?: number;
  to?: number;
}

export interface RetrievalHit {
  /** The service's own id for the point (the logical one comes back in the payload's chunkId). */
  pointId: string;
  score: number;
  payload: RetrievalPayload;
}

export interface SearchOptions {
  filters?: RetrievalFilters;
  limit: number;
}

/**
 * One point to write: a lexical point carries no vector, a dense one carries its own.
 * `pointId` is Rei's identity for the chunk (`m:<message id>:<chunk>` or `t:<session id>:<pi entry id>:<chunk>`) and it is the same
 * for the same chunk forever, so writing it again replaces it; how that is spelled in the service is the service's
 * business (Qdrant wants a UUID, so it derives one from this).
 */
export interface RetrievalPoint {
  pointId: string;
  payload: RetrievalPayload;
  vector?: Float32Array;
}

export interface RetrievalStatus {
  ok: boolean;
  /** What is wrong, in words a human can act on. Never a credential. */
  detail: string | null;
  lexicalCollection: string | null;
  lexicalPoints: number | null;
  /** The dense generations the service holds. Which one is live is SQLite's answer, not this one's. */
  dense: { collection: string; points: number }[];
}

export interface RetrievalStore {
  /** Creates what is missing. Idempotent: it runs at every start, and a half-finished one is fine to repeat. */
  ensureLexical(): Promise<void>;
  ensureDense(collection: string, dims: number): Promise<void>;
  /** Points for these entries (replacing what is already there for the same point id). The caller names the
   * collection, so a rebuild can fill the generation being built while the active one keeps serving. */
  upsert(collection: string, points: RetrievalPoint[]): Promise<void>;
  remove(collections: string[], pointIds: string[]): Promise<void>;
  /** Everything indexed from these sources (a purged session). */
  removeWhere(
    collections: string[],
    filters: RetrievalFilters & { sourceIds?: string[]; sessionIds?: string[] },
  ): Promise<void>;
  searchLexical(query: string, options: SearchOptions): Promise<RetrievalHit[]>;
  searchDense(collection: string, vector: Float32Array, options: SearchOptions): Promise<RetrievalHit[]>;
  count(collection: string): Promise<number>;
  status(): Promise<RetrievalStatus>;
  /** Every Rei collection, so a purge can be sure a point is gone from all of them. */
  collections(): Promise<string[]>;
  dropCollection(collection: string): Promise<void>;
}
