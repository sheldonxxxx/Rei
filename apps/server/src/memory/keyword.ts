// The keyword side of history search: SQLite FTS5 (default unicode61 tokenizer) over text that was split app-side, because
// unicode61 sees a run of CJK characters as one word. CJK runs become overlapping character
// bigrams (a run of one character stays as it is; the index also holds every single character, see ftsText), other runs become lower-case words. Index and query go through the same split.
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/u;
const LETTER = /[\p{L}\p{N}]/u;

/** Runs of CJK characters and runs of other letters and digits; everything else separates them. */
function runs(text: string): { cjk: boolean; s: string }[] {
  const out: { cjk: boolean; s: string }[] = [];
  let cur = "";
  let curCjk = false;
  for (const ch of text) {
    if (!LETTER.test(ch)) {
      if (cur) out.push({ cjk: curCjk, s: cur });
      cur = "";
      continue;
    }
    const cjk = CJK.test(ch);
    if (cur && cjk !== curCjk) {
      out.push({ cjk: curCjk, s: cur });
      cur = "";
    }
    cur += ch;
    curCjk = cjk;
  }
  if (cur) out.push({ cjk: curCjk, s: cur });
  return out;
}

export function bigramTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const r of runs(text)) {
    if (!r.cjk) {
      tokens.push(r.s.toLowerCase());
      continue;
    }
    const chars = [...r.s];
    if (chars.length === 1) tokens.push(chars[0]!);
    else for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i]! + chars[i + 1]!);
  }
  return tokens;
}

/**
 * What is stored in the FTS table for an entry's text: the query tokens plus every single CJK character, so a one-character
 * query (a name like 東, or a word like 犬) finds text where that character is part of a longer run.
 */
export function ftsText(text: string): string {
  const tokens: string[] = [];
  for (const r of runs(text)) {
    if (!r.cjk) {
      tokens.push(r.s.toLowerCase());
      continue;
    }
    const chars = [...r.s];
    tokens.push(...chars);
    for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i]! + chars[i + 1]!);
  }
  return tokens.join(" ");
}

/** A query can have this many distinct terms; a pasted paragraph would otherwise make a huge MATCH expression. */
export const MAX_QUERY_TERMS = 64;

/** The terms of a query as the index sees them (distinct, in order). */
export function queryTerms(query: string): string[] {
  return [...new Set(bigramTokens(query))].slice(0, MAX_QUERY_TERMS);
}

/** The MATCH expression: an OR of the quoted terms (BM25 ranks). Null when the query holds nothing to match. */
export function matchExpr(query: string): string | null {
  const terms = queryTerms(query);
  return terms.length === 0 ? null : terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Whether the query has a token that is an identifier more than a word: digits mixed with letters (booking codes), a
 * number of three or more digits, #12, an email or a URL fragment. Keyword search is the better of the two on those.
 */
export function hasIdLikeToken(query: string): boolean {
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(query)) return true;
  if (/https?:\/\/|www\./i.test(query)) return true;
  if (/#\d+/.test(query)) return true;
  for (const token of query.split(/[\s,;:()[\]{}"'<>|]+/)) {
    if (token === "") continue;
    if (/\d{3,}/.test(token)) return true;
    if (/\d/.test(token) && /\p{L}/u.test(token)) return true;
  }
  return false;
}
