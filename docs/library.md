# Persistent File Library

Library stores successful uploads and explicitly published agent deliverables independently of chats, runs, traces and agent workspaces. Removing a composer selection or deleting its source does not delete its Library file. This is local implementation documentation; deployment is separate.

## Ownership and versions

The database stores files, immutable versions, folders and chat references. Uploads enter the Library immediately; retained tool media appears only when the agent publishes it.

File identity is independent of its filename. Every version points to an original-byte blob envelope. Revisions require the expected base version and return 409 on a conflict. Restoring history appends a version. Messages, reports and questions pin both `fileId` and `versionId`; inspecting an older version is never interrupted by an AI update.

The application currently has one authenticated owner; Library follows that account boundary. Privacy labels accumulate when files are published, staged or reused in another chat. Deleting a chat removes its association while retaining files. Related chats include surviving upload, input and output associations.

Trash is recoverable for 30 days. Permanent deletion requires a confirmation in the UI and `confirm: true` in the authenticated API. Cleanup removes original bytes only after both Library ownership and surviving message references are gone. Historical chat attachments continue to download their pinned bytes after Library removal. Startup and the existing attachment sweep collect eligible bytes; purged metadata remains as an internal tombstone.

## API

All routes use existing authentication and CSRF protection. Upload limits are 1 GiB per file, 10 files and 2 GiB per message. The message total is twice the file limit so one largest file still fits beside smaller ones, and it bounds what one turn copies into the sandbox. Uploads are streamed: the size is enforced as bytes arrive, and the file is staged on disk, never held in memory (see [storage.md](storage.md)). Downloads stream too.

Files of any allowed size are stored and downloadable, but a path that needs the bytes in memory or in front of a model keeps a smaller limit and says so:

| Path                                              | Limit                         | Why                                                                         |
| ------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `read_library_file` on a text file                | first 32,000 bytes            | Text goes into model context; the result says when it is truncated.         |
| `read_library_file` on a binary file              | none (streamed to the sandbox) | The agent inspects it with sandbox tools, never as one model input.         |
| Attachments staged for a turn                     | none (streamed to the sandbox) | Copied a few MiB at a time; images sent to a model are bounded by the read tool. |
| Media kept with a run (`retainMedia`)             | 25 MiB each, 100 MiB in total | Kept for the model's own context.                                            |
| Office preview and compatibility preview          | 100 MiB                       | LibreOffice gets 40 seconds; converted PDFs stay at 25 MiB.                 |
| Text and HTML previews                            | 2 MiB                         | Rendered in the page.                                                        |
| Web previews of other files (images, PDF, media)  | 100 MiB                       | The browser fetches the file whole to render it.                            |
| A file the agent uploads to a website             | 25 MiB                        | Sent to the browser over DevTools in one piece.                              |
| Any other whole-file read on the server           | 100 MiB                       | Refused with "This file is too large to read here".                         |

| Route                                                              | Purpose                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `GET/POST /api/files`                                              | Search/list or upload; filters include type, origin, favorite, folder, Trash, sort and cursor     |
| `GET/PATCH/DELETE /api/files/:id`                                  | Detail/history/related chats; rename, move, favorite, trash/restore; confirmed permanent deletion |
| `POST /api/files/:id/versions?baseVersionId=...`                   | Append uploaded revision                                                                          |
| `POST /api/files/:id/restore-version`                              | Append a copy of an old version using an expected base                                            |
| `GET /api/files/:id/versions/:versionId/content`                   | Original bytes; safe raster thumbnails use `?thumbnail=1`                                         |
| `GET /api/files/:id/versions/:versionId/html`                      | Restricted interactive HTML document                                                              |
| `GET /api/files/:id/versions/:versionId/compatibility?session=...` | Explicit sandbox-based Office PDF preview                                                         |
| `GET/POST /api/library/folders`                                    | List/create folders                                                                               |
| `PATCH/DELETE /api/library/folders/:id`                            | Rename/reparent/delete folder; deletion keeps its files and children at root                      |

Messages accept `files: FileReference[]`. A reference contains `fileId`, `versionId` and optional `location` (sheet/cell/slide/page).

## Agent delivery

