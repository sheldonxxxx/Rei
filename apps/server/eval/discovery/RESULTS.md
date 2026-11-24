# Discovery eval: results

How well `search_capabilities` finds what a task needs. The eval searches the deferred built-in tools, as the real
browser, plugins and triggers extensions register them, together with the tools of three realistic connectors and the
agent's skills. It uses no model and runs in the normal suite:

```sh
REI_EVAL_OUT=/tmp/discovery-eval.json npx vitest run --project server apps/server/eval/discovery
```

`REI_EVAL_DEBUG=1` (with `--silent=false`) also prints each query's loads, suggested skills and top five candidates
with coverage and score.

## The set

`fixture.json` contains:

- **Three connectors**, shaped like the public MCP servers:
  - a GitHub-like connector with 97 tools (repositories, issues, sub-issues, pull requests and reviews, Actions,
    security alerts, notifications, discussions, gists, projects, labels);
  - a Notion-like connector with 13 tools;
  - a Gmail-like connector with 12 tools.

  Each tool becomes a deferred tool named `<slug>__<tool>`. GitHub and Notion belong to plugins.
- **Eight skills.** Three are in plugins: GitHub `issue-review` and `pr-review`, and Notion `meeting-notes`. Five are
  standalone; one has only a Chinese description.
- **48 queries** in these categories: exact name, group (task wording for a built-in group), paraphrase, connector,
  connector-only, Chinese, mixed Chinese and English, skill, and no answer.

What the eval measures:

- **recall@5:** the share of expected tools, groups and skills found among the first 5 candidates. A group counts when
  any tool of that group is there.
- **MRR@10:** how near the top the first expected result is (the mean reciprocal rank, over the first 10 candidates).
- **Needed loaded or also relevant:** for each expected tool or group, whether it was loaded or listed as "also
  relevant".
- **Unused connector loads:** connector tools that were loaded but that the query didn't need.
- **Connector-only queries** must return the connector's directory and load nothing.
- **No-answer queries** must load nothing, suggest no skills and list nothing as also relevant.

The scenario part, in which a real model works tasks through the deployed stack, needs a gateway and a provider. It is
run by hand at the end of the capability-discovery work (issue 10) and recorded below when it has been run.

## Run 2026-11-08 (Rei BM25 ranker, after tuning)

| category                                  | queries | recall@5 | MRR@10 | needed loaded or also relevant |
| ----------------------------------------- | ------- | -------- | ------ | ------------------------------ |
| exact                                     | 5       | 1.000    | 1.000  | 1.000                          |
| group                                     | 6       | 1.000    | 1.000  | 1.000                          |
| paraphrase                                | 10      | 1.000    | 0.950  | 1.000                          |
| connector                                 | 5       | 1.000    | 0.900  | 1.000                          |
| chinese                                   | 3       | 1.000    | 1.000  | 1.000                          |
| mixed                                     | 3       | 1.000    | 1.000  | 1.000                          |
| skill                                     | 5       | 0.900    | 1.000  | 0/1                            |
| **all**                                   | 37      | 0.986    | 0.973  | 0.969                          |
| connector-only: directory, nothing loaded | 3       | 3/3      |        |                                |
| no-answer: returned something             | 4       | 0/4      |        |                                |

Unused connector loads per connector query: 0.81. The one miss is s1, "review my open GitHub issues". Its strongest
word, "review", matches the pull-request review tools, so `list_issues` is neither loaded nor listed. The
`issue-review` skill it needs is suggested, and that skill names the tools to load.

### The tuning that produced it

The first run used the untuned ranker. Its problems, and the change that fixed each one:

- **Connector-only queries loaded tools.** "github" also appears in every GitHub tool's description. Fix: a query
  whose every term is a word of one connector's name is connector-only, whatever the descriptions say.
- **One word of a longer task loaded something.** For example, "order a pizza" loaded `reprioritize_sub_issue`, and
  "control the living room lights" loaded the browser. Fix: a tool or skill must cover at least two query terms, or
  every term of a one-term query, before it loads or is suggested (`minCoverage`).
- **Chinese queries found nothing,** because the built-in descriptions are English. Fix: a short synonym table maps
  common Chinese words (截圖, 提醒, 網頁, 寄, …) to the English ones.
- **Paraphrases missed.** For example, "read" vs "get", "find" vs "search", and "repo" vs "repository". Fix: the same
  synonym table, scored at 0.9 of a direct match. A light English stemmer also makes "reminder" match "remind" and
  "scheduled" match "schedule".
