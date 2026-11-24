// A small HTML-to-Markdown serializer for the web_fetch tool: headings, paragraphs, lists, links, code, quotes and
// tables as text. It works on any DOM (linkedom here) through the few members declared below, and drops scripts,
// styles, navigation and other page furniture.

export interface DomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null;
}

const ELEMENT = 1;
const TEXT = 3;

export interface MarkdownOptions {
  /** Relative links and images are resolved against this. */
  baseUrl?: string;
}

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "nav",
  "button",
  "select",
  "input",
  "textarea",
  "head",
  "link",
  "meta",
  "audio",
  "video",
  "dialog",
  "datalist",
  "map",
  "title",
]);
const INLINE = new Set([
  "a",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "code",
  "br",
  "img",
  "sup",
  "sub",
  "small",
  "abbr",
  "mark",
  "u",
  "s",
  "del",
  "ins",
  "strike",
  "cite",
  "q",
  "time",
  "label",
  "kbd",
  "var",
  "samp",
  "bdi",
  "bdo",
  "data",
  "font",
  "wbr",
  "big",
  "dfn",
  "tt",
  "picture",
  "source",
]);
const HEADING = /^h([1-6])$/;

const lower = (node: DomNode): string => node.nodeName.toLowerCase();
const attr = (node: DomNode, name: string): string | null => {
  try {
    return node.getAttribute?.(name) ?? null;
  } catch {
    return null;
  }
};

function hidden(node: DomNode): boolean {
  if (attr(node, "hidden") !== null) return true;
  if (attr(node, "aria-hidden") === "true") return true;
  const style = attr(node, "style");
  return style !== null && /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)\s*(;|$)/i.test(style);
}

const skipped = (node: DomNode): boolean => SKIP.has(lower(node)) || hidden(node);
const isElement = (node: DomNode): boolean => node.nodeType === ELEMENT;
const isInlineTag = (node: DomNode): boolean => INLINE.has(lower(node));

function hasBlockDescendant(node: DomNode): boolean {
  for (const child of Array.from(node.childNodes)) {
    if (!isElement(child) || skipped(child)) continue;
    if (!isInlineTag(child) || hasBlockDescendant(child)) return true;
  }
  return false;
}

