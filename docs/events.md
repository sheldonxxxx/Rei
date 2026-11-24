# Events: letting another service tell Rei レイ something happened

Another service on your network can start a trigger the moment something happens, instead of waiting for the next scheduled check. The service sends one signed message that says what kind of thing happened and points at it. It sends no content: when the trigger runs, the agent looks the thing up itself through a connector it already has. The decisions are in [ADR 0019](adr/0019-outside-events-start-triggers.md).

This page is for the person who runs the stack and for whoever writes the sending service.

## Set up a source

A source is an id and a secret. Rei knows no sender by name.

```sh
./rei sources add my-service --name "My service"   # prints the secret once, on the last line
./rei sources list
./rei sources rotate my-service                    # the old secret works for 24 hours more; --grace 0 ends it now
./rei sources disable my-service                   # and enable
./rei sources remove my-service                    # --force pauses the triggers that listen to it
```

- An id is 2 to 32 characters: a lowercase letter, then lowercase letters, digits or dashes.
- The secret looks like `whsec_` followed by base64. Give it to the sender. It cannot be read back later.
- Secrets are stored encrypted under `REI_EVENTS_KEY` (made by `containers/init.sh`, kept in `containers/.secrets/`). Losing that key makes the stored secrets unreadable; senders then fail with `401` until their sources are rotated.

Then ask an agent for a trigger that starts on events from the source, or edit one on **Settings → Triggers** (Starts: When an event arrives). It names the source and 1 to 10 event types, or `*` for every type. The Triggers page lists the sources read-only, with the last event and the types seen lately.

## The request

```
POST /api/events/<source>
webhook-id: <unique id of this event>
webhook-timestamp: <unix seconds>
webhook-signature: v1,<base64 HMAC-SHA256>
content-type: application/json

{"type":"items.new","ref":"item_42","occurredAt":"2026-11-16T09:30:00Z"}
```

This is the [Standard Webhooks](https://www.standardwebhooks.com) scheme. The signature covers `<webhook-id>.<webhook-timestamp>.<raw body>` with the secret (the base64 part after `whsec_`, decoded). A header may hold several signatures separated by spaces.

The body is exactly these fields, and nothing else:

| Field        | Rule                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| `type`       | lowercase words joined by dots, like `items.new` (up to 4 parts)        |
| `ref`        | 1 to 128 characters from letters, digits and `_ . : / -`                |
| `occurredAt` | optional ISO 8601 time with a zone                                      |

There is no free text and no payload, on purpose: nothing an outside party writes can reach the agent's prompt through an event. **Put nothing sensitive in `ref`.** The agent and the run history show it.

The body is at most 2048 bytes and the timestamp must be within 5 minutes of Rei's clock.

## A signing example

```python
import base64, hashlib, hmac, json, time, urllib.request, uuid

SECRET = "whsec_..."          # from ./rei sources add
URL = "https://rei.example/api/events/my-service"

body = json.dumps({"type": "items.new", "ref": "item_42"}).encode()
msg_id, ts = str(uuid.uuid4()), str(int(time.time()))
key = base64.b64decode(SECRET.removeprefix("whsec_"))
mac = hmac.new(key, f"{msg_id}.{ts}.".encode() + body, hashlib.sha256).digest()
req = urllib.request.Request(URL, data=body, method="POST", headers={
    "content-type": "application/json",
    "webhook-id": msg_id,
    "webhook-timestamp": ts,
    "webhook-signature": "v1," + base64.b64encode(mac).decode(),
})
print(urllib.request.urlopen(req).status)   # 202
```

## Answers

| Status | Code               | Meaning and what to do                                                      |
| ------ | ------------------ | --------------------------------------------------------------------------- |
| 202    |                    | Accepted. Triggers that listen for it will run (or have it waiting).        |
| 200    |                    | A duplicate: this `webhook-id` was already accepted. Treat it as success.   |
| 400    | `bad_event`        | The body or id is malformed. Fix it; do not retry as is.                    |
| 401    | `bad_signature`    | Wrong secret or a body changed after signing. Do not retry as is.           |
| 401    | `stale_timestamp`  | The clock is off by more than 5 minutes. Fix the clock.                     |
| 404    | `unknown_source`   | No such source, or it is disabled.                                          |
| 413    | `too_large`        | Over 2048 bytes.                                                            |
| 429    | `too_many`         | More than 120 events a minute for this source. Wait for `retry-after`.      |

The answer never says how many triggers matched.

## Retries

Rei does not receive events while it is down, and it does not queue them for you. So the sender should:

- **Retry with the same `webhook-id`** (and a fresh timestamp and signature). Rei remembers ids for 7 days, so a retry after a lost answer is a harmless `200`.
- Retry everything except `400`, `401`, `404` and `413`, with growing waits, **for at least an hour**.
- Keep an event that cannot be delivered, rather than dropping it, until you have seen a `202` or `200`.

## What a run gets

Events gather. When one arrives and nothing of that trigger is running, a run starts with it. While a run is going, events make one waiting run and join it, so a burst becomes one more run, not many. A run carries at most 20 events; past that the oldest are dropped and the run is told how many. A retry of a failed run keeps its events. A paused trigger ignores events, and resuming does not replay them. Run now on an event trigger starts a run with no event.

The agent sees a line per event (type, ref and time) after its prompt and looks the items up with its own tools; what it reads is treated like any connector result.
