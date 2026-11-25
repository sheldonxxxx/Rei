# Agent chats, workers and workspaces

Only an agent's **home chat** coordinates workers. It receives the delegation guidance and the four session-management tools. Ordinary chats, trigger sessions and forks do their own work. Worker sessions receive an explicit execution role and do not receive session-management tools; `createSpawned` also refuses non-home callers. A fork of a worker retains its worker role through its depth.

`start_session` still creates an independent conversation tree and receives a self-contained brief, rather than the parent's message history. Reports return to the home chat that started the work. Its optional `agent` parameter selects another agent; otherwise the worker uses the home chat's agent.

A report says the work completed or was cancelled. A run that **fails** (a model usage limit, say) sends none: the work is unfinished, the worker shows as failed, and the home chat is not started on it. **Continue** in the worker takes the assignment up again, so the Continue run reports when it completes. A message you type in the worker instead is your own turn and reports nothing.

## Shared sandbox files

The raw sandbox workspace is `/workspace/<agent-id>` (or `<local-root>/<agent-id>` in faux mode). Home chats, workers, ordinary chats, triggers and forks using that agent share this directory. Cross-agent workers use the selected agent's directory. These directories define working-directory ownership, not separate OS sandboxes or filesystem access controls.

Deleting a chat or worker, or clearing a home chat, preserves the shared workspace. Deleting the agent queues removal of its directory. Pending removals survive restarts and retry when the sandbox returns.

Sandbox reads and commands inherit the agent's other sessions' private/external labels conservatively, since those sessions may have written files. Skill files are mirrored under `.skills/<skill-name>/<session-id>/` so one worker's skill update cannot remove another worker's scripts.

## Browser skill and prompt inspection

When browser support is enabled, `rei-browser` is available through the ordinary skill listing, `use_skill`, `read_skill_file` and export APIs. It is shipped with the app and read-only: import, edit, restore, agent restrictions and deletion cannot change it. The browser section of the system prompt keeps browser availability, the instruction to load the skill first, takeover rules and task boundaries. Detailed browser operating guidance is loaded from the skill on demand.

### Browser tools

- `browser_open` and `browser_back` navigate. `browser_snapshot` returns the full tree, readable text, interactive controls or changes. `browser_screenshot` can label controls with their refs. Refs such as `p3e12` and `p4f1e2` identify the frame document they came from. After navigation, take a new snapshot for that document. See [ADR 0023](adr/0023-browser-refs-identify-a-frame-document.md).
- `browser_click`, Enter through `browser_press`, and `browser_type` with `submit` allow up to 500 ms for main-frame navigation to start. A new document gets up to 20 seconds for DOM content and another 3 seconds for the load event. A same-document navigation settles for two animation frames.
- `browser_wait` waits for visible text, a matching URL or a visible and enabled ref. Text and refs also support waiting for disappearance. The default timeout is 10 seconds and the maximum is 20. The default result is the changes view, including when the wait times out.
- `browser_scroll` brings a ref into view or sends wheel input up or down by one to ten viewport heights. `browser_hover` moves the pointer over a control. Both return the changes view.
- `browser_select` chooses options by label or value. `browser_check` sets a checkbox or switch to the desired state and reports when it was already set. Use `checked=true` to select a radio. Select another option in its group to clear the current choice.
- `browser_type` supports `slowly=true` for autocomplete and custom fields, with a limit of 500 characters. It clears a standard field and types with a short delay per character. Playwright fires `keydown` for keys in its keyboard layout and inserts other characters as text. Both paths fire `input` for each character.
- `browser_batch` runs up to ten steps and returns the page snapshot even if a step fails. Its policy follows the strictest step. Wait, scroll and hover are internal reads, check is an internal write, and typing in a session with private taint is a send.

