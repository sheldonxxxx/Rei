// The Qdrant client and its two collections. REST over fetch, because the API Rei needs (collections, payload indexes,
// upserts, a BM25 text query, a filtered dense query) is JSON, and a hand-written client keeps the exact request bodies
// that Qdrant's BM25-on-full-text-index feature (1.20+) requires visible and testable.
//
// Lexical points carry no vector: the collection is payload-only (`vectors: {}`, points with `vector: {}`), so keyword
// search works whether or not an embedding model is configured. The dense collections are one per model generation,
// named after the vector set they hold: which of them is live is SQLite's answer (memory_vector_sets.status), so the
// service is never asked to keep a second answer in step.
import type {
  RetrievalFilters,
  RetrievalHit,
  RetrievalPayload,
  RetrievalPoint,
  RetrievalStatus,
  RetrievalStore,
  SearchOptions,
} from "../retrieval/retrieval-store.ts";

export interface QdrantConfig {
  /** Absolute http(s) URL, e.g. http://qdrant:6333. */
  url: string;
  /** Only a check of the live service needs another lexical collection; Rei uses the one it names. */
  lexicalCollection?: string;
  apiKey: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** What Qdrant answers when something is wrong; the caller decides whether it is worth retrying. */
export class RetrievalError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RetrievalError";
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500 || status === 0;
  }
}

import { queryTerms } from "../memory/keyword.ts";
import { COLLECTION_PREFIX, LEXICAL_COLLECTION } from "../retrieval/retrieval-store.ts";

/** The field BM25 scores on. Rei's own tokens go in it (see memory/keyword.ts), so CJK behaves as it does today. */
const TEXT_FIELD = "tokens";
const BATCH = 256;

/**
 * Qdrant's own point id, derived from the chunk's identity: a version-5-shaped UUID from SHA-1 of the identity string,
 * with the version and variant bits set. Deterministic, so the same chunk of the same message is always the same point
 * and a re-index replaces it rather than adding another — and it is a form Qdrant accepts, which `m:msg_…:0` is not.
 */
export async function qdrantPointId(pointId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-1", new TextEncoder().encode(pointId) as Uint8Array<ArrayBuffer>),
  );
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Qdrant's full-text index with BM25 scoring, on Rei's pre-tokenised text. */
const TEXT_INDEX = {
  field_name: TEXT_FIELD,
  field_schema: { type: "text", tokenizer: "word", lowercase: true, scoring: true },
};
const KEYWORD_INDEXES = ["source_type", "source_id", "session_id", "agent_id", "kind"].map((field) => ({
  field_name: field,
  field_schema: "keyword",
}));
const CREATED_AT_INDEX = { field_name: "created_at", field_schema: "integer" };

const filterFor = (filters: RetrievalFilters & { sourceIds?: string[]; sessionIds?: string[] }) => {
  const must: Record<string, unknown>[] = [];
  if (filters.agentId !== undefined) must.push({ key: "agent_id", match: { any: [filters.agentId] } });
  if (filters.sessionId !== undefined) must.push({ key: "session_id", match: { any: [filters.sessionId] } });
  if (filters.sourceIds?.length) must.push({ key: "source_id", match: { any: filters.sourceIds } });
  if (filters.sessionIds?.length) must.push({ key: "session_id", match: { any: filters.sessionIds } });
  const range: Record<string, number> = {};
  if (filters.from !== undefined) range.gte = filters.from;
  if (filters.to !== undefined) range.lte = filters.to;
  if (Object.keys(range).length > 0) must.push({ key: "created_at", range });
  return must.length ? { must } : undefined;
};

/** The payload Qdrant holds, in the snake_case the collection's indexes are built on, and back again. */
const toPoint = (input: { pointId: string; payload: RetrievalPayload; vector?: Float32Array }) => ({
  id: input.pointId, // already in Qdrant's form
  vector: input.vector ? Array.from(input.vector) : {},
  payload: {
    entry_id: input.payload.entryId,
    source_type: input.payload.sourceType,
    source_id: input.payload.sourceId,
    chunk_id: input.payload.chunkId,
    session_id: input.payload.sessionId,
    agent_id: input.payload.agentId,
    kind: input.payload.kind,
    tool_name: input.payload.toolName,
    created_at: input.payload.createdAt,
    text: input.payload.text,
    tokens: input.payload.tokens,
    written_by: input.payload.writtenBy,
  },
});

