# Rendering: the Rei レイ Markdown dialect

User and assistant messages (`Message.text`) and knowledge pages are Markdown in the Rei dialect: the subset models actually write, plus a few Rei additions. Rich components travel beside the text as message parts (`MessagePart`). This page is what a client must render. The conformance fixtures in [`packages/protocol/fixtures/rendering.json`](../packages/protocol/fixtures/rendering.json) pin each rule down as input text and expected structure. The web parser (`apps/web/src/lib/markdown.ts`) runs against them in its tests, and a native parser should too.

## Safety rules

- HTML in a message is text. Never interpret it.
- Only `http:`, `https:` and `mailto:` links become links. Any other scheme (`javascript:`, `data:`, relative paths) shows the link text alone.
- Images render from the file library (`![alt](file:…)`) and from `http:` or `https:` addresses (`webimage`). A web image loads lazily and without a referrer; if it cannot load, its alt text (or its address) is shown as an ordinary link to it. An image with any other URL shows its alt text alone, never a stray `!`.
- Nothing inside a `ui` fenced block is drawn while it streams (see below).

## Blocks

| Feature     | Syntax                                                                | Notes                                                                                                          |
| ----------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Heading     | `#` to `######`, or paragraph text underlined with `===` or `---`     | Trailing `#`s are dropped. See "Underlined headings" below.                                                    |
| Paragraph   | Lines of text                                                         | A single newline inside a paragraph is a line break.                                                           |
| Rule        | `---`, `***`, `___`                                                   |                                                                                                                |
| Block quote | `> text`                                                              | Nests any blocks.                                                                                              |
| List        | `-`, `*`, `+`, or `1.`/`1)`                                           | An ordered list keeps its start number. Items nest by indentation.                                             |
| Code        | ` ``` ` or `~~~` fence, optional language                             | A fence still open at the end of the text is a code block with `open: true` (a reply that is still streaming). |
| Indented code | Lines indented four spaces or a tab                                 | A code block with no language, one level of indentation removed. See "Indented code" below.                    |
| Table       | GitHub pipe table                                                     | The separator row sets alignment (`:--`, `--:`, `:-:`). `\|` is a literal pipe. Missing cells are empty.       |
| Callout     | `> [!NOTE]` (also `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`, any case) | Text after the marker is the title; without it, show the kind's name.                                          |
| Toggle      | `> [!NOTE]-` or `> [!NOTE]+`                                          | A foldable callout: `-` starts closed, `+` starts open.                                                        |
| Task item   | `- [ ]` or `- [x]`                                                    | See below.                                                                                                     |

### Underlined headings

A line of `=` (level 1) or `-` (level 2) directly under paragraph text makes that text a heading; a paragraph of several lines makes a heading of several lines (its slug joins them with spaces). The underline may be indented up to three spaces and have trailing spaces. After a blank line, a list item, quote, table or fence, `---` is a rule; a line such as `---|---` is a table's separator row; under a list item's lazy continuation line, `--` and `==` stay text. An underlined heading is a section like a `#` heading.

While a reply streams, a lone `-` on its last line may still become a list item (`- …`), so the paragraph above it shows alone until the line is complete; `--` or `=` is already a heading.

### Indented code

Lines indented by four spaces or a tab, with the blank lines between them, are a code block with no language: one level of indentation (four spaces or a tab) is removed and trailing blank lines are dropped. An indented line directly under paragraph text continues the paragraph instead. Inside a list item or a footnote, indentation belongs to the item or note, so it never makes a code block there.

### Highlighting and diagrams (optional)

The parser treats every fence the same, so these need no dialect support. A client MAY colour a code block whose language it knows, and MAY draw a closed `mermaid` fence as a diagram (never while `open` is true; a diagram that fails to parse is shown as code). A client that does neither shows them as plain code. The web client does both: highlight.js (common languages) and Mermaid in strict mode with plain-text labels, both loaded on first use.

## Inline

`**strong**` or `__strong__`, `*em*` or `_em_`, `***both***`, `~~struck~~`, and `` `code` ``. An underscore inside a word (`snake_case`) is not emphasis. A backslash escapes Markdown punctuation. Bare `http(s)` URLs become links, without trailing punctuation.

### Rei links

- `[text](page:<pageId>)` opens a knowledge page. `[text](page:<pageId>#<slug>)` opens it at a section (see below).
- `[text](file:<fileId>)` opens a library file at its current version. `[text](file:<fileId>@<versionId>)` opens that exact version.
- `![alt](file:<fileId>)` or `![alt](file:<fileId>@<versionId>)` shows a library image. `![alt](https://…)` shows an image from the web (see Safety rules).

