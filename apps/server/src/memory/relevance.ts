// Relevance is separate from reciprocal-rank ordering: even the first candidate can be unrelated.
// These are retrieval signals, never a probability that a passage answers the question.

import { FUSION, type FusedHit } from "./fusion.ts";
import { ftsText, hasIdLikeToken, queryTerms } from "./keyword.ts";

export type SearchRelevance = "match" | "related";
const STRONG_SEMANTIC_MATCH = 0.55;
const MAX_POSSIBLE_LEADS = 5;
const COMMON = new Set(
  (
    "a an the and or of to for from in on at by with about as " +
    "i me my mine we us our ours you your yours they them their theirs he she his her it its " +
    "what which when where who whose why how is are am was were be been being do does did " +
    "have has had can could would should will may might must this that these those " +
    "tell please say said know remember recall saved history find search " +
    "我的 我嘅 係咩 什麼 什么 幾多 幾時 幾點 多少 是多 是什 的是 です ます か？"
  ).split(/\s+/),
);

function normalise(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFKC")
    .toLowerCase();
}

/** Full identifier anchors, including punctuation, rather than individual FTS fragments of a code/email/URL. */
function identifiers(query: string): string[] {
  return (
    query.match(/https?:\/\/[^\s<>"'）)]+|[a-z0-9._%+-]+@[a-z0-9.-]+|#[0-9]+|[a-z0-9]+(?:[-_/][a-z0-9]+)*/g) ?? []
  )
    .map((s) => s.replace(/[.,;:!?]+$/, ""))
    .filter(hasIdLikeToken);
}

export interface RelevantHit extends FusedHit {
  relevance: SearchRelevance;
}

/** Preserve ranking among accepted hits, but never fill the result count with weak keyword-only matches. */
export function relevantHits(
  query: string,
  ranked: readonly FusedHit[],
  texts: ReadonlyMap<number, string>,
  semanticAvailable = false,
): RelevantHit[] {
  const q = normalise(query);
  const terms = queryTerms(q).filter((t) => !COMMON.has(t));
  if (!terms.length) return [];
  const anchors = identifiers(q);
  const accepted: RelevantHit[] = [];
  let leads = 0;
  for (const hit of ranked) {
    const raw = texts.get(hit.id);
    if (raw === undefined) continue;
    const text = normalise(raw);
    const words = new Set(ftsText(text).split(" "));
    // A similar booking/invoice/email with a different identifier is not evidence for the requested one.
    if (anchors.length) {
      const found = new Set(identifiers(text));
      if (anchors.some((id) => (/^\d+$/.test(id) ? words.has(id) : found.has(id))))
        accepted.push({ ...hit, relevance: "match" });
      continue;
    }
    const matched = terms.filter((term) => words.has(term)).length;
    const coverage = matched / terms.length;
    const cosine = hit.cosine ?? 0;
    let relevance: SearchRelevance | undefined;
    if (
      (matched === terms.length && terms.length === 1) ||
      (matched >= 2 && coverage >= 0.6) ||
      cosine >= STRONG_SEMANTIC_MATCH
    )
      relevance = "match";
    else if (
      (!semanticAvailable && matched > 0 && coverage >= 0.5) ||
      (hit.vectorRank !== null && cosine >= FUSION.cosineFloor)
    )
      relevance = "related";
    // A few explicitly uncertain leads preserve cross-language discovery without flooding the context.
    if (relevance === "related" && leads++ >= MAX_POSSIBLE_LEADS) continue;
    if (relevance) accepted.push({ ...hit, relevance });
  }
  return accepted;
}
