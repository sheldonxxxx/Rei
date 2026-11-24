# Web-reading eval: results

What `web_fetch` hands the model for a fixed corpus of frozen pages. Each fixture runs through the real read path (`readPage` on the server and the reader core: redirects, limits, content types, extraction) with a fake proxy transport serving the files in `pages/`. There is no network and no model, so it runs in the normal suite:

```sh
REI_EVAL_PRINT=1 REI_EVAL_OUT=/tmp/web-eval.json npx vitest run --project server apps/server/eval/web-reading --silent=false
```

Token counts use o200k (`js-tiktoken`). Each result carries a random content-fence id, so counts move by a few tokens from run to run.

## The set

- **40 fixtures** in `corpus.json`, with bodies in `pages/`. They are hand-written, except the long pages, the Latin-1 page and the binary files, which come from `generate.ts` (deterministic, output frozen in the repo).
- **Categories:**
  - articles: short, a 40K-character feature, a 57K-character encyclopedia page with an infobox
  - docs: a sidebar-heavy guide, a 60-option config reference, `llms.txt`, a negotiated `text/markdown` page
  - API: a 40-endpoint reference, OpenAPI JSON
  - CJK: Traditional Chinese, Japanese, and a long Chinese report
  - tables, code, forum thread, news front page
  - malformed markup, Latin-1, a missing content type
  - short valid pages
  - JavaScript shells: empty, `__NEXT_DATA__`, JSON-LD, meta/noscript, and a misleading shell with heavy site chrome
  - blocked pages: 403, 429, a CAPTCHA served as 200, a login wall
  - prompt injection: a forged fence marker, hidden instructions
  - redirects: allowed cross-host, denied host, loop
  - oversize, PDF, PNG, RSS
- **46 questions:** 38 with a gold span (checked against the source), plus 8 controls the page cannot answer. Three controls sit on long pages.
- **`expect`** is the quality class ticket 02 should assign. Today's code does not classify, so the baseline only records it.

**Not covered here:** DNS rebinding, private addresses and egress-proxy behaviour. These live below the reader and are tested in `apps/reader/test` and `test/egress.test.ts`. JavaScript rendering is also not covered; it arrives with tickets 08–10.

## Run 2026-11-14: baseline, 20,000-character slicing (today's `web_fetch`)

