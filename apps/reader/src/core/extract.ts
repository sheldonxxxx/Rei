// Turns what a page returned into readable text for the model: HTML goes through Readability (on a linkedom document)
// and our own Markdown serializer; plain text and Markdown pass through; JSON is pretty-printed. Each result says what
// the page turned out to be (quality.ts), which extractor produced the text, and its sections. Pure and portable.
import { Readability } from "@mozilla/readability";
import type { ReadExtractor, ReadQuality, ReadSection } from "@rei/protocol";
import { parseHTML } from "linkedom";
import { type DomNode, htmlToMarkdown } from "./markdown.ts";
import { blockedReason, embeddedContent, jsShellReason, pageSignals } from "./quality.ts";
import { sectionsOf } from "./sections.ts";
import { ReaderError } from "./types.ts";

export type Extractor = ReadExtractor;

export interface ExtractedPage {
  title: string;
  /** The page as Markdown or text ("" when there is nothing to read). */
  text: string;
  quality: ReadQuality;
  extractor: Extractor;
  /** Why the quality is what it is, for logs and traces ("bot_check", "empty_app", ...); empty for a plain page. */
  reasons: string[];
  sections: ReadSection[];
}

/** Longest text kept for one page (characters); more is cut, so one huge page cannot fill the cache. */
export const MAX_TEXT_CHARS = 2_000_000;

const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

