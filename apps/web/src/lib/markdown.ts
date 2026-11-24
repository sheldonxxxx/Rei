// A small markdown parser for assistant replies: the subset models actually write (headings, `#` or underlined,
// paragraphs, lists, fenced and indented code, block quotes, tables, rules, emphasis, inline code, links, images). It
// returns a tree that the Markdown component renders as React elements, so HTML in a reply is always shown as text,
// never interpreted. Only http(s) and mailto links become links, and only http(s) images load. It must cope with a reply
// that is still streaming (an unclosed fence, half a table, a lone `-` under a line that may become a heading or a list).
// Knowledge pages add a little on top, and replies may use it too: `page:` and `file:` links (and `![](file:…)` images),
// GitHub callouts (`> [!NOTE]`, foldable with `-`/`+`), and task-list items (`- [ ]`), numbered in page order so a
// checkbox can be ticked by its position. Top-level headings carry their section slug, and `page:` links may name one
// (`page:<id>#<slug>`). Footnotes (`[^label]` with a `[^label]: text` definition) are numbered by first use and their
// definitions gather in a trailing `footnotes` block.
import { headingSlugs, linkAnchor } from "@rei/protocol";
import { linkify } from "./linkify.ts";

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong" | "em" | "del"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] }
  | { t: "page"; pageId: string; anchor?: string; children: Inline[] }
  | { t: "file"; fileId: string; versionId: string | null; children: Inline[] }
  | { t: "image"; fileId: string; versionId: string | null; alt: string }
  /** An image from the web (`![alt](https://…)`); only http(s) sources become one. */
  | { t: "webimage"; src: string; alt: string }
  | { t: "br" }
  /** A footnote reference: `n` is the note's number, `use` counts this label's references so far (1 for the first). */
  | { t: "fnref"; n: number; use: number };

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

