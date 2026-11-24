# An admitted message freezes its selected skills

When the user sends a message with selected skills, Rei resolves each chip to an exact skill ID and version, checks that the agent can use it at that moment, and puts the skills' instructions into the message's model input in the same commit that admits the message. From then on the message is ordinary durable input, like its text and attachments: the skill versions are part of what the model is given, on the first run and on any replay of that run. Nothing rewrites it afterwards.

Disabling or removing a skill or its plugin blocks new selections and live tool calls. It does not change a message already admitted, queued or run. A selected skill grants no permission; every tool call it leads to is still decided by Rei's policy.

## Considered Options

- **Re-resolve skills when the run starts:** rejected. A queued message could run with different instructions than the user saw, a replay could diverge from the original run, and the transcript would no longer say what the model was given.
- **Withdraw queued input when a skill becomes unavailable:** deferred. It needs a cancellation design for admitted input that does not exist, and the cost of an unrevoked skill instruction is small because it grants nothing. If the product needs it later, it is a new decision.
- **Rely on the model calling `use_skill`:** rejected for explicit selections. An instruction the user chose must not depend on the model choosing to load it.

## Consequences

A failure to load a selected skill before admission rejects the whole send and keeps the draft. A failure after admission is recorded on the input as an error, and Retry is a new admission that checks availability again. The visible message carries the skill IDs and versions; the prepared text is shown in the Trace in detail mode. Because the instructions are in the durable input, a long skill costs context in every later turn until a compaction summarizes it away.
