# Code mode

Code mode lets the agent do multi-step work in one model turn. Instead of calling a tool, reading the result, and calling the next, the model writes a short JavaScript **script**. The script calls tools as `await tools.<name>(args)`, loops and filters in a sandbox, and prints only what the model needs. Only that output goes back into the conversation.

It is **off by default**. The eval below found no drop in model turns or prompt tokens on the multi-step scenarios, so Rei leaves the choice to the owner.

## Turning it on

**Settings → Runtime → Tools → Code mode** (`PUT /api/settings/behavior` with `{ "codeMode": { "enabled": true } }`). The setting is global, not per agent.

- **On:** the model is offered `codemode` as one more core tool, next to its direct tools. It keeps every direct tool; code mode adds an option and removes none.
- **Off:** the model is not offered `codemode`. The offered tools, the system-prompt sections and the recorded request prefix are exactly what they are without the feature, so provider prompt caches are not disturbed.
- Switching installs or removes the tool in open conversations between model requests. No restart is needed.

Not part of code mode: a mode where the model is offered *only* `codemode`, `models.*` inside scripts, letting users write or run scripts by hand, and remote sandboxes.

## What a script is

- The model passes the source as `code`. The sandbox is QuickJS (WebAssembly) in a worker thread, provided by Pi (`pi-durable/codemode`). A script can only call the tools it is given: no network, files, timers or modules of its own.
- Each `tools.x(args)` is a **nested call**: an ordinary tool call with its own policy decision, approval, taint, binding, Trace step and output limits. A script is never a way around policy.
- A script's own call is `read_internal` and never asks. Its calls are what ask.
- `console.log` is the script's output. The model may end with a value too; Pi formats it.
- A script survives a restart. Pi journals its calls; after the restart the script replays, finished calls are not run again, and a call that was parked is picked up again.
- The model may start the script with `// @options: {"timeout_ms": 5000}` to **lower** its deadline. It cannot raise it.

## Who may call what

Every built-in tool names its callers explicitly (`apps/server/src/pi/callers.ts`); a test fails for a tool with none, so a new tool is always a decision.

**Model only.** A script that names one gets a "does not exist" error, and the tool is not listed by `searchTools()` or `describeTool()`.

| Tools | Why |
| --- | --- |
| `codemode` | A script does not start scripts. |
| `search_capabilities`, `use_skill` | They change what the model is offered or loaded; a script has no context to load into. |
| `show_surface`, `update_surface`, `browser_takeover` | They open UI or wait on the user. |
| `start_session`, `message_session`, `cancel_session`, `dismiss_event`, `report` | They start or steer sessions, report back to a parent, or dismiss events. |
| `create_trigger`, `update_trigger`, `delete_trigger` | They change scheduled and event-driven runs. |
| `save_skill`, `create_plugin`, `update_plugin` | They change skills and plugins. |

**Model and scripts.** Everything else, grouped in the script's `tools` object by namespace:

| Namespace | Tools |
| --- | --- |
| `memory` | memory and history search and edit tools (`search_history`, `history_context`, `memory_add`, `memory_confirm`, …) |
| `knowledge` | `knowledge_search`, `knowledge_read` and the page-writing tools |
| `library` | `search_library`, `read_library_file`, `publish_files` and the other library tools |
| `web` | `web_search`, `web_fetch` |
| `browser` | the browser tools, except `browser_takeover` (`browser_upload` stays callable) |
| `sandbox` | `bash` and the file tools |
| `sessions` | `read_chat` and the read-only session tools |
| `skills`, `plugins`, `triggers` | the list and read tools |
| `connectors` | every connector tool the agent may use |
| `demo` | the demo connector's tools (only where it is turned on) |

A script cannot see a connector tool its conversation's agent may not use. Such a tool is filtered out of what the script sees, not only blocked when called (call-time blocking stays as the second line).

**What the model sees about tools.** The `codemode` prompt section lists the non-deferred tools as TypeScript declarations within a budget (about 1,500 tokens; `REI_CODEMODE_INLINE_BUDGET`). Deferred tools (browser, plugins, triggers, connectors) are found with `searchTools()` and can be called without loading; policy applies to the call either way. The optional `_activity` label is left out of the declarations. The tools still accept it.

## Results scripts can use

Tools with a structured output schema give a script an object, not prose. Everything else resolves to its bounded text.

| Tool | A script gets |
| --- | --- |
| `search_history` | `{ hits: [...], note }` |
| `history_context` | `{ sessionId, title, messages: [...] }` |
| `knowledge_search` | `{ hits: [...], note? }` |
| `knowledge_read` | the page: `text`, `outline`, `tags`, `children`, … |
| `search_library`, `read_library_file` | objects with the file fields |
| `read_chat` | the same JSON the text holds |
| `web_search` | `{ query, provider, results: [{ title, url, snippet }], answer? }` |
| `web_fetch` | `{ url, title, text, truncated, pageContentId, … }` |
| a connector tool whose server declares an `outputSchema` | the server's `structuredContent` |

