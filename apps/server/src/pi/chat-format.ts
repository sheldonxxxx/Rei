import { defineExtension, section } from "@earendil-works/pi-durable";

/**
 * The reply language (here, since every conversation has this section and agents' editable instructions may not say
 * it), then the Markdown a chat reply may use: exactly what the chat renderer (apps/web `lib/markdown.ts` and
 * `Markdown.tsx`) turns into structure. Anything else shows as plain text, so the list is the contract.
 */
export const CHAT_FORMAT_NOTE = [
  "Reply in the language the user writes in, unless they ask for another.",
  "Chat replies are rendered as Markdown. Use only the syntax below; anything else shows as plain text.",
  "",
  "- Emphasis: **bold**, *italic*, ***bold and italic***, ~~strikethrough~~, `inline code`.",
  "- Headings: # to ######. Use them only to split a longer reply into sections.",
  "- Bullets: `- item`, `* item` or `+ item`. Numbered: `1. item` or `1) item`.",
  "- Task items: `- [ ] open` and `- [x] done`.",
  "- Block quote: `> text`.",
  "- Callouts: a block quote whose first line is `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]` or `> [!CAUTION]`, optionally followed by a title. Add `-` after the bracket for a folded callout (`> [!TIP]- Title`) or `+` for one that starts open.",
  "- Code: a fenced block opened with ``` or ~~~, with the language after the opening fence (```ts). A ```mermaid block is drawn as a diagram (flowchart, sequence and so on); keep its syntax simple, since a syntax error shows the code instead.",
  "- Table: a header row, a separator row and body rows, all with pipes: `| A | B |`, `|:--|--:|`, `| 1 | 2 |`. Use `:--` left, `:-:` centre and `--:` right alignment.",
  "- Horizontal rule: a line with only `---`, `***` or `___`.",
  "- Links: `[text](https://…)`, `[text](http://…)` or `[text](mailto:…)`. Write the brackets and parentheses as ASCII `[ ]` and `( )`; full-width brackets such as 〔 〕 or 【 】 are not links. A bare https URL in the text also becomes a link.",
  "- Web citations: put a reference after the claim (`a claim.[^1]`) and a definition on its own line (`[^1]: [Source title](https://…)`). Put sources that support the same claim in the same definition, with links separated by commas. Indent extra note paragraphs. Rei shows these as inline chips, so omit a separate Sources list.",
  "- Knowledge and library links, only with IDs that tools returned to you (never invent one): `[text](page:<id>)` for a Knowledge page, `[text](page:<id>#<slug>)` for one of its sections, `[text](file:<id>)` for a library file, and `![alt](file:<id>)` for a library image.",
  "- Escape a literal Markdown character with a backslash, for example `\\*`.",
  "",
  "Not supported: HTML tags (they show as text, so do not write them), math notation, and images from web URLs (give them as a link instead).",
].join("\n");

/** Tells the model which Markdown its chat replies can use, so it writes syntax that renders. */
export function createChatFormatExtension() {
  return defineExtension({
    name: "chat_format",
    sections: [section("chat_format", () => CHAT_FORMAT_NOTE)],
  });
}