/** A task-list item's checkbox. `index` is its position among the page's tasks; null where a page edit cannot reach it (in a quote). */
export interface TaskMark {
  done: boolean;
  index: number | null;
}

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; children: Inline[] }
  /** `slug` is the section anchor (packages/protocol slug.ts); only top-level headings are sections and have one. */
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; slug?: string; children: Inline[] }
  | { t: "code"; lang: string; text: string; open: boolean }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][]; tasks?: (TaskMark | null)[] }
  | { t: "callout"; kind: CalloutKind; fold: "open" | "closed" | null; title: Inline[]; blocks: Block[] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" }
  /** The notes, always the last block: referenced ones in order of first use (`uses` references each), then unreferenced ones (`uses` 0). */
  | { t: "footnotes"; items: { n: number; uses: number; blocks: Block[] }[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const BLANK = /^\s*$/;
/** The underline that turns the paragraph text above it into a heading: `=` for level 1, `-` for level 2. */
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** A lone `-` is also how a list item starts, so on the last line of a streaming reply it is not decided yet. */
const LONE_DASH = /^ {0,3}-[ \t]*$/;
/** Four columns of indentation: an indented code block, with the indentation it removes. */
const CODE_INDENT = /^(?: {4}| {0,3}\t)/;

/** Footnote labels with a definition, and the numbers handed out so far; null while footnote references are not read. */
interface Notes {
  defined: Set<string>;
  used: Map<string, { n: number; uses: number }>;
}
let notes: Notes | null = null;

const DEFINITION = /^\[\^([A-Za-z0-9_-]+)\]:[ \t]*(.*)$/;
const INDENTED = /^(?: {2,}|\t)\S/;

/**
 * Pulls footnote definitions out of the lines: `[^label]: text` at the start of a line, outside code fences, with indented
 * lines (and blank lines before them) as its continuation. The first definition of a label wins; a repeat stays in the text.
 * Each definition leaves one blank line behind.
 */
function extractDefinitions(lines: string[]): { rest: string[]; defs: Map<string, string[]>; last: string | null } {
  const rest: string[] = [];
  const defs = new Map<string, string[]>();
  // The definition that runs to the end of the text, whose last line may still be streaming.
  let last: string | null = null;
  let close: RegExp | null = null;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (close) {
      if (close.test(line)) close = null;
    } else {
      const fence = FENCE.exec(line);
      if (fence) {
        const mark = fence[1]!;
        close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
      } else {
        const def = DEFINITION.exec(line);
        if (def && defs.has(def[1]!)) {
          // A repeat of a label stays in the text, shown literally (escaped so it is not read as a reference).
          rest.push(`\\${line}`);
          i++;
          continue;
        }
        if (def) {
          const body = [def[2]!];
          for (i++; i < lines.length; i++) {
            const next = lines[i]!;
            if (INDENTED.test(next)) body.push(next.replace(/^(?: {1,4}|\t)/, ""));
            else if (BLANK.test(next) && INDENTED.test(lines.slice(i + 1).find((l) => !BLANK.test(l)) ?? ""))
              body.push("");
            else break;
          }
          defs.set(def[1]!, body);
          if (i === lines.length) last = def[1]!;
          rest.push("");
          continue;
        }
      }
    }
    rest.push(line);
    i++;
  }
  return { rest, defs, last };
}

/** Runs `read` with footnote references switched off (link text, and the notes themselves): they stay literal text. */
function withoutNotes<T>(read: () => T): T {
  const saved = notes;
  notes = null;
  try {
    return read();
  } finally {
    notes = saved;
  }
}

export function parseMarkdown(text: string): Block[] {
  const heads: Heading[] = [];
  const { rest, defs, last } = extractDefinitions(text.replace(/\r\n?/g, "\n").split("\n"));
  const state: Notes = { defined: new Set(defs.keys()), used: new Map() };
  let blocks: Block[];
  notes = state;
  try {
    blocks = parseBlocks(rest, { heads, atEnd: true });
  } finally {
    notes = null;
  }
  if (defs.size > 0) {
    const items = [...defs.keys()].map((label) => {
      const u = state.used.get(label);
      return { label, uses: u?.uses ?? 0, n: u?.n ?? Number.POSITIVE_INFINITY };
    });
    // Referenced notes keep the numbers their first use gave them; the rest follow in the order written.
    items.sort((a, b) => (a.n === b.n ? 0 : a.n < b.n ? -1 : 1));
    blocks.push({
      t: "footnotes",
      items: items.map((it, i) => ({
        n: i + 1,
        uses: it.uses,
        blocks: parseBlocks(defs.get(it.label)!, { nested: true, atEnd: it.label === last }),
      })),
    });
  }
  numberTasks(blocks, { next: 0 }, true);
  const slugs = headingSlugs(heads.map((h) => h.source));
  heads.forEach((h, i) => {
    h.block.slug = slugs[i]!;
  });
  return blocks;
}

/** A top-level heading and its Markdown source, which its slug is made from (the server slugs the same text). */
interface Heading {
  block: Extract<Block, { t: "h" }>;
  source: string;
}

/** Numbers task checkboxes in document order, the order the server counts them in; tasks inside quotes stay unnumbered. */
function numberTasks(blocks: Block[], counter: { next: number }, reachable: boolean): void {
  for (const b of blocks) {
    if (b.t === "list")
      b.items.forEach((item, i) => {
        const task = b.tasks?.[i];
        if (task) task.index = reachable ? counter.next++ : null;
        numberTasks(item, counter, reachable);
      });
    else if (b.t === "quote" || b.t === "callout") numberTasks(b.blocks, counter, false);
  }
}

const CALLOUT = /^\[!(note|tip|important|warning|caution)\]([+-]?)[ \t]*(.*)$/i;
const TASK_ITEM = /^\[([ xX])\]\s*(.*)$/;
const FILE_REF = /^file:([A-Za-z0-9_-]+)(?:@([A-Za-z0-9_-]+))?$/;
const PAGE_REF = /^page:([A-Za-z0-9_-]+)(?:#(.*))?$/;

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    isTableStart(lines, i)
  );
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i] ?? "";
  const sep = lines[i + 1] ?? "";
  return (
    head.includes("|") && sep.includes("-") && TABLE_SEP.test(sep) && splitRow(head).length === splitRow(sep).length
  );
}

/** Where a run of lines sits in the text. */
interface Place {
  /** Collects the headings at this level when given (the sections); nested blocks (quotes, list items) pass none. */
  heads?: Heading[];
  /** The last of the lines is the last line of the whole text, which may still be streaming. */
  atEnd?: boolean;
  /** Inside a list item or a footnote, where indentation belongs to the container, so it never makes a code block. */
  nested?: boolean;
}

