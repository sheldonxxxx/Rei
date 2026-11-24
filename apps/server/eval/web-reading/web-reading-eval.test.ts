// The web-reading eval (Web Reading v2, ticket 01): what web_fetch hands the model for a fixed corpus of frozen pages,
// measured through the real read path (readPage and the reader core: redirects, limits, content types, extraction)
// with a fake proxy transport that serves the files in pages/. No network, no model; it runs in the normal suite.
//
// For every fixture it records the outcome, the page's size in o200k tokens, what the first result costs, and for each
// question whether its gold span reached the model and how many tokens of results it took to get there (reading slice
// after slice, as the model does today). It also counts boilerplate that survived extraction and checks the
// content fence on the prompt-injection pages.
//
// The presentation is pluggable (`present`): today it is the 20,000-character slicing. Later tickets add their modes
// here and compare against the baseline recorded in RESULTS.md.
//
// REI_EVAL_OUT=/path.json writes the metrics; REI_EVAL_PRINT=1 prints the tables RESULTS.md records.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import { afterAll, describe, expect, it } from "vitest";
import { performRead } from "../../../reader/src/core/read.ts";
import { parseReadRequest } from "../../../reader/src/core/request.ts";
import { type FetchResponse, type FetchViaProxy, ProxyRefused } from "../../../reader/src/core/types.ts";
import { initializeDatabase } from "../../src/db/schema.ts";
import { openSqliteDb } from "../../src/node/sqlite-db.ts";
import { type CachedPage, renderSlice } from "../../src/web/cache.ts";
import { WebDocumentStore } from "../../src/web/documents.ts";
import { readPage } from "../../src/web/fetch.ts";
import { PASSAGE_BUDGET_TOKENS } from "../../src/web/passages.ts";
import { renderOverview, renderQuery } from "../../src/web/render.ts";
import { WebError } from "../../src/web/types.ts";
import { unfence } from "../../test/helpers/fence.ts";

// ---- the corpus ----------------------------------------------------------------------------------------------------

type Expect = "success" | "low_quality" | "requires_js" | "blocked" | "unsupported_mime" | "policy_denied" | "error";
interface Question {
  id: string;
  q: string;
  /** The span that answers it; null for a question the page cannot answer (a control). */
  gold: string | null;
}
interface Fixture {
  id: string;
  category: string;
  url: string;
  file?: string;
  contentType?: string;
  status?: number;
  headers?: Record<string, string>;
  truncated?: boolean;
  chain?: { url: string; status: number; location: string }[];
  finalUrl?: string;
  expect: Expect;
  injection?: boolean;
  staticRecoverable?: boolean;
  questions: Question[];
  boilerplate?: string[];
}

const DIR = import.meta.dirname;
const corpus = JSON.parse(readFileSync(join(DIR, "corpus.json"), "utf8")) as {
  denyHosts: string[];
  fixtures: Fixture[];
};
const bodyOf = (f: Fixture): Uint8Array =>
  f.file ? new Uint8Array(readFileSync(join(DIR, "pages", f.file))) : new Uint8Array();