function resolve(href: string, base: string | undefined): string | undefined {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  if (/^(javascript|data|vbscript|mailto|tel):/i.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Collapses whitespace in text; newlines placed by <br> (as \u0001) survive. */
const squash = (text: string): string => text.replace(/[ \t\r\n\f ]+/g, " ");

function tidy(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: \u0001 is the serializer's own line-break marker
      .replace(/ *\u0001 */g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function wrap(inner: string, mark: string): string {
  const core = inner.trim();
  if (core === "") return inner;
  const lead = inner.startsWith(" ") ? " " : "";
  const tail = inner.endsWith(" ") ? " " : "";
  return `${lead}${mark}${core}${mark}${tail}`;
}

class Serializer {
  readonly #base: string | undefined;
  constructor(options: MarkdownOptions) {
    this.#base = options.baseUrl;
  }

  // ---- inline ----------------------------------------------------------------------------------------------------

  inline(node: DomNode): string {
    if (node.nodeType === TEXT) return squash(node.textContent ?? "");
    if (!isElement(node) || skipped(node)) return "";
    const tag = lower(node);
    if (tag === "br") return "\u0001";
    if (tag === "wbr") return "";
    if (tag === "img") {
      const alt = squash(attr(node, "alt") ?? "").trim();
      return alt === "" ? "" : `[Image: ${alt}]`;
    }
    if (tag === "code") {
      const text = squash(node.textContent ?? "").trim();
      if (text === "") return "";
      const fence = "`".repeat(Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length)) + 1);
      return `${fence}${text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text}${fence}`;
    }
    const inner = this.#inlineChildren(node);
    switch (tag) {
      case "strong":
      case "b":
        return wrap(inner, "**");
      case "em":
      case "i":
      case "cite":
        return wrap(inner, "*");
      case "del":
      case "s":
      case "strike":
        return wrap(inner, "~~");
      case "a": {
        const href = resolve(attr(node, "href") ?? "", this.#base);
        const text = inner.trim();
        // A link that holds only images (a gallery thumbnail) would be noise: keep the alt text, drop the link.
        if (!href || /^(\[Image: [^\]]*\]\s*)+$/.test(text)) return inner;
        return text === ""
          ? ""
          : `${inner.startsWith(" ") ? " " : ""}[${text.replace(/\n+/g, " ")}](${href})${inner.endsWith(" ") ? " " : ""}`;
      }
      default:
        // Block elements met inside inline content (rare, malformed) are read as text with spaces around them.
        return isInlineTag(node) ? inner : ` ${inner} `;
    }
  }

  #inlineChildren(node: DomNode): string {
    let out = "";
    for (const child of Array.from(node.childNodes)) out += this.inline(child);
    return out;
  }

  // ---- blocks ----------------------------------------------------------------------------------------------------

  /** The block-level pieces of an element's content, in order. */
  blocks(node: DomNode): string[] {
    const out: string[] = [];
    let run = "";
    const flush = () => {
      const text = tidy(run);
      if (text !== "") out.push(text);
      run = "";
    };
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === TEXT) {
        run += squash(child.textContent ?? "");
        continue;
      }
      if (!isElement(child) || skipped(child)) continue;
      if (isInlineTag(child) && !(lower(child) === "a" && hasBlockDescendant(child))) {
        run += this.inline(child);
        continue;
      }
      flush();
      out.push(...this.block(child));
    }
    flush();
    return out;
  }

  block(node: DomNode): string[] {
    const tag = lower(node);
    const heading = HEADING.exec(tag);
    if (heading) {
      const text = tidy(this.#inlineChildren(node)).replace(/\n+/g, " ");
      return text === "" ? [] : [`${"#".repeat(Number(heading[1]))} ${text}`];
    }
    switch (tag) {
      case "ul":
      case "ol": {
        const list = this.#list(node, tag === "ol");
        return list === "" ? [] : [list];
      }
      case "pre": {
        const code = this.#pre(node);
        return code === "" ? [] : [code];
      }
      case "blockquote": {
        const inner = this.blocks(node).join("\n\n");
        return inner === ""
          ? []
          : [
              inner
                .split("\n")
                .map((line) => (line === "" ? ">" : `> ${line}`))
                .join("\n"),
            ];
      }
      case "hr":
        return ["---"];
      case "table": {
        const table = this.#table(node);
        return table === "" ? [] : [table];
      }
      case "dt": {
        const text = tidy(this.#inlineChildren(node)).replace(/\n+/g, " ");
        return text === "" ? [] : [`**${text}**`];
      }
      default:
        return this.blocks(node);
    }
  }

  #list(node: DomNode, ordered: boolean): string {
    const start = ordered ? Number.parseInt(attr(node, "start") ?? "1", 10) : 1;
    let n = Number.isFinite(start) ? start : 1;
    const items: string[] = [];
    for (const child of Array.from(node.childNodes)) {
      if (!isElement(child) || skipped(child)) continue;
      const parts = lower(child) === "li" ? this.blocks(child) : this.block(child);
      const text = parts.join("\n");
      if (text === "") continue;
      const marker = ordered ? `${n++}. ` : "- ";
      const pad = " ".repeat(marker.length);
      items.push(
        text
          .split("\n")
          .map((line, i) => (i === 0 ? marker + line : line === "" ? "" : pad + line))
          .join("\n"),
      );
    }
    return items.join("\n");
  }

  #pre(node: DomNode): string {
    const text = (node.textContent ?? "").replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
    if (text.trim() === "") return "";
    let lang = "";
    for (const el of [node, ...Array.from(node.childNodes).filter(isElement)]) {
      const m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(attr(el, "class") ?? "");
      if (m) {
        lang = m[1]!;
        break;
      }
    }
    const fence = "`".repeat(Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length)) + 1);
    return `${fence}${lang}\n${text}\n${fence}`;
  }

  #table(node: DomNode): string {
    const rows: DomNode[][] = [];
    const collect = (parent: DomNode) => {
      for (const child of Array.from(parent.childNodes)) {
        if (!isElement(child) || skipped(child)) continue;
        const tag = lower(child);
        if (tag === "tr")
          rows.push(
            Array.from(child.childNodes).filter(
              (c) => isElement(c) && !skipped(c) && (lower(c) === "td" || lower(c) === "th"),
            ),
          );
        else if (tag === "thead" || tag === "tbody" || tag === "tfoot") collect(child);
      }
    };
    collect(node);
    const filled = rows.filter((r) => r.length > 0);
    if (filled.length === 0) return "";
    const cellText = (cell: DomNode): string =>
      this.blocks(cell)
        .join(" ")
        .replace(/\s*\n\s*/g, " ")
        .replace(/\|/g, "\\|")
        .trim();
    const width = Math.max(...filled.map((r) => r.length));
    const grid = filled.map((r) => Array.from({ length: width }, (_, i) => (r[i] ? cellText(r[i]!) : "")));
    // Columns that are empty in every row are spacing, not data.
    const keep = Array.from({ length: width }, (_, i) => i).filter((i) => grid.some((row) => row[i] !== ""));
    if (keep.length === 0) return "";
    // A layout table (one column): its cells are just content.
    if (keep.length === 1) return filled.flatMap((r) => (r[keep[0]!] ? this.blocks(r[keep[0]!]!) : [])).join("\n\n");
    const line = (row: string[]): string => `| ${keep.map((i) => row[i]).join(" | ")} |`;
    const [head, ...body] = grid;
    return [line(head!), `| ${keep.map(() => "---").join(" | ")} |`, ...body.map(line)].join("\n");
  }
}

/** The Markdown for the content of `root` (its children; `root` itself is not rendered). */
export function htmlToMarkdown(root: DomNode, options: MarkdownOptions = {}): string {
  const blocks = new Serializer(options).blocks(root);
  return blocks
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
