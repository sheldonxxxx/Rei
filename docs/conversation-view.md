# Conversation View

Since Pi Durable 1.5, Pi owns every chat's transcript ([ADR 0004](adr/0004-pi-owns-the-transcript.md)). Rei has no `messages`, `runs`, `event_log` or `stream_cursors` tables. The server reads each conversation from Pi and merges it with Rei's product state into one shape, the **Conversation View** (`ReiConversationViewV2` in `packages/protocol/src/stream.ts`). Clients only ever see that view, never raw Pi documents.

## What Rei writes into a Pi conversation

- **Entries.** Rei writes three kinds, and each one carries display data in `data`:
  - `rei.input`: a user message, worker report, trigger result or app notice that starts a run. The model sees the staged model text. The chat shows `data`: text, attachments, mentions, sender, component event, trigger or report.
  - `rei.notice`: a data-only line from the app, such as a context note or a failed attachment staging.
  - `rei.trigger`: a trigger's own line in a home chat (a notify reminder, a failure or a self-pause).

  Report data is kept inline in the input entry. There is no separate `reports` table.
- **The command ledger.** The ledger is the conversation document `rei.commands` = `{ order, byId, byRequest, inherited? }`. It is written in the same Pi commit as the submission it describes (`conv.commit(tx => { ledger; conv.submit(tx, draft) })`), so a command is never recorded without its submission, or the reverse.
  - A ledger record holds what Pi does not know: role, `direct`, `assignedBy`, `triggerRunId`, `silent`, `cancelRequested`, the files a reply produced, an `inputDigest` of the model text (FNV-1a, 64-bit), and settlement facts.
  - `byRequest` maps a client's request ID to its run ID. Resending a request ID returns the same run.
