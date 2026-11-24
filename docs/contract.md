# Client contract

Every Rei client — the web app today, native apps later — speaks one published contract. It is defined as runtime schemas in `packages/protocol/src/contract/` (ADR 0008) and published as generated documents in `packages/protocol/generated/`:

- `openapi.json`: OpenAPI 3.1 for the REST routes.
- `stream.schema.json`: JSON Schema for the `data` of every server-sent event, by stream and event name.

A route is part of the contract only once it is converted. Unconverted routes still work, but a new client should not rely on them.

## Writing a route

1. Describe it in `packages/protocol/src/contract/<group>.ts` with `defineRoute`: method, Hono-style path, tag, summary, and `body`, `query` and `response` schemas built with `@earendil-works/pi-schema`. Derive the TypeScript type from the schema (`type X = Static<typeof XSchema>`) instead of writing an interface beside it.
2. Add it to `CONTRACT_ROUTES` in `registry.ts`.
3. Register it on the server with `mountRoute(app, route, contract, handler)` from `apps/server/src/http/contract.ts`. The handler receives the checked `body` and `query`, and returns the answer object (or a `Response` for files and streams).
4. Run `npm run contract` and commit the regenerated files. `npm run verify` runs `npm run contract:check`, which fails when they are stale.

Objects are closed: a request with an unknown field is refused, and in tests a response with a field missing from its schema fails. Query parameters are coerced from their string form (`?limit=20` → `20`).

## Errors

Every error answer is `{ error: { code, message, issues? } }`. `message` is one sentence for the user. A validation failure adds `issues`, one per failing field: a JSON Pointer `path` into the body or query, and a `message`.

## Drift checks

Test servers run with `checkContract: true`: every answer from a contract route is checked against its response schema, and a mismatch becomes a 500 `contract_violation`, so the test that caused it fails. Production never pays for this check.

## Streams

Two streams carry live state, both as `text/event-stream` over a long-lived GET (`stream.schema.json` describes each frame's `data`):

- `GET /api/stream`, the global stream: agents, the session list, pending approvals and takeovers, and change notices.
- `GET /api/sessions/:id/stream`, one session's Conversation View: a snapshot, then patches.

An EventSource cannot set headers, so a browser names its client with the `client` query parameter on these routes. Native clients should use a streaming HTTP request with headers and the bearer token instead.

### Framing

A frame is a block of `field: value` lines ending with a blank line:

- `retry: 3000` comes first on every connection: wait that many milliseconds before reconnecting.
- `event:` names the frame. For every frame except `ping`, it equals the `type` field of the JSON in `data:`.
- `data:` is one line of JSON. Its schema is the event's entry in `stream.schema.json`.
- `id:` is set only on committed events of the global stream. It is an opaque cursor: store the last one seen.
- `ping` arrives every 15 seconds with `data: {}`. A client that hears nothing for twice that long should reconnect.

Ignore an event name you do not know (ADR 0009 adds events freely).

### Resuming the global stream

Reconnect with the last `id:` as the `Last-Event-ID` header (an EventSource does this itself). When the server still holds every event after that cursor, it replays them, and the client applies them as if it had never left. Otherwise it sends a fresh `snapshot`, which replaces everything the client holds. A first connection always starts with a snapshot, and its `cursor` field equals its `id:`.

### The session stream

The session stream does not use `id:` or `Last-Event-ID`. Every frame carries `epoch` and `rev`: a `snapshot` starts a new epoch at some revision, and each `patch` advances `rev` by exactly one within that epoch. `applySessionEvent` in `packages/protocol` folds the frames into the view and is the reference implementation. A frame with a different epoch, or a `rev` that skips, means the client lost frames; so does `resync_required`. In every such case, drop the view and reconnect for a fresh snapshot. `session.removed` ends the stream: the session was deleted.

### Checks

Tests read streams through a reader that checks every frame against the stream contract, so a frame the server sends outside its schema fails the test that saw it.

## Browser live view

`GET /api/sessions/:id/browser/live` upgrades to a WebSocket. Native clients send `Authorization: Bearer <device token>` in the handshake. Web clients send the `rei_session` cookie and a same-host `Origin`. The server closes with code `4401` if the credential is rejected, the web origin check fails, the session is missing, or the connected device is revoked or signs out.

Control messages are JSON text frames defined in `packages/protocol/src/browser.ts`. Screen frames are binary JPEGs. The server accepts browser input only while a takeover is active for that session.

## Notifications and links

Every delivery channel (Web Push today; APNs and FCM once their adapters exist) carries the same payload: `{ event, sessionId, messageId?, title, body }`, plain text, with the body replaced by a generic line when previews are hidden. It names a place, never an action. A client builds its own route from the ids. The web app opens `/s/<sessionId>?m=<messageId>`, which scrolls to that message. `sessionId` is `""` for a test notification, which opens the app's start. The payload still carries `path`, the old web hash route (`#/s/<id>`), for service workers cached before path routes. It is deprecated: build from the ids.

## Versions

The contract only grows (ADR 0009):

- `GET /api/health`, open to everyone, reports `protocolVersion` (the contract this server speaks) and `minClientProtocol` (the oldest client protocol it still serves). Both are defined in `packages/protocol/src/contract/version.ts`.
- Every client names itself on every request with `x-rei-client: <kind>/<protocol>`, e.g. `web/1` or `ios/1`. A request that cannot carry headers, such as an EventSource, uses the `client` query parameter instead. A request without either is treated as the web app at the oldest supported protocol, so curl and scripts keep working.
- A client older than `minClientProtocol` is refused everywhere except health with `426 client_outdated`, which a client should turn into "update the app".
- Clients ignore fields they do not know. The server adds fields and routes freely; it removes or changes one only through a deprecation window, and raises `minClientProtocol` only once that window ends.
- Raise `PROTOCOL_VERSION` when the contract grows in a way a client may want to detect.
