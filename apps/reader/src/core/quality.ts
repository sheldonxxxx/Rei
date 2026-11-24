// Whether an HTML page is something to read: a bot check or a sign-in wall ("blocked"), an app shell that shows nothing
// without JavaScript ("requires_js"), or a page. The signals are taken from the document before Readability changes it.
// For an app shell, the content the page already ships in its HTML is tried before giving up: JSON-LD, Next.js and Nuxt
// data, then the meta description. Deterministic and portable: no network, no model.

import type { ReadQuality as PageQuality } from "@rei/protocol";
import { parseHTML } from "linkedom";
import { type DomNode, htmlToMarkdown } from "./markdown.ts";

export interface PageSignals {
  /** Script elements that run code (not JSON data blocks). */
  scripts: number;
  jsonLd: string[];
  /** `__NEXT_DATA__` or `__NUXT_DATA__` JSON. */
  appData: { source: "next-data" | "nuxt-data"; json: string } | undefined;
  title: string;
  /** The first h1 (or h2) text. */
  heading: string;
  ogTitle: string;
  description: string;
  /** `<noscript>` text, when it is more than an "enable JavaScript" line. */
  noscript: string;
  /** Text of the main region (main, role=main, article); undefined when the page has none. */
  mainText: string | undefined;
  bodyText: string;
  /** An app mount point (#root, #app, #__next, #__nuxt, ...) holding no text or only a loading line. */
  emptyMount: boolean;
  /** aria-busy, or a loading/spinner/skeleton element. */
  busy: boolean;
  /** A noscript line asking to enable JavaScript. */
  asksForJs: boolean;
  passwordField: boolean;
  /** Bot-check markup: Turnstile, reCAPTCHA, hCaptcha, a challenge platform. */
  botMarkup: boolean;
  /** Bot-check wording ("verify you are human", "checking your browser") or title ("Just a moment..."). */
  botWords: boolean;
}

const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
const LOADING = /^(loading|please wait|just a moment|載入中|加载中|読み込み中|로딩 중)[\s\S]{0,40}$/i;
const ASKS_FOR_JS = /(enable|turn on|requires?|need)\s+javascript|javascript (is )?(required|disabled)/i;
const BOT_MARKUP =
  /cf-turnstile|challenge-platform|cf-chl-|g-recaptcha|recaptcha\/api|h-captcha|hcaptcha\.com|perimeterx|px-captcha|datadome|captcha-delivery/i;
const BOT_WORDS =
  /verify (that )?you are (a )?human|checking (if the site connection is secure|your browser)|are you a robot|unusual traffic from your (computer )?network|press (&|and) hold/i;
const BOT_TITLE =
  /^(just a moment|attention required|access denied|are you a robot|security check|human verification)/i;
const LOGIN = /\b(sign[ -]?in|log[ -]?in|sign on)\b|登入|登录|ログイン|로그인/i;
const MOUNTS = [
  "#root",
  "#app",
  "#__next",
  "#__nuxt",
  "#___gatsby",
  "#svelte",
  "[data-reactroot]",
  "[ng-version]",
  "app-root",
];

/** The little of a DOM the classifier reads (linkedom's document satisfies it). */
interface ElementLike {
  getAttribute(name: string): string | null;
  textContent: string | null;
}
export interface DocumentLike {
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
  body?: ElementLike | null;
}

