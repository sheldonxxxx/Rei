# Home chat working context

A Home chat keeps one durable conversation across pauses. Human messages, trigger results, and background reports use the same working summary and recent exchanges. **New chat** starts another conversation with the same agent. The full transcript remains visible and searchable.

## Budget and compaction

The default Home chat budget is **64,000 tokens**, capped at 75% of the model window when known, after separately supplied instructions and tools. For providers that fold system updates into a single prompt, the estimate counts the effective instructions and tool set. It leaves out the opaque signatures that a provider returns for replaying a reply, such as encrypted reasoning. The selector keeps the active summary and the latest human input with its following tool chain. It trims complete older groups and keeps the previous exchange when it fits. Mandatory context can exceed this soft budget.

Rei uses Pi compaction to summarize older context and carry forward decisions, constraints, open questions, and work in progress. Either of these conditions can start the same background compaction:

- Model requests reach about **80% of the Home budget**. Rei records the crossing and starts compaction once the conversation has no active run. If a newer summary is applied, or the context is reset, before then, Rei drops that record and the next model request measures again. Pi still handles model-window pressure and overflow during a run.
- The chat has had **60 minutes without a human message** and has finished its current run. Rei checks once per quiet period. It skips short chats and chats with little unsummarized context, and uses the configured verbatim token target for recent exchanges. A tool-heavy exchange can span the cutoff. The summary carries forward decisions and requests from the part that was compacted. Reports and triggers do not reset this clock.

The idle check can reopen an idle Home chat tree. Pi records the check and any resulting task together, so reopening or restarting Rei does not repeat the decision for the same quiet period. A new message can run while summarization is underway. The summary takes effect at the next safe boundary.

Settings → Runtime → Context controls the idle time and Home budget. Automatic compaction follows the general setting and per-model overrides. Normal task chats use Pi's model-window compaction.