function parseBlocks(lines: string[], place: Place = {}): Block[] {
  const { heads, atEnd = false, nested = false } = place;
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (BLANK.test(line)) {
      i++;
      continue;
    }

    // Indented code: indented lines and the blank lines between them, less one level of indentation. An indented line
    // cannot interrupt a paragraph (it continues it), and a paragraph is read whole below, so this only sees new blocks.
    if (!nested && CODE_INDENT.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (CODE_INDENT.test(lines[i]!) || BLANK.test(lines[i]!)))
        body.push(lines[i++]!.replace(CODE_INDENT, ""));
      while (body.length > 0 && BLANK.test(body[body.length - 1]!)) {
        body.pop();
        i--;
      }
      out.push({ t: "code", lang: "", text: body.join("\n"), open: false });
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
      const body: string[] = [];
      let open = true;
      for (i++; i < lines.length; i++) {
        if (close.test(lines[i]!)) {
          open = false;
          i++;
          break;
        }
        body.push(lines[i]!);
      }
      out.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n"), open });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const source = heading[2] ?? "";
      const block: Extract<Block, { t: "h" }> = {
        t: "h",
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(source),
      };
      heads?.push({ block, source });
      out.push(block);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(lines[i++]!.replace(QUOTE, ""));
      const inside: Place = { nested, atEnd: atEnd && i === lines.length };
      const callout = CALLOUT.exec(inner[0] ?? "");
      if (callout) {
        const sign = callout[2];
        out.push({
          t: "callout",
          kind: callout[1]!.toLowerCase() as CalloutKind,
          fold: sign === "-" ? "closed" : sign === "+" ? "open" : null,
          title: parseInline(callout[3] ?? ""),
          blocks: parseBlocks(inner.slice(1), inside),
        });
      } else out.push({ t: "quote", blocks: parseBlocks(inner, inside) });
      continue;
    }

    if (ITEM.test(line)) {
      i = parseList(lines, i, out, atEnd);
      continue;
    }

    if (isTableStart(lines, i)) {
      const align = splitRow(lines[i + 1]!).map(cellAlign);
      const head = splitRow(lines[i]!).map(parseInline);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes("|") && !BLANK.test(lines[i]!); i++) {
        const cells = splitRow(lines[i]!);
        rows.push(align.map((_, c) => parseInline(cells[c] ?? "")));
      }
      out.push({ t: "table", align, head, rows });
      continue;
    }

    const para: string[] = [line.trim()];
    let level: 1 | 2 | null = null;
    for (i++; i < lines.length && !BLANK.test(lines[i]!); i++) {
      const under = SETEXT.exec(lines[i]!);
      if (under) {
        i++;
        // Until the line is complete, a lone `-` could still become a list item ("- …"): show the paragraph alone.
        if (!(atEnd && i === lines.length && LONE_DASH.test(lines[i - 1]!))) level = under[1]![0] === "=" ? 1 : 2;
        break;
      }
      if (startsBlock(lines, i)) break;
      para.push(lines[i]!.trim());
    }
    if (level) {
      const block: Extract<Block, { t: "h" }> = { t: "h", level, children: parseInline(para.join("\n")) };
      heads?.push({ block, source: para.join(" ") });
      out.push(block);
    } else out.push({ t: "p", children: parseInline(para.join("\n")) });
  }
  return out;
}

/** Reads one list (items with the same kind of marker at the same indent) starting at line i; returns the next line. */
function parseList(lines: string[], i: number, out: Block[], atEnd: boolean): number {
  const first = ITEM.exec(lines[i]!)!;
  const ordered = /\d/.test(first[2]!);
  const indent = first[1]!.length;
  const items: string[][] = [];
  const tasks: (TaskMark | null)[] = [];
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (!m || m[1]!.length !== indent || /\d/.test(m[2]!) !== ordered) break;
    const contentIndent = indent + m[2]!.length + 1;
    const item = [m[3] ?? ""];
    for (i++; i < lines.length; i++) {
      const line = lines[i]!;
      if (BLANK.test(line)) {
        // A blank line continues the item only if the next text is indented under it.
        const next = lines.slice(i + 1).find((l) => !BLANK.test(l));
        if (next !== undefined && leading(next) >= contentIndent) {
          item.push("");
          continue;
        }
        break;
      }
      if (leading(line) >= Math.min(contentIndent, indent + 2)) {
        item.push(line.slice(Math.min(leading(line), contentIndent)));
        continue;
      }
      // Lazy continuation of the item's paragraph. It never underlines a heading, so `--` or `==` stays text (escaped).
      if (!startsBlock(lines, i) && !BLANK.test(lines[i - 1]!)) {
        item.push(SETEXT.test(line) ? `\\${line.trim()}` : line.trim());
        continue;
      }
      break;
    }
    const task = TASK_ITEM.exec(item[0]!);
    if (task) item[0] = task[2] ?? "";
    tasks.push(task ? { done: task[1] !== " ", index: null } : null);
    items.push(item);
    while (i < lines.length && BLANK.test(lines[i]!)) {
      const next = lines.slice(i).find((l) => !BLANK.test(l));
      const nm = next === undefined ? null : ITEM.exec(next);
      if (!nm || nm[1]!.length !== indent || /\d/.test(nm[2]!) !== ordered) return finish();
      i++;
    }
  }
  return finish();

  function finish(): number {
    out.push({
      t: "list",
      ordered,
      start: ordered ? Number.parseInt(first[2]!, 10) : 1,
      // Only the last item can reach the end of the text (it does when nothing follows it, not even a blank line).
      items: items.map((item, k) =>
        parseBlocks(item, { nested: true, atEnd: atEnd && k === items.length - 1 && i === lines.length }),
      ),
      ...(tasks.some(Boolean) ? { tasks } : {}),
    });
    return i;
  }
}

