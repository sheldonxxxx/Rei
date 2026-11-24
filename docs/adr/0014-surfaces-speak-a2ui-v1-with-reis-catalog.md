# Surfaces speak A2UI v1 messages with Rei レイ's own catalog

Agent-made interface moves from `ui` fenced blocks to surfaces. Their wire format is the A2UI v1.0 message set used verbatim — `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface` and the client's `action` at first, without renderer or agent function calls — written as `pi-schema` definitions that match A2UI's JSON Schema. Components come from a Rei catalog: layout and input components use A2UI's basic-catalog names and properties, and Rei adds its own (table, chart, map, timeline, gallery, links, progress, steps). A Rei `surface` part wraps the messages with what A2UI lacks: the server-written fallback text, the revision and the owning session. Every client, the web app included, draws surfaces with its own engine until an official A2UI v1 renderer for that platform is worth adopting; swapping one in changes drawing code, not the contract.

## Considered Options

- **Adopt `@a2ui/react` now:** rejected. As of 2026-11-13 the official React renderer (0.15.0) implements protocol v0.8 and v0.9 only, there is no official SwiftUI renderer, and Compose is an alpha on v0.9.1. Adopting it means a forced v0.9 → v1 migration, and Rei's custom components need per-platform code regardless.
- **A Rei-owned shape modelled on A2UI:** rejected. Every A2UI release would need a hand-written translation, and an official renderer could never be swapped in.
- **Vercel json-render:** rejected. A library-defined spec at v0.x, not a multi-vendor protocol.
- **Keep `ui` fenced blocks:** rejected. They are parsed only after a reply completes, cannot change in place, and mix interface into model text.

## Consequences

The A2UI subset grows only by deliberate choice: function calls stay out until Rei's policy can check each one. A2UI's rule that an unresolvable catalog simply fails is softened by the wrapper's fallback, which every client may show instead.