/** What the classifier needs, read from the untouched document (Readability removes scripts and changes the tree). */
export function pageSignals(document: DocumentLike, html: string): PageSignals {
  const q = (sel: string): ElementLike | null => document.querySelector(sel) ?? null;
  const all = (sel: string): ElementLike[] => Array.from(document.querySelectorAll(sel) ?? []);
  const meta = (name: string): string =>
    clean(q(`meta[name="${name}"]`)?.getAttribute("content") ?? q(`meta[property="${name}"]`)?.getAttribute("content"));

  let scripts = 0;
  const jsonLd: string[] = [];
  let appData: PageSignals["appData"];
  for (const s of all("script")) {
    const type = (s.getAttribute("type") ?? "").toLowerCase();
    const id = s.getAttribute("id") ?? "";
    if (type === "application/ld+json") jsonLd.push(s.textContent ?? "");
    else if (id === "__NEXT_DATA__") appData = { source: "next-data", json: s.textContent ?? "" };
    else if (id === "__NUXT_DATA__") appData ??= { source: "nuxt-data", json: s.textContent ?? "" };
    else if (type === "" || type === "module" || type.includes("javascript")) scripts++;
  }

  const noscriptText = clean(
    all("noscript")
      .map((n) => n.textContent ?? "")
      .join(" "),
  );
  const main = q("main") ?? q('[role="main"]') ?? q("article");
  const mount = MOUNTS.map(q).find((el) => el !== null);
  const mountText = mount ? clean(mount.textContent) : undefined;
  const busy =
    q('[aria-busy="true"]') !== null ||
    all("[class]").some((el) => /(^|\s)(spinner|skeleton|loading|loader)(\s|$)/i.test(el.getAttribute("class") ?? ""));

  return {
    scripts,
    jsonLd,
    appData,
    title: clean(q("title")?.textContent),
    heading: clean((q("h1") ?? q("h2"))?.textContent),
    ogTitle: meta("og:title"),
    description: meta("og:description") || meta("description"),
    noscript: ASKS_FOR_JS.test(noscriptText) && noscriptText.length < 200 ? "" : noscriptText,
    mainText: main ? clean(main.textContent) : undefined,
    bodyText: clean(document.body?.textContent),
    emptyMount: mountText !== undefined && (mountText === "" || LOADING.test(mountText)),
    busy,
    asksForJs: ASKS_FOR_JS.test(noscriptText),
    passwordField: q('input[type="password"]') !== null,
    botMarkup: BOT_MARKUP.test(html),
    botWords: BOT_WORDS.test(clean(document.body?.textContent)) || BOT_TITLE.test(clean(q("title")?.textContent)),
  };
}

/** Why the page is not the page at all: a bot check, or a sign-in form in place of the content. Undefined: neither. */
export function blockedReason(s: PageSignals): "bot_check" | "login_wall" | undefined {
  // A real page can embed a reCAPTCHA on a comment form: markup alone counts only on a page with almost nothing else.
  if ((s.botWords && s.bodyText.length < 1_500) || (s.botMarkup && s.bodyText.length < 400)) return "bot_check";
  const h1ish = `${s.title} ${s.heading} ${(s.mainText ?? "").slice(0, 200)}`;
  if (s.passwordField && s.bodyText.length < 600 && LOGIN.test(h1ish)) return "login_wall";
  return undefined;
}

/** Why the page needs JavaScript to show its content, given what extraction found. Undefined: it does not. */
export function jsShellReason(s: PageSignals, extracted: string): "empty_app" | "empty_main" | undefined {
  if (s.scripts === 0) return undefined;
  const text = clean(extracted);
  const hint = s.emptyMount || s.busy || s.asksForJs;
  if ((text.length < 50 || LOADING.test(text)) && (hint || text === "")) return "empty_app";
  // Site chrome around an empty content area: the header and footer extract fine, the content is still loading.
  if (
    s.mainText !== undefined &&
    (s.mainText === "" || (s.mainText.length < 100 && (LOADING.test(s.mainText) || s.busy)))
  )
    return "empty_main";
  return undefined;
}

export interface Embedded {
  source: "json-ld" | "next-data" | "nuxt-data" | "meta";
  title: string | undefined;
  text: string;
  quality: Extract<PageQuality, "success" | "low_quality">;
}