const fromPoint = (point: { id: string | number; score?: number; payload?: Record<string, unknown> }): RetrievalHit => {
  const p = point.payload ?? {};
  return {
    pointId: String(point.id),
    score: point.score ?? 0,
    payload: {
      entryId: Number(p.entry_id ?? 0),
      sourceType: (p.source_type as string) === "tool" ? "tool" : "message",
      sourceId: String(p.source_id ?? ""),
      chunkId: String(p.chunk_id ?? ""),
      sessionId: String(p.session_id ?? ""),
      agentId: String(p.agent_id ?? ""),
      kind: p.kind as RetrievalPayload["kind"],
      toolName: p.tool_name == null ? null : String(p.tool_name),
      createdAt: Number(p.created_at ?? 0),
      text: String(p.text ?? ""),
      tokens: String(p.tokens ?? ""),
      writtenBy: String(p.written_by ?? ""),
    },
  };
};

export class QdrantStore implements RetrievalStore {
  readonly url: string;
  readonly lexicalCollection: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly backoffMs: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(config: QdrantConfig) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new RetrievalError(0, `Invalid Qdrant URL "${config.url}".`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new RetrievalError(0, "Qdrant's URL must be http(s).");
    if (!config.apiKey) throw new RetrievalError(0, "Qdrant needs an API key.");
    this.url = url.origin;
    this.lexicalCollection = config.lexicalCollection ?? LEXICAL_COLLECTION;
    if (!this.lexicalCollection.startsWith(COLLECTION_PREFIX))
      throw new RetrievalError(
        0,
        `A Rei collection must be named ${COLLECTION_PREFIX}<name>, not "${this.lexicalCollection}".`,
      );
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.retries = config.retries ?? 2;
    this.backoffMs = config.backoffMs ?? 200;
    this.#apiKey = config.apiKey;
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
    this.#sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
  }

