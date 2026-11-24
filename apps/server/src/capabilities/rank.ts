// The ranker of search_capabilities. It follows the rules Pi Durable documents for its own `rankDocuments` (which it does
// not export): term coverage first, a query term in the name above any number in the text, a bonus for a tool whose
// local name (after the last `__`) is in the query, an exact name first, and Unicode word segmentation so Chinese and
// Japanese queries work. Unlike Pi's it returns each document's score and coverage, which the Trace shows and the
// relative threshold of search_capabilities reads. Two additions, tuned on the discovery eval (eval/discovery): a light
// English stemmer ("reminder" and "remind", "scheduled" and "schedule" meet), and a short table of query synonyms for
// the verbs and nouns tool descriptions use differently from people ("read" finds "get", "repo" finds "repository"),
// including common Chinese words, so a Chinese query reaches English descriptions.

/** One thing the ranker can find: a tool or a skill. */
export interface RankDocument {
  readonly name: string;
  /** Description and parameter names and descriptions; not the name. */
  readonly text: string;
  /** The connector's or plugin's name and description; not length-normalized. */
  readonly namespaceText?: string;
}

export interface RankedDocument {
  readonly name: string;
  /** How many distinct query terms the document matches, in any field. Ranked on first. */
  readonly coverage: number;
  /** The query terms it matches in its name or text (not only its namespace). */
  readonly ownTerms: number;
  readonly score: number;
}

const K1 = 1.2;
const B = 0.75;
/** A name term counts more than any plausible number of text mentions. */
const NAME_WEIGHT = 8;
const NAMESPACE_WEIGHT = 1.5;

const STOP = new Set(
  "a an and are as at be by can do does for from has have how i in into is it its me my of on or our please should so that the their them then there these this to use using was we what when where which with you your".split(
    " ",
  ),
);

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** A word in its singular form, for plain English plurals. */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("ses")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

/** A light suffix stemmer for English words, applied to queries and documents alike, so only consistency matters. */
function stem(word: string): string {
  const w = singular(word);
  if (w.length < 5) return w;
  for (const suffix of ["ing", "ed", "er", "e"])
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) return w.slice(0, -suffix.length);
  return w;
}

/**
 * Unicode word segmentation with identifier boundaries (snake_case, `__`, camelCase), lower case, no stop words. A
 * camelCase word gives its parts and itself, so `getFileContents` matches "file" and `GitHub` matches "github".
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const push = (word: string) => {
    if (word === "" || STOP.has(word)) return;
    out.push(/^[a-z]+$/.test(word) ? stem(word) : word);
  };
  for (const part of segmenter.segment(text.replace(/[_\-./:]+/g, " "))) {
    if (!part.isWordLike) continue;
    const word = part.segment.trim();
    const pieces = word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ");
    if (pieces.length > 1) {
      for (const piece of pieces) push(piece.toLowerCase());
      push(word.toLowerCase());
    } else push(word.toLowerCase());
  }
  return out;
}

/**
 * Words a query may use for what descriptions say otherwise. A query term matches a document that has the term or one
 * of its alternatives (scored a little lower); it still counts as one term covered.
 */
const SYNONYMS: Record<string, string> = {
  find: "search",
  look: "search",
  read: "get fetch content",
  fetch: "get",
  show: "get list",
  view: "get",
  see: "get list",
  remove: "delete",
  erase: "delete",
  new: "create",
  make: "create",
  add: "create",
  edit: "update",
  change: "update",
  modify: "update",
  rename: "update",
  repo: "repository",
  pr: "pull",
  mail: "email",
  website: "web page site",
  webpage: "web page",
  site: "web page",
  寄: "send",
  發送: "send",
  發: "send",
  找: "search find",
  尋找: "search find",
  搜尋: "search",
  搜索: "search",
  讀: "read get",
  讀取: "read get",
  看: "read get list",
  刪除: "delete",
  刪: "delete",
  建立: "create",
  新增: "create add",
  更新: "update",
  修改: "update",
  截圖: "screenshot",
  提醒: "remind",
  網頁: "web page",
  網站: "web site page",
  打開: "open",
  開啟: "open",
  點擊: "click",
  每天: "daily day",
  每日: "daily day",
  每週: "weekly week",
  每月: "monthly month",
  排程: "schedule",
  郵件: "email",
  電郵: "email",
  合併: "merge",
  檔案: "file",
  文件: "file document",
  議題: "issue",
  外掛: "plugin",
  插件: "plugin",
};
const ALTERNATIVE_WEIGHT = 0.9;
const alternatives = new Map<string, string[]>(
  Object.entries(SYNONYMS).map(([word, alts]) => [tokenize(word)[0] ?? word, tokenize(alts)]),
);

