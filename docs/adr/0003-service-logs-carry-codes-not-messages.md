# Service logs carry codes, not messages

Rei's service logs (the stdout stream of control, gateway and egress) accept only short, token-shaped string values: ids, codes, enum-like words and route patterns. Free text is replaced with `"[dropped]"`. Errors appear as `errorCode` plus `errorClass`, never `Error.message`. This holds at every level, `debug` included. A denylist of field names and a regex for credential shapes could never guarantee that conversation content, URLs or uncommon secrets stay out. Rei is built to be inspected, so where full detail is needed it already has a home the user can see and forget: the Trace for agent runs, and the job's status record for background work.

## Considered Options

- **Relaxed debug**: let `debug` include raw messages. Rejected because it turns an operator setting into a way for data to leak, and debug tends to stay switched on.
- **Per-event field allowlists**: rejected because every event would need a schema to maintain. Checking the shape of each value gives most of the safety without that upkeep.

## Consequences

An operator chasing an unfamiliar failure sees `errorCode: "unknown"` and the error class, not the text. The fix is to add a classifier entry, not to loosen the logger. The gateway call log follows the same rule: it no longer saves upstream response bodies or error messages.
