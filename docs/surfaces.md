# Surfaces

> **Status: implemented (Phases 1–3, 2026-11-13).** Terms are defined in [GLOSSARY.md](../GLOSSARY.md#surfaces). Decisions: [ADR 0009 amendment](adr/0009-additive-protocol-without-path-versions.md), [ADR 0014](adr/0014-surfaces-speak-a2ui-v1-with-reis-catalog.md), [ADR 0015](adr/0015-surfaces-live-in-a-pi-document.md).

A **surface** is a live piece of interface an agent places in a session. It replaces rich components written as `ui` fenced blocks. Unlike those, a surface arrives as soon as its tool call is checked, can change in place, keeps every revision, and can be fed by Rei's own sources between runs.

## Why

Fenced `ui` blocks are parsed only after a reply completes, are drawn from a placeholder until then, cannot change once shown, and turn every button press or form step into a full run. That fits static cards and one-shot forms. It does not fit live progress for background work, multi-step forms with instant checks, or views that update without asking the model. Those are what surfaces are for.

## What changes

| Today                                                  | With surfaces                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Model writes ` ```ui ` JSON inside its reply text      | Model calls `show_surface` / `update_surface`                                        |
| Checked after the reply completes                      | Checked per tool call; the model sees errors and repairs in the same run             |
| 9 fixed components, one block each                     | A catalog of composable components with a separate data model                        |
| Cannot change once shown                               | Changes in place by revision, from the agent or a feed                               |
| Each form step is a run                                | Steps and field checks are local; one submit starts one run                          |
| `component` / `invalid` message parts, `POST …/events` | A `surface` part and surface actions; the old parts, endpoint and parser are removed |
| Fallback written by the server                         | Unchanged: the server writes the fallback from the catalog                           |

There is no backward compatibility: Phase 1 ships with a fresh stack (ADR 0009 amendment).

## Wire format

Surfaces speak the **A2UI v1.0** message set verbatim, as a subset (ADR 0014):

- Agent → client: `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`.
- Client → server: `action`.
- Not yet: `callRendererFunction`, `callAgentFunction` and their responses. They are added only once Rei's policy can check each call.

Components are a flat list with one `root`, children referenced by id. Data binds with JSON Pointers (`{"@path": "/x"}`). The definitions are written in `pi-schema` to match A2UI's JSON Schema (ADR 0008), so OpenAPI and native models are generated from them.

Rei wraps the A2UI messages in its own `surface` message part, which carries what A2UI lacks:

- `surfaceId`, owning session, current revision and surface state;
- the server-written **fallback** text (a client that cannot draw the surface, or a component in it, shows this; notifications, history search and copy use it too);
- the catalog id and protocol version.

**Spec conformance.** Rei's surface engine must never accept a message the official A2UI v1 schema rejects. A conformance test validates every surface message produced by tests and faux scenarios against A2UI's published v1.0 JSON Schema, vendored with its source commit. This keeps a later swap to an official renderer a drawing-code change only.

A client shows the fallback for a surface whose catalog id or protocol version it does not support, and for a single component it cannot draw.

## Catalog

The catalog id is Rei-owned (for example `rei/catalog/1`).

- **From A2UI's basic catalog, same names and properties:** Text, Image, Icon, Row, Column, List, Card, Tabs, Divider, Button, CheckBox, TextField, DateTimeInput, ChoicePicker, Slider. An official A2UI v1 renderer could draw these later without contract changes. Video, AudioPlayer and Modal are left out on purpose: Rei has no media policy for them yet, and a modal does not fit an inline chat surface.
- **Rei components:** Table, Chart, Map, Timeline, Gallery, Links, plus new **Progress** (bar and status) and **Steps** (a multi-step form or checklist).
- **Web implementations:** `apps/web/src/components/surface/` (the engine is `SurfaceView.tsx`). The schemas are in `packages/protocol/src/surfaces*.ts`; the server checks in `apps/server/src/surfaces/`.

Each component declares its props, its limits, its local checks (required, min/max, pattern) and how it contributes to the fallback.

## Tools

A built-in **surface** tool group, always offered (core). The catalog description lives in the tool descriptions.

- **`show_surface`**: creates a surface with its components and initial data in one call. The server assigns the `surfaceId`. May bind a feed.
- **`update_surface`**: given a `surfaceId` in the same session, changes its components, its data, or removes it.

The tool result is the `surfaceId` and new revision, or the validation errors, so the model can repair in the same run. A refused call is recorded as a validation failure on the surface (or the session) for the Inspector. The tools are replay-safe: the revision is committed in the same commit as the tool result, so a replayed run never writes a surface twice. The model never receives a surface's live data unless an action sends it. Showing a surface grants no permission.

## Storage

Surfaces and their revisions live in a Rei-owned Pi conversation document, `rei.surfaces` (ADR 0015):

- An agent revision is committed in the **same commit** as its tool result.
- Feed revisions go to the same document, coalesced to about one per second per surface. Which surfaces have a feed attached is kept in the `surface_feeds` table, so feeds survive a restart; the server ticks them every second (`apps/server/src/surfaces/feeds.ts`).
- The document forks **as of** the fork point, so a fork holds a frozen copy.
- Each revision records its number, its author (the agent with its tool call id, or the named feed), the time and what changed. Full content is kept for the latest 50 revisions; older ones keep only author, time and a summary.

## Revisions, feeds and states

- **Agent revisions** may change both components and data.
- **Feed revisions** may change data only. In the first release the only feed is a **worker session** (started with `start_session`), bound in `show_surface`. Rei writes a fixed shape: `/status` (the worker's session status), `/steps` (its latest tool steps, each `{label, status}`), `/percent` (100 when done) and `/summary` (its latest reply text). Only changed keys are written. When the worker ends (completed, failed or cancelled), the feed writes its last values and detaches. A worker that has already ended cannot be bound.
- **Surface states:** **live** (feed attached), **idle** (no feed; still usable and updatable by the agent in later runs), **removed** (agent deleted it; shows "Removed" with its last fallback), **frozen** (a fork's copy; not usable).

## Actions

An action is posted to `POST /api/sessions/:id/surfaces/:surfaceId/actions` as the A2UI v1.0 client `action` message, plus the revision the reader saw, the local data model and a client request id.

- Accepted only on live or idle surfaces. An action is **stale** when the agent changed the surface after the revision the reader saw; feed revisions change only data and never make an action stale. A stale action is refused and the surface says so.
- The server reloads the stored surface, re-runs the component checks, and deduplicates by request id: a double submit has no second effect.
- A multi-step form keeps its steps and values locally; only the final submit becomes the user's next input (with the submitted values) and starts a run.
- An action is untrusted user intent. It is never an approval and changes no permission; tool calls the following run makes are decided by policy as usual.

## Limits

Per surface: 200 components, 64 KB of components, 256 KB of data. Per session: 8 live surfaces. Feed revisions coalesced to one per second. Exceeding a limit is a validation error the model sees, never a silent cut. These are starting constants, to be revisited after real use.

## In the app

**Simple mode**

- A surface sits inline in the assistant's reply where its tool call happened. It updates in place, never moves and is never duplicated.
- No frame of its own. A state label shows only when it is not idle (Live, Removed, Frozen).
- `show_surface` and `update_surface` produce no separate activity row: the surface is the visible result. A failed attempt that left no surface gets a quiet row ("Couldn't show a table").
- A session with live surfaces shows a **Live** indicator in its header, naming what feeds them.

**Full mode**

Each surface has an inspect icon button that opens the Inspector on it:

- the revision list: number, author (agent with a link to its run step, or the feed), time;
- a selected revision drawn as it was, its components and data as JSON, and a diff against the previous one;
- validation failures and the model's repairs, each linked to its tool call;
- every action with the server's decision (accepted, stale, rejected) and why.

Follow [DESIGN.md](../DESIGN.md) and [motion.md](motion.md): theme tokens only, both schemes, phone width, icon buttons with names and tooltips, a revision changes content in place without moving layout.

## Native clients

Native clients show the fallback until they ship a renderer. The spec is platform-neutral, so either native SwiftUI/Compose implementations of the catalog or the web renderer in a WebView remain open; that choice is made when a native client ships. An official A2UI v1 renderer for a platform can draw the basic-catalog components; Rei components always need Rei code on each platform.

## Phases

All of 1–3 shipped together on a fresh stack.

1. **One cut:** contract and `surface` part, `rei.surfaces` document, the two tools, web engine and catalog (migrated views, inputs, Steps), actions, the Inspector surface view; remove the `ui` fence pipeline (`parse.ts`, `catalogue.ts`, `component`/`invalid` parts, `ComponentEvent`, `POST /api/sessions/:id/events`, streaming placeholders) and its docs; fresh stack. Forms are in this phase so the existing form feature does not regress.
2. **Feeds:** worker sessions as feeds, live state, the Live indicator.
3. **Data-bound views:** sort, filter and page tables and charts without the model.
4. **Later, each its own decision:** an MCP Apps host (a reserved `app` part with fallback; sandboxed iframe, CSP, bridge), native renderers, A2UI function calls.

## Release checks

- Faux-model scenarios that call the surface tools, so end-to-end tests are deterministic.
- Live-browser end-to-end tests on a fresh stack: a data table or chart; a three-step form with field checks submitted once; a worker progress surface going live then idle (Phase 2).
- Lifecycle: a fork shows a frozen copy; reconnect restores the surface; a stale action is rejected; a double submit has no second effect; light and dark at phone width.
- Real model (provider check, recorded as such): at least 30 prompts, ≥ 90 % valid first time and ≥ 98 % after the repair loop.
- A2UI v1 conformance: every surface message from tests and faux scenarios validates against the vendored official v1.0 JSON Schema.
- `npm run verify`.

## Research basis

Checked 2026-11-13: A2UI v1.0 is the current spec, but the official React renderer `@a2ui/react` 0.15.0 implements v0.8 and v0.9 only; Compose has an official alpha on v0.9.1; there is no official SwiftUI renderer. MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.4) is the standard for third-party tool UI and stays a later phase. AG-UI (1.0.4) is not needed: surfaces travel inside the existing `ReiConversationViewV2` snapshot and patch stream.
