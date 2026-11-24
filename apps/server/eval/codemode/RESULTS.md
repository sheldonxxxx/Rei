# Code mode eval: results

Does Code mode (the model writes a JavaScript script that calls tools in a sandbox) beat the model calling tools one
turn at a time? The eval runs ten tasks with the setting off and on, grades the final answers with assertions (no LLM
judge), and records turns, tokens, cache share, wall time, scripts and script failures. It also sweeps `inlineBudget`
(how many tokens of a script's result Pi puts straight into the `codemode` tool output).

## Recommendation

**Leave `codeMode.enabled` off by default.** The ticket's rule asks for a clear drop in turns or tokens on the
multi-step scenarios with equal or better success and no regression on the single lookup. None of that held:

- Success is 10/10 off and 10/10 on, so Code mode is not worse. It is not better either.
- Model turns do not drop: 25 off, 26 on over the eight multi-step scenarios. The model already fans out parallel tool
  calls in one turn when the setting is off (15 file reads in one turn, 31 record reads in one turn), so a script
  saves no round trips.
- Prompt tokens rise: 426,601 off, 497,916 on (+17%) on the multi-step scenarios. Every model call carries about
  2,150 more tokens (the `codemode` section and tool definition: 12,555 → 14,709 for the first call). The single
  lookup pays the same overhead: 31,709 → 35,941 (+13%), same two turns.
- The one clear gain is wall time: 194 s → 138 s on the multi-step scenarios (-29%), 212 s → 158 s over all ten
  (-25%). Output tokens also fall (mean 575 → 261 per run), probably because one script replaces many tool-call
  blocks. Both are real but are not what the rule asks for, and the sample is one run per cell.

Per the spec's stop condition 2 (no gain: ship with the setting off, record the result, do not tune further), the default
stays off and nothing was tuned. The setting remains available for anyone who values wall time on fan-out work.

**Budget: keep `inlineBudget` at 1500.** See the sweep below: no budget shows a gain over another beyond run-to-run
noise, and 3000 costs about 1,500 more tokens on every call for nothing.

What would change the recommendation: tasks where the tool results are large enough that keeping them out of the
context pays off (these scenarios' results were small, and the script saved no context), or a provider where parallel tool calls
are not available.

## Setup of the recorded run

- **Stack:** the local Compose deployment (control, edge, exec, egress, browser, and the shared gateway), rebuilt from
  this checkout, with `REI_DEMO_TOOLS=1`. Real model `gpt-6.2-sol` through the gateway. Date of the run: 2026-11-22.
- **One run per cell** (scenario × setting). No scenario failed, so no rerun was needed to tell flaky from real.
  Treat differences of 10–20% in a single scenario as noise: the same scenario with the same setting varied by more than
  that between the three budget runs (for example `records-sum` on: 52,440 / 76,205 / 100,424 prompt tokens).
- **Language:** the stack's profile memory asks for Traditional Chinese replies, so most answers came back in Chinese
  even for English prompts. The checks accept both languages.
- **Fixtures** are synthetic and seeded through the public API: 14 English library files and 6 Chinese ones (names start
  with `cmeval-`), a Knowledge page `Code mode eval fixtures` with Incidents, Runbooks and Contracts under it, one
  memory line, and the demo connector's 30 invoice records. The run purges the fixtures before it starts and after it
  ends, and touches nothing else on the server.
- **Setting:** the driver turns Code mode on or off through `PUT /api/settings/behavior` and restores it afterwards.
- **Approvals:** a script that sends needs an approval like any tool call. The driver approves every card once, the way a
  user who agrees would.

## Scenarios

| id              | kind     | task                                                                                                           |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| library-grep    | multi    | Which of 14 library files mention a project?                                                                   |
| library-max     | multi    | Of those files, which has the highest budget figure? (the file with the highest budget overall is a decoy)     |
| knowledge-tag   | multi    | Summarise the Knowledge pages tagged `postmortem` that mention an expired certificate (decoys: other tags)     |
| runbook-scan    | multi    | Which of 12 runbooks mention the pager, and what is each one's first step?                                     |
| records-overdue | multi    | List 30 invoices, read each, report the overdue ones over 1000 (decoys: overdue but small, exactly 1000, paid) |
| records-sum     | multi    | Total the amount of all open invoices                                                                          |
| cross-tool      | multi    | Search memory and Knowledge, fetch two contract pages, compare which expires first and the fiscal quarter      |
| single-lookup   | single   | One page lookup. Should not need a script.                                                                     |
| send-approval   | approval | Send three messages (each needs approval; the faux user approves)                                              |
| chinese-grep    | multi    | The library grep, asked in Chinese, over Chinese files                                                         |

## Metrics

- **success:** assertions on the final answer (and, for the approval scenario, on the approval cards). Never a model judge.
- **turns:** model calls over the whole conversation, continuations after approvals included.
- **prompt tokens:** the provider's input tokens summed over the calls, cached and uncached together. The provider
  reports them separately, so **uncached** is the part paid at full price and **cache share** is cached / prompt.
- **first call: tool defs + prompt:** an o200k estimate of everything the model is given before any work, from the
  context breakdown (`usage/context-breakdown.ts`). The difference between the settings is the cost of switching Code
  mode on.
- **wall s:** from sending the message to the end of the run.
- **scripts, nested, direct:** calls of the `codemode` tool, tool calls made inside scripts, tool calls the model made
  itself.
- **script failures by kind:** syntax, runtime, timeout, memory, concurrency, tool_refused, other.

## Full run, inline budget 1500, Code mode off and on

| group         | success off → on | turns         | prompt tokens          | uncached tokens        | wall s           |
| ------------- | ---------------- | ------------- | ---------------------- | ---------------------- | ---------------- |
| multi-step    | 8/8 → 8/8        | 25 → 26 (+4%) | 426601 → 497916 (+17%) | 106985 → 101116 (-5%)  | 194 → 138 (-29%) |
| single lookup | 1/1 → 1/1        | 2 → 2 (0%)    | 31709 → 35941 (+13%)   | 12509 → 7269 (-42%)    | 8 → 8 (-4%)      |
| approval      | 1/1 → 1/1        | 2 → 2 (0%)    | 31835 → 36087 (+13%)   | 12379 → 7927 (-36%)    | 10 → 13 (+27%)   |
| all           | 10/10 → 10/10    | 29 → 30 (+3%) | 490145 → 569944 (+16%) | 131873 → 116312 (-12%) | 212 → 158 (-25%) |

Per scenario:

| scenario        | arm | ok  | turns | prompt tokens | uncached | cache share | first call: tool defs + prompt | wall s | scripts | nested | direct |
| --------------- | --- | --- | ----- | ------------- | -------- | ----------- | ------------------------------ | ------ | ------- | ------ | ------ |
| library-grep    | off | 1/1 | 3     | 53926         | 28198    | 0.48        | 12475                          | 29.1   | 0       | 0      | 15     |
| library-grep    | on  | 1/1 | 3     | 59846         | 17990    | 0.70        | 14732                          | 13.4   | 2       | 15     | 0      |
| library-max     | off | 1/1 | 3     | 57041         | 12113    | 0.79        | 12505                          | 29.2   | 0       | 0      | 15     |
| library-max     | on  | 1/1 | 3     | 59772         | 11004    | 0.82        | 14688                          | 25.0   | 0       | 0      | 5      |
| knowledge-tag   | off | 1/1 | 3     | 49765         | 19941    | 0.60        | 12576                          | 18.7   | 0       | 0      | 9      |
| knowledge-tag   | on  | 1/1 | 3     | 55413         | 8949     | 0.84        | 14658                          | 15.6   | 1       | 8      | 1      |
| runbook-scan    | off | 1/1 | 4     | 65101         | 8013     | 0.88        | 12550                          | 18.9   | 0       | 0      | 6      |
| runbook-scan    | on  | 1/1 | 4     | 78425         | 11353    | 0.85        | 14698                          | 19.3   | 1       | 12     | 2      |
| records-overdue | off | 1/1 | 3     | 51000         | 8888     | 0.83        | 12567                          | 27.0   | 0       | 0      | 31     |
| records-overdue | on  | 1/1 | 3     | 56368         | 17072    | 0.70        | 14767                          | 12.6   | 1       | 30     | 1      |
| records-sum     | off | 1/1 | 3     | 50893         | 8781     | 0.83        | 12549                          | 29.0   | 0       | 0      | 31     |
| records-sum     | on  | 1/1 | 4     | 76205         | 9645     | 0.87        | 14711                          | 15.9   | 2       | 30     | 1      |
| cross-tool      | off | 1/1 | 3     | 48142         | 6286     | 0.87        | 12531                          | 23.7   | 0       | 0      | 3      |
| cross-tool      | on  | 1/1 | 3     | 54733         | 7757     | 0.86        | 14676                          | 15.2   | 0       | 0      | 3      |
| single-lookup   | off | 1/1 | 2     | 31709         | 12509    | 0.61        | 12583                          | 8.0    | 0       | 0      | 1      |
| single-lookup   | on  | 1/1 | 2     | 35941         | 7269     | 0.80        | 14697                          | 7.7    | 0       | 0      | 1      |
| send-approval   | off | 1/1 | 2     | 31835         | 12379    | 0.61        | 12598                          | 10.0   | 0       | 0      | 3      |
| send-approval   | on  | 1/1 | 2     | 36087         | 7927     | 0.78        | 14718                          | 12.7   | 0       | 0      | 3      |
| chinese-grep    | off | 1/1 | 3     | 50733         | 14765    | 0.71        | 12615                          | 18.2   | 0       | 0      | 7      |
| chinese-grep    | on  | 1/1 | 3     | 57154         | 17346    | 0.70        | 14746                          | 20.8   | 0       | 0      | 7      |

Script failures: none. Every script that ran returned a result.

Reading the table:

- The model used a script on six of the ten scenarios with Code mode on (seven scripts, 95 nested calls). On
  `library-max`, `cross-tool`, `single-lookup`, `send-approval` and `chinese-grep` it called the tools directly,
  which is what the single lookup and the three-call scenarios should do. For `library-max` and `chinese-grep` the fan-out
  was 5 and 7 direct calls and it did not reach for a script (at budget 0 it did script `chinese-grep`).
- Where it did script a fan-out, the nested calls ran inside one `codemode` call (`records-overdue`: 30 reads, one
  script). Wall time fell on those (27 s → 13 s, 29 s → 16 s, 29 s → 13 s) but turns did not, because the off arm
  already issued the 31 reads in one model turn.
- Uncached tokens are lower with the setting on (131,873 → 116,312) and the cache share higher (0.73 → 0.80). The same
  scenario's uncached figure moved by 20–50% between runs, so this is cache behaviour, not an effect of Code mode.

## Inline budget sweep (Code mode on, all ten scenarios)

The budget decides how much of a script's output the `codemode` tool result carries inline, and how long the
`codemode` section in the system prompt is. In the faux harness the section is 170, 1,633 and 3,163 tokens for budgets
0, 1500 and 3000. The real runs:

| run         | success | turns | prompt tokens | uncached | first call tool defs + prompt (mean) | scripts | nested |
| ----------- | ------- | ----- | ------------- | -------- | ------------------------------------ | ------- | ------ |
| inline-0    | 10/10   | 33    | 579188        | 132340   | 13234                                | 12      | 112    |
| inline-1500 | 10/10   | 30    | 569944        | 116312   | 14709                                | 7       | 95     |
| inline-3000 | 10/10   | 33    | 669989        | 144037   | 16245                                | 11      | 115    |

Per scenario (turns, prompt tokens, scripts):

| scenario        | turns 0 / 1500 / 3000 | prompt tokens 0 / 1500 / 3000 | scripts 0 / 1500 / 3000 |
| --------------- | --------------------- | ----------------------------- | ----------------------- |
| library-grep    | 3 / 3 / 3             | 53973 / 59846 / 62883         | 2 / 2 / 2               |
| library-max     | 3 / 3 / 3             | 55851 / 59772 / 64456         | 1 / 0 / 1               |
| knowledge-tag   | 3 / 3 / 3             | 52795 / 55413 / 59696         | 0 / 1 / 1               |
| runbook-scan    | 4 / 4 / 4             | 70883 / 78425 / 81505         | 2 / 1 / 1               |
| records-overdue | 4 / 3 / 4             | 73402 / 56368 / 80493         | 3 / 1 / 2               |
| records-sum     | 3 / 4 / 5             | 52440 / 76205 / 100424        | 2 / 2 / 3               |
| cross-tool      | 2 / 3 / 3             | 33116 / 54733 / 59799         | 0 / 0 / 0               |
| single-lookup   | 3 / 2 / 3             | 49412 / 35941 / 58498         | 0 / 0 / 0               |
| send-approval   | 4 / 2 / 2             | 66822 / 36087 / 39081         | 0 / 0 / 0               |
| chinese-grep    | 4 / 3 / 3             | 70494 / 57154 / 63154         | 2 / 0 / 1               |
| mean wall s     | 15.0 / 15.8 / 16.2    |                               |                         |

Reading the sweep:

- Success is 10/10 at every budget. The only script failure of the whole eval is at budget 0: one `chinese-grep` script
  hit a runtime error, and the model recovered in a second script.
- Turns (33 / 30 / 33) and scripts (12 / 7 / 11) differ by about what one scenario's variance does. Prompt tokens are
  579k / 570k / 670k. Budget 3000 is the one setting that is worse in a way that is not noise: the first call is
  1,500 tokens larger than at 1500, and it pays that on every call.
- Budget 0 saves about 1,500 tokens per call against 1500 but showed no benefit in the totals, and it is the only
  setting with a script failure. Nothing here justifies moving from 1500. The wording of the `codemode` description
  and section was not tuned: no failure pattern pointed at it.

## Faux part (runs in the normal suite)

`apps/server/eval/codemode/codemode-eval.test.ts` runs every scenario with the faux model through the in-process
server, with Code mode off and on, and asserts:

- every run succeeds; with Code mode on, each scenario's faux script is exactly one `codemode` call with no failure
  and at least one nested call, and the model makes no direct calls;
- with Code mode off there are no scripts;
- the approval scenario asks and decides three cards in both settings;
- on the six multi-call scenarios a script takes fewer model turns than the off arm, and the first call's prompt is larger
  with Code mode on (the section is there);
- the `codemode` section grows with the budget (170, 1,633 and 3,163 tokens at 0, 1500 and 3000).

The faux model replays scripted directives, so this part tests the harness, the fixtures, the graders and the metrics.
It says nothing about what a real model does. Its turn-count assertion (script < off) is a property of the faux script,
not of Code mode; the real run above shows the real result.

## Reproduce

Prerequisites for the real part, which is skipped without `REI_EVAL_URL`:

- a running Rei stack with a reachable provider through the gateway;
- the demo connector on: `REI_DEMO_TOOLS=1` on the control service;
- the dev login in `containers/.secrets/dev-login.json` (or `REI_EVAL_LOGIN`);
- optional: `REI_CODEMODE_INLINE_BUDGET=<n>` on the control service to change the budget (the default is 1500).

```sh
# the full off/on run
REI_EVAL_URL=http://127.0.0.1:8787 REI_EVAL_LABEL=inline-1500   REI_EVAL_OUT=apps/server/eval/codemode/runs/inline-1500.json   npx vitest run --project server apps/server/eval/codemode -t "real model" --silent=false

# a budget run: restart control with REI_CODEMODE_INLINE_BUDGET=0 (or 3000), then
REI_EVAL_URL=http://127.0.0.1:8787 REI_EVAL_ARMS=on REI_EVAL_LABEL=inline-0   REI_EVAL_OUT=apps/server/eval/codemode/runs/inline-0.json   npx vitest run --project server apps/server/eval/codemode -t "real model" --silent=false

# the tables above
node apps/server/eval/codemode/report.ts apps/server/eval/codemode/runs/inline-*.json
```

`REI_EVAL_ONLY=a,b` picks scenarios and `REI_EVAL_REPEAT=n` repeats each, to tell a flaky failure from a real one.
`report.ts` grades the stored answers again, so a corrected check applies to a recorded run. The run files in `runs/`
are the recorded data behind these tables.

Spend: one off/on run (20 conversations) and two on-only runs (10 each).
