# Web reading

`web_fetch` reads one web page for an agent. It fetches the page once, keeps a readable copy for that agent, and then shows the model only the part it needs: an outline, the passages that match a question, one section, or raw text from an offset. Reading a long page this way costs a fraction of the tokens that 20,000-character slices did (see `apps/server/eval/web-reading/RESULTS.md`). `web_search` is separate and described in [search.md](search.md).

## The tool

```ts
web_fetch({
  url: string,        // http or https, ports 80/443, at most 2,000 characters
  query?: string,     // the passages that best match this question
  section?: string,   // one section in full, by id from the outline
  offset?: number,    // the original 20,000-character slice from this offset
  refresh?: boolean,  // fetch again even when a stored copy is fresh
})
```

`query` cannot be combined with `section` or with `offset`. `section` and `offset` together page through one section.

| Call                          | What the model gets                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url` only                    | **Overview.** The title, the final URL, an outline of up to 50 sections with their ids and approximate token counts, then the opening text (about 600 tokens, less when the outline is long). It ends with how to ask for more. A page of at most 1,500 tokens comes back **whole** instead, identical to the first slice the original tool returned. |
| `query`                       | **Passages.** The best-matching passages in rank order, about 1,500 tokens at most, each under `[section id: heading › path]`. At most two passages come from one section before other sections get a turn. The footer says how many search terms were found, that the passages may not hold the answer, and which other sections also match. With no match, the model gets the overview and is told nothing matched. |
| `section`                     | **One section** in full, headed `url#id`, 20,000 characters at a time; `offset` continues inside the section. An unknown id fails and lists the ids.                                                                                                                                                                                                             |
| `offset` alone (including 0)  | **The original slice**, byte for byte, so calls written for the old contract still work.                                                                                                                                                                                                                                                                       |

Everything the page controls (title, headings, text) is inside one content fence per result, marked with the page's origin. Rei's own notes and footers are outside it. Cite a section as the URL with `#<section id>`.

Passages are ranked with SQLite FTS5 (bm25, with heading and title matches weighted three times), using the same CJK bigram splitting as memory search. Budgets are measured in o200k tokens.

## Fetching and extraction

Rei does not fetch or extract pages itself. `web_fetch` asks the shared reader, through the gateway (`POST /read`, token `REI_STANDIN`; see [reader.md](reader.md) and [ADR 0020](adr/0020-web-reading-is-a-shared-service.md)), and keeps the readable copy it gets back.

- **Rei decides where the reader may go.** Each call sends the hosts Rei's own policy allowed (`allowHosts`). A redirect to another host comes back as an answer, not a fetch: Rei checks the new host against the agent's network policy exactly as before, adds it to `allowHosts` and calls again with the remaining hops. A denied redirect ends the call with the usual message. At most 5 redirects, one 120-second deadline for the whole call.
- **Local networks.** The agent's network setting becomes the request's `localNetworks`: Any sends `"all"`, a whitelist sends the address entries that cover the destination, anything else sends nothing (`"none"`). Only Rei's token holds the `read-local` scope that allows this.
- **In the reader:** one request through its own proxy (15-second deadline, 5 MiB cap, no cookies or credentials), then Readability, falling back to the page body. When the page is an app shell, the reader reads content the page embeds instead: Next.js and Nuxt data, JSON-LD articles, meta descriptions and `<noscript>` text. Plain text, Markdown, CSV, XML, RSS/Atom and JSON are read as they are. The text is normalized Markdown, cut into sections at its headings.
- Each page gets a **quality**: `success`, `low_quality` (little readable text), `requires_js` (an app shell with nothing to read), `blocked` (a bot check, sign-in wall, or 401/403/429), or `unsupported_mime`. A `low_quality` page is still returned. A blocked, `requires_js` or unsupported page fails with a message that says why, and nothing is stored.
- **If the reader is down** (not configured, or it does not answer), `web_fetch` fails with "Web reading is not available right now: the page reader did not answer." Stored copies can still be read.

## Rendering pages that need JavaScript