`publish_files` snapshots bounded workspace bytes or retained tool media and creates assistant file cards. Workspace paths are confined to the agent workspace and cannot become browser URLs. A stable tool-call/item key makes retries idempotent. Updating a file requires `fileId` and `baseVersionId`; every successful item is attached immediately, including when a later batch item fails. Published worker outputs travel with the durable report to the parent chat.

`search_library` searches metadata; `read_library_file` reads bounded text or stages an exact binary version in the receiving workspace. These tools use the existing policy wrapper. Agents are instructed to publish final deliverables before presenting them. Scratch files and inspection media stay outside Library unless deliberately published.

Gateway normalization preserves bounded typed image/audio/embedded-resource content alongside flattened text. The server retains bytes outside text limits and gives the agent media IDs to publish. Resource links remain links; arbitrary URLs are never fetched automatically. Unpublished retained media expires through ordinary attachment cleanup.

## Viewer and rendering

Library, composer and messages use the same viewer. It has original download, version selection/history, file information, related chats, favorites and an external question composer. “Use in chat” creates a draft with the selected version attached. Library questions create a chat with the chosen agent; questions from chat continue that chat. Both carry the pinned version and available selection context. No sharing UI or public URLs are introduced.

Office and PDF use pinned File Viewer 3.3.3 browser renderers with only Word, spreadsheet, presentation and PDF packages. Each format loads on demand. Vite copies runtime assets to `/file-viewer/`; no document service or execution sandbox is needed for direct rendering. The PPTX chart capability is bundled locally. Static CSP allows WASM and local/blob workers while continuing to disallow JavaScript eval and inline application scripts.

- Word/PDF: document navigation, zoom, selectable text; DOCX has a collapsible page rail.
- Excel: virtual grid, sheet tabs, basic formatting/merges and value/formula inspection. XLSX-family preflight preserves cached values, including zero, and substitutes a visible missing-result marker in a preview-only copy. Legacy spreadsheet preflight reads cached values without calculation and rejects uncached formulas before the renderer can evaluate them. Originals are unchanged.
- PowerPoint: numbered thumbnails, zoom and presentation mode; supported PPTX charts are bundled. Complex diagrams, typography, animations and Office-specific features may differ.
- HTML: rendered/source views and refresh; self-contained inline JavaScript runs in an opaque sandbox origin. Frame response CSP blocks network, parent access, forms, nested frames, objects and base changes. The embedding page restricts frame destinations, blocking external navigation as well. No same-origin, popup or top-navigation privileges are granted.
- Scripts/text: highlighted escaped source, copy and download; standalone scripts never execute. Markdown, images, CSV/TSV, audio/video retain dedicated views.

Office ZIP parsing is cancellable in a worker (15 seconds), bounded to 100 MiB expanded / 32 MiB per member / 10,000 entries / 200,000 spreadsheet cells. External OOXML relationships are removed only from the preview copy. Text/HTML previews are bounded to 2 MiB. Large, damaged, encrypted or unsupported inputs retain original download and a visible recovery action.

**Compatibility preview** is offered explicitly after direct-render failure. It uses the selected agent/chat sandbox and existing LibreOffice conversion, with at most two concurrent conversions. It is labeled PDF/print layout and never silently replaces a spreadsheet grid or slide viewer. Legacy and less-common formats depend on renderer support and can use this recovery path. Compatibility output may recalculate according to LibreOffice and is distinct from the saved-result direct view. It is temporary and never becomes a new Library version.

Fonts and runtime assets are served locally; installed/local system fonts supply text fallback. Exact Microsoft Office layout, formula recalculation in direct view, editing/collaboration and animation playback are outside this version. Native renderer chunks are substantial and load lazily. Codec availability remains browser dependent.

## Validation

See the [synthetic fixtures](../tests/e2e/fixtures/library/README.md). Automated checks cover persistence, restart persistence, conflict detection, idempotent publication, worker delivery, privacy labels, source deletion, Trash/GC, authenticated content, isolation headers, pinned questions, native fallback and cached formula handling. The separately enabled real LibreOffice test covers nine ODF/legacy/modern inputs.

Build the web app before deployment so `/file-viewer/` assets are present. Rebuild the exec image only for the optional compatibility converter and its fonts. Fresh installations create the complete current schema directly.