An error rejects with its text; there is no value on error. A connector's `outputSchema` is used only when it is an object schema of at most 16,000 bytes that compiles; a result that does not match it is an `invalid_structured_output` error. The gateway redacts secrets inside structured content as it does in the text.

## Approvals inside a script

A nested call that needs approval takes the same path as a direct call: it gets a card, and the call **parks**. The script waits on that call's promise; it does not run again.

- **Approve:** the call runs once and the script goes on.
- **Deny:** the call rejects in the script with the denial text ("Approval #N was denied…"). The script can catch it or fail.
- **No repeats:** calls the script already made, such as an earlier write, are never run again. This holds across a restart: the replaying script reattaches to the parked call, with one approval row.
- **Restart while parked:** the approval is still pending after the restart, and approving it runs the call once.
- **The deadline includes the wait.** When it passes, or the user presses Stop, the script ends, its parked calls are aborted, and their approvals are withdrawn with "the script that asked for this ended" (`cancelReason: "script_ended"`). The model is told, and can run the script again after the user decides.
- **Trigger sessions.** A nested call that needs approval is blocked at once with the approval number. The script fails immediately.

Not built: one card for several nested approvals of the same script. Each call has its own card and the usual grant lengths.

## Limits

| What | Limit |
| --- | --- |
| Overall deadline (tool waits included) | 10 minutes; a script can lower it |
| VM heap | 128 MiB |
| Scripts at once, per server | 4 |
| Output | Pi's `max_output_tokens` handling; longer output is cut and saved to a temporary file |

A script over a limit fails with a clear error and leaves no worker running: `Execution timed out` for the deadline, `out of memory` for the heap, `Too many scripts are running; try again shortly.` for the concurrency limit.

Known limits:

- A script waiting on a card keeps its VM and one of the four worker slots until the card is decided or the deadline passes (about 9 MiB per waiting script).
- Pi's durable path takes a deadline only from the script's own `@options` line, so Rei clamps it. A restart gives the replaying attempt a fresh deadline: a script parked across a restart can wait the full limit again. Parking the `codemode` call itself while all its calls are parked would fix both; it is an upstream change.
- Connector calls ask for approval even under YOLO, so a script that calls a connector parks on a card.

## Configuration

These are server environment variables. `REI_CODEMODE_TIMEOUT_MS`, `REI_CODEMODE_MEMORY_BYTES` and `REI_CODEMODE_MAX_WORKERS` are read by `apps/server/src/node/config.ts`; the compose files pass `REI_CODEMODE_INLINE_BUDGET` through and leave the others to the image defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `REI_CODEMODE_TIMEOUT_MS` | `600000` | Deadline for a whole script, tool waits included. |
| `REI_CODEMODE_MEMORY_BYTES` | `134217728` | Heap of the script's VM. |
| `REI_CODEMODE_MAX_WORKERS` | `4` | Scripts running at once. |
| `REI_CODEMODE_INLINE_BUDGET` | `1500` | Tokens the `codemode` section may spend on tool declarations. `0` lists none, and scripts find tools with `searchTools()`. |

The setting itself (on or off) is stored in Rei, not in the environment. The control image must keep `quickjs-wasi` and the engine's worker file; its build checks both.

## Untrusted output

When any nested call in a script was a `read_external` tool (the web, a connector read), the script's output is wrapped before the model sees it: a line naming the source tools, then `<<<page-content id=X>>>` … `<<<end page-content id=X>>>`. The id appears nowhere in the output. The session is tainted from the nested reads, as for direct calls. A failed read counts too, since its error can quote what it read. The `untrusted_content` note lists "the output of scripts that read outside content". A script that read only internal tools is not wrapped.

The temporary file Pi writes for long output holds the raw text, unwrapped. No model tool reads it today; one that does must treat it as outside content.

## What the Trace and the chat show

- **Trace.** The `codemode` step's input is the code; its output is what the model got. Nested steps carry `parentStepId`, are listed after their script, and share its run, so paging never splits them. The script's own step lists its calls (`tool.script.calls`). `RunTrace.totals.toolCalls` counts nested calls plus the script. The context breakdown shows one tool call and one result for a script, since nested outputs never enter the model's context.
- **Chat.** One row per script, with the model's `_activity` or "Ran a script", and "· N calls". Full mode shows the calls under it; Simple mode shows only the row. A nested approval card sits under its script's row and says "Asked by a script". Inspect shows the code with line numbers, the output and the call list. See [tool-activity.md](tool-activity.md#scripts-code-mode).

## Evidence

- Eval: `apps/server/eval/codemode/RESULTS.md`. Ten scenarios, real model through the local stack. Success was 10/10 with Code mode off and 10/10 on. On the multi-step scenarios turns went from 25 to 26 and prompt tokens rose 17%, because the model already issues parallel tool calls and a script saves no round trip; each model call carries about 2,150 more tokens with the section. Wall time fell 29% and output tokens about half. The budget sweep (0, 1500, 3000) passed 10/10 at each. The setting stays off by default.
- Scenario tests: `apps/server/test/codemode*.test.ts`, `apps/web/src/components/ToolActivity.script.test.tsx`, and `tests/e2e/code-mode.test.ts` (a real server process: a script, a nested approval, a restart while parked).
