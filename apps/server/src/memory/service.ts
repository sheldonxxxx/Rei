// Memory profile editing and search presentation. History indexing owns ingestion, lookup and lifecycle.
import type { HistoryHit, TaintLabel } from "@rei/protocol";
import type { BlobStore } from "../blobs/blob-store.ts";
import { badRequest } from "../util/errors.ts";
import { fuse, type SearchMode } from "./fusion.ts";
import { HistoryIndexing, type HistoryIndexingDeps, type SearchFilters } from "./history-indexing.ts";
import { queryTerms } from "./keyword.ts";
import { MemoryLines } from "./lines.ts";
import { relevantHits } from "./relevance.ts";
import { snippetAround } from "./text.ts";

export interface MemoryServiceDeps extends Omit<HistoryIndexingDeps, "onPurgeSession"> {
  traceBlobs: BlobStore;
}

export interface SearchInput {
  query: string;
  from?: number;
  to?: number;
  /** Only this agent's chats and sessions (an agent id); default every agent's. */
  agentId?: string;
  /** Tool callers exclude their current request: a search question is not past evidence for its own answer. */
  excludeMessageId?: string;
  /** 1 to 50; default 20. */
  limit?: number;
  /** Eval only: the keyword-only, vector-only and weighted variants. */
  mode?: SearchMode;
}

export class MemoryService {
  readonly store: HistoryIndexingDeps["store"];
  readonly traceBlobs: BlobStore;
  readonly lines: MemoryLines;
  readonly history: HistoryIndexing;

  constructor(deps: MemoryServiceDeps) {
    this.store = deps.store;
    this.traceBlobs = deps.traceBlobs;
    this.lines = new MemoryLines(deps.store);
    this.history = new HistoryIndexing({ ...deps, onPurgeSession: (id) => this.lines.purgeSession(id) });
  }

  start(): void {
    this.history.start();
  }
  stop(): void {
    this.history.stop();
  }

  // ---- search ------------------------------------------------------------------------------------------------------

  /**
   * Keyword and meaning search, fused. With a search service configured, both sides ask it (filters and all, before it
   * chooses its top-K) and every candidate is checked against SQLite before it can become a hit. Without one — faux
   * mode, or the service not answering — the same query runs on Rei's own index inside SQLite.
   */
  async search(input: SearchInput): Promise<HistoryHit[]> {
    const query = input.query.trim();
    if (query === "") throw badRequest("bad_query", "Give something to search for.");
    const filters: SearchFilters = {
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    };
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 20)));
    const mode = input.mode ?? { kind: "fusion" };
    const keyword = mode.kind === "vector" ? [] : await this.history.keywordSearch(query, filters);
    const vector = mode.kind === "keyword" ? [] : await this.history.vectorSearch(query, filters);
    const fused = fuse(query, vector, keyword, mode);
    const rows = this.history.hydrate(fused.map((hit) => hit.id));
    const texts = new Map(
      [...rows].filter(([, row]) => row.message_id !== input.excludeMessageId).map(([id, row]) => [id, row.text]),
    );
    const relevant = relevantHits(query, fused, texts, vector.length > 0).slice(0, limit);
    const relevance = new Map(relevant.map((hit) => [hit.id, hit.relevance]));
    return this.hits(query, relevant).map((hit) => ({
      ...hit,
      relevance: relevance.get(Number(hit.chunkId.slice(1)))!,
    }));
  }

  /** Search hits for ranked entries (the snippet is cut around the query's terms). */
  hits(
    query: string,
    ranked: readonly {
      id: number;
      score: number;
      keywordRank: number | null;
      vectorRank: number | null;
      cosine: number | null;
    }[],
  ): HistoryHit[] {
    const rows = this.history.hydrate(ranked.map((f) => f.id));
    const terms = queryTerms(query);
    const hits: HistoryHit[] = [];
    for (const f of ranked) {
      const row = rows.get(f.id);
      if (!row) continue;
      hits.push({
        chunkId: `h${row.id}`,
        sessionId: row.session_id,
        sessionTitle: row.title,
        agentId: row.agent_id,
        messageId: row.message_id,
        kind: row.kind,
        toolName: row.tool_name,
        snippet: snippetAround(row.text, terms),
        createdAt: row.created_at,
        score: f.score,
        keywordRank: f.keywordRank,
        vectorRank: f.vectorRank,
        cosine: f.cosine,
        // Your own words carry no label; anything else carries the labels of the chat it came from.
        taint: row.kind === "user" ? [] : (JSON.parse(row.taint) as TaintLabel[]),
      });
    }
    return hits;
  }
}