// ---- matching ------------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  copy: "©",
};
/** Text of a source file for the gold check: tags become spaces and the common entities are decoded. */
function sourceText(f: Fixture): string {
  const raw = new TextDecoder(f.id === "m02-latin1" ? "latin1" : "utf-8").decode(bodyOf(f));
  if (!/html|xml/.test(f.contentType ?? "html")) return raw;
  return raw.replace(/<[^>]*>/g, " ").replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
/** Both sides of a match go through this: table pipes, emphasis, code ticks and Markdown escapes do not count. */
export const norm = (s: string): string =>
  s
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, "$1")
    .replace(/[|`]/g, " ")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// ---- tokens --------------------------------------------------------------------------------------------------------

const tokenizer = new Tiktoken(o200k);
const tokens = (text: string): number => tokenizer.encode(text, [], []).length;

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
};
const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

// ---- running a fixture ---------------------------------------------------------------------------------------------

/** What web_fetch returns, call after call, until the page is read to the end. */
type Present = (page: CachedPage) => string[];
const slicing: Present = (page) => {
  const out: string[] = [];
  for (let offset = 0; ; ) {
    const slice = renderSlice(page, offset);
    if ("error" in slice) break;
    out.push(slice.text);
    const next = /offset=(\d+) for more/.exec(slice.text)?.[1];
    if (!next) break;
    offset = Number(next);
  }
  return out;
};

type Outcome =
  | "ok"
  | "http_error"
  | "too_large"
  | "unsupported"
  | "no_text"
  | "redirect_denied"
  | "too_many_redirects"
  | "blocked_page"
  | "other_error";
function outcomeOf(message: string): Outcome {
  if (/answered HTTP/.test(message)) return "http_error";
  if (/larger than/.test(message)) return "too_large";
  if (/not a readable page/.test(message)) return "unsupported";
  if (/no readable text/.test(message)) return "no_text";
  if (/not allowed without the user's approval|was not followed/.test(message)) return "redirect_denied";
  if (/Too many redirects/.test(message)) return "too_many_redirects";
  if (/bot check|asks you to sign in/.test(message)) return "blocked_page";
  return "other_error";
}

interface QuestionResult {
  id: string;
  answerable: boolean;
  /** The gold span is somewhere in the extracted page. */
  extracted: boolean;
  /** It is in the first result. */
  first: boolean;
  /** Results read until it appeared (0: never). */
  calls: number;
  /** Tokens of those results; for a control, of the whole page read to the end. */
  tokensToEvidence: number;
}
interface FixtureResult {
  id: string;
  category: string;
  expect: Expect;
  /** The class the page got: the page's quality, or the error's (a refused redirect is policy_denied, a limit error). */
  quality: Expect;
  extractor: string | undefined;
  staticRecoverable: boolean;
  outcome: Outcome;
  error?: string;
  chars: number;
  pageTokens: number;
  firstTokens: number;
  calls: number;
  allTokens: number;
  extractMs: number;
  boilerplateLeaks: string[];
  questions: QuestionResult[];
  results: string[];
  /** What was read (not written out). */
  page?: CachedPage;
}

function responsesOf(f: Fixture): Map<string, FetchResponse> {
  const map = new Map<string, FetchResponse>();
  for (const hop of f.chain ?? [])
    map.set(hop.url, {
      status: hop.status,
      headers: { location: hop.location },
      body: new Uint8Array(),
      truncated: false,
    });
  if (f.file) {
    const headers: Record<string, string> = { ...(f.headers ?? {}) };
    if (f.contentType) headers["content-type"] = f.contentType;
    map.set(f.finalUrl ?? f.url, {
      status: f.status ?? 200,
      headers,
      body: bodyOf(f),
      truncated: f.truncated ?? false,
    });
  }
  return map;
}

async function run(f: Fixture, present: Present): Promise<FixtureResult> {
  const responses = responsesOf(f);
  const fetchViaProxy: FetchViaProxy = async (url) => {
    const r = responses.get(url);
    if (!r) throw new ProxyRefused(`no fixture answers ${url}`);
    return r;
  };
  // The real read path: the server's redirect loop and policy, the reader's fetch, limits and extraction, and the
  // gateway between them replaced by a function.
  const gateway = (async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = parseReadRequest(JSON.parse(String(init?.body)));
    const json = await performRead(
      // This corpus measures static extraction, independent of browser engines.
      { ...parsed, render: "off" },
      { fetch: fetchViaProxy, openFetchJob: () => ({ token: "job", revoke: () => undefined }) },
      undefined,
      { readId: "eval", caller: "rei", defer: () => undefined },
    );
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const base = { id: f.id, category: f.category, expect: f.expect, staticRecoverable: f.staticRecoverable ?? false };
  const empty = { chars: 0, pageTokens: 0, firstTokens: 0, calls: 0, allTokens: 0, boilerplateLeaks: [], results: [] };
  const started = performance.now();
  let page: CachedPage;
  try {
    ({ page } = await readPage(new URL(f.url), {
      gatewayUrl: "http://gateway.test",
      token: "eval",
      fetchImpl: gateway,
      localNetworksFor: () => "none",
      checkRedirect: (host: string) =>
        corpus.denyHosts.includes(host)
          ? `The page redirects to ${host}, which is not allowed without the user's approval, so the redirect was not followed.`
          : undefined,
    }));
  } catch (error) {
    const message = error instanceof WebError ? error.message : String(error);
    const outcome = outcomeOf(message);
    return {
      ...base,
      ...empty,
      quality:
        (error instanceof WebError ? error.quality : undefined) ??
        (outcome === "redirect_denied" ? "policy_denied" : "error"),
      extractor: undefined,
      outcome,
      error: message,
      extractMs: performance.now() - started,
      questions: f.questions.map((q) => ({
        id: q.id,
        answerable: q.gold !== null,
        extracted: false,
        first: false,
        calls: 0,
        tokensToEvidence: 0,
      })),
    };
  }
  const extractMs = performance.now() - started;
  const results = present(page);
  const counts = results.map(tokens);
  const extractedText = norm(page.text);
  const questions = f.questions.map((q): QuestionResult => {
    if (q.gold === null)
      return {
        id: q.id,
        answerable: false,
        extracted: false,
        first: false,
        calls: results.length,
        tokensToEvidence: counts.reduce((a, b) => a + b, 0),
      };
    const gold = norm(q.gold);
    const at = results.findIndex((r) => norm(r).includes(gold));
    return {
      id: q.id,
      answerable: true,
      extracted: extractedText.includes(gold),
      first: at === 0,
      calls: at + 1,
      tokensToEvidence: at < 0 ? 0 : counts.slice(0, at + 1).reduce((a, b) => a + b, 0),
    };
  });
  return {
    ...base,
    quality: page.quality ?? "success",
    extractor: page.extractor,
    outcome: "ok",
    chars: page.text.length,
    pageTokens: tokens(page.text),
    firstTokens: counts[0] ?? 0,
    calls: results.length,
    allTokens: counts.reduce((a, b) => a + b, 0),
    extractMs,
    boilerplateLeaks: (f.boilerplate ?? []).filter((b) => extractedText.includes(norm(b))),
    questions,
    results,
    page,
  };
}

