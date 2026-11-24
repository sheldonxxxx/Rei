// Passages: a stored page cut into pieces of a few hundred tokens that a question can be ranked against. Each passage lies
// inside one section, keeps that section's heading path, and is a pair of offsets into the page text, so whatever is shown
// from it can be checked against the source. Fenced code blocks and tables are not cut unless one alone is longer than a
// passage (then at line boundaries). Pure and portable; the index lives in documents.ts.
import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import { estimateTokens } from "../memory/text.ts";
import { type Section, TOP_SECTION } from "./sections.ts";

/** A passage closes once it has MIN estimated tokens and the next block would take it past SOFT, or at MAX regardless. */
export const PASSAGE_MIN_TOKENS = 300;
export const PASSAGE_SOFT_TOKENS = 500;
export const PASSAGE_MAX_TOKENS = 800;
/** What query mode shows at most (o200k tokens, passage text only). */
export const PASSAGE_BUDGET_TOKENS = 1_500;
/** A section gets this many passages before any other section's next one. */
export const PASSAGES_PER_SECTION = 2;

export interface Passage {
  /** Order in the page, from 0. */
  ord: number;
  sectionId: string;
  /** The section's headings, outermost first (empty for "top"). */
  path: string[];
  start: number;
  end: number;
  /** Estimated tokens (memory/text.ts). */
  tokens: number;
}

interface Unit {
  start: number;
  end: number;
  cost: number;
}

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const TABLE_ROW = /^[ \t]*\|/;

/** The blocks of text[start, end): a fenced code block, a table, or lines up to a blank line. Offsets include the trailing newlines. */
function blocks(text: string, start: number, end: number): (Unit & { kind: "code" | "table" | "text" })[] {
  const out: (Unit & { kind: "code" | "table" | "text" })[] = [];
  let at = start;
  const lineEnd = (from: number) => {
    const nl = text.indexOf("\n", from);
    return nl < 0 || nl >= end ? end : nl + 1;
  };
  const isBlank = (from: number, to: number) => text.slice(from, to).trim() === "";
  while (at < end) {
    let next = lineEnd(at);
    if (isBlank(at, next)) {
      // Blank lines join the block before them (or are skipped at the start).
      if (out.length > 0) out[out.length - 1]!.end = next;
      at = next;
      continue;
    }
    const line = text.slice(at, next);
    const blockStart = at;
    let kind: "code" | "table" | "text" = "text";
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      kind = "code";
      at = next;
      while (at < end) {
        next = lineEnd(at);
        const closes = text.slice(at, next).trim().startsWith(fence);
        at = next;
        if (closes) break;
      }
    } else if (TABLE_ROW.test(line)) {
      kind = "table";
      while (at < end && TABLE_ROW.test(text.slice(at, lineEnd(at)))) at = lineEnd(at);
    } else {
      while (at < end) {
        next = lineEnd(at);
        const l = text.slice(at, next);
        if (isBlank(at, next) || (at !== blockStart && (FENCE.test(l) || TABLE_ROW.test(l)))) break;
        at = next;
      }
    }
    out.push({ kind, start: blockStart, end: at, cost: estimateTokens(text.slice(blockStart, at)) });
  }
  return out;
}

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** Splits text[start, end) into pieces of at most `limit` estimated tokens: at line ends for code and tables, else at sentences, then characters. */
function split(text: string, start: number, end: number, byLine: boolean, limit: number): Unit[] {
  const pieces: Unit[] = [];
  if (byLine) {
    for (let at = start; at < end; ) {
      const nl = text.indexOf("\n", at);
      const next = nl < 0 || nl >= end ? end : nl + 1;
      pieces.push({ start: at, end: next, cost: estimateTokens(text.slice(at, next)) });
      at = next;
    }
  } else {
    for (const { segment, index } of sentences.segment(text.slice(start, end)))
      pieces.push({ start: start + index, end: start + index + segment.length, cost: estimateTokens(segment) });
  }
  const out: Unit[] = [];
  for (const p of pieces) {
    if (p.cost <= limit) {
      out.push(p);
      continue;
    }
    // One line or sentence longer than a passage: by characters (ASCII a quarter token, anything else one).
    let from = p.start;
    let cost = 0;
    for (let i = p.start; i < p.end; ) {
      const cp = text.codePointAt(i)!;
      const width = cp > 0xffff ? 2 : 1;
      const c = cp < 128 ? 0.25 : 1;
      if (cost + c > limit) {
        out.push({ start: from, end: i, cost: Math.ceil(cost) });
        from = i;
        cost = 0;
      }
      cost += c;
      i += width;
    }
    if (from < p.end) out.push({ start: from, end: p.end, cost: Math.ceil(cost) });
  }
  // Merge the small pieces back up to the limit, so a long table becomes a few passages, not one per row.
  const merged: Unit[] = [];
  for (const u of out) {
    const last = merged[merged.length - 1];
    if (last && last.cost + u.cost <= limit) {
      last.end = u.end;
      last.cost += u.cost;
    } else merged.push({ ...u });
  }
  return merged;
}

