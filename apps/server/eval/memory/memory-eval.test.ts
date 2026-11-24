// The memory eval: how well history search finds things, with keyword only, meaning only, and the fused ranking at a few
// weights. It runs the real index and the real embedder, so it needs a running llama.cpp embedding server:
//
//   REI_EMBEDDER_URL=http://127.0.0.1:18080 npx vitest run apps/server/eval
//
// and is skipped without that variable (so it never runs in CI). Two sets: A is the 1,000-chunk, 75-question corpus
// (data under ./data, skipped when absent); B is the small conversation-shaped fixture next to this file. The tables it prints are what RESULTS.md records, and the assertions guard FUSION in
// src/memory/fusion.ts: the fused default must not do worse than meaning-only search by more than 0.02 recall@5.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FUSION, type FusionConfig, fuse, type SearchMode } from "../../src/memory/fusion.ts";
import { HistoryIndex } from "../../src/memory/index.ts";
import { relevantHits } from "../../src/memory/relevance.ts";
import type { MemoryService } from "../../src/memory/service.ts";
import { startSignedIn } from "../../test/helpers/server.ts";
import { chat } from "../../test/helpers/sessions.ts";

const URL_ = process.env.REI_EMBEDDER_URL;
const HERE = import.meta.dirname;
const CORPUS_DATA = join(HERE, "data");
const OUT = process.env.REI_EVAL_OUT;
const CANDIDATES_OUT = process.env.REI_EVAL_CANDIDATES;