// ---- the summary ---------------------------------------------------------------------------------------------------

/** A page above this many tokens is "long": the v2 target compares tokens to evidence on these. */
const LONG_PAGE_TOKENS = 1_500;

function summarize(results: FixtureResult[]) {
  const answerable = results.flatMap((r) => r.questions.filter((q) => q.answerable).map((q) => ({ ...q, fixture: r })));
  const reachable = answerable.filter((q) => q.fixture.expect === "success");
  const ok = results.filter((r) => r.outcome === "ok");
  const found = reachable.filter((q) => q.calls > 0);
  const controls = results.flatMap((r) => r.questions.filter((q) => !q.answerable));
  return {
    fixtures: results.length,
    questions: { answerable: answerable.length, onSuccessPages: reachable.length, controls: controls.length },
    extractionRecall: reachable.filter((q) => q.extracted).length / reachable.length,
    firstResultRecall: reachable.filter((q) => q.first).length / reachable.length,
    staticRecoverableRecall: (() => {
      const js = answerable.filter((q) => q.fixture.staticRecoverable);
      return { found: js.filter((q) => q.extracted).length, of: js.length };
    })(),
    firstResultTokens: {
      mean: mean(ok.map((r) => r.firstTokens)),
      p50: quantile(
        ok.map((r) => r.firstTokens),
        0.5,
      ),
      p95: quantile(
        ok.map((r) => r.firstTokens),
        0.95,
      ),
    },
    tokensToEvidence: {
      mean: mean(found.map((q) => q.tokensToEvidence)),
      p50: quantile(
        found.map((q) => q.tokensToEvidence),
        0.5,
      ),
      p95: quantile(
        found.map((q) => q.tokensToEvidence),
        0.95,
      ),
      max: Math.max(0, ...found.map((q) => q.tokensToEvidence)),
    },
    callsToEvidence: { mean: mean(found.map((q) => q.calls)), max: Math.max(0, ...found.map((q) => q.calls)) },
    // Where the savings must come from: pages longer than one compact answer (LONG_PAGE_TOKENS).
    longPages: (() => {
      const long = found.filter((q) => q.fixture.pageTokens > LONG_PAGE_TOKENS);
      return {
        pages: new Set(long.map((q) => q.fixture.id)).size,
        questions: long.length,
        tokensToEvidenceMean: mean(long.map((q) => q.tokensToEvidence)),
        tokensToEvidenceMax: Math.max(0, ...long.map((q) => q.tokensToEvidence)),
      };
    })(),
    controlTokens: mean(controls.map((q) => q.tokensToEvidence)),
    falseSuccess: results
      .filter((r) => r.outcome === "ok" && r.expect !== "success" && r.expect !== "low_quality")
      .map((r) => r.id),
    misclassified: results
      .filter((r) => r.quality !== r.expect)
      .map((r) => `${r.id}: ${r.quality} (expected ${r.expect})`),
    wrongFailure: results.filter((r) => r.outcome !== "ok" && r.expect === "success").map((r) => r.id),
    boilerplateLeaks: results.flatMap((r) => r.boilerplateLeaks.map((b) => `${r.id}: ${b}`)),
    extractMs: {
      p50: quantile(
        results.map((r) => r.extractMs),
        0.5,
      ),
      p95: quantile(
        results.map((r) => r.extractMs),
        0.95,
      ),
    },
  };
}

