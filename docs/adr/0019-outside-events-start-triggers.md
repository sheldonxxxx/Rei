# Outside events start triggers

Status: accepted (2026-11-16). The sender's contract is `docs/events.md`.

Another service on the owner's network needs to tell Rei that something happened, so an agent can act without waiting for its next scheduled check. That service never calls Rei for tools and never runs an agent. It sends one signed message carrying a reference, and Rei's agent looks the thing up itself through a connector it already has.

## Decisions

- **An event source is an id and a secret.** Rei names no sender. Sources are managed on the command line (`./rei sources`), by the control plane's own admin entry inside its container, like `./rei callers`; the Triggers page lists them read-only.
- **Requests are signed with HMAC in the Standard Webhooks scheme**, to `POST /api/events/<source>` on Rei's ordinary address, outside the device-credential check. The signature covers the id, a timestamp and the raw body, so a captured request can be neither replayed nor altered. It is checked, in constant time, before the body is parsed. Answers carry a status code and a short code and nothing else; an unknown and a disabled source answer the same, and the answer never says how many triggers matched.
- **Secrets are stored, encrypted.** HMAC needs the secret itself. It is kept in the control plane's database under AES-256-GCM with a key in `containers/.secrets/` (`REI_EVENTS_KEY`), so a copy of the database does not reveal it. A rotation keeps the old secret for a grace period.
- **An event is a type and a reference, both in a strict character set.** No free text and no payload, so nothing an outside party writes can reach the agent's prompt through an event. What the run reads afterwards through a connector is tainted as any connector result is. Events are recorded for 7 days, which is also the duplicate window.
- **A trigger starts either on a schedule or on events** (`TriggerStart`). An event trigger names one source and 1–10 types (or `*`). It has no next fire time, and lateness, catch-up and overlap do not apply.
- **Events gather.** An event starts a run if none of that trigger is running or waiting, makes one waiting run if one is going, and joins the waiting run otherwise. A run carries at most 20 events; past that the oldest are dropped and the run is told how many. A retry keeps its events. A paused trigger ignores events and does not replay them on resume.

## Considered and not done

- **A payload in the event.** It would put outside text in the agent's prompt and make the event a second data channel beside MCP. The reference keeps one way to read data, with policy and taint already applied.
- **A bearer token instead of a signature.** Simpler and storable as a hash, but replayable and not bound to the body. It remains the fallback if the signature scheme proves a burden.
- **A separate network for senders.** Signed requests are safe on Rei's ordinary address, which also works from another machine. A network can be added later without changing the contract.
- **Filters on the reference, queuing while paused, and events sent from inside Rei.** Possible later with the same tables.

## Consequences

- A sender must keep the same `webhook-id` when it retries, and must retry for at least an hour, because Rei does not receive events while it is down.
- Losing `REI_EVENTS_KEY` makes stored secrets unreadable; senders then fail with `401 bad_signature` until their sources are rotated.
