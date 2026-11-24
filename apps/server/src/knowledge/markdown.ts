// The parts of a page's Markdown that the Knowledge service needs to understand: its sections (by heading), its task
// checkboxes, and the page/file references in its links. Everything else is just text. Code fences are respected, so a
// "# comment" inside a fenced block is never mistaken for a heading. A heading is a `#` line or top-level paragraph text
// underlined with `===` or `---`, read the way the clients' parsers read it (docs/rendering.md). Web APIs only.
import { findSlug, headingSlugs, linkAnchor } from "@rei/protocol";
import { estimateTokens } from "../memory/text.ts";
import { Invalid } from "../util/errors.ts";

export interface Section {
  /** 0 for the text before the first heading ("top"), otherwise the heading's position in the outline, from 1. */
  index: number;
  /** 0 for "top". */
  level: number;
  heading: string;
  /** The section's anchor, as in `page:<id>#<slug>` (GitHub-style, shared with clients); "" for "top". */
  slug: string;
  /** Heading texts from the outermost section down to this one. */
  path: string[];
  /** Line range [start, end) of the whole section, heading and subsections included. */
  start: number;
  end: number;
  /** End of the heading's own lines: one line for `#`, its text and underline for an underlined heading. */
  headEnd: number;
  /** End of the section's own text, before its first subsection. */
  ownEnd: number;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
// The rest mirror the web client's parser (apps/web/src/lib/markdown.ts), which decides what a reader sees as a heading.
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const LONE_DASH = /^ {0,3}-[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const CODE_INDENT = /^(?: {4}| {0,3}\t)/;
const DEFINITION = /^\[\^([A-Za-z0-9_-]+)\]:/;
const CONTINUED = /^(?: {2,}|\t)\S/;
const BLANK = /^\s*$/;

export const lines = (body: string): string[] => body.split("\n");

/** Which lines are inside a fenced code block (fence lines included). */
function fencedLines(all: readonly string[]): boolean[] {
  const out = new Array<boolean>(all.length).fill(false);
  let fence: string | null = null;
  for (let i = 0; i < all.length; i++) {
    const m = FENCE.exec(all[i]!);
    if (fence) {
      out[i] = true;
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
    } else if (m) {
      out[i] = true;
      fence = m[1]!;
    }
  }
  return out;
}

/** The slugs of the page's headings, in order (section §n has slugs[n - 1]). */
export const slugs = (body: string): string[] =>
  sections(body)
    .slice(1)
    .map((s) => s.slug);

const leading = (line: string): number => /^ */.exec(line)![0].length;

/** How many cells a table row has (`\|` is a literal pipe, and a pipe inside a code span does not split). */
function cellCount(line: string): number {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  let n = 1;
  let code = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") i++;
    else if (s[i] === "`") code = !code;
    else if (s[i] === "|" && !code) n++;
  }
  return n;
}

function tableStarts(all: readonly string[], i: number): boolean {
  const head = all[i] ?? "";
  const sep = all[i + 1] ?? "";
  return head.includes("|") && sep.includes("-") && TABLE_SEP.test(sep) && cellCount(head) === cellCount(sep);
}

interface Head {
  line: number;
  headEnd: number;
  level: number;
  text: string;
}

/**
 * The page's headings, in order. A `#` line is one anywhere outside code fences. Paragraph text followed by a line of
 * `=` (level 1) or `-` (level 2) is one at the top level only: not after a blank line, and not in a list item, quote,
 * table, footnote or indented code, where that line is a rule or text. A lone `-` on the page's last line is not one
 * (a streaming reply may be starting a list item there).
 */
function headings(all: readonly string[]): Head[] {
  const fenced = fencedLines(all);
  const out: Head[] = [];
  const notes = new Set<string>();
  // The open top-level paragraph's first line, or -1; the container the lines are in; whether a blank line came before.
  let para = -1;
  let inside: "list" | "note" | "table" | null = null;
  let gap = true;
  const startsBlock = (i: number): boolean =>
    FENCE.test(all[i]!) ||
    HEADING.test(all[i]!) ||
    RULE.test(all[i]!) ||
    QUOTE.test(all[i]!) ||
    ITEM.test(all[i]!) ||
    tableStarts(all, i);
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
    const blank = BLANK.test(line);
    const afterBlank = gap;
    gap = blank;
    if (fenced[i]) {
      para = -1;
      if (leading(line) < 2) inside = null;
      continue;
    }
    const atx = HEADING.exec(line);
    if (atx) {
      out.push({ line: i, headEnd: i + 1, level: atx[1]!.length, text: atx[2]!.trim() });
      para = -1;
      if (leading(line) < 2) inside = null;
      continue;
    }
    // A footnote definition leaves the flow with its indented continuation (and one blank line in its place).
    const def = DEFINITION.exec(line);
    if (def && !notes.has(def[1]!)) {
      notes.add(def[1]!);
      inside = "note";
      para = -1;
      continue;
    }
    if (inside === "note") {
      const next = all.slice(i + 1).find((l) => !BLANK.test(l)) ?? "";
      if (CONTINUED.test(line) || (blank && CONTINUED.test(next))) continue;
      inside = null;
      if (blank) continue;
    } else if (blank) {
      para = -1;
      if (inside === "table") inside = null;
      continue;
    }
    if (inside === "list") {
      // Item content (indented) or a lazy continuation of the item's paragraph.
      if (leading(line) >= 2 || (!afterBlank && !startsBlock(i))) continue;
      inside = null;
    } else if (inside === "table") {
      if (line.includes("|")) continue;
      inside = null;
    }
    if (para >= 0) {
      if (SETEXT.test(line) && !(i === all.length - 1 && LONE_DASH.test(line))) {
        const text = all
          .slice(para, i)
          .map((l) => l.trim())
          .join(" ");
        out.push({ line: para, headEnd: i + 1, level: line.trim()[0] === "=" ? 1 : 2, text });
        para = -1;
        continue;
      }
      if (!startsBlock(i)) continue;
      para = -1;
    }
    // A new block, in the order the client tries them: indented code, rule and quote lines are not paragraph text.
    if (CODE_INDENT.test(line) || RULE.test(line) || QUOTE.test(line)) continue;
    if (ITEM.test(line)) inside = "list";
    else if (tableStarts(all, i)) {
      inside = "table";
      i++;
    } else para = i;
  }
  return out;
}