/** The page's passages, in order. A page without sections is one "top" section. */
export function passagesOf(text: string, sections: readonly Section[]): Passage[] {
  const secs: readonly Pick<Section, "id" | "path" | "start" | "end">[] =
    sections.length > 0 ? sections : [{ id: TOP_SECTION, path: [], start: 0, end: text.length }];
  const out: Passage[] = [];
  for (const section of secs) {
    const units = blocks(text, section.start, section.end).flatMap((b) =>
      b.cost > PASSAGE_MAX_TOKENS ? split(text, b.start, b.end, b.kind !== "text", PASSAGE_MAX_TOKENS) : [b],
    );
    const groups: Unit[] = [];
    let current: Unit | undefined;
    for (const u of units) {
      if (
        current &&
        (current.cost + u.cost > PASSAGE_MAX_TOKENS ||
          (current.cost >= PASSAGE_MIN_TOKENS && current.cost + u.cost > PASSAGE_SOFT_TOKENS))
      ) {
        groups.push(current);
        current = undefined;
      }
      if (current) {
        current.end = u.end;
        current.cost += u.cost;
      } else current = { ...u };
    }
    if (current) {
      // A short tail joins the passage before it when they fit together.
      const prev = groups[groups.length - 1];
      if (prev && current.cost < PASSAGE_MIN_TOKENS / 2 && prev.cost + current.cost <= PASSAGE_MAX_TOKENS) {
        prev.end = current.end;
        prev.cost += current.cost;
      } else groups.push(current);
    }
    for (const g of groups) {
      // Trailing blank lines are not part of a passage.
      let end = g.end;
      while (end > g.start && /\s/.test(text[end - 1]!)) end--;
      if (end <= g.start) continue;
      out.push({
        ord: out.length,
        sectionId: section.id,
        path: section.path,
        start: g.start,
        end,
        tokens: estimateTokens(text.slice(g.start, end)),
      });
    }
  }
  return out;
}

let tokenizer: Tiktoken | undefined;
/** o200k tokens: what the budget is measured in. */
export function countTokens(text: string): number {
  tokenizer ??= new Tiktoken(o200k);
  return tokenizer.encode(text).length;
}

export interface RankedPassage extends Passage {
  /** bm25 with heading matches weighted up: lower is better. */
  score: number;
}

export interface Selection {
  /** In rank order. */
  passages: (RankedPassage & { exactTokens: number })[];
  /** Sections with matching passages that were not shown, best first. */
  moreSections: string[];
}

/**
 * Picks passages in rank order until the budget is spent, at most PASSAGES_PER_SECTION from a section before every other
 * section has had its turn; a passage that does not fit is skipped for a smaller one further down.
 */
export function selectPassages(
  ranked: readonly RankedPassage[],
  tokensOf: (p: RankedPassage) => number,
  budget: number = PASSAGE_BUDGET_TOKENS,
): Selection {
  const perSection = new Map<string, number>();
  const first: RankedPassage[] = [];
  const later: RankedPassage[] = [];
  for (const p of ranked) {
    const n = perSection.get(p.sectionId) ?? 0;
    perSection.set(p.sectionId, n + 1);
    (n < PASSAGES_PER_SECTION ? first : later).push(p);
  }
  const chosen: (RankedPassage & { exactTokens: number })[] = [];
  let left = budget;
  for (const p of [...first, ...later]) {
    if (left <= 0) break;
    if (p.tokens > left * 2) continue; // far too big by the estimate: skip without counting
    const exact = tokensOf(p);
    if (exact > left) continue;
    chosen.push({ ...p, exactTokens: exact });
    left -= exact;
  }
  const shown = new Set(chosen.map((p) => p.sectionId));
  const moreSections: string[] = [];
  for (const p of ranked)
    if (!shown.has(p.sectionId) && !moreSections.includes(p.sectionId)) moreSections.push(p.sectionId);
  return { passages: chosen, moreSections };
}
