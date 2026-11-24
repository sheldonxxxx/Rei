// What web_fetch shows the model of a stored page, in four modes: an overview (outline and opening; a short page whole),
// the passages that match a query, one section, or the raw text from an offset (the original slicing, unchanged). Every
// byte the page controls (title, headings, text) is inside one content fence per result; what we add (notes, footers)
// is outside it. Pure and portable.
import { estimateTokens } from "../memory/text.ts";
import { type CachedPage, renderSlice, SLICE_CHARS } from "./cache.ts";
import type { WebDocument } from "./documents.ts";
import { fenceWithId, originOf } from "./fence.ts";
import { countTokens, type Selection } from "./passages.ts";
import { type Section, TOP_SECTION } from "./sections.ts";

/** A page of at most this many o200k tokens is shown whole instead of as an outline. */
export const SHORT_PAGE_TOKENS = 1_500;
/** About this much of the opening text follows the outline, less what a long outline takes beyond its share (estimated tokens). */
export const OPENING_TOKENS = 600;
const OVERVIEW_TOKENS = 900;
const OPENING_MIN_TOKENS = 100;
/** The outline lists at most this many sections. */
export const OUTLINE_MAX = 50;

export type RenderMode = "overview" | "whole" | "query" | "section" | "offset";
/**
 * `fenceId` is the id in the page-content markers of `text`; `truncated` is false only when `text` holds all of what was
 * asked for: the whole page, a whole section, or the last slice. An outline or matching passages are partial.
 */
export type Rendered =
  | { text: string; mode: RenderMode; sections?: string[]; fenceId: string; truncated: boolean }
  | { error: string };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const when = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Whether the page is short enough to show whole (o200k counted only when the characters allow it). */
export function isShort(doc: Pick<CachedPage, "text">): boolean {
  return doc.text.length <= SHORT_PAGE_TOKENS * 6 && countTokens(doc.text) <= SHORT_PAGE_TOKENS;
}

const lead = (doc: CachedPage): string => (doc.note ? `[${doc.note}]\n\n` : "");
const header = (doc: CachedPage, anchor?: string): string =>
  `# ${doc.title}\n${doc.url}${anchor ? `#${anchor}` : ""}\n\n`;
const stored = (doc: WebDocument, cached: boolean): string =>
  cached ? ` Stored copy from ${when(doc.fetchedAt)}; pass refresh=true to fetch it again.` : "";

/** The text from the start up to about `tokens` estimated tokens, cut at a line break when there is one. */
function opening(text: string, tokens: number): string {
  let end = 0;
  let cost = 0;
  for (const ch of text) {
    cost += ch.charCodeAt(0) < 128 ? 0.25 : 1;
    if (cost > tokens) break;
    end += ch.length;
  }
  if (end >= text.length) return text;
  const nl = text.lastIndexOf("\n", end);
  return text.slice(0, nl > end / 2 ? nl : end);
}

function outline(doc: WebDocument): string[] {
  const lines: string[] = [];
  const named = doc.sections.filter((s) => s.id !== TOP_SECTION);
  for (const s of named.slice(0, OUTLINE_MAX)) {
    const indent = "  ".repeat(Math.max(0, s.level - 1));
    lines.push(
      `${indent}- [${s.id}] ${clip(s.heading, 120)} (~${estimateTokens(doc.text.slice(s.start, s.end))} tokens)`,
    );
  }
  if (named.length > OUTLINE_MAX) lines.push(`- … ${named.length - OUTLINE_MAX} more sections`);
  return lines;
}

/** The outline and the opening, or the whole page when it is short. `prefix` goes before everything (a query that matched nothing). */
export function renderOverview(doc: WebDocument, cached: boolean, prefix = ""): Rendered {
  if (isShort(doc)) {
    const whole = renderSlice(doc, 0);
    if ("error" in whole) return whole;
    const note = stored(doc, cached).trim();
    return {
      text: `${prefix}${whole.text}${note ? `\n\n[${note}]` : ""}`,
      mode: "whole",
      fenceId: whole.fenceId,
      truncated: whole.truncated,
    };
  }
  const sections = outline(doc);
  const room = OVERVIEW_TOKENS - estimateTokens(sections.join("\n"));
  const open = opening(doc.text, Math.max(OPENING_MIN_TOKENS, Math.min(OPENING_TOKENS, room)));
  const body = [
    header(doc).trimEnd(),
    "",
    ...(sections.length > 0 ? ["Sections:", ...sections, ""] : []),
    "Opening:",
    open.trimEnd(),
  ].join("\n");
  const size = `~${estimateTokens(doc.text).toLocaleString("en")} tokens, ${doc.text.length.toLocaleString("en")} characters`;
  const how =
    sections.length > 0
      ? `Call web_fetch with query="…" for the passages that match a question, section="<id>" to read one section, or offset=${open.length} to read on from the opening.`
      : `Call web_fetch with query="…" for the passages that match a question, or offset=${open.length} to read on from the opening.`;
  const fenced = fenceWithId(body, originOf(doc.url));
  return {
    text: `${prefix}${lead(doc)}${fenced.text}\n\n[This is an outline of a long page (${size}).${stored(doc, cached)} ${how}]`,
    mode: "overview",
    fenceId: fenced.id,
    truncated: true,
  };
}

