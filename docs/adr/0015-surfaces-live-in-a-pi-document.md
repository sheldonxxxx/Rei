# Surfaces live in a Pi conversation document

A session's surfaces and their revisions are kept in a Rei-owned Pi conversation document (`rei.surfaces`), not in a Rei SQLite table. An agent's revision is written in the same commit as the tool result that made it, so the transcript and the surface can never disagree; a feed's revisions go to the same document, coalesced. The document forks "as of" the fork point, which gives a fork its frozen copy without Rei copying anything, and it is removed with its conversation. This extends ADR 0004: Pi owns what was said, and now also what was shown.

## Considered Options

- **A Rei SQLite table keyed by session and surface:** rejected. It would need its own fork-copy, purge and crash-consistency logic against a transcript it does not commit with.

## Consequences

Feed revisions cannot use Pi's deferred persistence, which only applies to documents that fork from their initial value, so they are coalesced instead (about one per second per surface). Full revision content is kept for the most recent revisions only; older ones keep who changed what and when.
