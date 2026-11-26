# Knowledge MCP access

Status: accepted (2026-11-26). User guide: `docs/knowledge-mcp.md`.

External MCP clients need controlled access to selected subtrees of Rei's Knowledge without receiving owner session cookies, device tokens, or unrestricted workspace access.

## Decisions

- **Stateless Streamable HTTP on `apps/server` (`/api/mcp/knowledge`)**: Knowledge and its SQLite tables live in `apps/server`. Hosting the endpoint directly on `apps/server` (using Web Standard `WebStandardStreamableHTTPServerTransport` in stateless JSON mode) avoids proxying Knowledge state through the Dodai gateway and evaluates live SQLite permissions and folder subtrees on every request with zero stale session state.
- **Hash-only bearer tokens (`rei_kmcp_…`)**: Secrets carry 256 bits of entropy, are returned once on creation and rotation, and are persisted only as SHA-256 digests alongside a non-secret display prefix. Revoking a token sets `revoked_at` and clears its folder grants while keeping the row so Knowledge revision history continues to resolve `<name> (revoked)`.
- **Deny-all defaults and per-token R/W/D flags**: New tokens start with `read = false`, `write = false`, `delete = false`, and `allowedPageIds = []`. `tools/list` hides unpermitted tools, and `tools/call` re-checks both flags and live subtree membership.
- **Folder-subtree scoping with anti-enumeration**: Allowed folders resolve dynamically via recursive CTE over live pages (`trashed_at IS NULL`). Paths omit ancestors above the outermost in-scope root; missing, trashed, and out-of-scope IDs return one uniform error; keyword/meaning search, similar-page hints, and link reports are filtered to in-scope pages; newly introduced out-of-scope `page:` links are refused.
- **Descendant-only Trash delete**: `knowledge_delete` only calls `trashPage()` (30-day Trash retention). A subtree is eligible only when every affected page is in scope and none is a granted root, `Inbox`, or a locked page.
- **External taint and credential isolation**: Every MCP write uses `actor: "mcp:<tokenId>"` and marks affected pages and any resulting content revisions `external`. MCP tokens are rejected on all user/device `/api/*` routes, while user cookies and device tokens are rejected on `/api/mcp/knowledge`. Cross-origin `Origin` headers are rejected (`403`) and request bodies are capped at 512 KiB (`413`).

## Considered and not done

- **Hosting on the Dodai gateway**: The gateway holds upstream provider credentials and has no access to Rei's Knowledge SQLite database; adding an internal RPC channel for Knowledge would duplicate auth and complicate live subtree checks.
- **Per-folder permission matrices**: Per-token `read` / `write` / `delete` flags across explicit allowed folders keep configuration and mental models simple; finer scoping can be achieved by creating separate tokens per role.
- **Stateful MCP sessions**: Long-lived server-side MCP session state can drift behind permission edits, token revocations, or page moves; stateless per-request evaluation guarantees immediate enforcement.

## Consequences

- Token revocations, disables, permission edits, and page trash/move operations take effect on the very next MCP request.
- Existing Knowledge revision history and UI views cleanly display external MCP edits with token attribution and `external` markers.
