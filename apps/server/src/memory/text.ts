// Text helpers for memory: the token estimate and the splitting of long text into chunks. Web APIs only.

/** A chunk holds at most this many estimated tokens, and the next chunk starts about OVERLAP tokens before the end of the last one. */
export const CHUNK_TOKENS = 256;
export const CHUNK_OVERLAP_TOKENS = 32;

/**
 * Estimated tokens: ASCII characters / 4 plus one per other character. The first suits English; CJK text is about one
 * token per character with the tokenizers in use (measured 8 to 10% either way, which the 256 limit leaves room for).
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** Paragraphs, then sentences, each piece keeping its own trailing whitespace so that joining the pieces gives the text back. */
function pieces(text: string): string[] {
  const out: string[] = [];
  for (const paragraph of text.match(/[^\n]*\n*/g) ?? []) {
    if (paragraph === "") continue;
    if (estimateTokens(paragraph) <= CHUNK_TOKENS) {
      out.push(paragraph);
      continue;
    }
    for (const { segment } of sentences.segment(paragraph)) out.push(segment);
  }
  return out;
}

/** Splits one piece that is over the limit by characters, at a space when there is one near the end. */
function hardSplit(piece: string, limit: number): string[] {
  const out: string[] = [];
  let rest = piece;
  while (estimateTokens(rest) > limit) {
    let cost = 0;
    let end = 0;
    let lastSpace = -1;
    for (const ch of rest) {
      const next = cost + (ch.charCodeAt(0) < 128 ? 0.25 : 1);
      if (next > limit) break;
      cost = next;
      end += ch.length;
      if (ch === " " || ch === "\n") lastSpace = end;
    }
    if (end === 0) end = 1;
    // Cut at the last space of the final fifth, so a word is not split when it need not be.
    const cut = lastSpace > end * 0.8 ? lastSpace : end;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== "") out.push(rest);
  return out;
}

/** The tail of `text` of about `tokens` tokens, starting at a space when there is one. */
function tailOf(text: string, tokens: number): string {
  let cost = 0;
  let start = text.length;
  const chars = [...text];
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i]!;
    cost += c.charCodeAt(0) < 128 ? 0.25 : 1;
    if (cost > tokens) break;
    start -= c.length;
  }
  const space = text.indexOf(" ", start);
  return space >= 0 && space < text.length - 1 ? text.slice(space + 1) : text.slice(start);
}

/**
 * Splits text over CHUNK_TOKENS into chunks of at most that many estimated tokens, at paragraph and sentence boundaries,
 * each starting with about CHUNK_OVERLAP_TOKENS of the end of the one before so that a fact on a boundary is whole in one
 * of them. Text that fits is one chunk. Chunks are trimmed; none is empty.
 */
export function chunkText(text: string): string[] {
  if (estimateTokens(text) <= CHUNK_TOKENS) {
    const whole = text.trim();
    return whole === "" ? [] : [whole];
  }
  const units = pieces(text).flatMap((p) => (estimateTokens(p) > CHUNK_TOKENS ? hardSplit(p, CHUNK_TOKENS) : [p]));
  const chunks: string[] = [];
  let current: string[] = [];
  let cost = 0;
  const flush = () => {
    const body = current.join("").trim();
    if (body !== "") chunks.push(body);
  };
  for (const unit of units) {
    const unitCost = estimateTokens(unit);
    if (current.length > 0 && cost + unitCost > CHUNK_TOKENS) {
      flush();
      // The overlap: whole pieces from the end of the chunk just closed, or the tail of a long last piece.
      const carry: string[] = [];
      let carried = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const c = estimateTokens(current[i]!);
        if (carried + c > CHUNK_OVERLAP_TOKENS) break;
        carry.unshift(current[i]!);
        carried += c;
      }
      if (carry.length === 0) {
        const tail = tailOf(current[current.length - 1]!, CHUNK_OVERLAP_TOKENS);
        carry.push(tail);
        carried = estimateTokens(tail);
      }
      // Never let the overlap push the new chunk over the limit with the piece that is about to join it.
      while (carry.length > 0 && carried + unitCost > CHUNK_TOKENS) carried -= estimateTokens(carry.shift()!);
      current = carry;
      cost = carried;
    }
    current.push(unit);
    cost += unitCost;
  }
  flush();
  return chunks;
}

/** Markdown marks a reply may carry (emphasis, code, headings, list bullets, link syntax), dropped so a snippet reads as plain text. */
export function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`+)/g, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "");
}

/** About `max` characters of `text` (as plain text) around the first place any of `terms` (lower case) occurs, else from the start. */
export function snippetAround(text: string, terms: readonly string[], max = 300): string {
  const flat = plainText(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  // The longest term that occurs anchors the snippet: it is the most specific thing the query matched.
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    if (term === "") continue;
    at = lower.indexOf(term);
    if (at >= 0) break;
  }
  if (at < 0) return `${flat.slice(0, max - 1).trimEnd()}…`;
  let start = Math.max(0, at - Math.floor(max / 3));
  let end = Math.min(flat.length, start + max);
  start = Math.max(0, end - max);
  // Start and end at a space when one is close.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space - start < 20 && space < at) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > at && end - space < 20) end = space;
  }
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}
