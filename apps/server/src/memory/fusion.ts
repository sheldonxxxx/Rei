// Merging the keyword ranking and the meaning ranking of a query into one: weighted reciprocal rank fusion, with the
// rank on each side kept so a result can say why it matched. Pure; the numbers below were chosen with the eval in
// apps/server/eval/memory (see RESULTS.md there; run it again on every memory or model change).
import { hasIdLikeToken } from "./keyword.ts";

export interface FusionConfig {
  /** score = wv / (k + rank_v) + wk / (k + rank_k), ranks from 1. */
  k: number;
  /** Each side contributes its best `top` results. */
  top: number;
  vectorWeight: number;
  keywordWeight: number;
  /** The keyword weight for a query with an identifier in it (booking code, number, email, URL), where keyword search is the better side. */
  idKeywordWeight: number;
  /** A vector hit below this cosine is dropped before ranking (calibrated about 0.3 for EmbeddingGemma on its no-answer questions). */
  cosineFloor: number;
}

/**
 * The defaults, chosen with the eval in apps/server/eval/memory (numbers in its RESULTS.md): meaning counts double, an
 * identifier in the query doubles the keyword side, and a small k (10, not the textbook 60) so that the best few
 * results of each side count most; k 60 lost 0.10 recall@5 to k 10 on the 75-question set. Run the eval again after any
 * change to the index, the tokenizer or the model.
 */
export const FUSION: FusionConfig = {
  k: 10,
  top: 50,
  vectorWeight: 2,
  keywordWeight: 1,
  idKeywordWeight: 2,
  cosineFloor: 0.3,
};

export interface RankedId {
  id: number;
}
export interface FusedHit {
  id: number;
  score: number;
  /** 1-based; null when that side did not find it. */
  keywordRank: number | null;
  vectorRank: number | null;
  cosine: number | null;
}

/** How a query is searched; the eval compares them. */
export type SearchMode =
  | { kind: "fusion"; vectorWeight?: number; keywordWeight?: number; idBoost?: boolean }
  | { kind: "keyword" }
  | { kind: "vector" };

/**
 * Fuses the two best-first lists. `vector` carries cosines and has already had the floor applied by the caller or is
 * filtered here; either list may be empty (the embedder is down, or the query has no terms).
 */
export function fuse(
  query: string,
  vector: { id: number; cosine: number }[],
  keyword: RankedId[],
  mode: SearchMode = { kind: "fusion" },
  config: FusionConfig = FUSION,
): FusedHit[] {
  const vec = vector.filter((v) => v.cosine >= config.cosineFloor).slice(0, config.top);
  const kw = keyword.slice(0, config.top);
  const hits = new Map<number, FusedHit>();
  const hit = (id: number): FusedHit => {
    let h = hits.get(id);
    if (!h) hits.set(id, (h = { id, score: 0, keywordRank: null, vectorRank: null, cosine: null }));
    return h;
  };
  vec.forEach((v, i) => {
    const h = hit(v.id);
    h.vectorRank = i + 1;
    h.cosine = v.cosine;
  });
  kw.forEach((k, i) => {
    hit(k.id).keywordRank = i + 1;
  });
  let wv = config.vectorWeight;
  let wk = config.keywordWeight;
  if (mode.kind === "keyword") {
    wv = 0;
    wk = 1;
  } else if (mode.kind === "vector") {
    wv = 1;
    wk = 0;
  } else {
    wv = mode.vectorWeight ?? wv;
    wk = mode.keywordWeight ?? wk;
    if ((mode.idBoost ?? true) && mode.keywordWeight === undefined && hasIdLikeToken(query))
      wk = config.idKeywordWeight;
  }
  for (const h of hits.values()) {
    h.score =
      (h.vectorRank !== null ? wv / (config.k + h.vectorRank) : 0) +
      (h.keywordRank !== null ? wk / (config.k + h.keywordRank) : 0);
  }
  // A side with weight 0 only orders what the other side found: drop what only it found.
  return [...hits.values()]
    .filter((h) => h.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.vectorRank ?? 1e9) - (b.vectorRank ?? 1e9) ||
        (a.keywordRank ?? 1e9) - (b.keywordRank ?? 1e9) ||
        a.id - b.id,
    );
}