function tables(results: FixtureResult[], summary: ReturnType<typeof summarize>): string {
  const rows = results.map(
    (r) =>
      `| ${r.id} | ${r.expect} | ${r.quality} | ${r.extractor ?? ""} | ${r.outcome} | ${r.pageTokens} | ${r.firstTokens} | ${r.calls} | ${r.questions
        .filter((q) => q.answerable)
        .map((q) => (q.calls > 0 ? `${q.calls}:${q.tokensToEvidence}` : q.extracted ? "lost" : "miss"))
        .join(" ")} |`,
  );
  return [
    "| fixture | expect | got | extractor | outcome | page tokens | first result | calls to end | evidence (calls:tokens) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
  ].join("\n");
}

// ---- the tests -----------------------------------------------------------------------------------------------------

describe("web-reading corpus", () => {
  it("has unique ids, readable files and gold spans that are in the source", () => {
    const ids = new Set<string>();
    for (const f of corpus.fixtures) {
      expect(ids.has(f.id), f.id).toBe(false);
      ids.add(f.id);
      if (f.file) expect(bodyOf(f).length, f.id).toBeGreaterThan(0);
      // Text content, or the raw markup for evidence that lives in an attribute or a script (meta tags, JSON-LD).
      const source = `${norm(sourceText(f))}\n${norm(new TextDecoder().decode(bodyOf(f)))}`;
      for (const q of f.questions) if (q.gold !== null) expect(source, `${q.id} gold`).toContain(norm(q.gold));
    }
    expect(corpus.fixtures.length).toBeGreaterThanOrEqual(40);
  });
});

describe("web-reading eval: today's 20,000-character slicing", async () => {
  const results: FixtureResult[] = [];
  for (const f of corpus.fixtures) results.push(await run(f, slicing));
  const summary = summarize(results);
  if (process.env.REI_EVAL_OUT)
    writeFileSync(
      process.env.REI_EVAL_OUT,
      JSON.stringify({ summary, fixtures: results.map(({ results: _, page: __, ...r }) => r) }, null, 2),
    );
  if (process.env.REI_EVAL_PRINT) console.log(tables(results, summary));
  const byId = new Map(results.map((r) => [r.id, r]));

  it("never reads what the policy or the limits refuse", () => {
    expect(byId.get("r02-redirect-denied")!.outcome).toBe("redirect_denied");
    expect(byId.get("r03-redirect-loop")!.outcome).toBe("too_many_redirects");
    expect(byId.get("g01-oversize")!.outcome).toBe("too_large");
    expect(byId.get("u01-pdf")!.outcome).toBe("unsupported");
    expect(byId.get("u02-image")!.outcome).toBe("unsupported");
    expect(byId.get("b01-forbidden")!.outcome).toBe("http_error");
    expect(byId.get("b02-rate-limited")!.outcome).toBe("http_error");
  });

  it("keeps injected markers and instructions inside one content fence", () => {
    for (const id of ["i01-fake-fence", "i02-hidden-instructions"]) {
      const r = byId.get(id)!;
      expect(r.outcome).toBe("ok");
      for (const text of r.results) {
        const { id: fenceId, body, footer } = unfence(text);
        expect(fenceId).not.toBe("deadbeef");
        expect(text.split(`<<<end page-content id=${fenceId}>>>`)).toHaveLength(2);
        expect(footer).not.toMatch(/SYSTEM|ignore all previous/);
        if (id === "i01-fake-fence") expect(body).toContain("<<<end page-content id=deadbeef>>>");
      }
    }
    expect(byId.get("i02-hidden-instructions")!.boilerplateLeaks).not.toContain("pills.example.net");
  });

  // Floors just under the recorded runs (RESULTS.md): extraction must not get worse while the presentation changes.
  it("keeps the baseline's extraction recall", () => {
    expect(summary.extractionRecall).toBeGreaterThanOrEqual(0.95);
    expect(summary.wrongFailure).toEqual([]);
  });

  it("gives every page the class it should get, and recovers content embedded for scripts", () => {
    expect(summary.misclassified).toEqual([]);
    expect(summary.falseSuccess).toEqual([]);
    expect(summary.staticRecoverableRecall.found).toBe(summary.staticRecoverableRecall.of);
  });
});

