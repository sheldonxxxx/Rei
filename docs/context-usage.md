# Composer settings and context usage

The composer has a compact input and a right-aligned toolbar below it: model and thinking effort, current permission profile, and context usage. The permission control is always visible, including Standard. It opens the existing chat permission dialog. The model control opens a dedicated model/effort view; agent identity settings retain name, appearance and deletion. Model changes still apply to the agent's chats from their next model call; permissions still apply to the current chat.

Hover or keyboard focus on the circular gauge shows used tokens / maximum context and the used percentage. Click opens a breakdown of input, cached input (a subset of input), latest output, remaining capacity and the model's configured context window. Escape and outside presses dismiss the breakdown. The ring uses warning colour from 75% and destructive colour from 90%.

`GET /api/sessions/:id/context` returns the most recent completed chat or agent-task model call for a visible session. Steps store numeric context fields. Instrumentation records the runtime model's configured context window and reuses the validated provider-usage normalization, including cache writes in inclusive input. Usage is input plus output from that single call, never a sum across calls. Title and memory calls are excluded.

The display is a snapshot, not a tokenizer prediction: it excludes unsent drafts and subsequent tool results, and uses the model configuration at the recorded call. Missing provider reports and unreported totals remain unavailable; reported counts are never fabricated. The gauge refreshes on chat/run changes and polls every three seconds while a run is active.

Validation: web/server typechecks, web production build, 105 focused UI tests, and 15 server context/usage tests passed, along with browser checks on desktop and 390px mobile.

## Per-source input breakdown

The expanded gauge contains an **Estimated input breakdown** with expandable categories for the system prompt, the Capabilities index, skills, core tool definitions, loaded tool definitions, conversation, tool calls/results, connector (MCP) calls/results, and other context. Entries include individual prompt sections, skill names and reference file paths, and tool names. Core tool definitions are the tools a chat starts with; loaded tool definitions are the deferred groups and connector tools that `search_capabilities` loaded since, each by name. Each model call records which of its tools were loaded (`steps.loaded_tools`), because a provider without native tool search receives every offered tool in the request's own tool list. Skill tool results count under Skills and are not double-counted as generic tool results. Skills the user chose with `/` count under Skills as `Selected skill: <name>` (their text is in the user message, so the user's own text stays under Conversation and nothing is counted twice).

Attribution reads the exact stored OpenAI Responses request, including root tools, inline `additional_tools`, `tool_search_output`, function/custom calls, and matching outputs. It excludes billing metadata, generation settings and other non-context fields. This works with retained historical request blobs. Missing or unsupported payloads leave the detailed breakdown unavailable.

Text is tokenized locally with `js-tiktoken`'s `o200k_base` encoding. Category/detail values use `~` because the selected model's tokenizer, message framing and provider-side processing may differ. Their sum is displayed separately and is never scaled to fit or substituted for reported input. Images, attached binary files/audio and encrypted reasoning cannot be reliably tokenized from text and are excluded; the estimate heading tooltip explains these limits. Cache is a subset of reported input, not an extra source category.

The server caches a bounded set of derived counters and labels by immutable payload blob reference, coalescing concurrent requests. It does not copy raw prompt text into the API response or cache. Final session visibility is rechecked after the asynchronous blob read.

Follow-up validation: web/server typechecks, web build, 20 server integration/accounting/attribution tests, then 25 focused attribution/UI tests passed. The latter includes additional MCP schema classification coverage. Browser verified expanded skill and MCP rows and mobile scrolling; captures are `source-breakdown-desktop.png` and `source-breakdown-mobile.png`.

The panel visualizes estimated category shares with a horizontal stacked bar and matching colour dots beside the expandable category rows. Zero-token categories have no bar segment. Segment hover labels show token estimates and percentages of estimated input. The bottom explanatory paragraphs were removed; load errors remain visible.

Token values now use compact K/M notation with up to one decimal place. Bar segments have themed tooltips showing category, token estimate and share, available on hover or keyboard focus. Category rows use a trailing plus/minus control, hover highlight and expanded background instead of disclosure arrows.