- **Withdrawn inputs.** On Stop, Pi drops your messages that were queued behind the running run. Rei writes each one back as a data-only `rei.input` entry (request ID `<runId>:withdrawn`). It stays in the chat as cancelled, with no reply. Use as draft puts the original message and its context back in an empty composer.
- **Steers.** Your own message in one of your chats (`home`, `user`, `fork`, `import`) is submitted with `whenBusy: "steer"` when Settings › Runtime (`BehaviorSettings.chat.whenBusy`, default `steer`) or the send's own `whenBusy` says so; anything else (a report, a trigger result, another agent's message or brief, a component action) always follows up. Its input data carries `steer: true`, and a waiting one shows as a pending user item with `steer`. Pi places a steer after the running run's current tool round and adds it to that run's inputs, so several runs can be `running` at once and all settle with the one answer. The run being answered now is the running one whose input was placed last (`currentRun`): live text, trace steps and the files, surfaces and approvals of its tool calls belong to it. The reply of the input a steer joined shows only what was written before the steer (nothing when that was only tool calls) and counts as done. A steer still waiting when the run answers is placed at that boundary and starts the next run, like a follow-up. Stop withdraws a waiting steer like a queued message.
- **Kept inputs.** A session report, a trigger result and a brief from a parent session can't be sent again by their sender, so they are admitted with `onAbort: "keep"` and Stop leaves them queued: they aren't marked cancelled and get no `:withdrawn` entry. Pi only places queued items with the next input or the next write that changes what the model sees (a data-only write doesn't), so `ConversationCommands.cancel` submits a `continue` right after the stopped run settles. One run then answers the kept inputs and the session isn't left busy. Deleting a session and `cancel_session` (a parent stopping its worker) pass `withdrawAll`, which withdraws kept inputs through `harness.abortSubmission` too.

## Runs

A run's ID is the Pi request ID. `store.runs` is an in-memory `RunRegistry`. It is hydrated per tree when the tree opens, from the ledger and Pi's submission records, and kept current from Pi commits.

- A run's status comes from its submission:
  - queued → `queued`
  - placed → `running`
  - done → `completed`
  - unanswered → `failed` or `cancelled`

  This applies to `input` and `continue` submissions alike.
- **Settlement.** Status, report delivery, notifications, title, review turn and history are applied once. The ledger's `settled` flag records this, so a restart replays only the runs that are still unsettled.
- **Queued admissions.** Approval notices, takeover notices and trigger briefs wait in the `outbox` (kind `admit`) until they are delivered to Pi. Until then they appear as queued placeholder runs.

## Item IDs

| Item                                                                | ID              | Notes                                                                                    |
| ------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| A run's input                                                       | `u:<runId>`     | Stable from admission to settlement, so a queued message keeps its ID once Pi places it. |
| A run's reply                                                       | `a:<runId>`     | Same stability.                                                                          |
| Entries not tied to a run (notice, trigger line, compaction, reset) | `e:<entryId>`   |                                                                                          |
| Overlays (approval, takeover, memory chip)                          | `o:<overlayId>` | Placed after their run's last item.                                                      |

- The web draws a run's approval card just above that run's reply, under its activity row, so you decide before reading the answer that depended on the call.
- Memory cards stay with their source turn, including on older transcript pages. A card from Continue follows the reply it continued.

- Items carry `entryId`. Fork, edit and retry resolve an item to its Pi entry.
- `sessions.forked_from_message_id` stores the item ID.
- **Forks.** A fork copies the entries, so forked items keep their IDs. Their `runId` is `null`, because those runs belong to the source chat.
- **Files.** A fork inherits the files the source chat's replies produced (`ledger.inherited`).

## Tool approvals

Top-level tool calls that require policy approval wait before dispatch, including memory changes, configuration changes, and connector operations. The approval card is the request. The waiting call is parked in Pi: it holds no work, so a long wait costs nothing and the live view shows the call as waiting. A decision, a cancellation or an expiry wakes it with a Pi signal that carries nothing. The call then reads the decision from SQLite again, so approval content never goes into Pi. Allow once resumes that exact Pi task after checking its arguments, tool definition and current authority. Deny or expiry returns a skipped tool result in the original run. Send queues new input and Stop cancels the run and its pending approval.

A tool round of two or more connector reads that each require approval waits before its first tool dispatch. Rei records the per-call decisions in SQLite. The round's call parks until no request of the group is pending. Pi runs its gates again after a wake, a restart or a tool change, and they read the same decisions and never make a second request. The run's time limit excludes the wait for approval. After Pi commits dispatch intent, interrupted connector calls are reported as possibly having run and are not replayed.

The web submits the choices together with `POST /api/approval-groups/:id/decide`. After all requests are resolved, the original tool tasks revalidate their calls and give the model one round of results. The approval overlays track the decision and execution separately. A worker's parent sees the review card while the worker waits, then beside the worker's report.

The chat activity shows work time and approval wait separately. The trace's `durationMs` is elapsed time and `approvalWaitMs` is the part spent waiting for decisions in the original run.

Mixed tool rounds present individual approvals. Existing retry approvals use the block-and-resubmit flow.

## Rewind and message versions

Edit rewinds the chat in place (`POST /api/sessions/:id/edit`). Choose **Save & send** to send updated or unchanged text. Branch on a finished reply still opens a new chat.

- **The swap.** The session's conversation is forked at the entry just before the message (for the chat's first message, an empty conversation is created instead), through the policy guard. The fork is swapped in under the same session: `sessions.pi_conversation_id` names it, the old conversation's sync stops and the new one's starts. Then the text is sent as a direct run. The session id, URL and sidebar entry stay the same; a rewind of the first message keeps the title.
- **Versions.** Every conversation a session has had is a row of `session_branches`: the original (written on the first rewind, no parent), and each rewind's fork with its parent conversation and `cut_entry_id` (the last entry kept; null when nothing was). A fork is always cut from the conversation that owns the cut entry, so all versions of one message hang off one parent at one cut. Pi entry ids are unique within a tree file, so the cut entry names the point.
- **Picking a version.** The arrows under a versioned user message send `POST /api/sessions/:id/version` with `{ messageId, to: "prev" | "next" }`. The switch restores the selected version's most recently used continuation and sends no message. Transcript pages and stream items show the current version index and total. A fork's header says when its source message is on another version of the source chat.
- **The kept prefix keeps its runs.** A fork's ledger starts empty (`fork: "initial"`), so the rewind copies the settled ledger records whose entries are at or before the cut into it (`prefixLedger`). Kept items keep their `runId`, cards, files and trace links.
- **What follows the active version.** Runs come from the active conversation's ledger. Run-linked cards follow their run. A finished browser takeover without a run appears beside its outcome entry, so it follows the retained transcript through paging and message version switches. Pending and active takeovers can appear at the end while they need attention, including in a worker's parent chat. The history index records which conversation wrote each entry (`history_entries.pi_conversation_id`); on every swap, entries outside the active chain are hidden from search (keyword rows, vectors and search-service points go, `branch_hidden = 1`) and entries back in the chain come back.
- **What is not rolled back.** Workspace files, memory notes and side chats started from a replaced version stay. Deleting the chat purges every version's records; Pi keeps a deleted session's conversations in the tree file until the tree is deleted, as for any deleted fork.
- **Busy.** Rewind and version switching return `409 busy` ("Wait for the reply to finish, or stop it.") while a run is going or queued, an approval waits, or a manual compaction runs.
- **The stream.** After a swap every watcher gets a fresh `snapshot` of a new epoch for the new conversation, then patches against it.

