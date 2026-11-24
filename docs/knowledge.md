# Knowledge

Knowledge holds shared, nested Markdown pages where agents keep lasting learnings, research, plans and decisions, and
where the user reads them and sometimes edits them. It sits above chat history, which is the day-to-day record, and
beside Memory, the compact layer that is always in the prompt. Vocabulary is in `GLOSSARY.md`. The decisions are in
`docs/adr/0001` (pages live in SQLite) and `docs/adr/0002`.

## Storage and migration

Pages, revisions, links, write-idempotency records and both search indexes live in the main SQLite database. The tables
are `knowledge_pages`, `knowledge_revisions`, `knowledge_links`, `knowledge_calls`, `knowledge_fts` and
`knowledge_vectors`. A link to a page records `page`/`<pageId>` in `knowledge_links` (backlinks read these); a section
link (`page:<pageId>#<slug>`) adds a second row `page`/`<pageId>#<slug>`. Images and
attachments stay Library files and are referenced from Markdown as `file:<fileId>[@<versionId>]`.

- **Schema 6 → 7 → 8** is additive. On startup, a version-6 database gains the Knowledge tables and a version-7
  database gains `knowledge_vectors`; both keep all their data. Nothing needs to be done by hand. Back up the data
  directory first, as before any upgrade (`docs/storage.md`).
- A fresh installation creates the **Inbox** page at setup. The Inbox cannot be trashed.
- `knowledge_fts` is derived. It is rebuilt from the pages on every write, trash, restore and purge.
- `knowledge_vectors` is derived too: one vector per distinct section text, keyed by a hash of that text. A write drops
  the vectors of the sections it changed in the same transaction; a background pass embeds what is missing. Dropping
  the table loses nothing but the time to embed again.
- Trashed pages are purged after 30 days, with their revisions and index rows. Purging one by hand from Trash is
  permanent; only the user can do it, and it asks for confirmation.

There is no configuration. Knowledge is on for every agent. Writes are classed `write_internal`, so policy always allows
them. Each revision records which agent and session wrote it, and whether that session had read outside content. Pages
written that way show an "Outside content" badge and appear under "Needs a look" in the overview.

## Agent tools

| Tool               | Purpose                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge_browse` | Child pages (title, id, description, child count, last writer), newest activity first, with paging (`limit`, `offset`) and up to 3 levels                                              |
| `knowledge_read`   | Path, revision, outline (`§n heading #slug ≈tokens`), then text up to `maxTokens` (default 1500). Long pages stop at a section boundary and name the next section. `section` (`§n`, `#slug`, heading or path) reads one section |
| `knowledge_search` | Search over sections in any language, by shared words and by similar meaning, optionally `under` a page. Hits found only by meaning are marked `(by meaning)`                          |
| `knowledge_write`  | `create`, `edit` (ops: append, append_to_section, replace_section, insert_section_after, replace_text, set_task, set_title, set_description), `move`, `archive` (to Trash). The answer names section links that now point nowhere: other pages' links to a heading this edit renamed or removed, and this page's own links to a slug its target lacks. The write is never blocked by them |

The built-in, read-only skill `rei-knowledge` (`apps/server/src/skills/knowledge/`) teaches how to write a page: page
shape, editing, linking, placement and the Markdown that renders (`references/markdown.md`). The system prompt tells
agents to load it before creating or restructuring a page. Change the Markdown reference together with the dialect
(`docs/rendering.md`); a test in `tests/e2e` checks that every example in it parses to structure.

Edits other than `append` and `set_task` need the base revision from the agent's last read. A stale base fails and
returns the current text. "Lock for agents" allows agents only `append`. A retried tool call returns its first answer
and does not write twice.

The system prompt carries a pointer, capped at about 550 tokens. It lists top-level pages by subtree activity, then
pinned pages and recently updated ones. The eval measured 429 tokens with 210 pages.

## HTTP API

All routes use the existing authentication and CSRF protection.