/** The page's sections: "top" (always present, maybe empty) and one per heading, in order. */
export function sections(body: string): Section[] {
  const all = lines(body);
  const heads = headings(all);
  const out: Section[] = [
    {
      index: 0,
      level: 0,
      heading: "",
      slug: "",
      path: [],
      start: 0,
      end: all.length,
      headEnd: 0,
      ownEnd: heads[0]?.line ?? all.length,
    },
  ];
  const stack: Section[] = [];
  const slugs = headingSlugs(heads.map((h) => h.text));
  heads.forEach((h, k) => {
    let end = all.length;
    for (let j = k + 1; j < heads.length; j++)
      if (heads[j]!.level <= h.level) {
        end = heads[j]!.line;
        break;
      }
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    const section: Section = {
      index: k + 1,
      level: h.level,
      heading: h.text,
      slug: slugs[k]!,
      path: [...stack.map((s) => s.heading), h.text],
      start: h.line,
      end,
      headEnd: h.headEnd,
      ownEnd: heads[k + 1]?.line ?? all.length,
    };
    stack.push(section);
    out.push(section);
  });
  return out;
}

export const sectionText = (body: string, s: Section): string => lines(body).slice(s.start, s.end).join("\n");
export const ownText = (body: string, s: Section): string => lines(body).slice(s.start, s.ownEnd).join("\n");

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Finds a section by what an agent or the UI calls it: "§3" or "3" (outline position), "#slug" (its link anchor), a
 * heading's text, or a path ("Plan > Week 2") when a heading repeats. "top" is the text before the first heading. Ambiguity and absence are
 * errors that list what exists, so the caller can correct itself in one step.
 */