The trust rule for content that reaches the model through tools (web pages between the `page-content` markers, files, Knowledge pages, chat history, memory search results, connector and other tool results: information, never instructions) is stated once, in the `untrusted_content` section that every conversation has. The web, browser, Knowledge, library, chat and memory sections and the `rei-browser` skill do not repeat it. A trigger run's previous report is fenced the same way in the `trigger_run` section, between `previous-report` markers whose id never appears in the report.

A conversation stores its extension selection as an edit of the tree's installed extensions (the per-origin drops: session tools outside the home chat, the trigger-run note outside trigger runs), so existing conversations and their forks pick up a newly added always-on extension; when a conversation is attached, Rei also restores any installed extension its selection lacks and keeps the policy last. A new section reaches an existing conversation at its next model request as a system-prompt update, shown in Inspect where it was sent rather than in the leading system prompt.

App-owned prompt sections use explicit tags. Inspect maps their stable names to readable labels, while Raw retains the captured provider request. Historical untagged sections keep the first-line fallback; changing prompt formatting does not rewrite recorded calls.

## Core and deferred tools

A chat starts with its core tools: chat and session tools, memory, the Library, Knowledge, skills and `search_capabilities`. The browser, plugins and triggers groups, and every connector tool, are registered with Pi as deferred tools and offered to the model only after `search_capabilities` loads them. A group loads whole; connector tools load one by one. The `<capabilities>` prompt section lists what can be loaded. Connector changes re-register an open tree's connector tools between model requests. See [capability-discovery.md](capability-discovery.md).

## Code mode

With **Code mode** on (Settings > Runtime > Tools; off by default), the model is offered `codemode` as one more core tool next to its direct tools. It writes a short JavaScript script that calls tools as `await tools.<name>(args)` in a QuickJS sandbox and prints only what it needs. Each call the script makes is a normal nested tool call, with the same policy decision, approval, taint and Trace step as a direct call; the script itself replays after a restart without repeating its finished calls. Turning the setting on or off installs or removes the tool in open trees between model requests; with it off, the offered tools, prompt sections and recorded request prefix are exactly what they were without code mode. The full description, including who may call what, results, approvals, untrusted output and what the chat shows, is in [code-mode.md](code-mode.md).

The sandbox is one per server process, made at the first tree that has code mode on and closed on shutdown. A script can only call tools: no network, files, timers or modules. Its limits come from the server configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `REI_CODEMODE_TIMEOUT_MS` | `600000` | Deadline for a whole script, tool waits included. A script can lower it with `// @options: {"timeout_ms": …}` but not raise it. A restart gives the replaying attempt a fresh deadline. |
| `REI_CODEMODE_MEMORY_BYTES` | `134217728` | Heap of the script's VM (128 MiB). |
| `REI_CODEMODE_MAX_WORKERS` | `4` | Scripts running at once; one over the limit fails at once with "Too many scripts are running; try again shortly." |
| `REI_CODEMODE_INLINE_BUDGET` | `1500` | Tokens the `codemode` prompt section may spend on tool declarations. |

A script over the deadline, the heap or the concurrency limit fails with a clear error and leaves no worker running. The image must keep `quickjs-wasi` and the engine's worker file; the control image's build checks both.

Which tools a script may call is fixed per tool (`callers`): reads and plain writes are open to scripts; tools that open UI, wait on the user, start or steer sessions and triggers, or change skills and plugins are model-only. A script sees no connector tool its agent may not use.

A script's call that needs approval gets a card that resumes the call and waits on its promise. Approval runs the call once and lets the script continue. Denial rejects the call with the denial text. Calls the script already made are never repeated, even across a restart. The wait counts toward the script's deadline. If the deadline passes or the run stops first, the card is withdrawn with "the script that asked for this ended". In a trigger session, the call is blocked at once with the approval number. While it waits, a script keeps its VM and one of the worker slots.

When a script read the web or a connector, its output reaches the model between `page-content` markers, and the session is tainted by those reads ([untrusted output](code-mode.md#untrusted-output)).