| metric | value |
| --- | --- |
| Extraction recall (gold span anywhere in the extracted page, success pages) | 35/35 = 1.000 |
| First-result recall (gold in the first call's result) | 31/35 = 0.886 |
| First-result tokens, mean / p50 / p95 | 1,249 / 199 / 4,397 |
| Tokens to evidence, mean / p50 / p95 / max | 1,609 / 269 / 7,748 / 23,241 |
| **Long pages (> 1,500 tokens): tokens to evidence, mean / max** | **8,327 / 23,239** (5 pages, 6 questions) |
| Calls to evidence, mean / max | 1.11 / 2 |
| Control questions: tokens read to the end of the page, mean | 4,901 |
| JavaScript shells with embedded content recovered | 0/3 |
| False successes (returned as a page, should not be) | b03-captcha, b04-login-wall, j03-jsonld, j05-misleading-shell |
| Wrong failures (success pages that errored) | none |
| Boilerplate kept | a03 "ADVERTISEMENT" (ad slots inside the recipe), i02 white-on-white instruction text |
| Extraction time p50 / p95 | 0.6 / 7.5 ms |

Per fixture (evidence `calls:tokens` per answerable question, `miss` = never reached):

| fixture | expect | outcome | page tokens | first result | calls to end | evidence |
| --- | --- | --- | --- | --- | --- | --- |
| a01-blog-post | success | ok | 292 | 348 | 1 | 1:348 1:348 |
| a02-news-long | success | ok | 4743 | 3266 | 2 | 2:4871 |
| a03-recipe | success | ok | 222 | 279 | 1 | 1:279 1:279 |
| a04-encyclopedia-long | success | ok | 9138 | 3293 | 3 | 2:6481 1:3293 |
| b01-forbidden | blocked | http_error | 0 | 0 | 0 | |
| b02-rate-limited | blocked | http_error | 0 | 0 | 0 | |
| b03-captcha | blocked | ok | 33 | 76 | 1 | |
| b04-login-wall | blocked | ok | 40 | 92 | 1 | |
| c01-zh-article | success | ok | 204 | 270 | 1 | 1:270 1:270 |
| c02-ja-docs | success | ok | 124 | 180 | 1 | 1:180 |
| c03-zh-long | success | ok | 23095 | 17614 | 2 | 2:23241 |
| d01-docs-guide | success | ok | 293 | 344 | 1 | 1:344 1:344 1:344 |
| d02-config-reference | success | ok | 5018 | 4342 | 2 | 1:4342 |
| d03-llms-txt | success | ok | 156 | 204 | 1 | 1:204 |
| d04-markdown | success | ok | 85 | 128 | 1 | 1:128 |
| g01-oversize | error | too_large | 0 | 0 | 0 | |
| i01-fake-fence | success | ok | 108 | 160 | 1 | 1:160 1:160 |
| i02-hidden-instructions | success | ok | 80 | 129 | 1 | 1:129 |
| j01-spa-empty | requires_js | no_text | 0 | 0 | 0 | |
| j02-next-data | requires_js | no_text | 0 | 0 | 0 | miss |
| j03-jsonld | requires_js | ok | 2 | 50 | 1 | miss |
| j04-noscript-meta | requires_js | no_text | 0 | 0 | 0 | miss |
| j05-misleading-shell | requires_js | ok | 196 | 243 | 1 | |
| l01-forum-thread | success | ok | 172 | 224 | 1 | 1:224 |
| l02-news-front | success | ok | 149 | 196 | 1 | 1:196 |
| m01-broken-markup | success | ok | 72 | 121 | 1 | 1:121 |
| m02-latin1 | success | ok | 22 | 69 | 1 | 1:69 |
| m03-no-content-type | success | ok | 38 | 82 | 1 | 1:82 |
| p01-api-reference | success | ok | 7627 | 4397 | 2 | 2:7748 |
| p02-openapi | success | ok | 343 | 394 | 1 | 1:394 |
| r01-redirect-allowed | success | ok | 28 | 77 | 1 | 1:77 |
| r02-redirect-denied | policy_denied | redirect_denied | 0 | 0 | 0 | |
| r03-redirect-loop | error | too_many_redirects | 0 | 0 | 0 | |
| s01-short-status | success | ok | 23 | 63 | 1 | 1:63 |
| s02-short-glossary | success | ok | 41 | 96 | 1 | 1:96 |
| t01-pricing-tables | success | ok | 204 | 251 | 1 | 1:251 1:251 |
| t02-code-tutorial | success | ok | 219 | 269 | 1 | 1:269 1:269 |
| u01-pdf | unsupported_mime | unsupported | 0 | 0 | 0 | |
| u02-image | unsupported_mime | unsupported | 0 | 0 | 0 | |
| x01-feed | success | ok | 149 | 199 | 1 | 1:199 |

## Run 2026-11-14: quality classification and embedded content (ticket 02)

Same slicing; extraction now classifies each page and reads what app shells embed. `j02`, `j03` and `j04` now expect what their embedded content yields: `success`, `success` and `low_quality`. That moves two questions onto success pages (37).

| metric | baseline | ticket 02 |
| --- | --- | --- |
| Pages given the expected class | not classified | **40/40** |
| False successes | 4 | **0** (CAPTCHA and login wall are now `blocked`; misleading shell is `requires_js`; JSON-LD shell is read) |
| JavaScript shells with embedded content recovered | 0/3 | **3/3** (`json-ld`, `next-data`, `meta`) |
| Extraction recall (success pages) | 35/35 | 37/37 |
| First-result recall | 31/35 | 33/37 |
| Long pages: tokens to evidence, mean / max | 8,327 / 23,239 | 8,329 / 23,243 (unchanged: presentation is ticket 05) |
| Boilerplate kept | ad slots in a03, white-on-white text in i02 | unchanged |
| Extraction time p50 / p95 | 0.6 / 7.5 ms | 0.7 / 7.9 ms |

The class only changes what happens to pages that were never readable. Bot checks, sign-in walls and app shells now fail with a message that names the reason. Pages read from embedded data or meta tags carry a note before the fence saying so. Short pages, pages with a reCAPTCHA comment form and server-rendered app pages stay `success` (unit tests in `test/web-extract.test.ts`).

## Run 2026-11-14: query mode, ranked passages (ticket 04)

A new block in the eval stores each success page in a `WebDocumentStore` and asks every question through `search` (bm25 over FTS5 with the CJK bigram split, heading and title matches weighted 3×, at most two passages per section before others, a 1,500-token o200k budget). It measures passage text only; ticket 05 adds the framing (title, section ids, footer) and decides how the result is shown.

| metric | 20,000-character slicing | query mode |
| --- | --- | --- |
| Gold span in the result (answerable questions) | 31/35 in the first result | **38/38** |
| Long pages (> 1,500 tokens): tokens to evidence, mean | 8,327 | **1,408** (6/6 found) |
| Tokens per result, mean / p95 / max | 1,249 / 4,397 / 17,614 (first result) | 332 / 1,467 / 1,493 |
| Control questions: tokens returned, mean | 4,901 (read to the end) | 611 |

Controls still get their best passages (two of eight match nothing at all), along with how many of the query's terms those passages contain (2/6 to 4/7). That is the signal ticket 05 uses to say the passages may not answer. The page title is indexed with every passage's heading path. Without that, "Is Larkspur up?" matched nothing on a status page whose only use of the name is its title (37/38).

## Run 2026-11-14: the web_fetch v2 contract (ticket 05)

What the model now receives (render.ts), measured two ways per question: **overview then query** (the overview first; a query only when the overview lacks the answer) and **query first**. A page of at most 1,500 tokens comes back whole, the same as the original first slice, so short pages cost exactly what they did.

| metric | baseline (slicing) | overview then query | query first |
| --- | --- | --- | --- |
| Gold span reached (answerable questions) | 37/37 on success pages | **38/38** | **38/38** |
| Tokens to evidence, mean | 1,609 | 551 | 439 |
| **Long pages: tokens to evidence, mean** | **8,327** | **2,244 (−73%)** | **1,663 (−80%)** |
| Long pages: max | 23,239 | 2,976 | — |
| Calls to evidence, mean | 1.11 | 1.13 | 1 |
| Control questions: tokens, mean | 4,901 | 1,365 | 801 |

Overviews of long pages are 658 to 1,170 tokens (target ≤ 1,200). The opening shrinks when a long outline takes its room (d02, p01, about 60 sections each). The injection fixtures keep one fence per result in overview and query modes, and the forged marker stays inside it.

## Run 2026-11-16: through the shared reader (ticket 3 of the shared web reader)

The eval now calls `readPage` (server) and `performRead` (reader core) instead of the in-process `fetchPage`. Extraction code moved to `apps/reader` unchanged, so the numbers should not move.

| metric | ticket 05 | shared reader |
| --- | --- | --- |
| Extraction recall (success pages) | 37/37 | 37/37 |
| False successes, wrong failures, misclassified | 0 | 0 |
| Overview then query: recall / tokens mean | 38/38 / 551 | 38/38 / 530 |
| Long pages: tokens to evidence, mean | 2,244 | 2,244 |
| Query first: tokens mean / long pages | 439 / 1,663 | 438 / 1,662 |
| Control questions: tokens, mean | 1,365 | 1,307 |

No regression. The small differences come from the random fence id and rounding.

## What the baseline says for the plan

- **Extraction is not the bottleneck.** Readability with the Markdown serializer kept every gold span on static pages, including the infobox, the pricing table row, code and the forum reply. This supports deferring the extractor bake-off (Defuddle, Webforai).
- **Token cost sits in long pages, and in CJK above all.** Short pages already cost under 400 tokens. On the five long pages, reaching the evidence costs 8,327 tokens on average. A 20,000-character slice of Chinese is about 17,600 tokens, because slicing counts characters, not tokens. Ticket 05's "at least 60% fewer" target applies to the long-page number (≤ 3,330 mean). Short pages must not get more expensive.
- **Control questions are the worst case.** With no answer on the page, the model reads to the end: 4,901 tokens on average and 23K on the Chinese page. Query mode has to say "not found in this page" from the passage index instead of making the model read everything.
- **Quality classification has concrete targets for ticket 02:**
  - Four false successes: a CAPTCHA, a login wall, a JSON-LD shell returning "Loading…", and a misleading shell whose site chrome passes as content.
  - 0/3 embedded JavaScript payloads recovered.
  - The forged fence marker stays inside the real fence, as intended.

Assertions in the test cover policy and limit refusals, fence integrity on the injection pages, extraction recall of at least 0.95, and no wrong failures. They are floors, so extraction cannot regress while the presentation changes.
