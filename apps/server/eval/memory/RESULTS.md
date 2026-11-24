# Memory eval: results

The 2026-11-02 relevance-gate comparison and current abstention checks are documented in
[`docs/memory-search-relevance.md`](../../../../docs/memory-search-relevance.md).
The tables below retain the original ranking-only baseline for comparison.

How well history search finds things, and why `FUSION` in `src/memory/fusion.ts` has the numbers it has.

Run it (inside the VM, against a llama.cpp embedding server serving EmbeddingGemma-300M Q8_0 with the prompts in `src/memory/embedder.ts`):

```sh
REI_EMBEDDER_URL=http://127.0.0.1:18080 REI_EVAL_OUT=/tmp/eval.json npx vitest run apps/server/eval
```

It is skipped without `REI_EMBEDDER_URL`, so it never runs in the normal suite. It builds the real index (the same chunking, FTS5 tokenising and vector sets the server uses), lets the real worker embed everything, asks both sides of every question once, and then ranks the candidates with each variant. Variants are compared on the same candidates, so the differences are purely the fusion.

Run 2026-10-31, llama.cpp `server-b11946` (the compose image), EmbeddingGemma-300M Q8_0, 768 dimensions. Indexing the 1,000 chunks of set A took about 155 s (6 to 7 chunks per second on this VM).

## The two sets

- **A**: the corpus (`apps/server/eval/memory/data/corpus.json` and `questions.json`): 1,000 synthetic notes of about 250 tokens in English, Traditional and Simplified Chinese, Cantonese and Japanese, 75 questions (17 paraphrase, 17 cross-language, 12 exact term, 8 Cantonese, 7 Traditional/Simplified, 6 near-miss distractors, 8 with no answer). Skipped when the data files are absent.
- **B**: `fixture.json` and `questions.json` next to this file: 52 short chat messages (what the index mostly holds in real use), 36 questions in the same categories, with near-duplicate distractors (two tracking numbers, two invoices, two reservation references). Hand-written, no real data. It is small and easy: every sensible variant reaches recall@5 1.0, so it separates the variants only by MRR and by what happens with no floor.

Metrics, for the questions that have an answer: recall@5 (the fraction of the gold chunks in the first 5), MRR@10 and nDCG@10. "No-answer: returned something" is the share of no-answer questions for which any hit came back at all (lower is better, but see the notes).

## Set A (1,000 chunks, 75 questions)

| variant                                             | recall@5  | MRR@10    | nDCG@10   | no-answer: returned something |
| --------------------------------------------------- | --------- | --------- | --------- | ----------------------------- |
| keyword only                                        | 0.672     | 0.667     | 0.671     | 100%                          |
| vector only (no floor)                              | 0.836     | 0.763     | 0.795     | 100%                          |
| vector only (floor 0.3)                             | 0.761     | 0.716     | 0.741     | 50%                           |
| fused 1:1, k 60                                     | 0.836     | 0.769     | 0.799     | 100%                          |
| fused 2:1, k 60, no id boost                        | 0.806     | 0.758     | 0.797     | 100%                          |
| fused 2:1, k 60                                     | 0.821     | 0.763     | 0.801     | 100%                          |
| fused 3:1, k 60                                     | 0.851     | 0.760     | 0.802     | 100%                          |
| fused 2:1, k 30                                     | 0.881     | 0.783     | 0.820     | 100%                          |
| fused 2:1, k 20                                     | 0.881     | 0.791     | 0.827     | 100%                          |
| fused 2:1, k 5                                      | 0.925     | 0.816     | 0.847     | 100%                          |
| fused 1:1, k 10                                     | 0.881     | 0.802     | 0.832     | 100%                          |
| fused 3:1, k 10                                     | 0.881     | 0.799     | 0.833     | 100%                          |
| fused 2:1, k 10, no id boost                        | 0.910     | 0.792     | 0.828     | 100%                          |
| fused 2:1, k 10, id boost 3                         | 0.925     | 0.809     | 0.841     | 100%                          |
| fused 2:1, k 10, floor 0.2                          | 0.940     | 0.790     | 0.828     | 100%                          |
| fused 2:1, k 10, floor 0.25                         | 0.925     | 0.777     | 0.815     | 100%                          |
| fused 2:1, k 10, floor 0.35                         | 0.881     | 0.780     | 0.805     | 100%                          |
| fused 2:1, k 10, no floor                           | 0.940     | 0.787     | 0.826     | 100%                          |
| **fused 2:1, k 10, id boost 2, floor 0.3 (FUSION)** | **0.925** | **0.801** | **0.836** | 100%                          |

recall@5 by category (A):

