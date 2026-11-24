# Runtime schemas are the client contract

Rei will have clients that cannot import TypeScript: native apps in Swift and Kotlin. The client contract in `packages/protocol` therefore moves from plain TypeScript types to runtime schemas. The server validates requests against those same schemas, and OpenAPI and JSON Schema are generated from them so native clients can generate their models. The web app is the first consumer of the published contract: if it needs a private shortcut, the contract is incomplete.

The schemas are written with `@earendil-works/pi-schema`, which the server already uses for tool definitions. Its builders return plain JSON Schema typed with the values it accepts, so the OpenAPI document is assembled from them rather than converted, and it is small and free of `eval`, so the web app can bundle it.

## Considered Options

- **Zod 4:** rejected. It would add a JSON Schema conversion step and a second schema style next to the tool definitions.

- **Keep TS types and hand-write native models:** rejected. Every client would redo the same models by hand, and nothing would catch drift between them and the server.
- **Hand-written OpenAPI beside the TS types:** rejected. That is two sources of truth, and the server's hand-written validation would still be a third.

## Consequences

The server's hand-written request validation is replaced by schema validation as routes are converted. Schemas live in `packages/protocol`, so the rule "update producers and consumers together" now covers the generated artifacts too.