/** The selected passages in rank order, each under its section id and heading path. No passage: the overview, saying so. */
export function renderQuery(
  doc: WebDocument,
  query: string,
  selection: Selection & { termsFound: number; terms: number },
  cached: boolean,
): Rendered {
  const q = clip(query.replace(/\s+/g, " ").trim(), 200);
  if (isShort(doc)) return renderOverview(doc, cached);
  if (selection.passages.length === 0)
    return renderOverview(doc, cached, `[Nothing on this page matches "${q}". Here is its outline instead.]\n\n`);
  const parts = selection.passages.map((p) => {
    const path = p.path.length > 0 ? `: ${p.path.map((h) => clip(h, 80)).join(" › ")}` : "";
    return `[section ${p.sectionId}${path}]\n${doc.text.slice(p.start, p.end).trimEnd()}`;
  });
  const more =
    selection.moreSections.length > 0
      ? ` Other sections that match: ${selection.moreSections.slice(0, 8).join(", ")}.`
      : "";
  const footer = `[The passages that best match "${q}" (${selection.termsFound} of ${selection.terms} search terms found); they may not hold the answer.${more} Call web_fetch with section="<id>" to read a section in full.${stored(doc, cached)}]`;
  const fenced = fenceWithId(`${header(doc)}${parts.join("\n\n")}`, originOf(doc.url));
  return {
    text: `${lead(doc)}${fenced.text}\n\n${footer}`,
    mode: "query",
    sections: [...new Set(selection.passages.map((p) => p.sectionId))],
    fenceId: fenced.id,
    truncated: true,
  };
}

/** One section in full, 20,000 characters at a time from `offset` inside it. */
export function renderSection(doc: WebDocument, id: string, offset: number, cached: boolean): Rendered {
  const section: Pick<Section, "id" | "start" | "end"> | undefined =
    doc.sections.find((s) => s.id === id) ??
    (doc.sections.length === 0 && id === TOP_SECTION ? { id, start: 0, end: doc.text.length } : undefined);
  if (!section) {
    const ids = doc.sections.map((s) => s.id);
    const list = ids.length > 0 ? ` Its sections: ${ids.slice(0, 40).join(", ")}${ids.length > 40 ? ", …" : ""}.` : "";
    return { error: `There is no section "${clip(id, 80)}" on this page.${list}` };
  }
  const text = doc.text.slice(section.start, section.end);
  const total = text.length;
  if (offset > 0 && offset >= total)
    return { error: `offset ${offset} is past the end of section "${id}" (${total} characters).` };
  let end = Math.min(total, offset + SLICE_CHARS);
  if (end < total) {
    const nl = text.lastIndexOf("\n", end - 1);
    if (nl >= offset + SLICE_CHARS - 2_000) end = nl + 1;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  const footer =
    end < total
      ? `\n\n[Showing characters ${offset}–${end} of ${total} in section "${id}". Call web_fetch again with section="${id}" and offset=${end} for more.${stored(doc, cached)}]`
      : cached
        ? `\n\n[${stored(doc, cached).trim()}]`
        : "";
  const fenced = fenceWithId(`${header(doc, id)}${text.slice(offset, end).trimEnd()}`, originOf(doc.url));
  return {
    text: `${offset === 0 ? lead(doc) : ""}${fenced.text}${footer}`,
    mode: "section",
    sections: [id],
    fenceId: fenced.id,
    truncated: end < total,
  };
}

/** The original slicing, byte for byte. */
export function renderOffset(doc: WebDocument, offset: number): Rendered {
  const slice = renderSlice(doc, offset);
  return "error" in slice
    ? slice
    : { text: slice.text, mode: "offset", fenceId: slice.fenceId, truncated: slice.truncated };
}
