# Knowledge page text lives in SQLite, not Garage

Rei keeps file bytes in Garage, so a reader might expect Knowledge page bodies there too. We keep page text and its revisions in SQLite instead: agents edit pages section by section and the browser autosaves, and each save must commit the revision, the page's revision counter and the search-index outbox row together. Garage would turn every small edit into the pending → put → verify → ready ledger dance with network reads for every outline. Pages are small Markdown (capped at 256 KB) — the same kind of data as chat messages, which already live in SQLite. Images and attachments in a page are Library files, so their bytes stay in Garage.

## Consequences

Revisions grow `app.sqlite`; consecutive edits by the same actor within 10 minutes coalesce into one revision to keep that bounded. A future move to PostgreSQL carries page text along with the rest of the application state.
