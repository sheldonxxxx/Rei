# Knowledge MCP access

Rei can expose selected parts of Knowledge to external MCP clients over Streamable HTTP at `/api/mcp/knowledge`, configured entirely in **Settings → MCP** (`/settings/mcp`).

## Enabling access

1. Open **Settings → MCP** (or click the plug shortcut in the **Knowledge** page header).
2. Create a token with **New token**.
3. Choose which Knowledge pages (folders) the token may access. Granting a page grants that live page and all of its live child pages.
4. Enable **Read**, **Write**, or **Delete** as needed.
5. Copy the generated `rei_kmcp_…` secret from the one-time reveal panel. Rei stores only its SHA-256 hash and cannot show the secret again (rotate it to issue a replacement).

## Security model

- **Deny all by default**: Newly created tokens start with `Read`, `Write`, and `Delete` off and no allowed pages. Even when flags are enabled, a token with no live allowed pages cannot read, search, or modify anything.
- **Dynamic scope resolution**: Every MCP request authenticates the token and recomputes its permissions and live folder subtrees directly from SQLite. Disabling, revoking, rotating, editing permissions, or moving/trashing pages takes effect on the very next call.
- **Credential isolation**:
  - Knowledge MCP tokens (`rei_kmcp_…`) are rejected on all user and device `/api/*` endpoints.
  - User session cookies and device bearer tokens are rejected on `/api/mcp/knowledge`.
  - Cross-origin `Origin` headers are rejected with `403`, and request bodies are capped at 512 KiB (`413`).
- **Anti-leakage**:
  - Page paths reported to MCP clients start at the outermost allowed root page and never reveal ancestor titles above it.
  - Missing, trashed, and out-of-scope page IDs return the same error message (`Page <id> is not accessible or does not exist.`).
  - Keyword search, meaning search, duplicate-title hints, and broken-link reports are filtered to the token's allowed subtrees.
  - Newly added `page:<id>` links targeting pages outside the token's allowed subtrees are rejected (pre-existing links on a page survive unrelated edits).
- **Descendant-only Trash delete**: `knowledge_delete` can only move descendant pages inside an allowed folder to Trash (recoverable for 30 days). Rei protects granted root folders, `Inbox`, and locked pages even when deleting an ancestor would otherwise move them to Trash. Permanent deletion is available only to the owner in the Trash UI.
- **Locked pages**: Pages locked for agents remain append-only (`op: "append"`) over MCP.
- **Attribution and taint**: Pages changed through MCP show the token name and carry the `external` label. Content revisions record that same attribution. After revocation, the actor appears as `<name> (revoked)`.

## Available tools

`tools/list` exposes only the tools permitted by the token's live flags:

| Tool | Permission | Behavior |
| --- | --- | --- |
| `knowledge_browse` | `Read` | Lists effective allowed root folders when `pageId` is omitted, or child pages under an allowed `pageId` (`depth` 1–3). |
| `knowledge_read` | `Read` | Reads an allowed page or section (`section`, `maxTokens`), returning scoped path, revision, tags, outline, text, and child pages. |
| `knowledge_search` | `Read` | Runs keyword + meaning search constrained to the token's allowed pages (and optional `under` / `tags`). |
| `knowledge_create` | `Write` | Creates a child page under an allowed `parentId` (top-level creation is refused). |
| `knowledge_edit` | `Write` | Edits an allowed page via structured `ops` or full-source replacement with `baseRevision` conflict recovery. |
| `knowledge_move` | `Write` | Moves a non-root page inside an allowed folder to another allowed `parentId`. |
| `knowledge_delete` | `Delete` | Moves a non-root descendant page and its subtree to Trash (recoverable for 30 days). |

## Client configuration

Point your MCP client at the Streamable HTTP endpoint shown in **Settings → MCP** with a Bearer token header:

```json
{
  "mcpServers": {
    "rei-knowledge": {
      "type": "http",
      "url": "http://127.0.0.1:8787/api/mcp/knowledge",
      "headers": {
        "Authorization": "Bearer rei_kmcp_..."
      }
    }
  }
}
```