// ---- query mode (ticket 04): ranked passages within a token budget -------------------------------------------------

interface FlowResult {
  fixture: string;
  question: string;
  answerable: boolean;
  pageTokens: number;
  /** Overview first, then a query when the overview does not hold the gold span. */
  overviewThenQuery: { found: boolean; calls: number; tokens: number };
  /** Straight to a query. */
  queryFirst: { found: boolean; tokens: number };
  results: string[];
}

interface QueryResult {
  fixture: string;
  question: string;
  answerable: boolean;
  found: boolean;
  tokens: number;
  passages: number;
  termsFound: number;
  terms: number;
  pageTokens: number;
}

describe("web-reading eval: query mode (passages)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rei-web-eval-"));
  const db = openSqliteDb(join(dir, "eval.db"));
  initializeDatabase(db);
  afterAll(() => {
    (db as unknown as { close: () => void }).close();
    rmSync(dir, { recursive: true, force: true });
  });
  const docs = new WebDocumentStore(db, () => 0);
  const rows: QueryResult[] = [];
  const flows: FlowResult[] = [];
  for (const f of corpus.fixtures) {
    if (f.expect !== "success" && f.expect !== "low_quality") continue;
    const r = await run(f, () => []);
    if (!r.page) continue;
    const doc = await docs.put("agt_eval", "ses_eval", f.url, r.page);
    for (const q of f.questions) {
      // What web_fetch v2 returns (render.ts), as the model would call it.
      const overview = renderOverview(doc, false);
      const query = renderQuery(doc, q.q, docs.search(doc, q.q), false);
      if ("error" in overview || "error" in query) throw new Error(`${f.id}: render failed`);
      const has = (text: string) => q.gold !== null && norm(text).includes(norm(q.gold));
      const [ot, qt] = [tokens(overview.text), tokens(query.text)];
      const inOverview = has(overview.text);
      flows.push({
        fixture: f.id,
        question: q.id,
        answerable: q.gold !== null,
        pageTokens: r.pageTokens,
        overviewThenQuery: inOverview
          ? { found: true, calls: 1, tokens: ot }
          : { found: has(query.text), calls: 2, tokens: ot + qt },
        queryFirst: { found: has(query.text), tokens: qt },
        results: [overview.text, query.text],
      });
      const sel = docs.search(doc, q.q);
      const shown = sel.passages.map((p) => doc.text.slice(p.start, p.end)).join("\n\n");
      rows.push({
        fixture: f.id,
        question: q.id,
        answerable: q.gold !== null,
        found: q.gold !== null && norm(shown).includes(norm(q.gold)),
        tokens: sel.passages.reduce((a, p) => a + p.exactTokens, 0),
        passages: sel.passages.length,
        termsFound: sel.termsFound,
        terms: sel.terms,
        pageTokens: r.pageTokens,
      });
    }
  }
  const answerable = rows.filter((r) => r.answerable);
  const long = answerable.filter((r) => r.pageTokens > LONG_PAGE_TOKENS);
  const controls = rows.filter((r) => !r.answerable);
  const summary = {
    recall: { found: answerable.filter((r) => r.found).length, of: answerable.length },
    longPageRecall: { found: long.filter((r) => r.found).length, of: long.length },
    tokens: {
      mean: mean(answerable.map((r) => r.tokens)),
      p95: quantile(
        answerable.map((r) => r.tokens),
        0.95,
      ),
      max: Math.max(0, ...rows.map((r) => r.tokens)),
    },
    longPageTokensMean: mean(long.map((r) => r.tokens)),
    controlTokensMean: mean(controls.map((r) => r.tokens)),
    misses: answerable.filter((r) => !r.found).map((r) => `${r.fixture}/${r.question}`),
    controls: controls.map(
      (r) => `${r.fixture}/${r.question}: ${r.passages} passages, ${r.termsFound}/${r.terms} terms`,
    ),
  };
  const flowAnswerable = flows.filter((f) => f.answerable);
  const flowLong = flowAnswerable.filter((f) => f.pageTokens > LONG_PAGE_TOKENS);
  const flowControls = flows.filter((f) => !f.answerable);
  const v2 = {
    overviewThenQuery: {
      recall: flowAnswerable.filter((f) => f.overviewThenQuery.found).length / flowAnswerable.length,
      tokensMean: mean(flowAnswerable.map((f) => f.overviewThenQuery.tokens)),
      longPageTokensMean: mean(flowLong.map((f) => f.overviewThenQuery.tokens)),
      longPageTokensMax: Math.max(0, ...flowLong.map((f) => f.overviewThenQuery.tokens)),
      callsMean: mean(flowAnswerable.map((f) => f.overviewThenQuery.calls)),
      controlTokensMean: mean(flowControls.map((f) => f.overviewThenQuery.tokens)),
    },
    queryFirst: {
      recall: flowAnswerable.filter((f) => f.queryFirst.found).length / flowAnswerable.length,
      tokensMean: mean(flowAnswerable.map((f) => f.queryFirst.tokens)),
      longPageTokensMean: mean(flowLong.map((f) => f.queryFirst.tokens)),
      controlTokensMean: mean(flowControls.map((f) => f.queryFirst.tokens)),
    },
    misses: flowAnswerable.filter((f) => !f.overviewThenQuery.found).map((f) => `${f.fixture}/${f.question}`),
  };
  if (process.env.REI_EVAL_PRINT) console.log(JSON.stringify({ passages: summary, v2 }, null, 2));
  if (process.env.REI_EVAL_PRINT)
    console.log(
      [
        ...new Map(
          flows.map((f) => [f.fixture, `${f.fixture}: page ${f.pageTokens}, overview ${tokens(f.results[0]!)}`]),
        ).values(),
      ].join("\n"),
    );

  // The v2 targets (spec, ticket 05): long pages at least 60% cheaper than the 8,327-token baseline, recall at least 95%.
  it("cuts the tokens to evidence on long pages by at least 60% while keeping recall", () => {
    expect(v2.overviewThenQuery.recall).toBeGreaterThanOrEqual(0.95);
    expect(v2.overviewThenQuery.longPageTokensMean).toBeLessThanOrEqual(3_330);
    expect(v2.queryFirst.recall).toBeGreaterThanOrEqual(0.95);
  });

  it("keeps injected markers and instructions inside one content fence in overview and query results", () => {
    for (const f of flows.filter((x) => x.fixture.startsWith("i0"))) {
      for (const text of f.results) {
        const { id: fenceId, body, footer } = unfence(text);
        expect(fenceId).not.toBe("deadbeef");
        expect(text.split(`<<<end page-content id=${fenceId}>>>`)).toHaveLength(2);
        expect(footer).not.toMatch(/SYSTEM|ignore all previous/);
        if (f.fixture === "i01-fake-fence") expect(body).toContain("<<<end page-content id=deadbeef>>>");
      }
    }
  });

  it("returns the supporting span for at least 95% of answerable questions within the budget", () => {
    expect(summary.recall.found / summary.recall.of).toBeGreaterThanOrEqual(0.95);
    expect(summary.tokens.max).toBeLessThanOrEqual(PASSAGE_BUDGET_TOKENS);
  });

  it("still returns the best passages for a question the page cannot answer, and says which terms they hold", () => {
    for (const r of controls) {
      expect(r.tokens).toBeLessThanOrEqual(PASSAGE_BUDGET_TOKENS);
      expect(r.termsFound).toBeLessThanOrEqual(r.terms);
    }
  });
});
