# Background work and Memory Review

Memory settings expose one global review cadence: default 5, integer range 2–100. Eligible completed direct-user runs are counted separately in each source session. Triggers, reports, forwarded inputs, failed/cancelled runs and private executions do not count. There is no inactivity trigger. The actual model/provider of the reply at each reserved cut is frozen for that review and its retries; there is no separate Review Model selector or silent model fallback.

Exact N-run windows are reserved durably and processed in session order. Applied changes and explicit `no_changes` complete a window; missing completion is a failure. Automatic retries use bounded backoff and reload current memory. Exhausted failures remain visible in Background Activity and block later windows until Retry. Changing global N reconsiders every unreserved remainder while preserving reserved windows. Disabling cancels unfinished reviews and retires the remainder; enabling starts counting from a fresh boundary without backfill. Existing accepted memory survives.

## Runtime boundaries

`background/service.ts` registers lifecycle subscribers and task kinds. Committed `run.completed` events contain references and routing metadata, not source text. Subscriber acknowledgement and enqueue are transactional. The shared executor owns concurrency (2), leases (120 seconds), automatic attempts (3), backoff, cancellation fences and activity. Unregistered kinds remain queued. Every side effect must validate its active attempt in the same transaction as its commit. Completion after a lost lease, deletion or disable is rejected.

Memory Review uses the reusable private execution primitive described in ADR-0013. The Node adapter performs online SQLite backup in a worker: 256 MiB maximum, 30-second deadline. Each review has a 60-second execution deadline, at most four model calls/tool rounds, a 128,000-token estimated input ceiling and a 1,536-token estimated output ceiling. Lower model context limits still apply. Oversized contexts fail visibly; they are not silently replaced with a reconstructed message window.

Inherited conversation explains references, but only immutable first-party source entries in the new window authorize changes. Current MemoryLines budgets, global revision CAS, protected user edits, atomic validation and Undo remain authoritative. A revision conflict retries with fresh memory. Successful changes create one grouped overlay after the captured source reply, linking to Activity. Undo refreshes the group. No-change reviews write no memory and create no chip.

## Data and cutover

Schema 17 is a fresh-install schema. At the user's request there are no database upgrade or legacy-review cutover paths. Opening an earlier database fails without modifying or resetting it; provision an empty database explicitly. The local development database was replaced under that authorization, with a private backup retained. Ordinary restarts preserve the current database, review windows and settings. Existing Knowledge schema checks remain in force. Other service volumes are not reset by this feature.

Private stores and raw model traces are removed after each attempt; startup removes abandoned stores. Activity keeps outcomes, actual model, usage, duration, source links and memory-change references. Source deletion immediately fences writes, cancels work, removes source-entry references and redacts job payload/result/source links. Aggregate attempt usage survives. Minimal deletion lifecycle events retain only the existing session/agent tombstone IDs; they hold no transcript or message references. Normal accepted memory follows existing deletion behavior.

## Verification

Focused fixtures cover native cut isolation with a continuing source, sleeping/background task cancellation, subscriber rollback, deduplication, independent session windows, global cadence changes, queue pressure, late-write rejection, retry, no-change completion and snapshot cleanup. The fake OpenAI Responses gateway exercises real SDK parsing, guarded batch repair, model reuse, isolated tools, usage and the source overlay. Local full verification and live-browser evidence are recorded separately in `background-memory-review-validation.md`.