interface Item {
  id: string;
  text: string;
}
interface Question {
  id: string;
  cat: string;
  lang: string;
  q: string;
  gold: string[];
}
interface EvalSet {
  name: string;
  items: Item[];
  questions: Question[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const sets: EvalSet[] = [];
if (existsSync(join(CORPUS_DATA, "corpus.json")))
  sets.push({
    name: "A (corpus)",
    items: readJson<Item[]>(join(CORPUS_DATA, "corpus.json")),
    questions: readJson<Question[]>(join(CORPUS_DATA, "questions.json")),
  });
sets.push({
  name: "B (conversations)",
  items: readJson<{ entries: Item[] }>(join(HERE, "fixture.json")).entries,
  questions: readJson<Question[]>(join(HERE, "questions.json")),
});
sets.push(readJson<EvalSet>(join(HERE, "relevance-fixture.json")));

interface Variant {
  name: string;
  mode: SearchMode;
  config?: Partial<FusionConfig>;
  gated?: boolean;
}
const NO_FLOOR = { cosineFloor: 0 };
const VARIANTS: Variant[] = [
  { name: "keyword only", mode: { kind: "keyword" } },
  { name: "vector only (no floor)", mode: { kind: "vector" }, config: NO_FLOOR },
  { name: "vector only (floor 0.3)", mode: { kind: "vector" } },
  { name: "fused 1:1, k 60", mode: { kind: "fusion", vectorWeight: 1, keywordWeight: 1 }, config: { k: 60 } },
  { name: "fused 2:1, k 60, no id boost", mode: { kind: "fusion", idBoost: false }, config: { k: 60 } },
  { name: "fused 2:1, k 60", mode: { kind: "fusion" }, config: { k: 60 } },
  { name: "fused 3:1, k 60", mode: { kind: "fusion", vectorWeight: 3 }, config: { k: 60 } },
  { name: "fused 2:1, k 30", mode: { kind: "fusion" }, config: { k: 30 } },
  { name: "fused 2:1, k 20", mode: { kind: "fusion" }, config: { k: 20 } },
  { name: "fused 2:1, k 5", mode: { kind: "fusion" }, config: { k: 5 } },
  { name: "fused 1:1, k 10", mode: { kind: "fusion", vectorWeight: 1, keywordWeight: 1 }, config: { k: 10 } },
  { name: "fused 3:1, k 10", mode: { kind: "fusion", vectorWeight: 3 }, config: { k: 10 } },
  { name: "fused 2:1, k 10, no id boost", mode: { kind: "fusion", idBoost: false }, config: { k: 10 } },
  { name: "fused 2:1, k 10, id boost 3", mode: { kind: "fusion" }, config: { k: 10, idKeywordWeight: 3 } },
  { name: "fused 2:1, k 10, floor 0.2", mode: { kind: "fusion" }, config: { k: 10, cosineFloor: 0.2 } },
  { name: "fused 2:1, k 10, floor 0.25", mode: { kind: "fusion" }, config: { k: 10, cosineFloor: 0.25 } },
  { name: "fused 2:1, k 10, floor 0.35", mode: { kind: "fusion" }, config: { k: 10, cosineFloor: 0.35 } },
  { name: "fused 2:1, k 10, no floor", mode: { kind: "fusion" }, config: { k: 10, ...NO_FLOOR } },
  { name: "fused 2:1, k 10, id boost 2, floor 0.3 (FUSION)", mode: { kind: "fusion" } },
  { name: "FUSION with relevance gate", mode: { kind: "fusion" }, gated: true },
];
/** The variant that matches FUSION (the assertions run against it). */
const LEGACY = "fused 2:1, k 10, id boost 2, floor 0.3 (FUSION)";
const DEFAULT = "FUSION with relevance gate";

interface Scored {
  r5: number;
  rr10: number;
  ndcg10: number;
  /** For no-answer questions: whether anything at all came back. */
  returned: boolean;
  strongReturned?: boolean;
}

function score(ranked: string[], gold: Set<string>): Scored {
  const top5 = ranked.slice(0, 5);
  const top10 = ranked.slice(0, 10);
  const r5 = gold.size === 0 ? 0 : [...gold].filter((g) => top5.includes(g)).length / gold.size;
  let rr10 = 0;
  for (let i = 0; i < top10.length; i++) {
    if (gold.has(top10[i]!)) {
      rr10 = 1 / (i + 1);
      break;
    }
  }
  let dcg = 0;
  top10.forEach((id, i) => {
    if (gold.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(gold.size, 10); i++) idcg += 1 / Math.log2(i + 2);
  return { r5, rr10, ndcg10: idcg > 0 ? dcg / idcg : 0, returned: ranked.length > 0 };
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

interface Built {
  /** Candidate lists per question, as chunk ids (best first). */
  candidates: Map<string, { keyword: { id: number }[]; vector: { id: number; cosine: number }[] }>;
  chunkOf: Map<number, string>;
  textOf: Map<number, string>;
}

/** Puts a set into a real index, lets the worker embed it, and asks both sides of every question. */
async function build(set: EvalSet): Promise<{ built: Built; stop: () => Promise<void>; seconds: number }> {
  const server = await startSignedIn({
    config: {
      embedder: {
        url: URL_!,
        model: "embeddinggemma-300m",
        provider: "openai",
        apiModel: "embeddinggemma-300m",
        profile: {
          id: "embeddinggemma-300m",
          repository: "ggml-org/embeddinggemma-300M-GGUF",
          revision: "eval-only",
          dims: 768,
          quant: "Q8_0",
          pooling: "mean",
          docTemplate: "title: none | text: ${t}",
          queryTemplate: "task: search result | query: ${q}",
          maxInputTokens: 2_048,
          contextTokens: 900,
        },
      },
    },
  });
  const memory: MemoryService = server.host.plane.memory!;
  const session = await chat(server);
  const t0 = Date.now();
  for (const item of set.items)
    new HistoryIndex(memory.store.db, memory.store.clock).addToolResult({
      sessionId: session,
      runId: null,
      piEntryId: item.id,
      toolName: "eval",
      text: item.text,
    });
  memory.history.catchUp();
  await memory.history.settle();
  const status = memory.history.status();
  if (status.state !== "ready")
    throw new Error(
      `the index is ${status.state} (${status.lastError ?? "no error"}), ${status.embedded} of ${status.entries} embedded`,
    );
  const seconds = (Date.now() - t0) / 1000;
  const chunkOf = new Map(
    memory.store.db
      .all<{ id: number; pi_entry_id: string }>("SELECT id, pi_entry_id FROM history_entries WHERE hidden = 0")
      .map((r) => [r.id, r.pi_entry_id]),
  );
  const textOf = new Map(
    memory.store.db
      .all<{ id: number; text: string }>("SELECT id, text FROM history_entries WHERE hidden = 0")
      .map((r) => [r.id, r.text]),
  );
  const candidates: Built["candidates"] = new Map();
  for (const q of set.questions) {
    const keyword = await memory.history.keywordSearch(q.q, {});
    const vector = await memory.history.vectorSearch(q.q, {});
    candidates.set(q.id, { keyword, vector });
  }
  return { built: { candidates, chunkOf, textOf }, stop: () => server.destroy(), seconds };
}

function run(set: EvalSet, built: Built, variant: Variant): { question: Question; scored: Scored }[] {
  const config: FusionConfig = { ...FUSION, ...variant.config };
  return set.questions.map((question) => {
    const c = built.candidates.get(question.id)!;
    const ordered = fuse(question.q, c.vector, c.keyword, variant.mode, config);
    const fused = variant.gated ? relevantHits(question.q, ordered, built.textOf, c.vector.length > 0) : ordered;
    // Several entries can come from one chunk (long text); the first one counts.
    const ranked: string[] = [];
    for (const f of fused) {
      const chunk = built.chunkOf.get(f.id);
      if (chunk !== undefined && !ranked.includes(chunk)) ranked.push(chunk);
    }
    return {
      question,
      scored: {
        ...score(ranked, new Set(question.gold)),
        strongReturned: fused.some((hit) => !("relevance" in hit) || hit.relevance === "match"),
      },
    };
  });
}

const f3 = (n: number): string => n.toFixed(3);

describe.skipIf(!URL_)("memory eval", () => {
  const summary: Record<
    string,
    Record<
      string,
      {
        r5: number;
        rr10: number;
        ndcg10: number;
        byCat: Record<string, number>;
        noAnswerReturned: number;
        noAnswerStrongReturned: number;
        answerFound: number;
      }
    >
  > = {};

  for (const set of sets) {
    it(`${set.name}: fused search is not worse than meaning-only search`, { timeout: 30 * 60_000 }, async () => {
      const { built, stop, seconds } = await build(set);
      try {
        // Synthetic fixture candidates only; allows repeatable relevance analysis without re-embedding the corpus.
        if (CANDIDATES_OUT)
          writeFileSync(
            `${CANDIDATES_OUT}-${set.name[0]}.json`,
            JSON.stringify({
              set,
              candidates: [...built.candidates],
              chunkOf: [...built.chunkOf],
              textOf: [...built.textOf],
            }),
          );
        const table: string[] = [
          `\n### ${set.name}: ${set.items.length} items, ${set.questions.length} questions, indexed in ${seconds.toFixed(0)} s`,
          "| variant | recall@5 | MRR@10 | nDCG@10 | no-answer: returned something |",
          "|---|---|---|---|---|",
        ];
        const results: Record<string, ReturnType<typeof run>> = {};
        summary[set.name] = {};
        for (const v of VARIANTS) {
          const rows = run(set, built, v);
          results[v.name] = rows;
          const answerable = rows.filter((r) => r.question.gold.length > 0);
          const none = rows.filter((r) => r.question.gold.length === 0);
          const byCat: Record<string, number> = {};
          for (const cat of [...new Set(answerable.map((r) => r.question.cat))])
            byCat[cat] = mean(answerable.filter((r) => r.question.cat === cat).map((r) => r.scored.r5));
          const entry = {
            r5: mean(answerable.map((r) => r.scored.r5)),
            rr10: mean(answerable.map((r) => r.scored.rr10)),
            ndcg10: mean(answerable.map((r) => r.scored.ndcg10)),
            byCat,
            noAnswerReturned: none.filter((r) => r.scored.returned).length / Math.max(1, none.length),
            noAnswerStrongReturned: none.filter((r) => r.scored.strongReturned).length / Math.max(1, none.length),
            answerFound: mean(answerable.map((r) => Number(r.scored.r5 > 0))),
          };
          summary[set.name]![v.name] = entry;
          table.push(
            `| ${v.name} | ${f3(entry.r5)} | ${f3(entry.rr10)} | ${f3(entry.ndcg10)} | ${(entry.noAnswerReturned * 100).toFixed(0)}% |`,
          );
        }
        const cats = Object.keys(summary[set.name]![DEFAULT]!.byCat);
        table.push("", `recall@5 by category | ${cats.join(" | ")}`, `---|${cats.map(() => "---").join("|")}`);
        for (const v of VARIANTS)
          table.push(`${v.name} | ${cats.map((c) => f3(summary[set.name]![v.name]!.byCat[c] ?? 0)).join(" | ")}`);
        // The questions the default misses in the top 5, for reading by hand.
        const missed = results[DEFAULT]!.filter((r) => r.question.gold.length > 0 && r.scored.r5 < 1).map(
          (r) => `${r.question.id} [${r.question.cat}] ${r.question.q} (recall@5 ${f3(r.scored.r5)})`,
        );
        table.push("", `default misses (${missed.length}):`, ...missed.map((m) => `- ${m}`));
        console.log(table.join("\n"));

        const def = summary[set.name]![DEFAULT]!;
        const vectorOnly = summary[set.name]!["vector only (no floor)"]!;
        expect(def.r5).toBeGreaterThanOrEqual(vectorOnly.r5 - 0.02);
        expect(def.r5).toBeGreaterThanOrEqual(summary[set.name]!["keyword only"]!.r5 - 0.02);
        // Guard abstention as well as retrieval. A lead is not an answer; separately measure both kinds of return.
        const legacy = summary[set.name]![LEGACY]!;
        expect(def.r5).toBeGreaterThanOrEqual(legacy.r5 - 0.02);
        expect(def.answerFound).toBeGreaterThanOrEqual(legacy.answerFound);
        expect(def.noAnswerReturned).toBeLessThanOrEqual(legacy.noAnswerReturned - 0.25);
        expect(def.noAnswerStrongReturned).toBe(0);
      } finally {
        await stop();
      }
    });
  }

  it("records the numbers when REI_EVAL_OUT names a file", () => {
    if (OUT) writeFileSync(OUT, `${JSON.stringify({ defaults: FUSION, summary }, null, 1)}\n`);
    expect(Object.keys(summary).length).toBe(sets.length);
  });
});