Ids are letters, digits, `_` and `-`. A client without a page or file view can show the link text and open `REI_PUBLIC_URL` in a browser instead.

### Section links

A page's sections are its top-level headings outside code fences, `#` or underlined (a heading inside a quote, callout or list item is not one). Each has a slug, GitHub-style:

- the heading's text as a reader sees it (link and image text without the target, code without backticks, emphasis underscores at a word's edge dropped), lowercased;
- every character except letters (any script), marks, digits, `_`, `-` and spaces removed;
- spaces turned into `-`;
- a slug already used on the page gets `-1`, `-2`, … in document order (`notes`, `notes-1`; a heading `Notes 1` after them becomes `notes-1-1`).

`## 第二週 進度` is `第二週-進度`; `## Week 2: Shipping!` is `week-2-shipping`. `packages/protocol/src/slug.ts` is the definition the server and the web client share, and the `slugs` fixtures pin it down.

The parser puts the slug on each top-level heading (`slug`) and the anchor on the link (`anchor`, percent-escapes decoded; absent for a bare `#`). A client resolves the anchor against the page's slugs, ignoring case, and scrolls to that heading; an anchor that matches nothing opens the page at the top with no error. A client that predates section links opens the page, which is fine. Only `page:` links take an anchor: `file:<id>#x` is not a reference and shows its text.

The web client gives a Knowledge page's headings the element id `section-<slug>` and addresses a section as `/knowledge/<pageId>#<slug>`. Hovering a heading shows a button that copies `[heading](page:<pageId>#<slug>)`.

## Footnotes

A reference `[^label]` in the text points at a definition `[^label]: text`. Labels are letters, digits, `-` and `_`.

- A definition starts at the first column of a line, anywhere in the text outside code fences. Indented lines (two spaces or a tab, with blank lines allowed between them) continue it; its content is ordinary blocks, so inline formatting and Rei links work in it. A definition inside a quote, list item or callout is not one.
- References are numbered from 1 in order of first use; the label is never shown. Repeated references to one label share its number.
- Definitions leave the flow. The parser appends one `footnotes` block as the last block: referenced notes in number order, each with its reference count (`uses`), then notes nothing references (`uses` 0) after them, in the order written. Nothing is dropped.
- A reference whose label has no definition stays literal text, and so does a reference inside a definition, a code span or fence, link text, or after a backslash. If a label is defined twice, the first wins and the later line stays in the text as literal text.
- Each reference is an inline `fnref` with the note's number `n` and `use`, which counts that label's references so far (1 for the first).
- In assistant replies, each footnote reference becomes an inline chip. Its label is the first source's site or title, with a count of any additional sources, or Note for a text-only footnote. Hover or focus previews the card. Click or tap keeps it open. The card shows each source's title and link, followed by any note text. Unreferenced definitions open from a Notes chip after the reply.
- In documents, the web client links each reference to its note and each note back to its references in a compact list. The anchors use a per-document prefix and scroll without changing the address.
- While a reply streams, a reference whose definition has not arrived yet shows as text, then becomes a reference once the definition is complete. A client that predates footnotes shows the syntax as text.

On the server, a definition line is ordinary text of the section it is written in (search chunks and `knowledge_read` keep it there), and a definition never starts a section.

## Task lists and chips

A list item that starts with `[ ]` or `[x]` (or `[X]`) is a task. Tasks are numbered in document order, from 0, across the whole text, nested lists included; a client ticking a box on a knowledge page sends that index. Tasks inside a quote or callout are shown but are not numbered (their index is `null`), because a page edit cannot reach them.

The text of a task item may carry chips:

- `@name` is an agent mention. It must start a word, so an email address is not a mention.
- `📅 YYYY-MM-DD` is a due date. Show it as past due when it is before today in the viewer's time zone.

Chips appear only in task items. Elsewhere `@name` and `📅` are plain text.

## Surfaces

Rich, interactive content is a surface: an A2UI v1.0 message the agent sends with the `show_surface` tool, carried in the message's `parts` as a `surface` part. [surfaces.md](surfaces.md) is the contract. Models no longer write components in the text; a fenced block with the language `ui` is ordinary code.

Every surface part carries a `fallback`: plain text that holds everything the surface shows, cut at about 2,000 characters. A client that renders only Markdown text plus fallbacks loses no information it needs, so a thin client (a widget, a notification, a watch) may do exactly that. A client shows the fallback for a catalog it does not support.

## Changing the dialect

Add a fixture case (input and expected structure) for every new rule, and keep the web parser passing it. A new syntax is additive (ADR 0009): an older client shows it as text.