const leading = (line: string) => /^ */.exec(line)![0].length;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      cell += c;
    } else if (c === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

function cellAlign(sep: string): Align {
  const left = sep.startsWith(":");
  const right = sep.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

/** A run of task-item text: plain, an agent mention (`@name`), or a due date (`📅 YYYY-MM-DD`). */
export type ImageEmbed = Extract<Inline, { t: "image" }>;

/** Every `![alt](file:…)` image in the text, in order, wherever it sits (lists, quotes, callouts, tables, notes). */
export function imageEmbeds(text: string): ImageEmbed[] {
  const out: ImageEmbed[] = [];
  const inline = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.t === "image") out.push(node);
      else if ("children" in node) inline(node.children);
    }
  };
  const blocks = (list: Block[]) => {
    for (const b of list) {
      if (b.t === "p" || b.t === "h") inline(b.children);
      else if (b.t === "quote") blocks(b.blocks);
      else if (b.t === "callout") {
        inline(b.title);
        blocks(b.blocks);
      } else if (b.t === "list") for (const item of b.items) blocks(item);
      else if (b.t === "table") for (const cell of [...b.head, ...b.rows.flat()]) inline(cell);
      else if (b.t === "footnotes") for (const note of b.items) blocks(note.blocks);
    }
  };
  blocks(parseMarkdown(text));
  return out;
}

/** A paragraph that holds nothing but images (and the spaces or line breaks between them): it renders as figures. */
export function imageOnly(nodes: Inline[]): ImageEmbed[] | null {
  const images: ImageEmbed[] = [];
  for (const node of nodes) {
    if (node.t === "image") images.push(node);
    else if (node.t === "br" || (node.t === "text" && !node.text.trim())) continue;
    else return null;
  }
  return images.length ? images : null;
}

export type ChipSegment = { t: "text"; text: string } | { t: "mention"; name: string } | { t: "due"; date: string };

/** A mention starts a word (so an email address is not one); the date is ISO. */
const CHIP = /((?<![\p{L}\p{N}_.@])@[\p{L}\p{N}_][\p{L}\p{N}_.-]*|📅\s*\d{4}-\d{2}-\d{2})/u;

/** Splits the text of a task-list item into chips; only task items get chips (docs/rendering.md). */
export function splitChips(value: string): ChipSegment[] {
  return value
    .split(CHIP)
    .map((part, i): ChipSegment | null => {
      if (i % 2 === 0) return part === "" ? null : { t: "text", text: part };
      return part.startsWith("@")
        ? { t: "mention", name: part.slice(1) }
        : { t: "due", date: part.replace(/^📅\s*/, "") };
    })
    .filter((x): x is ChipSegment => x !== null);
}

/** Only these schemes become links; anything else (javascript:, data:, relative paths) stays text. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

/** An image source from the web: a safe link that is http(s) (never mailto:) and parses as a URL. */
function imageSrc(raw: string): string | null {
  const href = safeHref(raw);
  return href && /^https?:/i.test(href) && URL.canParse(href) ? href : null;
}