| variant                      | paraphrase | cross_lang | exact_term | trad_simp | cantonese | distractor |
| ---------------------------- | ---------- | ---------- | ---------- | --------- | --------- | ---------- |
| keyword only                 | 0.882      | 0.059      | 1.000      | 0.571     | 1.000     | 0.833      |
| vector only (no floor)       | 0.941      | 0.824      | 0.667      | 1.000     | 1.000     | 0.500      |
| vector only (floor 0.3)      | 0.941      | 0.765      | 0.333      | 1.000     | 1.000     | 0.500      |
| fused 2:1, k 60              | 0.941      | 0.529      | 1.000      | 0.857     | 1.000     | 0.667      |
| fused 2:1, k 10, no id boost | 1.000      | 0.765      | 0.917      | 1.000     | 1.000     | 0.833      |
| **FUSION**                   | 1.000      | 0.765      | 1.000      | 1.000     | 1.000     | 0.833      |

Questions the default still misses in the top 5 (5 of 67): four cross-language ones (Traditional Chinese or Japanese asking about a note written in another language: q010, q011, q024, q060) and one Japanese near-miss distractor (q067).

## Set B (52 messages, 36 questions)

| variant                     | recall@5  | MRR@10    | nDCG@10   | no-answer: returned something |
| --------------------------- | --------- | --------- | --------- | ----------------------------- |
| keyword only                | 0.773     | 0.747     | 0.746     | 100%                          |
| vector only (no floor)      | 1.000     | 1.000     | 1.000     | 100%                          |
| vector only (floor 0.3)     | 0.970     | 1.000     | 0.977     | 33%                           |
| fused 1:1, k 60             | 1.000     | 0.939     | 0.950     | 100%                          |
| fused 2:1, k 60             | 1.000     | 0.939     | 0.955     | 100%                          |
| fused 2:1, k 10, floor 0.2  | 1.000     | 0.896     | 0.924     | 100%                          |
| fused 2:1, k 10, floor 0.25 | 1.000     | 0.902     | 0.931     | 100%                          |
| fused 2:1, k 10, no floor   | 0.985     | 0.884     | 0.909     | 100%                          |
| **FUSION**                  | **1.000** | **0.939** | **0.955** | 100%                          |

(All other rows of B equal the FUSION row to the third decimal except 1:1, which is 0.950 nDCG. The full tables are printed by the run.)

## What this says, and what was chosen

`FUSION = { k: 10, top: 50, vectorWeight: 2, keywordWeight: 1, idKeywordWeight: 2, cosineFloor: 0.3 }`.

- **Hybrid beats either side on A**: recall@5 0.925 against 0.836 (meaning only) and 0.672 (keywords only). Meaning-only search is bad at exact terms (0.667 on codes, numbers and names, 0.333 with the floor), keyword-only search cannot cross languages (0.059), and the fusion gets both: exact_term 1.000, cross_lang 0.765, paraphrase 1.000, Cantonese 1.000.
- **k matters more than the weights.** With the textbook k of 60 the keyword side's noise (a common word matching a few notes) outweighs a good vector rank and the fused result is _worse_ than meaning-only on cross-language questions (0.529 against 0.824). A small k makes the top of each list count for much more: recall@5 0.821 at k 60, 0.881 at 30 and 20, 0.925 at 10 and 5. k 10 sits in the flat part of that curve; k 5 is a hair better on A and no different on B, but is at the edge of what was tried, so it was not taken.
- **Weights.** 2:1 for meaning against keywords with the identifier boost beats 1:1 and 3:1 at k 10 (0.925 against 0.881 and 0.881). The identifier boost (keyword weight 2 for a query containing a code, number, e-mail or URL) buys exact_term 1.000 against 0.917 and distractors 0.833; boost 3 gives the same recall with a marginally better MRR, so 2 stays.
- **The cosine floor.** 0.3 (the no-answer calibration) is kept. Without it, or at 0.2, A's recall@5 is 0.940 (+0.015) but on B, which has the real shape of the data, MRR falls from 0.939 to 0.884 to 0.896 because weak neighbours of the query get ranks. At 0.35 the cross-language recall falls (0.588), since right answers in another language have a cosine of only 0.3 to 0.4.
- The assertions in the eval: the default's recall@5 is no worse than meaning-only search's, and no worse than keyword-only search's, by more than 0.02 on both sets (A: 0.925 against 0.836 and 0.672; B: 1.000 against 1.000 and 0.773).

## Limits worth knowing

- Cross-language questions (about 0.77 on A) are the weak spot of the fusion: meaning-only search gets 0.824 there, and loses on everything else. A reranker is the fix if it ever matters.
- A question with no answer still returns hits: the keyword side matches any shared word and the fused list has no absolute score cut. The hits carry their ranks and cosines (`keywordRank`, `vectorRank`, `cosine`); the tool text shows the model the best few and the model judges. The meaning-only variant with the floor returns nothing for 50% (A) and 67% (B) of no-answer questions, but pays 0.075 recall@5 for it.
- Set A is synthetic (the synthetic generator), set B is small and hand-written. They check the direction of a change, not a number to promise anyone. Run the eval again after any change to the tokenizer, the chunking, the model or its prompts.