- **"Fill in the form on this website" and "remind me every Monday"** were weak matches. Fix: the browser and
  triggers index lines now say "websites, fill in forms, take screenshots" and "daily, weekly, monthly".

The load threshold stays at 50% of the top score (`LOAD_RATIO`). With the coverage minimum it loads one to three
connector tools for most queries.

## Connector tools as Pi tools (issue 03), 2026-11-08

The connector numbers above stand: issue 03 registers the same `<slug>__<tool>` names the eval uses, and the eval's
connector floors (recall@5 ≥ 0.95, every connector-only query answered with a directory, at most 1.2 unused loads per
connector query) pass unchanged.

Tree open time with connector tools registered, in the test server (fake gateway, warm tool-list cache, six opens each):

| connectors | tools | open, ms           |
| ---------- | ----- | ------------------ |
| 0          | 0     | 3.1–3.9 (12 first) |
| 5          | 100   | 4.5–7.5 (9 first)  |

About 2–3 ms for 100 tools, well under the spec's 50 ms stop condition.

## Capabilities index size (issue 04), 2026-11-08

`test/capabilities-index.test.ts` renders the index for its worst case: all three deferred groups, 10 connectors and 50 skills with long descriptions (30 shown, then the "more skills" line). It measures 1,079 tokens with the o200k tokenizer. The test's budget is 1,200 tokens; a change that pushes the worst case over it fails the test.

## Finished branch (issue 10), 2026-11-08

The search part was rerun on the finished branch (`119ab69`, after issues 05–09). Every number matches the tuned run above: recall@5 0.986, MRR@10 0.973, needed loaded or also relevant 0.969, 3/3 connector-only queries answered with a directory and nothing loaded, 0/4 no-answer queries returning anything, and 0.81 unused connector loads per connector query. The one miss is still s1. Issues 08 and 09 changed skill ownership and naming, not ranking: standalone skills keep their bare names and plugin skills keep `plugin/skill`, as the fixture already had them.

The index worst case still passes the 1,200-token budget in `test/capabilities-index.test.ts` after its sign-in hint became "Settings → Capabilities → Connectors".

## Scenario part, by hand on the deployed stack (issue 10), 2026-11-08

Run on the fresh local stack in a live browser with one real model, `deepseek-v4.1-flash-1017` through the `aigw` provider, which has no native tool search: Pi appends loaded tools to the request's own tool list. Each run below is one user turn; a turn that stopped for an approval counts with its continuation. Token figures are the provider's reports; cache share is cached input over all input across the turn's model calls.

| scenario                                     | outcome                      | model calls | searches | offered tools | cache share |
| -------------------------------------------- | ---------------------------- | ----------- | -------- | ------------- | ----------- |
| Ask DeepWiki about facebook/react            | success (after one approval) | 4 + 2       | 2        | 29 → 32       | 0.65, 0.95  |
| @DeepWiki, list your tools                   | success                      | 2           | 1        | 24 → 27       | 0.32 (cold) |
| Use DeepWiki after it was removed            | no tool (expected)           | 10          | 5        | 27 → 24       | 0.96        |
| Use DeepWiki after it was added again        | success (after one approval) | 5 + 2       | 3        | 24 → 25       | 0.83, 0.96  |
| Open example.com, read the heading (browser) | success                      | 3           | 1        | 24 → 34       | 0.73        |
| Weekday 9:00 reminder (triggers)             | success (after one approval) | 3 + 2       | 1        | 24 → 28       | 0.74, 0.97  |

Success rate: 5 of 5 scenarios where the capability existed; the sixth correctly found no tool. Searches per scenario: 1 when the model loaded a group or a directory's exact names, 2–3 when it first guessed a connector's name as a load name ("Not found"), which is the main waste seen.

The home chat offers 29 core tools (it adds the session tools); other chats offer 24. Tool-definition tokens (o200k estimate from the context breakdown): the 24 core tools are about 5,100 tokens, the Capabilities index about 234 and the 10 browser tools about 2,100 once loaded. Turns that loaded a group mid-turn still had 0.73–0.74 of their input cached, because loaded tools are appended after the core tools.

## Browser improvements, 2026-11-18

The retrieval eval passed on `8155e97`. Each exact-name query for `browser_wait`, `browser_scroll`, `browser_hover` and `browser_check` ranked the requested tool first and loaded the browser group. Across 41 scored queries, recall@5 was 0.988, MRR@10 was 0.976, and the needed-tool reach metric was 1.000. The three connector-only queries returned directories without loading tools, and all four no-answer queries returned nothing. The remaining recall miss was the existing GitHub issue-review query.