| Route                                              | Purpose                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/knowledge/tree`                          | Every live page (no bodies)                                                   |
| `GET /api/knowledge/overview`                      | Pinned, recently updated, this week per writer, Inbox, needs a look, counts   |
| `GET /api/knowledge/trash`                         | Trashed pages                                                                 |
| `GET /api/knowledge/search?q=&under=`              | Keyword search                                                                |
| `GET /api/knowledge/file-usage/:fileId`            | Pages linking a Library file (used before permanent deletion)                 |
| `POST /api/knowledge/pages`                        | Create a page                                                                 |
| `GET /api/knowledge/pages/:id`                     | Page, body, ancestors, children, backlinks, files and history                 |
| `GET /api/knowledge/pages/:id/revisions/:revision` | One revision                                                                  |
| `PUT /api/knowledge/pages/:id`                     | Save title, description and body against `baseRevision` (409 on a stale base) |
| `PATCH /api/knowledge/pages/:id`                   | Tick a task, lock, pin, move                                                  |
| `POST /api/knowledge/pages/:id/restore-revision`   | Restore an old revision as a new one                                          |
| `POST /api/knowledge/pages/:id/trash`, `/restore`  | Trash or restore a subtree                                                    |
| `DELETE /api/knowledge/pages/:id`                  | Delete permanently, with `confirm: true`                                      |
| `GET /api/knowledge/pages/:id/markdown`            | Download one page as `.md`                                                    |

Changes are broadcast on the global stream as `knowledge.changed`. Open views refresh. While the editor is open, a
"Page changed — review" banner appears instead.

## Search and evaluation

Search runs two rankings over page sections and fuses them by page:

- **Keyword:** SQLite FTS5 with Rei's CJK-aware tokens. Always on. Common English words ("how", "to", "the") are left out of a query so they cannot match a page on their own; a query of nothing but such words is searched as typed. History search does not do this.
- **Meaning:** the embedding model history search uses, with the same on/off switch (Settings → Memory). Each section
  is embedded as "page title › heading path" plus its text. A query is compared with every vector in memory; at
  Knowledge's size (hundreds to a few thousand sections) that takes milliseconds.

The two are fused with history search's weighted reciprocal rank fusion (`memory/fusion.ts`), but with equal weights:
Knowledge pages have curated titles and headings, so a shared word is stronger evidence than in a chat log. A meaning
hit has to pass two tests, because Knowledge does not filter its results again afterwards the way history does
(`memory/relevance.ts`): a cosine of at least 0.70, and within 0.10 of the best meaning hit. History's 0.3 returned
every page for every query. Measured on the live stack with `embeddinggemma-2` (6-bit), unrelated queries, nonsense
words included, scored 0.52–0.65 against every page and genuine matches 0.72–0.87; the earlier EmbeddingGemma scored
unrelated queries 0.41–0.52, so the 0.55 it needed was too low on the new model and every page came back for every
query. The band keeps a weak page from riding in just above the floor beside a strong match, and a page that shares a
word with the query is a keyword hit, which the band does not touch. Recalibrate both numbers if the embedding model
changes (`KNOWLEDGE_FUSION` and `MEANING_BAND` in `knowledge/meaning.ts`). Every meaning hit is re-checked against the live sections of live pages before it is returned. If the model is off, down or
still embedding, search answers from keywords alone. The overview header says which ("Keyword and meaning search",
"Meaning search: 7 of 10 sections ready", "Embedder down — keyword search only", "Keyword search only"), and the search
box marks a result found only by meaning as "similar meaning".

The vectors live in SQLite, not in Qdrant like history's. Knowledge is small enough for brute force, and keeping the
vectors beside the pages lets a write drop stale vectors in its own transaction, with no queue to keep in step and the
same code with or without Qdrant. Past roughly 50,000 sections this should move to the search service.

`apps/server/eval/knowledge/` seeds 210 pages and checks the following with the simulated model and the fake
embedder: recall for keyword and fused search, stale and misfiled pages, high fan-out paging, and tool-answer sizes.
`RESULTS.md` there records the latest run and its limits.