export function findSection(body: string, ref: string): Section {
  const all = sections(body);
  const r = ref.trim();
  if (/^(top|§0|0)$/i.test(r)) return all[0]!;
  const numbered = /^§?(\d+)$/.exec(r);
  if (numbered) {
    const s = all[Number(numbered[1])];
    if (s) return s;
  }
  // "#week-2" is an anchor; "# Week 2" (a heading line) and "#" alone fall through to heading text.
  if (/^#[^\s#]/.test(r)) {
    const at = findSlug(
      all.map((s) => s.slug),
      r,
    );
    if (at > 0) return all[at]!;
  }
  const wanted = r
    .replace(/^#+\s*/, "")
    .split(/\s*[>›]\s*/)
    .map(norm)
    .filter(Boolean);
  const matches = all.filter((s) => {
    if (s.index === 0 || wanted.length === 0) return false;
    if (wanted.length === 1) return norm(s.heading) === wanted[0];
    const tail = s.path.slice(-wanted.length).map(norm);
    return tail.every((p, i) => p === wanted[i]);
  });
  if (matches.length === 1) return matches[0]!;
  const listing = all
    .slice(1)
    .map((s) => `§${s.index} ${s.path.join(" > ")} #${s.slug}`)
    .join("; ");
  if (matches.length > 1)
    throw new Invalid(
      `"${ref}" matches ${matches.length} sections; use its number or path. Sections: ${listing || "(none)"}.`,
    );
  throw new Invalid(`There is no section "${ref}". Sections: ${listing || "(none — the page has no headings)"}.`);
}

/** One line per heading: `§n heading #slug (≈tokens)`, indented by depth. */
export function outline(body: string): string[] {
  const all = sections(body);
  const top = all[0]!;
  const out: string[] = [];
  const topTokens = estimateTokens(ownText(body, top));
  if (topTokens > 0 && all.length > 1) out.push(`§0 (top) (≈${topTokens})`);
  for (const s of all.slice(1))
    out.push(
      `${"  ".repeat(Math.max(0, s.level - 1))}§${s.index} ${s.heading} #${s.slug} (≈${estimateTokens(sectionText(body, s))})`,
    );
  return out;
}

const join = (parts: string[]): string => parts.join("\n");

/** Puts `text` on its own lines, with one blank line separating it from non-empty neighbours. */
function insertAt(all: string[], at: number, text: string): string[] {
  const before = all.slice(0, at);
  const after = all.slice(at);
  while (before.length > 0 && before[before.length - 1]!.trim() === "") before.pop();
  while (after.length > 0 && after[0]!.trim() === "") after.shift();
  const block = text.replace(/^\n+|\n+$/g, "").split("\n");
  // A list item added after a list item continues that list instead of starting a new one.
  const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
  const continues = before.length > 0 && LIST_ITEM.test(before[before.length - 1]!) && LIST_ITEM.test(block[0] ?? "");
  return [
    ...before,
    ...(before.length > 0 && !continues ? [""] : []),
    ...block,
    ...(after.length > 0 ? ["", ...after] : []),
  ];
}

export function appendText(body: string, text: string): string {
  return join(insertAt(lines(body), lines(body).length, text)).replace(/^\n+/, "");
}

export function appendToSection(body: string, ref: string, text: string): { body: string; section: Section } {
  const s = findSection(body, ref);
  // The end of the section's own text: before its first subsection, so an appended line stays with its heading.
  const next = join(insertAt(lines(body), s.ownEnd, text));
  return { body: next, section: s };
}

/** Whether the text opens with a heading, `#` or underlined. */
function startsWithHeading(text: string): boolean {
  const first = sections(text.replace(/^\n+/, ""))[1];
  return first !== undefined && first.start === 0;
}

export function replaceSection(body: string, ref: string, text: string): { body: string; section: Section } {
  const s = findSection(body, ref);
  const all = lines(body);
  const keepHeading = s.index > 0 && !startsWithHeading(text);
  const heading = all.slice(s.start, s.headEnd).join("\n");
  const replacement = keepHeading ? `${heading}\n\n${text.replace(/^\n+/, "")}` : text;
  const before = all.slice(0, s.start);
  const after = all.slice(s.end);
  const merged = insertAt([...before, ...after], before.length, replacement);
  return { body: join(merged), section: s };
}

export function insertSectionAfter(body: string, ref: string, text: string): { body: string; section: Section } {
  const s = findSection(body, ref);
  if (!startsWithHeading(text))
    throw new Invalid("A new section must start with a heading line (for example ## Notes).");
  return { body: join(insertAt(lines(body), s.end, text)), section: s };
}

export function replaceText(body: string, oldText: string, newText: string): string {
  if (oldText === "") throw new Invalid("replace_text needs the exact text to replace (old).");
  const first = body.indexOf(oldText);
  if (first < 0) throw new Invalid("The text to replace (old) is not on the page; read the page and copy it exactly.");
  if (body.indexOf(oldText, first + 1) >= 0)
    throw new Invalid("The text to replace (old) appears more than once; include more surrounding text.");
  return body.slice(0, first) + newText + body.slice(first + oldText.length);
}

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s*)(.*)$/;

