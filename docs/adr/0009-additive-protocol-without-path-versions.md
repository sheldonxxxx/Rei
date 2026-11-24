# The protocol only grows; versions are advertised, not routed

Native clients will lag behind their server by weeks, unlike the web app, which always ships with it. Contract changes are therefore additive only. The server advertises a `protocolVersion` and a `minClientProtocol`, and each client identifies itself and its protocol on every request. A breaking change gets a deprecation window, during which the server keeps the old shape. There is no `/v1` → `/v2` path split.

## Considered Options

- **Path-versioned APIs (`/api/v1`, `/api/v2`):** rejected. For a single-owner, self-hosted server it would mean maintaining parallel route trees. The owner usually controls both ends and can update either, so an advertised minimum version and a clear "update your app" message are enough.

## Amendment (2026-11-13): additive from the first native release

The reason for this rule is native clients that lag their server, and none has shipped yet. Until the first native client release, the contract may break, and a break is taken with a fresh stack (new database, no migration of old conversations) rather than with a compatibility shape. The first such break replaces rich components written as `ui` fenced blocks with surfaces: the old component parts, their event endpoint and their parser are removed, not kept read-only. Once a native client ships, this ADR applies in full.