/** The text and target of a link (`[text](target "title")`), and the same after `!` for an image. */
const LINK = /^\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*<?([^\s<>()]+(?:\([^\s()]*\))?)>?(?:\s+"[^"\n]*")?\s*\)/;

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|>=]/;
const WORD = /[\p{L}\p{N}]/u;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    for (const seg of linkify(buf))
      out.push(
        seg.type === "link"
          ? { t: "link", href: seg.href, children: [{ t: "text", text: seg.text }] }
          : { t: "text", text: seg.text },
      );
    buf = "";
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const rest = src.slice(i);

    if (c === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = src.indexOf(run, i + run.length);
      if (end !== -1) {
        flush();
        const code = src.slice(i + run.length, end);
        out.push({
          t: "code",
          text: code.length > 2 && code.startsWith(" ") && code.endsWith(" ") ? code.slice(1, -1) : code,
        });
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if (c === "!" && src[i + 1] === "[") {
      const m = LINK.exec(rest.slice(1));
      if (m) {
        // A Library image, a web image, or (any other target) just its alt text: never a stray `!`.
        const alt = m[1]!;
        const ref = FILE_REF.exec(m[2]!);
        const web = ref ? null : imageSrc(m[2]!);
        flush();
        if (ref) out.push({ t: "image", fileId: ref[1]!, versionId: ref[2] ?? null, alt });
        else if (web) out.push({ t: "webimage", src: web, alt });
        else if (alt) out.push({ t: "text", text: alt });
        i += m[0].length + 1;
        continue;
      }
    }
    if (c === "[" && notes && src[i + 1] === "^") {
      const m = /^\[\^([A-Za-z0-9_-]+)\]/.exec(rest);
      if (m && notes.defined.has(m[1]!)) {
        flush();
        const entry = notes.used.get(m[1]!) ?? { n: notes.used.size + 1, uses: 0 };
        notes.used.set(m[1]!, entry);
        entry.uses++;
        out.push({ t: "fnref", n: entry.n, use: entry.uses });
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      const m = LINK.exec(rest);
      if (m) {
        const href = safeHref(m[2]!);
        const page = PAGE_REF.exec(m[2]!.trim());
        const file = FILE_REF.exec(m[2]!.trim());
        flush();
        if (page) {
          const anchor = linkAnchor(page[2] ?? "");
          out.push({
            t: "page",
            pageId: page[1]!,
            ...(anchor ? { anchor } : {}),
            children: withoutNotes(() => parseInline(m[1]!)),
          });
        } else if (file)
          out.push({
            t: "file",
            fileId: file[1]!,
            versionId: file[2] ?? null,
            children: withoutNotes(() => parseInline(m[1]!)),
          });
        else if (href) out.push({ t: "link", href, children: withoutNotes(() => parseInline(m[1]!)) });
        else out.push(...withoutNotes(() => parseInline(m[1]!)));
        i += m[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const span = emphasis(src, i);
      if (span) {
        flush();
        out.push(span.node);
        i = span.end;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Tries to read an emphasis span (***, **, __, ~~, *, _) that opens at i. */
function emphasis(src: string, i: number): { node: Inline; end: number } | null {
  const prev = src[i - 1] ?? " ";
  for (const [mark, kind] of [
    ["***", "strongem"],
    ["**", "strong"],
    ["__", "strong"],
    ["~~", "del"],
    ["*", "em"],
    ["_", "em"],
  ] as const) {
    if (!src.startsWith(mark, i)) continue;
    const from = i + mark.length;
    const after = src[from];
    if (after === undefined || /\s/.test(after)) continue;
    // Underscores inside words (snake_case) are not emphasis.
    if (mark[0] === "_" && WORD.test(prev)) continue;
    const close = findClose(src, from, mark);
    if (close === -1) continue;
    const inner = parseInline(src.slice(from, close));
    const node: Inline =
      kind === "strongem" ? { t: "strong", children: [{ t: "em", children: inner }] } : { t: kind, children: inner };
    return { node, end: close + mark.length };
  }
  return null;
}

function findClose(src: string, from: number, mark: string): number {
  for (let at = src.indexOf(mark, from + 1); at !== -1; at = src.indexOf(mark, at + 1)) {
    if (src.slice(from, at).includes("\n\n")) return -1;
    if (/\s/.test(src[at - 1]!)) continue;
    // A single * must not be part of ** (that closes a different span).
    if (mark.length === 1 && src[at + 1] === mark) {
      at++;
      continue;
    }
    if (mark[0] === "_" && WORD.test(src[at + mark.length] ?? "")) continue;
    return at;
  }
  return -1;
}
