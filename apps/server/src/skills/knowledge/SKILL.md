---
name: rei-knowledge
description: "Write or reorganize Knowledge pages: page structure, the Markdown Rei renders, links to pages and sections, and edit operations. Load before creating a page or making any edit beyond an append."
---

# Knowledge pages

Knowledge pages are shared Markdown that people and agents read and edit. Write each page for a reader who arrives cold, sees the outline, and jumps to one section. Formatting that renders is in `references/markdown.md` (read it with `read_skill_file({ name: "rei-knowledge", path: "references/markdown.md" })`).

## Page shape

- A clear title and a one-line description: browsing shows only these.
- A short summary at the top: what the page holds and its current state.
- One topic per page. Split when a page covers two topics, never because of length.
- Headings make each section stand alone: a section reads correctly without the sections around it.

## Editing

- Read the page first; the read gives `baseRevision`.
- Use the smallest operation that does the job: `replace_text`, then `replace_section` or `append_to_section`, then a wider rewrite.
- On a conflict, the error returns the current text: merge your change into it and edit again, keeping the other writer's changes.
- `append` and `set_task` need no base revision.
- A locked page allows `append` only.

## Linking

- `[text](page:<id>)` links a page; `[text](file:<id>)` links a library file at its current version.
- `[text](page:<id>#<slug>)` links one section. Copy the slug from the outline `knowledge_read` returns (`§3 Week 2 #week-2`); never guess it. Renaming or removing a heading breaks links to it: the write result names those pages, so fix them.
- `file:<id>@<versionId>` pins an exact version: use it for evidence that must not change.
- Link a related page instead of copying its text.

## Upkeep

- Record decisions with their reasons and a date.
- Update a page that has gone stale instead of writing a second one beside it.
- Archive is reversible: archive pages that no longer apply.
- Tags are flat labels shared by everyone. Reuse an existing spelling.
- A page written after reading outside content carries an "Outside content" badge: weigh it accordingly.