const cap = (text: string): string =>
  text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[The page is longer than this tool keeps; the rest was dropped.]`
    : text;

/** The document of `html`, with a `<base href>` or the page's own address as the base for links. */
// biome-ignore lint/suspicious/noExplicitAny: linkedom does not export its document types
function parse(html: string): { document: any; window: any } {
  // linkedom needs a whole document; a fragment (a partial response, an API snippet) gets wrapped in one.
  const whole = /<(html|body)[\s>]/i.test(html.slice(0, 4096))
    ? html
    : `<!doctype html><html><body>${html}</body></html>`;
  const { document, window } = parseHTML(whole);
  return { document, window };
}

// biome-ignore lint/suspicious/noExplicitAny: linkedom does not export its document types
function baseOf(document: any, url: string): string {
  try {
    const href = document.querySelector?.("base[href]")?.getAttribute("href");
    if (href) return new URL(href, url).href;
  } catch {
    // an unusable <base>: the page's own address stands
  }
  return url;
}

// biome-ignore lint/suspicious/noExplicitAny: linkedom does not export its document types
function fallbackTitle(document: any, url: string): string {
  const fromTag = clean(document.querySelector?.("title")?.textContent);
  if (fromTag) return fromTag;
  const h1 = clean(document.querySelector?.("h1")?.textContent);
  if (h1) return h1;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The page with its sections, the text capped. */
function finish(page: Omit<ExtractedPage, "sections" | "reasons"> & { reasons?: string[] }): ExtractedPage {
  const text = cap(page.text);
  return { ...page, text, reasons: page.reasons ?? [], sections: sectionsOf(text) };
}

/**
 * HTML to a title, Markdown and a quality. Never throws on odd markup: Readability failures fall back to the body text.
 * A bot check or sign-in wall is `blocked`; an app shell is `requires_js` unless the page embeds its content.
 */
export function extractHtml(html: string, url: string): ExtractedPage {
  const first = parse(html);
  const base = baseOf(first.document, url);
  const title = fallbackTitle(first.document, url);
  // Before Readability: it removes scripts and rewrites the tree.
  const signals = pageSignals(first.document, html);
  const read = readHtml(html, first, base, title);

  const blocked = blockedReason(signals);
  if (blocked) return finish({ ...read, quality: "blocked", reasons: [blocked] });
  const shell = jsShellReason(signals, read.text);
  if (shell) {
    const embedded = embeddedContent(signals, base);
    if (!embedded) return finish({ title, text: "", extractor: "none", quality: "requires_js", reasons: [shell] });
    return finish({
      title: clean(embedded.title) || title,
      text: embedded.text,
      extractor: embedded.source,
      quality: embedded.quality,
      reasons: [shell],
    });
  }
  return finish({ ...read, quality: "success" });
}

/** Readability's article, or the whole body when Readability finds nothing or only a scrap of a longer page. */
function readHtml(
  html: string,
  first: ReturnType<typeof parse>,
  base: string,
  title: string,
): { title: string; text: string; extractor: "readability" | "body" } {
  const bodyText = clean(first.document.body?.textContent);

  let article: { title: string; text: string } | undefined;
  try {
    const reader = new Readability(first.document as never, {
      keepClasses: true,
      serializer: (node: unknown) => htmlToMarkdown(node as DomNode, { baseUrl: base }) as never,
    });
    const parsed = reader.parse();
    const text = typeof parsed?.content === "string" ? parsed.content : "";
    if (parsed && text.trim() !== "") article = { title: clean(parsed.title) || title, text };
  } catch {
    article = undefined;
  }

  // Readability found nothing, or only a scrap of a page that has a lot more text (a listing, a front page).
  if (!article || (article.text.length < 300 && bodyText.length > article.text.length * 4)) {
    const second = parse(html);
    const body = second.document.body ?? second.document.documentElement;
    const text = body ? htmlToMarkdown(body as DomNode, { baseUrl: base }) : "";
    if (text.trim() !== "" && (!article || text.length > article.text.length))
      return { title: article?.title ?? title, text, extractor: "body" };
    if (!article) return { title, text: "", extractor: "body" };
  }
  return { title: article.title, text: article.text, extractor: "readability" };
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/csv",
  "text/xml",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
]);

/** `type/subtype` in lower case, without parameters. */
export const mediaType = (contentType: string | undefined): string =>
  (contentType ?? "").split(";")[0]!.trim().toLowerCase();

export function charsetOf(contentType: string | undefined): string | undefined {
  const m = /charset\s*=\s*"?([\w:.-]+)"?/i.exec(contentType ?? "");
  return m?.[1];
}

/** Decodes bytes with the charset the header names, else a `<meta charset>` near the top, else UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string | undefined): string {
  let label = charsetOf(contentType);
  if (!label) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    label = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * The readable text of a response body by its content type. A type that is not text (PDF, image, archive) is an
 * error for the model; a missing type is sniffed.
 */
export function extractBody(bytes: Uint8Array, contentType: string | undefined, url: string): ExtractedPage {
  const type = mediaType(contentType);
  const hostname = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  const isJson = type === "application/json" || type.endsWith("+json");
  if (
    HTML_TYPES.has(type) ||
    (type === "" && /^\s*(<!doctype html|<html|<head|<body)/i.test(decodeBody(bytes.subarray(0, 512), undefined)))
  ) {
    return extractHtml(decodeBody(bytes, contentType), url);
  }
  if (isJson) {
    const raw = decodeBody(bytes, contentType);
    let text = raw;
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      // not valid JSON: the text as it came
    }
    return { title: hostname, text: cap(text), quality: "success", extractor: "json", reasons: [], sections: [] };
  }
  if (
    TEXT_TYPES.has(type) ||
    (type.startsWith("text/") && type !== "text/css" && type !== "text/javascript") ||
    type === ""
  ) {
    if (type === "" && bytes.subarray(0, 1024).includes(0))
      throw new ReaderError("This is not a readable page (unknown type).", "unsupported_mime");
    const text = decodeBody(bytes, contentType);
    const heading = /^\s*#\s+(.+)$/m.exec(text)?.[1];
    return finish({ title: clean(heading) || hostname, text, quality: "success", extractor: "text" });
  }
  throw new ReaderError(
    `This is not a readable page (${type}). Only web pages, text and JSON can be read.`,
    "unsupported_mime",
  );
}