## A continue

A Continue (`POST /api/sessions/:id/continue`) starts a run with no input of its own. It answers the input before the entry it continued after:

- That input's reply shows the newest continuing run's state and text.
- The continue run is listed with the window that holds that entry.
- `live.runFailure.canContinue` says whether Pi allows a continue now. It is false after Stop or a reset, and while a run is going.

## Reading the view

- `GET /api/sessions/:id` returns the newest window (100 entries) as `{ session, messages, runs, before, live }`.
- `GET /api/sessions/:id/transcript?before=<itemId>&limit=` pages older history. It returns `{ items, before }`; `before` is `null` at the start of the chat.
- **The session stream** (`/api/sessions/:id/stream`):
  - It sends `snapshot`, then `patch` frames ordered by `{ epoch, rev }`. Frames carry no SSE `id:`, so a reconnect always starts with a fresh snapshot.
  - Live answer text is patched at most every 30 ms. Any other change (a new entry, a run's state, the inbox, a store event) is patched at once. When only the live answer changed, the hub reuses its last read of Pi's entries instead of reading them again.
  - A client that falls more than 2,000 frames behind gets `resync_required`, and the stream ends. A deleted chat sends `session.removed`, and the stream ends.
  - `applySessionEvent` (`packages/protocol/src/view-reducer.ts`) folds frames. The PWA and the server tests share it.
- **The global stream** (`/api/stream`) keeps an in-memory buffer of recent events for replay. A cursor from before a restart is always older than the buffer, so it gets a fresh snapshot.

## The PWA

`apps/web/src/state/session.ts` holds the view, the older pages the user loaded, and sends not yet in the view.

- A pending send is matched to its item by request ID, or by the message ID its POST returned.
- A frame that does not follow (a rev gap, another epoch, or `resync_required`) makes the hook reconnect for a snapshot.
- Items the window slides past move to the loaded pages, so no gap opens.

The chat shows:

- "Load earlier messages" while `before` is set.
- Compaction and reset markers as dividers.
- A note while Pi summarizes or retries.
- Continue after a failed run that Pi can continue.

## Records derived from transcripts

- **`attachment_refs`** (attachment, session, run) records which chats use an uploaded file. It is written at admission and when a reply publishes files, copied on fork, and removed on purge. Attachment and Library liveness checks read it.
- **`memory_review_turns`** stores each counted turn's session, text and time when the turn is counted. A background review needs no transcript read. Turns that ended while the maintainer was stopped are counted by settlement replay when their tree is next opened.
- **`history_entries`** is keyed by item ID (`u:`/`a:`) and rebuilt from settlements.
- **`trigger_runs`** keeps its own `last_*` summary columns.
- **The home chat's context window** finds where its own inputs begin among the model messages by the ledger's `inputDigest`.