/** The query's terms, each with the alternatives that also match it (the term first). */
export function queryTerms(query: string): string[][] {
  return [...new Set(tokenize(query))].map((term) => [
    term,
    ...(alternatives.get(term) ?? []).filter((a) => a !== term),
  ]);
}

/** The part of a tool name after its last `__` (a connector tool's own name). */
const localName = (name: string): string => {
  const at = name.lastIndexOf("__");
  return at >= 0 ? name.slice(at + 2) : name;
};

const counts = (tokens: readonly string[]): Map<string, number> => {
  const map = new Map<string, number>();
  for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1);
  return map;
};

/**
 * Okapi BM25 (k1 1.2, b 0.75) over `text`, with the name and namespace as separate fields, best first. Documents that
 * match no query term are left out. Ties keep document order.
 */
export function rank(query: string, documents: readonly RankDocument[]): RankedDocument[] {
  const raw = query.trim().toLowerCase();
  const terms = queryTerms(query);
  if (terms.length === 0 && raw === "") return [];
  const prepared = documents.map((d) => ({
    doc: d,
    name: new Set(tokenize(localName(d.name))),
    text: counts(tokenize(d.text)),
    textLength: tokenize(d.text).length,
    namespace: new Set(tokenize(d.namespaceText ?? "")),
  }));
  const n = prepared.length;
  const avgLength = n === 0 ? 1 : Math.max(1, prepared.reduce((sum, p) => sum + p.textLength, 0) / n);
  const df = new Map<string, number>();
  for (const word of new Set(terms.flat())) {
    let count = 0;
    for (const p of prepared) if (p.text.has(word) || p.name.has(word) || p.namespace.has(word)) count++;
    df.set(word, count);
  }
  const idf = (word: string): number => {
    const d = df.get(word) ?? 0;
    return Math.log(1 + (n - d + 0.5) / (d + 0.5));
  };
  const queryWords = new Set(raw.split(/[^\p{L}\p{N}_-]+/u).filter((w) => w !== ""));
  const results: (RankedDocument & { index: number; exact: boolean })[] = [];
  prepared.forEach((p, index) => {
    let score = 0;
    let coverage = 0;
    let ownTerms = 0;
    for (const words of terms) {
      // The best of the term and its alternatives.
      let best = 0;
      let matched = false;
      let own = false;
      words.forEach((word, i) => {
        const inName = p.name.has(word);
        const tf = p.text.get(word) ?? 0;
        const inNamespace = p.namespace.has(word);
        if (!inName && tf === 0 && !inNamespace) return;
        matched = true;
        if (inName || tf > 0) own = true;
        const weight = idf(word) * (i === 0 ? 1 : ALTERNATIVE_WEIGHT);
        let s = 0;
        if (inName) s += NAME_WEIGHT * weight;
        if (tf > 0) s += (weight * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * p.textLength) / avgLength));
        if (inNamespace) s += NAMESPACE_WEIGHT * weight;
        best = Math.max(best, s);
      });
      if (!matched) continue;
      coverage++;
      if (own) ownTerms++;
      score += best;
    }
    const name = p.doc.name.toLowerCase();
    const local = localName(name);
    const exact = raw === name || raw === local;
    // A tool whose whole local name is in the query is worth one more match of every term.
    if (!exact && queryWords.has(local)) {
      coverage += terms.length;
      score += terms.reduce((sum, t) => sum + NAME_WEIGHT * idf(t[0]!), 0);
    }
    if (coverage === 0 && !exact) return;
    results.push({ name: p.doc.name, coverage, ownTerms, score, index, exact });
  });
  results.sort(
    (a, b) => Number(b.exact) - Number(a.exact) || b.coverage - a.coverage || b.score - a.score || a.index - b.index,
  );
  return results.map(({ name, coverage, ownTerms, score }) => ({ name, coverage, ownTerms, score }));
}

/**
 * The leading results that clear the relative threshold: the best coverage, at least `minCoverage`, and a score of at
 * least `ratio` of the best score at that coverage.
 */
export function clearing(ranked: readonly RankedDocument[], ratio: number, minCoverage = 1): RankedDocument[] {
  const top = ranked[0];
  if (!top || top.coverage < minCoverage) return [];
  return ranked.filter((r) => r.coverage === top.coverage && r.score >= top.score * ratio);
}

/**
 * How many query terms a result must cover to be loaded or suggested: two, or every term of a one-term query. One word
 * of a longer task ("order" in "order a pizza") is not enough evidence.
 */
export const minCoverage = (query: string): number => Math.min(2, queryTerms(query).length);