export interface Task {
  /** Position among the page's tasks, from 0. */
  index: number;
  line: number;
  done: boolean;
  text: string;
}

export function tasks(body: string): Task[] {
  const all = lines(body);
  const fenced = fencedLines(all);
  const out: Task[] = [];
  for (let i = 0; i < all.length; i++) {
    if (fenced[i]) continue;
    const m = TASK.exec(all[i]!);
    if (m) out.push({ index: out.length, line: i, done: m[2] !== " ", text: m[4]!.trim() });
  }
  return out;
}

/** Ticks or unticks one task, found by its position or by text (exact, then a unique substring, case-insensitive). */
export function setTask(
  body: string,
  which: { index?: number; text?: string },
  done: boolean,
): { body: string; task: Task } {
  const all = tasks(body);
  let task: Task | undefined;
  if (which.index !== undefined) task = all[which.index];
  else if (which.text !== undefined) {
    const t = norm(which.text);
    const exact = all.filter((x) => norm(x.text) === t);
    const partial = exact.length > 0 ? exact : all.filter((x) => norm(x.text).includes(t));
    if (partial.length > 1)
      throw new Invalid(`"${which.text}" matches ${partial.length} tasks; give more of the task's text.`);
    task = partial[0];
  }
  if (!task) throw new Invalid("There is no such task on the page.");
  const ls = lines(body);
  ls[task.line] = ls[task.line]!.replace(
    TASK,
    (_m, a: string, _x: string, b: string, rest: string) => `${a}${done ? "x" : " "}${b}${rest}`,
  );
  return { body: join(ls), task: { ...task, done } };
}

export interface Refs {
  pages: string[];
  /** Section links, `page:<pageId>#<anchor>`, one per distinct target. */
  anchors: { pageId: string; anchor: string }[];
  files: { fileId: string; versionId: string | null }[];
}

const LINK = /\]\(\s*<?(?:page:([A-Za-z0-9_-]+)(?:#([^\s<>()]*))?|file:([A-Za-z0-9_-]+)(?:@([A-Za-z0-9_-]+))?)>?\s*\)/g;

/** The `page:` and `file:` links on the page (outside code fences). */
export function refs(body: string): Refs {
  const all = lines(body);
  const fenced = fencedLines(all);
  const pages = new Set<string>();
  const anchors = new Map<string, { pageId: string; anchor: string }>();
  const files = new Map<string, { fileId: string; versionId: string | null }>();
  for (let i = 0; i < all.length; i++) {
    if (fenced[i]) continue;
    for (const m of all[i]!.matchAll(LINK)) {
      if (m[1]) {
        pages.add(m[1]);
        const anchor = linkAnchor(m[2] ?? "");
        if (anchor) anchors.set(`${m[1]}#${anchor}`, { pageId: m[1], anchor });
      } else files.set(`${m[3]}@${m[4] ?? ""}`, { fileId: m[3]!, versionId: m[4] ?? null });
    }
  }
  return { pages: [...pages], anchors: [...anchors.values()], files: [...files.values()] };
}

/** The search chunks of a page: each section's own text, cut to about `max` characters, with its heading path. */
export function chunks(body: string, max = 1_600): { path: string[]; sectionIndex: number; text: string }[] {
  const out: { path: string[]; sectionIndex: number; text: string }[] = [];
  for (const s of sections(body)) {
    const text = ownText(body, s).trim();
    if (text === "") continue;
    for (let at = 0; at < text.length; at += max)
      out.push({ path: s.path, sectionIndex: s.index, text: text.slice(at, at + max) });
  }
  return out;
}
