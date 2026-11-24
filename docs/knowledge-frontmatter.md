# Knowledge frontmatter and tags

Knowledge source editing and Markdown downloads use a YAML 1.2 header with `title`, optional `description`, and optional `tags`. Status, aliases and other fields are rejected. SQLite owns the canonical properties and plain Markdown body; YAML comments, quoting and key order are not preserved (ADR 0012).

```text
---
title: Knowledge design
description: Decisions about shared pages
tags:
  - architecture
  - 知識
---
## Decisions
Page content goes here.
```

Full-source input requires the header and a nonempty title. Omitted description and tags clear those properties. Typed partial writes preserve omitted fields. Ordinary body operations treat YAML-looking text literally. Source serialization retains page and file reference links and body whitespace so downloads can be re-imported without changing their meaning.

Tags are flat shared labels. Identity uses NFKC, lowercase comparison, and normalized whitespace; each page keeps its chosen display spelling. Translations are distinct. Limits are 20 distinct tags, 40 Unicode code points per normalized tag, and a 16 KiB header. The parser rejects duplicate keys, nested values, anchors, YAML aliases, explicit tags, unsupported types and unknown fields. Validation failures save nothing and return an error code and property path; YAML errors include one-based numeric `line` and `column` on the structured issue as well as in the message.

## Interfaces

- Create/save HTTP routes accept optional `metadata: { tags: string[] }` or `sourceMarkdown`. Source input cannot accompany title, description, body or metadata. Saves require `baseRevision`.
- `knowledge_write` accepts metadata on create, metadata or source on edit, and `set_metadata`, `add_tags`, `remove_tags` edit operations. Tag changes require a base revision and are refused for agents on locked pages. Source reads remain native properties plus plain body; source export is available over HTTP.
- `GET /api/knowledge/tags` suggests tags used by non-trashed pages. No independent tag registry or global rename exists.
- HTTP search accepts `q`, `under`, `tags` (a JSON string array) and `limit` (1–20). Agent search uses optional `query`, `under`, `tags` (a string array) and `limit`. Every supplied tag must match. Without query text, results sort by update time, with page id breaking ties.
- Tags affect lexical discovery and exact filtering, not semantic embedding text. Both retrieval paths filter before selecting a limited result set; all section candidates can compete before page deduplication.

The normal editor contains properties, tag chips and body with Write/Preview/Side by side views. Edit Markdown Source transforms the current unsaved draft; switching back validates it without saving. Conflicts preserve the draft and expose base/latest/local source for deliberate reconciliation. Save remains blocked until the user chooses a base. Revisions and restoration include properties and body together, with the existing same-actor, same-session ten-minute grouping policy.

## Fresh development databases

This change intentionally changes the fresh schema only. It does not migrate, backfill or reset existing databases. Startup refuses an initialized database missing the new Knowledge columns rather than partly operating on it.

Reinitialization is destructive and requires explicit user authorization. For the local Docker deployment:

1. Stop the control and edge services to close the database cleanly.
2. Preserve `app.sqlite` and any `app.sqlite-wal`/`app.sqlite-shm` files in a restricted, timestamped backup directory inside the existing control-data volume. Preserve all other files and volumes.
3. Rebuild the web assets and control image, then recreate control and edge. The missing database is initialized with the fresh schema.
4. Complete setup using the newly generated setup code and the saved development password in `containers/.secrets/dev-login.json` (mode 0600). Never copy credentials to reports or source files.
5. Verify health and Knowledge flows. Reinitialization resets login, sessions and other SQLite records. Existing object storage and tree files remain preserved but their former database references are in the backup.

To restore the backup, stop the services and run the corresponding older application version with the archived database. The new version cannot open the older schema. Never overwrite a running SQLite database.
