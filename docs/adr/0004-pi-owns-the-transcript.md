# Pi owns the transcript; Rei レイ owns product state

With the move to Pi Durable 1.5, the Pi conversation is the only canonical transcript. Transcript entries, live generation, tool state, run failures, compaction and fork markers, and submission settlement are read from Pi, never copied into Rei's own message or run tables. Rei keeps what Pi does not know about: sessions, agents, roles and grants, policy and taint, approvals and takeovers, triggers, the outbox, Library, Knowledge, Memory, the Trace and derived indexes. A server-side Conversation View API merges both and is the only shape clients see. Raw Pi documents never reach a browser or mobile client. Rei's own transcript entries are limited to `rei.*` kinds, at first only `rei.report`. Approvals, takeovers and memory chips are overlays bound to a Pi task or entry ID. Client commands are recorded in a Rei-owned Pi document admitted in the same commit as the Pi submission (`Conversation.submit(tx, draft)`), so a crash can never leave a command recorded without its submission, or the reverse. External side effects still go through Rei's outbox and reconciliation, because no store makes a third-party call exactly-once.

## Considered Options

- **Compatibility projector (A):** turn Pi 1.5 watches back into the old message/run stream. Rejected because it keeps two lifecycles for every message and the recovery code that goes with them, and frontend compatibility was not needed.
- **All product data in Pi documents or StoreStorage (C):** deferred. It would unify some transactions, but it couples all of Rei's data model to the runtime, and there is no consistency or throughput evidence that needs it.
- **Raw Pi watch documents to clients (D):** rejected because it couples clients to an experimental internal API and risks exposing host state.
- **Command ledger in `app.sqlite`:** rejected because two stores can't commit together. Recovering by request ID after a crash between the writes is harder to get right than one atomic commit.

## Consequences

Rei's `messages`, `runs`, `event_log` and `stream_cursors` tables are removed. There is no upgrade path from 1.4 data: the change shipped on a fresh stack. Every consumer of the old tables (history indexing, memory, titles, triggers, attachments, trace, usage, MCP tools) reads Pi entries by stable entry or task ID, or reads a Rei record derived from them that can be rebuilt. A Pi upgrade that changes the shape of the view affects only the server-side view adapter, not the clients.

## Notes from implementation

- Rei writes `rei.input`, `rei.notice` and `rei.trigger` entries. Report data stays inline in the input entry, with no `reports` table.
- Item IDs are `u:<runId>`, `a:<runId>`, `e:<entryId>` and `o:<overlayId>` rather than bare entry IDs, so a queued input keeps its ID once Pi places it. Items still carry their entry ID for fork, edit and retry.

The details are in [Conversation View](../conversation-view.md).
