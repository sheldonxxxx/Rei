# Knowledge eval: results

How well an agent finds and keeps Knowledge pages in a workspace of realistic size, measured with the real service,
the real indexes and the real tools driven by the simulated model. No real model: meaning search runs on the fake
embedder from `test/helpers/fake-embedder.ts`, so it runs in the normal suite:

```sh
REI_EVAL_OUT=/tmp/knowledge-eval.json npx vitest run --project server apps/server/eval/knowledge
```

`REI_EVAL_DEBUG=1` also prints each question's top five hits and which ranking found each one.

## The set

- `fixture.json`: 34 hand-written pages (personal, health, home, finance, travel, projects, work, study, recipes),
  in English, Traditional Chinese and mixed text. Two scenario pages: a **stale** page that is updated after seeding
  (the cleaner moves from Wednesday to Friday) and a **misfiled** page (car insurance under Recipes).
- Generated distractors that reuse the fixture's vocabulary on purpose: "Weekly reviews" with 52 children (the high
  fan-out parent), 60 meeting notes, and 60 reading notes in English and Chinese. That makes 210 pages in all.
- 39 questions: exact, paraphrase, Chinese, mixed, stale, misfiled, 5 **meaning** questions that share no word with
  their page ("automobile", "sedan" and "汽車" for the car insurance page; "physiotherapist"; "pager"), and 4 with no
  answer. The keyword run checks that the meaning questions really get nothing from keywords.

Metrics for the questions that have an answer: recall@5 (the share of gold pages in the first 5 hits) and MRR@10.
"No-answer: returned something" counts the no-answer questions for which any hit came back.

## Run 2026-11-07 (keyword search, SQLite FTS5 with Rei's CJK tokens)

| category                      | questions | recall@5 | MRR@10 |
| ----------------------------- | --------- | -------- | ------ |
| exact                         | 8         | 1.000    | 1.000  |
| paraphrase                    | 10        | 1.000    | 0.950  |
| chinese                       | 6         | 1.000    | 1.000  |
| mixed                         | 4         | 1.000    | 1.000  |
| stale                         | 1         | 1.000    | 1.000  |
| misfiled                      | 1         | 1.000    | 1.000  |
| **all**                       | 30        | 1.000    | 0.983  |
| no-answer: returned something | 4         | 0/4      |        |

Scenario checks (all pass):

- **Stale:** "cleaner Friday afternoon" ranks the updated page first; "Wednesday morning" no longer finds it; the old
  text stays in revision 1.
- **Misfiled:** "Zurich car insurance" finds the page first when unscoped, and not at all when scoped under Finance;
  its path reads "Recipes › Car insurance renewal", so an agent can see it is misplaced and move it.
- **High fan-out:** `knowledge_browse` on "Weekly reviews" (52 children) returns 10 lines, newest first, with the
  offset for the next page of results.
- **Budgets:** the prompt pointer is 429 tokens with 210 pages (ceiling 600). Tool answers: `knowledge_search` 332
  tokens; `knowledge_read` of an 8,578-token page 1,901 tokens (text stops near 1,500 at a section boundary and names
  the next section; the outline of all 40 sections comes on top); one section 595 tokens.

## Run 2026-11-07, keyword and meaning fused (fake embedder)

Meaning search fused with keyword search, equal weights, the same 210 pages (`find`, which the agent's
`knowledge_search` and the search box use). The keyword run on the same day matches the table above; on the meaning
questions it scores 0, as intended.

| category                      | questions | keyword recall@5 | keyword MRR@10 | fused recall@5 | fused MRR@10 |
| ----------------------------- | --------- | ---------------- | -------------- | -------------- | ------------ |
| exact                         | 8         | 1.000            | 1.000          | 1.000          | 1.000        |
| paraphrase                    | 10        | 1.000            | 0.950          | 1.000          | 0.950        |
| chinese                       | 6         | 1.000            | 1.000          | 1.000          | 0.917        |
| mixed                         | 4         | 1.000            | 1.000          | 1.000          | 1.000        |
| stale                         | 1         | 1.000            | 1.000          | 1.000          | 1.000        |
| misfiled                      | 1         | 1.000            | 1.000          | 1.000          | 1.000        |
| **shared words** (above)      | 30        | 1.000            | 0.983          | 1.000          | 0.967        |
| meaning                       | 5         | 0.000            | 0.000          | 1.000          | 0.600        |
| **all**                       | 35        | 0.857            | 0.843          | 1.000          | 0.914        |
| no-answer: returned something | 4         | 0/4              |                | 2/4            |              |

What the fused run shows, and what it does not:

- **The plumbing works.** Every question that shares no word with its page is found in the top five, through the
  vector index, the fusion and the checks against live sections. No keyword hit is lost.
- **The fake embedder's noise is visible.** It is a hashed bag of words in 768 buckets, with no stop-word list. "what"
  lands in the same bucket as "vehicle", so "automobile" ranks short pages that contain "what" next to the car
  insurance page (meaning MRR 0.600). "漢字" pulls in "Project Hail Mary" the same way (Chinese MRR 0.917), and the
  two no-answer hits come from shared stop words. A real model does not share these quirks, and its cosines are on
  another scale. These runs therefore use history's 0.3 floor (`FAKE_KNOWLEDGE_COSINE_FLOOR`) instead of the production
  floor (now 0.70, with a 0.10 band under the best hit; first set to 0.55 from a few live EmbeddingGemma queries: unrelated ones scored 0.41–0.52, related ones
  0.69–0.83; see docs/knowledge.md). These numbers say nothing about precision with a real model.
- **Weights.** History search counts meaning double. With that weighting here, the fused run lost a Chinese question
  (recall 0.833) and paraphrase MRR fell to 0.883, because noisy meaning hits outranked exact keyword hits. Equal
  weights kept every keyword hit and still answered the meaning questions. Knowledge pages have curated titles and
  headings, so a shared word is stronger evidence than in a chat log; a real-model run should confirm the choice.

## How to read this

The questions were written alongside the pages, and every paraphrase keeps at least one word of the page, so these
numbers overstate what keyword search does with real questions. The set is for catching regressions (the assertions
are floors just under this run), not a claim about recall in the wild. The meaning questions were written to
match the fake embedder's synonym list, so they test that meaning hits reach the agent, not how well a model
understands meaning.

Not covered here, recorded as skipped: a real-model run, which measures whether agents browse, read and write well on
their own initiative, and how a real embedding model ranks Knowledge sections (needs model quota and a working
embedder; skipped this round).
