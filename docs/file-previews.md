# File previews

The persistent Library implementation supersedes the original attachment-only viewer. See [Persistent File Library](library.md) for storage, APIs, agent publication, browser Office rendering and the current validation evidence.

Click a file card in a chat, or **Preview** next to an uploaded composer attachment, to open its viewer. The viewer supports Escape, restores keyboard focus on close, fills the screen on mobile, and offers the original download even if previewing fails. Preview is read-only.

## Research and approach

Reviewed the official documentation of existing AI chat applications before implementation:

| Application                                                                                                                                               | Documented approach                                                                                                                      | Applied here                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Open WebUI — File Management](https://docs.openwebui.com/features/chat-conversations/data-controls/files/)                                               | File cards open a viewer; Office files have rendered previews.                                                                           | One viewer for chat and composer attachments.                                                                     |
| [Open WebUI — File Browser](https://docs.openwebui.com/features/open-terminal/file-browser/)                                                              | Text/code, PDFs, CSV/TSV, spreadsheets, Word and slides use viewers suited to their type; Office layout can be rendered by the terminal. | Type-specific rendering; browser Office rendering is primary, with explicit sandbox compatibility conversion.     |
| [LibreChat — Code Interpreter](https://www.librechat.ai/docs/features/code_interpreter) and [Artifacts](https://www.librechat.ai/docs/features/artifacts) | File rows open a panel with preview, source and download controls; source-file size limits bound previews.                               | Rendered/source views for HTML, Markdown and delimited tables; bounded text previews; original download retained. |

Uploads, published deliverables, composer selections and messages share the same viewer and immutable Library references. Arbitrary workspace paths are never exposed.

## Formats

| Formats                                                                      | Viewer                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML, HTM                                                                    | Sandboxed rendered document with Source view. Saved Library HTML permits inline JavaScript in an opaque origin; external resources, forms, popups and parent access are blocked. Legacy attachments retain a static preview.        |
| TXT, LOG, JSON, JSONL, YAML, XML, TOML, source code and other `text/*` files | Escaped text, preserving whitespace; UTF-8 and BOM-marked UTF-16.                                                                                                                                                                   |
| MD, Markdown, MDX                                                            | Existing safe Markdown renderer and Source view. MDX is treated as Markdown; components are not executed.                                                                                                                           |
| CSV, TSV                                                                     | Quoted-field-aware table, with Source view; up to 200 rows and 50 columns.                                                                                                                                                          |
| DOC/DOCX, XLS/XLSX, PPT/PPTX; common Office templates; ODT/ODS/ODP; RTF      | Browser File Viewer renderers. Excel provides a read-only grid, sheet tabs and saved-value inspection; PowerPoint provides slide navigation. Explicit Compatibility preview uses LibreOffice PDF print layout after direct failure. |
| PDF                                                                          | Locally bundled File Viewer PDF renderer.                                                                                                                                                                                           |
| PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO                                    | Full-size image. SVG is loaded as an image, never as an active document.                                                                                                                                                            |
| MP3, WAV, OGG, M4A, AAC, FLAC; MP4, WebM, MOV, OGV                           | Browser audio/video controls; codec support depends on the browser.                                                                                                                                                                 |
| Other binary files                                                           | Download fallback with a clear unsupported-format message.                                                                                                                                                                          |

Known extensions take precedence over uploaded MIME metadata, so ordinary files uploaded as `application/octet-stream` still preview. Text previews are limited to 2 MiB. Other previews are limited to 100 MiB (the browser fetches the file whole to render it, and Office conversion copies it into the sandbox), and converted PDFs are limited to 25 MiB. Files up to the 1 GiB upload limit are still stored and downloadable. Office and PDF runtime assets are bundled locally. Password-protected, damaged or unsupported documents show a failure message and preserve the original download.

## Office runtime and access

The exec image includes `libreoffice-writer`, `libreoffice-calc`, `libreoffice-impress`, Liberation fonts and Noto CJK fonts. Rebuild the exec image when deploying this change. Custom execution environments need `python3` and `soffice` on PATH. Only explicit compatibility conversion requires an execution sandbox. Direct Office/PDF previews work without one.

Compatibility conversion uses the existing execution environment, not the control-plane host or an external document-viewer service. Each conversion gets a temporary directory and LibreOffice profile with macro execution disabled. Conversion has a 40-second subprocess timeout and a 50-second execution timeout; temporary files are removed afterward. At most two distinct conversions run concurrently; repeated requests for the same session/file share the pending conversion. Derived PDFs are not persisted or cached.

`GET /api/sessions/:id/attachments/:attachmentId/preview` authenticates and checks the same session/inherited-file access rules as downloads. It returns a PDF for Office inputs, rechecks access after conversion, and uses `Cache-Control: no-store`. Original downloads and the existing image thumbnail endpoint retain their original-byte behavior. No arbitrary local path is accepted.

LibreOffice conversion parameters follow its [official CLI documentation](https://help.libreoffice.org/latest/en-GB/text/shared/guide/start_parameters.html). Font substitution, pagination and unsupported Office features may cause differences from Microsoft Office.

## Validation

- Automated viewer tests cover classification, rendered/source views, CSV quoting and bounds, text-size rejection, retry, cancellation, URL cleanup, keyboard dismissal and original downloads.
- API tests cover authentication, cross-chat denial, Office formats, missing sandbox, original-byte preservation, active-content rejection and deletion during conversion.
- Converter tests cover argument passing, profile configuration, timeout configuration, failure cleanup and non-PDF rejection.
- Real LibreOffice checks generated PDF previews from ODT/DOC/DOCX, ODS/XLS/XLSX and ODP/PPT/PPTX. Opt in with `RUN_OFFICE_PREVIEW_TESTS=1 npx vitest run --project server apps/server/test/office-preview.integration.test.ts` on a machine with LibreOffice.
