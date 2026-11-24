# History-search relevance

History search ranks keyword and embedding candidates with the existing reciprocal-rank fusion, then applies a separate relevance check before limiting the response. Relative rank alone is not evidence that a passage is relevant, and neither rank nor a relevance label proves that a passage answers a question.

The gate checks full indexed text, not just a displayed snippet. It ignores common question/function words, preserves meaningful lexical coverage and single-character CJK searches, and normalises case, full-width characters and Latin accents. Queries containing booking/invoice codes, emails or URLs require a complete matching identifier; a nearby code or a prefix collision is rejected. Numeric terms still match whole FTS terms inside dates.

Accepted results have an optional `HistoryHit.relevance` field (`match` or `related`). Strong lexical coverage, an exact identifier or semantic similarity of at least 0.55 is labelled `match`. Weaker semantic candidates admitted by the existing 0.3 vector floor are `related`; at most five are retained. When embeddings are unavailable, partial meaningful keyword coverage can supply related leads. This uses no extra model calls and requires no stored-memory changes or index rebuild.

The search UI marks related results as **Possible lead** and explains when there are no strong matches. Empty results say **No sufficiently relevant matches in your history**. The tool distinguishes empty results from possible leads and tells the model to verify the requested fact using `history_context`, saying it does not know if the fact is absent. All candidates require fact checking, including those labelled `match`.

The tool excludes the user message that initiated its current run, so a question cannot become its own historical evidence. Filtering occurs before the requested result limit. Hidden/deleted-history handling, agent/date filters and taint propagation continue to apply.

## Evaluation

Run the normal memory/search tests, then opt into the real local embedder evaluation:

```sh
npm test -- memory- MemoryPage.test UsagePage.test HistorySearch.test apps/server/test/usage.test.ts
REI_EMBEDDER_URL=http://EMBEDDER:8080 REI_EVAL_OUT=/tmp/memory-eval.json \
  npx vitest run apps/server/eval/memory/memory-eval.test.ts
```

The evaluation compares the prior FUSION ranking and the gated ranking on identical real-embedder candidates. It guards recall within two percentage points of the old ranking, preserves the fraction of questions with at least one correct top-five passage, measures both any returned candidate and non-lead candidates on no-answer questions, and includes an independent multilingual/near-identifier fixture. `REI_EVAL_CANDIDATES=/tmp/candidates` optionally exports **synthetic fixture** candidates for offline analysis; it never exports live user history.

Measured 2026-11-02 with the existing EmbeddingGemma-300M Q8_0 service:

| Fixture                                  | Prior recall@5 | Gated recall@5 | Prior no-answer queries returning anything | Gated returning anything |
| ---------------------------------------- | -------------: | -------------: | -----------------------------------------: | -----------------------: |
| A: 1,000 items, 75 questions             |         92.54% |         92.54% |                                       100% |                      50% |
| B: 52 conversation entries, 36 questions |           100% |         98.48% |                                       100% |                   33.33% |
| C: 8 holdout entries, 14 questions       |           100% |           100% |                                       100% |                   16.67% |

Every remaining no-answer result was labelled a possible lead. No previously answered question lost all its correct top-five passages. B's small recall reduction came from filtering one supporting assistant passage; the original answer-bearing message remained. On A, MRR@10 improved from 0.8014 to 0.8144.

These fixtures are small/synthetic and do not establish universal confidence thresholds. Similar-topic passages can still lack the requested fact. Very short cross-language queries can fall below the existing vector floor; provide context or try a more specific query.