  async #request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    let last: RetrievalError = new RetrievalError(0, `Qdrant ${method} ${path} failed.`);
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.#sleep(this.backoffMs * 2 ** (attempt - 1));
      let response: Response;
      try {
        response = await this.#fetch(`${this.url}${path}`, {
          method,
          headers: { "api-key": this.#apiKey, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        last = new RetrievalError(
          0,
          `Qdrant ${method} ${path} → ${error instanceof Error ? error.message : "unreachable"}`,
        );
        continue;
      }
      const text = await response.text();
      if (response.ok) {
        try {
          return text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          throw new RetrievalError(0, `Qdrant answered ${method} ${path} with something that is not JSON.`);
        }
      }
      const detail = /"error":\s*"([^"]{0,200})/.exec(text)?.[1] ?? text.slice(0, 160);
      last = new RetrievalError(response.status, `Qdrant ${method} ${path} → ${response.status} ${detail}`);
      if (!last.retryable) throw last;
    }
    throw last;
  }

  async #exists(collection: string): Promise<boolean> {
    try {
      await this.#request("GET", `/collections/${collection}`);
      return true;
    } catch (error) {
      if (error instanceof RetrievalError && error.status === 404) return false;
      throw error;
    }
  }

  async ensureLexical(): Promise<void> {
    if (!(await this.#exists(this.lexicalCollection)))
      await this.#request("PUT", `/collections/${this.lexicalCollection}`, { vectors: {} });
    for (const index of [TEXT_INDEX, ...KEYWORD_INDEXES, CREATED_AT_INDEX])
      await this.#request("PUT", `/collections/${this.lexicalCollection}/index?wait=true`, index);
  }

  async ensureDense(collection: string, dims: number): Promise<void> {
    if (dims < 1 || !Number.isSafeInteger(dims)) throw new RetrievalError(0, `Invalid vector dimensions ${dims}.`);
    if (!(await this.#exists(collection)))
      await this.#request("PUT", `/collections/${collection}`, { vectors: { size: dims, distance: "Cosine" } });
    for (const index of [...KEYWORD_INDEXES, CREATED_AT_INDEX])
      await this.#request("PUT", `/collections/${collection}/index?wait=true`, index);
  }

  /** Points to write: the logical point id each one carries becomes Qdrant's id on the way out. */
  async upsert(collection: string, points: RetrievalPoint[]): Promise<void> {
    if (points.length === 0) return;
    for (let at = 0; at < points.length; at += BATCH) {
      const batch = points.slice(at, at + BATCH);
      const ids = await Promise.all(batch.map((point) => qdrantPointId(point.pointId)));
      await this.#request("PUT", `/collections/${collection}/points?wait=true`, {
        points: batch.map((point, i) => toPoint({ ...point, pointId: ids[i]! })),
      });
    }
  }

  async remove(collections: string[], pointIds: string[]): Promise<void> {
    if (pointIds.length === 0) return;
    const ids = await Promise.all(pointIds.map((pointId) => qdrantPointId(pointId)));
    for (const collection of collections)
      await this.#request("POST", `/collections/${collection}/points/delete?wait=true`, { points: ids, wait: true });
  }

  async removeWhere(
    collections: string[],
    filters: RetrievalFilters & { sourceIds?: string[]; sessionIds?: string[] },
  ): Promise<void> {
    const filter = filterFor(filters);
    if (!filter) throw new RetrievalError(0, "Refusing to delete every point: no filter was given.");
    for (const collection of collections)
      await this.#request("POST", `/collections/${collection}/points/delete?wait=true`, { filter, wait: true });
  }

  /**
   * A BM25 query over Rei's tokens. The query is split the same way the passages were (see memory/keyword.ts): Qdrant's
   * own tokenizer would see a run of Chinese as one word, and a query in Chinese would find nothing.
   * Filters run inside Qdrant, before the top-K is chosen.
   */
  async searchLexical(query: string, options: SearchOptions): Promise<RetrievalHit[]> {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const filter = filterFor(options.filters ?? {});
    const response = await this.#request("POST", `/collections/${this.lexicalCollection}/points/query`, {
      query: { text: terms.join(" ") },
      using: TEXT_FIELD,
      limit: options.limit,
      with_payload: true,
      ...(filter ? { filter } : {}),
    });
    return this.#hits(response);
  }

  async searchDense(collection: string, vector: Float32Array, options: SearchOptions): Promise<RetrievalHit[]> {
    const filter = filterFor(options.filters ?? {});
    const response = await this.#request("POST", `/collections/${collection}/points/query`, {
      query: Array.from(vector),
      limit: options.limit,
      with_payload: true,
      ...(filter ? { filter } : {}),
    });
    return this.#hits(response);
  }

  #hits(response: Record<string, unknown>): RetrievalHit[] {
    const result = response.result as
      | { points?: { id: string | number; score?: number; payload?: Record<string, unknown> }[] }
      | undefined;
    return (result?.points ?? []).map(fromPoint);
  }

  async count(collection: string): Promise<number> {
    const response = await this.#request("POST", `/collections/${collection}/points/count`, { exact: true });
    return Number((response.result as { count?: number } | undefined)?.count ?? 0);
  }

  async status(): Promise<RetrievalStatus> {
    try {
      const lexical = await this.#exists(this.lexicalCollection);
      const dense = (await this.collections()).filter((name) => name !== this.lexicalCollection);
      return {
        ok: lexical,
        detail: lexical ? null : "the lexical collection is missing",
        lexicalCollection: lexical ? this.lexicalCollection : null,
        lexicalPoints: lexical ? await this.count(this.lexicalCollection) : null,
        dense: await Promise.all(
          dense.map(async (collection) => ({ collection, points: await this.count(collection) })),
        ),
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message.slice(0, 200) : "unreachable",
        lexicalCollection: null,
        lexicalPoints: null,
        dense: [],
      };
    }
  }

  async collections(): Promise<string[]> {
    const response = await this.#request("GET", "/collections");
    const names = ((response.result as { collections?: { name: string }[] } | undefined)?.collections ?? []).map(
      (c) => c.name,
    );
    return names.filter((name) => name.startsWith(COLLECTION_PREFIX));
  }

  async dropCollection(collection: string): Promise<void> {
    if (!collection.startsWith(COLLECTION_PREFIX))
      throw new RetrievalError(0, `Refusing to drop "${collection}": not a Rei collection.`);
    await this.#request("DELETE", `/collections/${collection}?wait=true`);
  }
}