Web reading always renders pages in an isolated browser through the shared reader, using Moli first and Chromium as the configured fallback. There is no rendering switch. See [reader.md](reader.md#rendering).

- **When:** only a fetch that reaches the network renders, and only when the HTTP read gave `requires_js`, or `low_quality` with nothing but the page's embedded summary to read. A page the HTTP read classed as blocked (a bot check it recognises, a sign-in wall), a policy denial or an HTTP error never renders. A JavaScript challenge that a browser passes just by running the page's script (no puzzle for a person) is not recognised as a bot check: it reads as `requires_js`, and the render passes it like any browser would. This is intended: the agent reads on the user's behalf, and the reader makes a best effort to get the content (owner's decision, 2026-11-16). With rendering off, a `requires_js` page fails and the details say why it was not rendered.
- **Privacy:** the page's own scripts run, so the site and the services it calls (analytics, ads, APIs) see a visit from the reader's address, as they would from any browser. Nothing from the agent computer's browser profile, the user's files or their network is shared; a render never reaches local networks. The setting says so.
- **A navigation to another site inside the page** comes back as a redirect answer and is checked against the agent's policy like an HTTP redirect.
- **Result:** the stored copy records `method: "render"`, and later reads of it say so. Detail mode shows the engine that rendered, whether the fallback ran, the wait for a slot, render time, connections and refusals.
- **Checks:** `containers/smoke-render/run.sh [moli|chromium]` runs the render checks and the red-team suite against one engine in the reader image. The rules are also covered without a browser in `apps/reader/test` and `apps/server/test/web-render.test.ts`.

## Policy

A first fetch or a refresh reaches the network. In Standard and YOLO, public web research runs automatically even after reading private data, in chats, workers and trigger runs alike. Strict public research prompts offer one request, one destination for this chat, or all public web research for this chat. The all-web grant covers public redirects and uses the reader's public network scope. A redirect that needs its own approval stops at the new host and names it so Rei can request that destination directly. See [Chat permissions](chat-permissions.md).

A fresh stored copy is an internal read. The tool requires a network decision before it fetches. If the stored copy expires between the policy check and the read, the tool asks the agent to fetch again.

## Storage and retention

Stored copies live in the control plane's SQLite database, never in memory, history search, Qdrant or the trace payload.

| Table                          | Holds                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `web_documents`                | One readable copy per agent and requested URL: final URL, title, text, sections, quality, extractor, content hash, fetched and expiry times. Raw HTML is not kept. |
| `web_passages`, `web_passages_fts` | The passages of each copy as offsets into its text, and their search index. Deleted with their document. |
| `web_calls`                    | Which document each `web_fetch` call read (session, call id, title, URL), so the trace can show the page without reading payloads. |

- **Scope:** copies belong to one agent and are reused across that agent's chats. Another agent never sees them, even for the same URL.
- **Lifetime:** 24 hours from the fetch. Expired copies are dropped on every write and when the server starts.
- **Caps per agent:** 200 documents and 20 million characters; the least recently used go first. A page bigger than the character cap alone is returned to the model but not kept.
- **Deletion:** deleting an agent deletes its copies. Purging a chat deletes the copies it fetched last and its `web_calls` rows. A trace keeps the page's title and host after the copy is gone.

## In the app

- **Simple mode:** each `web_fetch` step in the run's activity list stays a plain one-line activity row without the page badge.
- **Detail mode:** each `web_fetch` step adds a chip with the page title and host, and the step detail adds a **Fetch** section: where the page came from (fetched, fetched again, or the stored copy), how (HTTP or rendered, with the engine, why it rendered or why not, the wait for a slot, render time, connections and refusals, and media not loaded), what the model was shown and which sections, HTTP status, redirects, media type, bytes downloaded, extractor, quality, tokens returned against tokens on the page, and duration. A failed fetch keeps its status and quality.
- **Stored copy:** the page icon in the Fetch section opens the readable copy in the inspector (`GET /api/steps/:id/web-document`). It is for people only: it is served while the step's agent still holds the copy, and it never goes to the model. The output above it is exactly what the model saw.

## Not supported

- Pages that need JavaScript, while rendering is off (the default) or the reader is not available. Rendered pages still get no images, media or fonts, so text that only appears after an image loads is read at the deadline without it.
- Signed-in pages, cookies, or any credentials.
- PDF, Office documents and images (`unsupported_mime`).
- Ports other than 80 and 443, and addresses the agent's sandbox network mode refuses ([sandbox-network.md](sandbox-network.md)).
- Summaries or answers written by a helper model: the model reads the passages itself.
- Sharing copies between agents, or keeping them longer than 24 hours.