const htmlish = (s: string): boolean => /<(p|div|br|h[1-6]|ul|ol|li|strong|em|a)\b[^>]*>/i.test(s);
function asMarkdown(s: string, baseUrl: string): string {
  if (!htmlish(s)) return s.trim();
  const { document } = parseHTML(`<!doctype html><html><body>${s}</body></html>`);
  return htmlToMarkdown(document.body as DomNode, { baseUrl }).trim();
}
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The JSON-LD item that carries an article's text (articleBody or text), looking through arrays and @graph. */
function jsonLdArticle(blocks: string[]): { title?: string; body: string } | undefined {
  const queue: unknown[] = blocks.map(parseJson);
  while (queue.length > 0) {
    const item = queue.shift();
    if (Array.isArray(item)) queue.push(...item);
    else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      if (Array.isArray(o["@graph"])) queue.push(...o["@graph"]);
      const body = typeof o.articleBody === "string" ? o.articleBody : typeof o.text === "string" ? o.text : "";
      if (body.trim().length >= 100) {
        const title = typeof o.headline === "string" ? o.headline : typeof o.name === "string" ? o.name : undefined;
        return { ...(title ? { title } : {}), body };
      }
    }
  }
  return undefined;
}

/** A CSS class list or similar markup ("flex items-center gap-4"): no sentence punctuation, mostly hyphenated tokens. */
function looksLikeMarkup(s: string): boolean {
  if (/[.!?,。！？、，]/.test(s)) return false;
  const tokens = s.split(/\s+/);
  return tokens.filter((t) => /[-:_/[\]]/.test(t)).length * 2 >= tokens.length;
}

/** Prose in app data: strings of some length with spaces, in document order, without URLs, ids, class lists or code. */
function harvestStrings(data: unknown): { title?: string; strings: string[] } {
  const strings: string[] = [];
  const seen = new Set<string>();
  let title: string | undefined;
  const walk = (v: unknown, key: string, depth: number): void => {
    if (depth > 30) return;
    if (typeof v === "string") {
      const s = v.trim();
      if (!title && /^(title|headline)$/i.test(key) && s.length > 0 && s.length < 200) title = s;
      if (
        s.length >= 40 &&
        /\s/.test(s) &&
        !/^(https?:|\/|data:)/.test(s) &&
        !/[{};]\s*$/.test(s) &&
        !looksLikeMarkup(s) &&
        !seen.has(s)
      ) {
        seen.add(s);
        strings.push(s);
      }
    } else if (Array.isArray(v)) for (const x of v) walk(x, key, depth + 1);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(data, "", 0);
  return { ...(title ? { title } : {}), strings };
}

/** Content the page ships in its HTML for its scripts to render, best source first; undefined when there is none. */
export function embeddedContent(s: PageSignals, baseUrl: string): Embedded | undefined {
  const article = jsonLdArticle(s.jsonLd);
  if (article)
    return { source: "json-ld", title: article.title, text: asMarkdown(article.body, baseUrl), quality: "success" };

  if (s.appData) {
    const data = parseJson(s.appData.json) as Record<string, unknown> | undefined;
    const props = (data?.props as Record<string, unknown> | undefined)?.pageProps ?? data?.props ?? data;
    const { title, strings } = harvestStrings(props);
    const text = strings.map((x) => asMarkdown(x, baseUrl)).join("\n\n");
    if (text.length > 0)
      return { source: s.appData.source, title, text, quality: text.length >= 150 ? "success" : "low_quality" };
  }

  const summary = [s.description, s.noscript].filter((x) => x !== "").join("\n\n");
  if (summary !== "") return { source: "meta", title: s.ogTitle || undefined, text: summary, quality: "low_quality" };
  return undefined;
}

/** A line for the model, outside the page's fence, saying where the text came from when it is not the page as shown. */
export function sourceNote(source: string, quality: PageQuality): string | undefined {
  if (source === "meta")
    return "Only the page's summary could be read: the rest needs JavaScript, which web_fetch does not run.";
  if (source === "json-ld" || source === "next-data" || source === "nuxt-data")
    return quality === "success"
      ? "This page needs JavaScript; its text was read from the data it embeds, so layout and some parts may be missing."
      : "This page needs JavaScript; only a little text could be read from the data it embeds.";
  return undefined;
}
