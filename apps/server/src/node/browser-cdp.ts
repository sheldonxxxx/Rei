// The browser driver on Chromium's DevTools protocol, through playwright-core. One connection to the one browser
// container; each session's window is a top-level window made with Target.createTarget (one Page per window, never
// minimized, a keeper window so the browser never quits). Nothing here decides policy: it does what the service asks,
// bounded by guards so a hung page cannot hold a tool call forever.
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { stripVTControlCharacters } from "node:util";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Dialog,
  type ElementHandle,
  errors,
  type FileChooser,
  type Frame,
  type Page,
} from "playwright-core";
import type {
  ActionFailure,
  BrowserDriver,
  BrowserScroll,
  BrowserSnapshot,
  BrowserUploadFile,
  BrowserUploadTarget,
  BrowserWait,
  DialogKind,
  DriverEvent,
  ElementInfo,
  PageInfo,
  PointerInput,
  ScreenshotLabel,
  SelectOption,
  SlowTyping,
  Viewport,
} from "../browser/driver.ts";
import { BrowserActionError, SLOW_TYPE_LIMIT } from "../browser/driver.ts";
import { InputMapper } from "../browser/input.ts";
import { ACTIONABLE, nativeSnapshotRefs, snapshotRef } from "../browser/snapshot-view.ts";
import { classifyError, type Logger } from "../util/log.ts";
import { installOpenFilePicker, type OpenPickerWindow } from "./browser-open-picker.ts";
import { BrowserRefs } from "./browser-refs.ts";

export interface CdpDriverOptions {
  /** `http://browser:9223`: the DevTools HTTP endpoint (the hostname is resolved here; Chromium refuses other Host headers). */
  endpoint: string;
  log: Logger;
  /** The size every window is given (the container's screen). */
  window?: { width: number; height: number };
  /** No browser call waits longer than this (default 30 s). */
  guardMs?: number;
  /** How often a window's url and title are looked at (default 1.5 s). */
  pollMs?: number;
}

interface Win {
  key: string;
  page: Page;
  cdp: CDPSession;
  refs: BrowserRefs;
  targetId: string;
  windowId: number;
  mapper: InputMapper;
  dialogMode: "auto" | "ask";
  dialog: Dialog | undefined;
  /** Called when a dialog starts waiting for the user: a pending input event is blocked behind it, not lost. */
  onDialog: Set<() => void>;
  onFileChooser?: (chooser: FileChooser) => boolean;
  guard: ((url: URL) => boolean) | null;
  fetchOn: boolean;
  screencast:
    | {
        onFrame: (jpeg: Uint8Array) => void;
        viewport: Viewport | undefined;
        timer: NodeJS.Timeout | undefined;
        frames: number;
      }
    | undefined;
  url: string;
  title: string;
  /** We are closing it: its close event is not news. */
  closing: boolean;
}

const ACTION_MS = 10_000;
const NAV_MS = 20_000;
const NAV_START_MS = 500;
const SETTLE_LOAD_MS = 3_000;
const BACKOFF_MS = [300, 1_000, 2_000, 4_000, 8_000];

/** What is known about an element, run in the page (a string: the page's world has no DOM types here). */
const DESCRIBE = `(el) => {
  if (!el || el.nodeType !== 1) return null;
  const tag = el.tagName.toLowerCase();
  const clip = (s) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  const attr = (n) => el.getAttribute(n);
  const link = el.closest ? el.closest("a[href]") : null;
  const inputType = tag === "input" ? (attr("type") || "text").toLowerCase() : null;
  const buttonLike = ["button", "submit", "reset", "image"];
  const nonText = ["button", "submit", "reset", "image", "checkbox", "radio", "range", "color", "file", "hidden"];
  const implicit = () => {
    if (link && tag !== "input" && tag !== "button") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (buttonLike.includes(inputType)) return "button";
      if (inputType === "checkbox") return "checkbox";
      if (inputType === "radio") return "radio";
      if (inputType === "range") return "slider";
      if (inputType === "search") return "searchbox";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "img";
    return tag;
  };
  const labelled = () => {
    const ids = attr("aria-labelledby");
    if (!ids) return "";
    return ids.split(/\\s+/).map((id) => { const n = el.ownerDocument.getElementById(id); return n ? n.textContent : ""; }).join(" ");
  };
  const labels = el.labels && el.labels.length ? Array.from(el.labels).map((l) => l.textContent).join(" ") : "";
  const own = buttonLike.includes(inputType) ? el.value : "";
  const name = clip(attr("aria-label") || labelled() || labels || attr("alt") || own || attr("placeholder") || attr("title") || (tag === "input" || tag === "select" || tag === "textarea" ? "" : el.textContent) || (link ? link.textContent : ""));
  const editable = tag === "textarea" || (tag === "input" && !nonText.includes(inputType)) || !!el.isContentEditable;
  const ac = attr("autocomplete");
  return { role: attr("role") || implicit(), name, type: inputType, autocomplete: ac ? ac.toLowerCase() : null, editable };
}`;

/** The focused <select>, if any: its options as the picker shows them. */
const SELECT_STATE = `(() => {
  const el = document.activeElement;
  if (!el || el.tagName !== "SELECT") return null;
  return { multiple: !!el.multiple, options: Array.from(el.options).map((o) => ({ label: (o.label || o.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200), value: o.value, selected: o.selected })) };
})()`;

/** The page-side functions as real function objects (Playwright serializes them; a string would be an expression, not a call). */
const describeFn = new Function(`return ${DESCRIBE}`)() as (el: Node) => ElementInfo | null;
const describeTypingFn = new Function(`return (node) => {
  const doc = node.ownerDocument;
  let active = doc.hasFocus() ? doc.activeElement : null;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const describe = ${DESCRIBE};
  return { target: describe(node), focused: describe(active) };
}`)() as (el: Node) => { target: ElementInfo | null; focused: ElementInfo | null };

const SET_SELECT = `(values) => {
  const el = document.activeElement;
  if (!el || el.tagName !== "SELECT") return false;
  const want = new Set(values);
  let any = false;
  for (const o of Array.from(el.options)) { const on = want.has(o.value); if (!el.multiple && any) { o.selected = false; continue; } o.selected = on; if (on) any = true; }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

/** Most labels one annotated screenshot carries: more would hide the page under tags. */
const MAX_LABELS = 150;

/** One node of `ariaSnapshotJSON({ mode: "ai", boxes: true })`: what the labels need of it. */
interface AriaNode {
  role?: string;
  name?: string;
  ref?: string;
  cursor?: string;
  box?: { x: number; y: number; width: number; height: number };
  children?: unknown;
}

/** The elements in the viewport that can be acted on, in page order: a ref, a box that shows, and an actionable role or a pointer cursor. */
export function labelsOf(
  tree: unknown,
  viewport: Viewport,
  max = MAX_LABELS,
): { label: ScreenshotLabel; box: NonNullable<AriaNode["box"]> }[] {
  const out: { label: ScreenshotLabel; box: NonNullable<AriaNode["box"]> }[] = [];
  const walk = (node: unknown): void => {
    if (out.length >= max || !node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as AriaNode;
    const b = n.box;
    const shows =
      b &&
      b.width > 0 &&
      b.height > 0 &&
      b.x < viewport.width &&
      b.y < viewport.height &&
      b.x + b.width > 0 &&
      b.y + b.height > 0;
    if (n.ref && shows && ((n.role !== undefined && ACTIONABLE.has(n.role)) || n.cursor === "pointer"))
      out.push({ label: { ref: n.ref, role: n.role ?? "", name: n.name ?? "" }, box: b });
    walk(n.children);
  };
  walk(tree);
  return out;
}

/**
 * Draws the labels in the page, run in the page (a string, like DESCRIBE). The host is a fixed, click-through layer over
 * the whole viewport with a closed shadow root: the user's live view may show the labels for a moment, and page scripts
 * cannot easily read or poke them. It is found again by a one-off attribute, so the page has no fixed name to look for.
 */
const OVERLAY = `(arg) => {
  const host = document.createElement("div");
  host.setAttribute(arg.attr, "");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;background:none";
  const root = host.attachShadow({ mode: "closed" });
  const w = window.innerWidth, h = window.innerHeight;
  for (const item of arg.items) {
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;box-sizing:border-box;outline:2px solid #e11d48;outline-offset:-1px;left:" + item.x + "px;top:" + item.y + "px;width:" + item.width + "px;height:" + item.height + "px";
    const tag = document.createElement("div");
    tag.textContent = item.ref;
    tag.style.cssText = "position:absolute;left:0;top:0;padding:0 3px;font:bold 11px/14px monospace;color:#fff;background:#e11d48;white-space:nowrap";
    box.appendChild(tag);
    root.appendChild(box);
  }
  document.documentElement.appendChild(host);
  // A tag sits just above its element's corner so it hides none of it; it moves inside where there is no room above.
  // Keep every tag inside the viewport (an element that starts above or left of it has its corner out of sight).
  const kids = root.children;
  for (let i = 0; i < kids.length; i++) {
    const it = arg.items[i], tag = kids[i].firstChild;
    const tw = tag.offsetWidth, th = tag.offsetHeight;
    tag.style.left = Math.max(0, Math.min(w - tw, it.x)) - it.x + "px";
    tag.style.top = Math.max(0, Math.min(h - th, it.y - th >= 0 ? it.y - th : it.y)) - it.y + "px";
  }
}`;
const UNOVERLAY = `(attr) => { document.querySelectorAll("[" + attr + "]").forEach((n) => n.remove()); }`;

const first = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e))
    .split("\n")[0]!
    .replace(/^[A-Za-z]+\.[A-Za-z]+: /, "")
    .trim()
    .slice(0, 240);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Playwright logs a short node preview, possibly followed by a preview of its containing subtree. */
function coveringElement(preview: string): string {
  const node = /^<([\w:-]+)\b((?:"[^"]*"|[^">])*)>([^<]*)/.exec(preview);
  if (!node) return "<element>";
  const [, tag, attrs = "", content = ""] = node;
  const id = /(?:^|\s)id="([^"]*)"/.exec(attrs)?.[1]?.trim().slice(0, 80);
  const classes = /(?:^|\s)class="([^"]*)"/.exec(attrs)?.[1]?.trim().split(/\s+/).filter(Boolean).slice(0, 2) ?? [];
  const label = content.replace(/\s+/g, " ").trim().slice(0, 60);
  return `<${tag}${id ? `#${id}` : ""}${classes.map((c) => `.${c.slice(0, 48)}`).join("")}${label ? ` "${label}"` : ""}>`;
}

const ACTION_REASONS = [
  [/^element is not visible$/i, "hidden"],
  [/^(?:element|option being selected) is (?:not enabled|disabled)$/i, "disabled"],
  [/^element is not editable$/i, "read-only"],
  [/^element is not stable$/i, "moving"],
  [/^element is outside of the viewport$/i, "off-screen"],
  [/^element (?:(?:was|is) detached from|is not attached to) the DOM\b/i, "stale"],
] as const;

function actionFailure(error: unknown): ActionFailure | undefined {
  const message = error instanceof Error ? error.message : String(error);
  for (const line of stripVTControlCharacters(message).split("\n").reverse()) {
    const detail = line.trim().replace(/^(?:\d+ × )?-\s*/, "");
    const blockedBy = /^(.+) intercepts pointer events$/.exec(detail)?.[1];
    if (blockedBy) return { reason: "covered", coveringElement: coveringElement(blockedBy) };
    if (detail === "did not find some options") return { reason: "options-not-found", labels: [] };
    const reason = ACTION_REASONS.find(([pattern]) => pattern.test(detail))?.[1];
    if (reason) return { reason };
  }
  const headline = first(error);
  if (/Element is not an <input>, <textarea>(?:, <select>)? or \[contenteditable\]/i.test(headline))
    return { reason: "not-fillable" };
  if (/Not a checkbox or radio button/i.test(headline)) return { reason: "not-checkable" };
  if (/Cannot uncheck radio button/i.test(headline)) return { reason: "radio-uncheck" };
  if (
    /not found|resolved to 0|no node|Unable to adopt|element (?:(?:was|is) detached from|is not attached to) the DOM/i.test(
      headline,
    )
  )
    return { reason: "stale" };
  return undefined;
}

export class CdpBrowserDriver implements BrowserDriver {
  readonly #opts: Required<Pick<CdpDriverOptions, "guardMs" | "pollMs">> & CdpDriverOptions;
  readonly #listeners = new Set<(event: DriverEvent) => void>();
  readonly #wins = new Map<string, Win>();
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #bcdp: CDPSession | undefined;
  #keeper: Page | undefined;
  #connecting: Promise<void> | undefined;
  /** Window creation is one at a time (parallel Target.createTarget calls confuse the page matching). */
  #chain: Promise<unknown> = Promise.resolve();
  #poll: NodeJS.Timeout | undefined;
  #stopped = false;
  /** Set while `release` drops the connection on purpose, so `#lost` does not report it as a loss. */
  #releasing = false;

  constructor(opts: CdpDriverOptions) {
    this.#opts = { guardMs: 30_000, pollMs: 1_500, ...opts };
  }

  onEvent(listener: (event: DriverEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit(event: DriverEvent): void {
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch (error) {
        this.#opts.log.warn("browser.listener_failed", classifyError(error));
      }
    }
  }

  // ---- connection ------------------------------------------------------------------------------------------------

  async #endpoint(): Promise<string> {
    const url = new URL(this.#opts.endpoint);
    if (!net.isIP(url.hostname) && url.hostname !== "localhost") {
      const { address } = await dns.lookup(url.hostname, { family: 4 });
      url.hostname = address;
    }
    return url.origin;
  }

  #ensure(): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("The browser is shutting down."));
    if (this.#browser?.isConnected()) return Promise.resolve();
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connect(): Promise<void> {
    let lastError: unknown;
    for (const wait of [0, ...BACKOFF_MS]) {
      if (wait) await sleep(wait);
      try {
        const browser = await chromium.connectOverCDP(await this.#endpoint(), { timeout: 10_000 });
        const context = browser.contexts()[0];
        if (!context) throw new Error("the browser has no default context");
        const bcdp = await browser.newBrowserCDPSession();
        await bcdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);
        browser.on("disconnected", () => this.#lost(browser));
        this.#browser = browser;
        this.#context = context;
        this.#bcdp = bcdp;
        await context.addInitScript(installOpenFilePicker);
        await this.#adopt(context, bcdp);
        this.#startPolling();
        this.#opts.log.info("browser.connected", {});
        return;
      } catch (error) {
        lastError = error;
        this.#browser?.close().catch(() => undefined);
        this.#browser = undefined;
      }
    }
    throw new Error(`The browser is not reachable (${first(lastError)}).`);
  }

  /** Windows that were open before this connection are not ours: close them all but one, which stays so the browser never quits. */
  async #adopt(context: BrowserContext, bcdp: CDPSession): Promise<void> {
    const pages = await this.#profilePages(context, bcdp);
    this.#keeper = pages[0];
    for (const page of pages.slice(1)) await page.close().catch(() => undefined);
    if (!this.#keeper) {
      const { targetId } = (await bcdp.send("Target.createTarget", { url: "about:blank", newWindow: true })) as {
        targetId: string;
      };
      const page = await this.#pageFor(context, targetId, []);
      this.#keeper = page?.page;
    }
  }

  /** The browser went away (restart, crash, network): every window is gone. */
  #lost(browser: Browser): void {
    if (this.#browser !== browser) return;
    this.#browser = this.#context = this.#bcdp = this.#keeper = undefined;
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = undefined;
    const keys = [...this.#wins.keys()];
    for (const win of this.#wins.values()) this.#stopScreencast(win);
    this.#wins.clear();
    if (this.#releasing) {
      this.#opts.log.info("browser.released", {});
      return;
    }
    this.#opts.log.warn("browser.disconnected", { windows: keys.length });
    for (const key of keys) this.#emit({ type: "closed", key, reason: "restarted" });
  }

  /**
   * The profile's own pages. Playwright files pages of contexts it did not make (a render's disposable context, ADR
   * 0017) under the default context, so those are told apart by their browser context and left alone.
   */
  async #profilePages(context: BrowserContext, bcdp: CDPSession): Promise<Page[]> {
    const listed = (await bcdp.send("Target.getBrowserContexts").catch(() => undefined)) as
      | { browserContextIds?: string[] }
      | undefined;
    const others = new Set(listed?.browserContextIds ?? []);
    if (others.size === 0) return context.pages();
    const pages: Page[] = [];
    for (const page of context.pages()) {
      const cdp = await context.newCDPSession(page).catch(() => undefined);
      const info = (await cdp?.send("Target.getTargetInfo").catch(() => undefined)) as
        | { targetInfo: { browserContextId?: string } }
        | undefined;
      await cdp?.detach().catch(() => undefined);
      if (!others.has(info?.targetInfo.browserContextId ?? "")) pages.push(page);
    }
    return pages;
  }

  async #pageFor(
    context: BrowserContext,
    targetId: string,
    seen: Page[],
  ): Promise<{ page: Page; cdp: CDPSession } | undefined> {
    const deadline = Date.now() + 15_000;
    const tried = new Set<Page>();
    while (Date.now() < deadline) {
      for (const page of new Set([...seen, ...context.pages()])) {
        if (tried.has(page)) continue;
        const cdp = await context.newCDPSession(page).catch(() => undefined);
        if (!cdp) continue;
        const info = (await cdp.send("Target.getTargetInfo").catch(() => undefined)) as
          | { targetInfo: { targetId: string } }
          | undefined;
        if (info?.targetInfo.targetId === targetId) return { page, cdp };
        tried.add(page);
        await cdp.detach().catch(() => undefined);
      }
      await sleep(100);
    }
    return undefined;
  }

  #startPolling(): void {
    this.#poll ??= setInterval(() => {
      for (const win of this.#wins.values()) void this.#look(win);
    }, this.#opts.pollMs);
    this.#poll.unref?.();
  }

  /** Reports a changed url or title (a title changes without any navigation). */
  async #look(win: Win): Promise<void> {
    if (win.closing || win.page.isClosed()) return;
    try {
      const title = await Promise.race([win.page.title(), sleep(2_000).then(() => win.title)]);
      const url = win.page.url();
      if (url !== win.url || title !== win.title) {
        win.url = url;
        win.title = title;
        this.#emit({ type: "page", key: win.key, url, title });
      }
    } catch {
      // closed under us: its close event reports it
    }
  }

  // ---- guards ------------------------------------------------------------------------------------------------------

  /** Runs `fn` for at most the guard time; a call that hangs leaves its promise dangling and the caller gets an error. */
  async #guard<T>(what: string, fn: () => Promise<T>, ms = this.#opts.guardMs): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const p = fn();
    p.catch(() => undefined);
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`The browser did not answer (${what}). Try again, or open the page again with browser_open.`),
              ),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A short, model-fit message for a failed page action. */
  #fail(what: string, error: unknown): Error {
    const text = first(error);
    if (
      /Timeout \d+ms exceeded|waiting for/i.test(
        (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "",
      )
    ) {
      return new Error(
        `Could not ${what}: the element was not found or not usable. The page may have changed; call browser_snapshot for fresh refs.`,
      );
    }
    return new Error(`Could not ${what}: ${text}`);
  }

  #win(key: string): Win {
    const win = this.#wins.get(key);
    if (!win || win.closing || win.page.isClosed()) throw new Error("No page is open. Call browser_open first.");
    return win;
  }

  #action<T>(win: Win, what: string, ref: string, act: (el: ElementHandle<Node>) => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.#opts.guardMs;
    return this.#guard(what, async () => {
      const el = await win.refs.target(ref);
      const url = win.page.url();
      try {
        if (Date.now() >= deadline) throw new Error("The browser took too long to find the element.");
        return await act(el);
      } catch (error) {
        if (error instanceof BrowserActionError) throw error;
        const failure = actionFailure(error);
        if (!failure) throw error;
        if (failure.reason === "options-not-found") {
          failure.labels = await el
            .evaluate((node) =>
              Array.from((node as HTMLSelectElement).options)
                .slice(0, 20)
                .map((option) => option.label.replace(/\s+/g, " ").trim().slice(0, 120)),
            )
            .catch(() => []);
        }
        throw new BrowserActionError(failure, url);
      } finally {
        await el.dispose().catch(() => undefined);
      }
    }).catch((error: unknown) => {
      throw error instanceof BrowserActionError ? error : this.#fail(what, error);
    });
  }

  // ---- windows -----------------------------------------------------------------------------------------------------

  hasWindow(key: string): boolean {
    const win = this.#wins.get(key);
    return !!win && !win.closing && !win.page.isClosed();
  }

  openWindow(key: string, url?: string): Promise<PageInfo> {
    const run = async (): Promise<PageInfo> => {
      await this.#ensure();
      if (this.#wins.has(key)) await this.closeWindow(key);
      const context = this.#context!;
      const bcdp = this.#bcdp!;
      const seen: Page[] = [];
      const onPage = (p: Page) => seen.push(p);
      context.on("page", onPage);
      let targetId: string | undefined;
      try {
        ({ targetId } = (await bcdp.send("Target.createTarget", { url: "about:blank", newWindow: true })) as {
          targetId: string;
        });
        const found = await this.#pageFor(context, targetId, seen);
        if (!found) throw new Error("the window never appeared");
        const win = await this.#setup(key, found.page, found.cdp, targetId);
        this.#wins.set(key, win);
        if (url) await this.goto(key, url);
        return { url: win.page.url(), title: await win.page.title().catch(() => "") };
      } catch (error) {
        if (targetId) await bcdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
        this.#wins.delete(key);
        throw new Error(`Could not open a browser window: ${first(error)}`);
      } finally {
        context.off("page", onPage);
      }
    };
    const p = this.#chain.then(
      () => this.#guard("open window", run, this.#opts.guardMs),
      () => this.#guard("open window", run, this.#opts.guardMs),
    );
    this.#chain = p.catch(() => undefined);
    return p;
  }

  async #setup(key: string, page: Page, cdp: CDPSession, targetId: string): Promise<Win> {
    const size = this.#opts.window ?? { width: 1280, height: 900 };
    const bcdp = this.#bcdp!;
    const { windowId } = (await bcdp.send("Browser.getWindowForTarget", { targetId })) as { windowId: number };
    await bcdp
      .send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 0, top: 0, width: size.width, height: size.height, windowState: "normal" },
      })
      .catch(() => undefined);
    // Pages believe they are focused and visible even when another window is on top (a covered window must still work).
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
    page.setDefaultTimeout(ACTION_MS);
    page.setDefaultNavigationTimeout(NAV_MS);
    const refs = new BrowserRefs(page, cdp);
    await cdp.send("Page.enable");
    await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
    const win: Win = {
      key,
      page,
      cdp,
      refs,
      targetId,
      windowId,
      mapper: new InputMapper(),
      dialogMode: "auto",
      dialog: undefined,
      onDialog: new Set(),
      guard: null,
      fetchOn: false,
      screencast: undefined,
      url: page.url(),
      title: "",
      closing: false,
    };

    // A browser that dies closes its pages just before the connection drops. Wait a beat so that case is told apart:
    // #lost reports it as "restarted" (a waiting takeover survives that), and a window you closed is "closed".
    page.on("close", () => {
      if (win.closing || this.#wins.get(key) !== win) return;
      setTimeout(() => {
        if (win.closing || this.#wins.get(key) !== win) return;
        this.#wins.delete(key);
        this.#stopScreencast(win);
        this.#emit({ type: "closed", key, reason: "closed" });
      }, 300);
    });
    page.on("crash", () => {
      if (this.#wins.get(key) !== win) return;
      this.#wins.delete(key);
      win.closing = true;
      this.#stopScreencast(win);
      void this.#bcdp?.send("Target.closeTarget", { targetId }).catch(() => undefined);
      this.#emit({ type: "closed", key, reason: "crashed" });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) void this.#look(win);
    });
    page.on("load", () => void this.#look(win));
    page.on("dialog", (dialog) => void this.#onDialog(win, dialog));
    page.on("popup", (popup) => void this.#onPopup(win, popup));
    page.on("filechooser", (chooser) => {
      if (win.onFileChooser?.(chooser)) return;
      this.#emit({
        type: "note",
        key,
        text: "The page asked for a file. Use browser_upload with the file input or upload button ref.",
      });
      void chooser
        .element()
        .dispose()
        .catch(() => undefined);
    });
    page.on("download", (download) => {
      void download.cancel().catch(() => undefined);
      this.#emit({
        type: "note",
        key,
        text: `The page tried to download a file (${download.suggestedFilename().slice(0, 100)}); downloads are not allowed.`,
      });
    });
    cdp.on("Fetch.requestPaused", (e: { requestId: string; request: { url: string } }) => void this.#onPaused(win, e));
    return win;
  }

  async closeWindow(key: string): Promise<void> {
    const win = this.#wins.get(key);
    if (!win) return;
    win.closing = true;
    this.#wins.delete(key);
    this.#stopScreencast(win);
    if (win.dialog) await win.dialog.dismiss().catch(() => undefined);
    await this.#guard("close window", async () => {
      await this.#bcdp?.send("Target.closeTarget", { targetId: win.targetId }).catch(() => undefined);
    }).catch(() => undefined);
  }

  async pageInfo(key: string): Promise<PageInfo> {
    const win = this.#win(key);
    return {
      url: win.page.url(),
      title: await this.#guard("read title", () => win.page.title()).catch(() => win.title),
    };
  }

  async viewport(key: string): Promise<Viewport> {
    const win = this.#win(key);
    const [width, height] = await this.#guard(
      "read size",
      () => win.page.evaluate("[window.innerWidth, window.innerHeight]") as Promise<[number, number]>,
    );
    return { width, height };
  }

  // ---- dialogs and popups --------------------------------------------------------------------------------------------

  async #onDialog(win: Win, dialog: Dialog): Promise<void> {
    const kind = dialog.type() as DialogKind;
    const message = dialog.message();
    if (win.dialogMode === "auto") {
      const accepted = kind === "alert";
      await (accepted ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
      this.#emit({ type: "dialog", key: win.key, kind, message, defaultPrompt: null, handled: true, accepted });
      return;
    }
    win.dialog = dialog;
    for (const wake of win.onDialog) wake();
    this.#emit({
      type: "dialog",
      key: win.key,
      kind,
      message,
      defaultPrompt: kind === "prompt" ? dialog.defaultValue() : null,
      handled: false,
      accepted: false,
    });
  }

  setDialogMode(key: string, mode: "auto" | "ask"): void {
    const win = this.#wins.get(key);
    if (!win) return;
    win.dialogMode = mode;
    // Leaving a takeover with a dialog still open: answer it the way "auto" would.
    if (mode === "auto" && win.dialog) {
      const dialog = win.dialog;
      win.dialog = undefined;
      void (dialog.type() === "alert" ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    }
  }

  async handleDialog(key: string, accept: boolean, text?: string): Promise<void> {
    const win = this.#win(key);
    const dialog = win.dialog;
    if (!dialog) return;
    win.dialog = undefined;
    await this.#guard("answer dialog", () => (accept ? dialog.accept(text) : dialog.dismiss())).catch(() => undefined);
  }

  async #onPopup(win: Win, popup: Page): Promise<void> {
    await sleep(250);
    const url = popup.url();
    await popup.close().catch(() => undefined);
    this.#emit({ type: "popup", key: win.key, url: url === "about:blank" ? "" : url });
  }

  // ---- navigation guard ------------------------------------------------------------------------------------------------

  setNavigationGuard(key: string, allow: ((url: URL) => boolean) | null): void {
    const win = this.#wins.get(key);
    if (!win) return;
    win.guard = allow;
    const want = allow !== null;
    if (want === win.fetchOn) return;
    win.fetchOn = want;
    // Only documents (the page and its frames): subresources are the egress proxy's business.
    const call = want
      ? win.cdp.send("Fetch.enable", { patterns: [{ resourceType: "Document" }] })
      : win.cdp.send("Fetch.disable");
    call.catch((error) => {
      win.fetchOn = !want;
      this.#opts.log.warn("browser.guard_failed", classifyError(error));
    });
  }

  async #onPaused(win: Win, e: { requestId: string; request: { url: string } }): Promise<void> {
    let allowed = true;
    let host = "";
    try {
      const url = new URL(e.request.url);
      host = url.hostname;
      allowed = win.guard ? win.guard(url) : true;
    } catch {
      allowed = false;
    }
    try {
      if (allowed) await win.cdp.send("Fetch.continueRequest", { requestId: e.requestId });
      else {
        await win.cdp.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" });
        this.#emit({ type: "blocked", key: win.key, host });
      }
    } catch {
      // the request ended by itself
    }
  }

  // ---- what the agent does ----------------------------------------------------------------------------------------------

  async #afterPaint(win: Win): Promise<void> {
    await within(
      win.page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      ),
      NAV_START_MS,
    ).catch(() => undefined);
  }

  /** Watch before the action so we see even a navigation that Playwright waits for during the action. */
  async #settle<T>(win: Win, action: () => Promise<T>): Promise<T> {
    const tree = await within(win.cdp.send("Page.getFrameTree"), NAV_START_MS).catch(() => undefined);
    if (!tree) return action();
    const { id, loaderId } = tree.frameTree.frame;
    const started = Promise.withResolvers<"page" | "same">();
    const content = Promise.withResolvers<void>();
    const load = Promise.withResolvers<void>();
    let nextLoader: string | undefined;
    const onStart = (event: { frameId: string; loaderId: string; navigationType: string }) => {
      if (event.frameId !== id || /sameDocument/i.test(event.navigationType)) return;
      nextLoader = event.loaderId;
      started.resolve("page");
    };
    let mainFrameId = id;
    const onCommit = (event: { frame: { id: string; parentId?: string; loaderId: string } }) => {
      if (event.frame.parentId || event.frame.loaderId === loaderId) return;
      mainFrameId = event.frame.id;
      nextLoader = event.frame.loaderId;
      started.resolve("page");
    };
    const onSame = (event: { frameId: string }) => {
      if (event.frameId === mainFrameId) started.resolve("same");
    };
    const onLifecycle = (event: { frameId: string; loaderId: string; name: string }) => {
      if (event.frameId !== mainFrameId || event.loaderId !== nextLoader) return;
      if (event.name === "DOMContentLoaded" || event.name === "load") content.resolve();
      if (event.name === "load") load.resolve();
    };
    win.cdp.on("Page.frameStartedNavigating", onStart);
    win.cdp.on("Page.frameNavigated", onCommit);
    win.cdp.on("Page.navigatedWithinDocument", onSame);
    win.cdp.on("Page.lifecycleEvent", onLifecycle);
    try {
      const result = await action();
      const navigation = await within(started.promise, NAV_START_MS);
      if (navigation === "page") {
        await within(content.promise, NAV_MS);
        await within(load.promise, SETTLE_LOAD_MS);
      } else if (navigation === "same") {
        await this.#afterPaint(win);
      }
      return result;
    } finally {
      win.cdp.off("Page.frameStartedNavigating", onStart);
      win.cdp.off("Page.frameNavigated", onCommit);
      win.cdp.off("Page.navigatedWithinDocument", onSame);
      win.cdp.off("Page.lifecycleEvent", onLifecycle);
    }
  }

  async goto(key: string, url: string): Promise<PageInfo> {
    const win = this.#win(key);
    try {
      const go = () =>
        this.#guard(
          "navigate",
          () => win.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_MS }),
          NAV_MS + 5_000,
        );
      // A refused navigation's error page can commit just as the next one starts; once more settles it.
      await go().catch(async (error: unknown) => {
        if (!/interrupted by another navigation/i.test(first(error))) throw error;
        await sleep(300);
        await go();
      });
      await win.page.waitForLoadState("load", { timeout: 5_000 }).catch(() => undefined);
    } catch (error) {
      const text = first(error);
      if (/Download is starting/i.test(text)) throw new Error("That address is a file download, which is not allowed.");
      if (/ERR_BLOCKED_BY_CLIENT/.test(text)) throw new Error("That navigation was blocked.");
      if (/Timeout/i.test(text)) {
        // A slow page is still a page: report what is there.
      } else throw new Error(`Could not load ${url.slice(0, 200)}: ${text}`);
    }
    const info = { url: win.page.url(), title: await win.page.title().catch(() => "") };
    win.url = info.url;
    win.title = info.title;
    return info;
  }

  async snapshot(key: string): Promise<BrowserSnapshot> {
    const win = this.#win(key);
    return this.#guard("snapshot", () =>
      win.refs.capture(async (bind) => {
        const raw = await win.page.ariaSnapshot({ mode: "ai", timeout: 20_000 });
        return { raw, ...(await bind(nativeSnapshotRefs(raw))) };
      }),
    ).catch((e: unknown) => {
      throw this.#fail("read the page", e);
    });
  }

  async wait(key: string, condition: BrowserWait, timeoutMs: number): Promise<boolean> {
    const win = this.#win(key);
    return this.#guard("wait for the page", async () => {
      if (condition.target === "ref") {
        return (await within(this.#waitRef(win, condition, timeoutMs), timeoutMs)) ?? false;
      }
      try {
        if (condition.target === "url") {
          const match = condition.value.includes("*")
            ? condition.value
            : (url: URL) => url.href.includes(condition.value);
          await win.page.waitForURL(match, { waitUntil: "commit", timeout: timeoutMs });
        } else {
          await win.page
            .getByText(condition.value)
            .first()
            .waitFor({
              state: condition.gone ? "hidden" : "visible",
              timeout: timeoutMs,
            });
        }
      } catch (error) {
        if (error instanceof errors.TimeoutError) return false;
        throw error;
      }
      return true;
    });
  }

  async #waitRef(win: Win, condition: BrowserWait, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let seen = false;
    do {
      try {
        const el = await win.refs.target(condition.value);
        seen = true;
        try {
          const visible = await el.isVisible();
          if (condition.gone ? !visible : visible && (await el.isEnabled())) return true;
        } finally {
          await el.dispose().catch(() => undefined);
        }
      } catch (error) {
        if (!(error instanceof BrowserActionError)) throw error;
        if (error.failure.reason === "earlier-page" && seen && condition.gone) return true;
        if (error.failure.reason !== "stale") throw error;
        if (condition.gone) return true;
      }
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(left, 75));
    } while (Date.now() < deadline);
    return false;
  }

  /** Null: there is no such element. A browser that fails to answer rejects, and the caller then assumes the worst. */
  async describe(key: string, ref: string | null): Promise<ElementInfo | null> {
    const win = this.#win(key);
    if (ref === null)
      return this.#guard(
        "describe",
        () => win.page.evaluate(`(${DESCRIBE})(document.activeElement)`) as Promise<ElementInfo | null>,
        5_000,
      );
    return this.#guard(
      "describe",
      async () => {
        const el = await win.refs.target(ref).catch((error: unknown) => {
          if (error instanceof BrowserActionError && error.failure.reason === "stale") return null;
          throw error;
        });
        if (!el) return null;
        try {
          const info = await el.evaluate(describeFn);
          return info ? { ...info, frameUrl: (await el.ownerFrame())?.url() ?? null } : null;
        } finally {
          await el.dispose().catch(() => undefined);
        }
      },
      5_000,
    );
  }

  async click(key: string, ref: string): Promise<void> {
    const win = this.#win(key);
    await this.#settle(win, () => this.#action(win, "click that", ref, (el) => el.click({ timeout: ACTION_MS })));
  }

  async #uploadTarget(win: Win, el: ElementHandle<Node>) {
    const frame = await el.ownerFrame();
    if (!frame || !win.page.frames().includes(frame)) throw new Error("The upload control is no longer available.");
    const kind = await el.evaluate((node) => {
      if (!(node instanceof HTMLElement) || !node.isConnected || node.matches(":disabled")) return null;
      if (node instanceof HTMLInputElement && node.type === "file" && !node.webkitdirectory) return "input";
      if (
        node instanceof HTMLButtonElement ||
        node instanceof HTMLLabelElement ||
        node.getAttribute("role") === "button" ||
        (node instanceof HTMLInputElement && node.type === "button")
      )
        return "chooser";
      return null;
    });
    if (!kind) throw new Error("Choose an enabled file input or upload button from the latest snapshot.");
    const target: BrowserUploadTarget = {
      kind,
      windowId: win.targetId,
      pageUrl: win.page.url(),
      frameUrl: frame.url(),
    };
    return { frame, target };
  }

  uploadTarget(key: string, ref: string): Promise<BrowserUploadTarget> {
    const win = this.#win(key);
    return this.#action(
      win,
      "inspect the upload control",
      ref,
      async (el) => (await this.#uploadTarget(win, el)).target,
    );
  }

  async upload(
    key: string,
    ref: string,
    approved: BrowserUploadTarget,
    file: BrowserUploadFile,
    assertAuthorized: () => void,
  ): Promise<void> {
    const win = this.#win(key);
    let changed = false;
    let frame: Frame | undefined;
    const onNavigation = (navigated: Frame) => {
      if (!frame || navigated === frame || navigated === win.page.mainFrame()) changed = true;
    };
    win.page.on("framenavigated", onNavigation);
    try {
      await this.#action(win, "select the upload file", ref, async (el) => {
        const current = await this.#uploadTarget(win, el);
        frame = current.frame;
        const assertTarget = () => {
          if (
            changed ||
            this.#wins.get(key) !== win ||
            win.closing ||
            frame?.isDetached() ||
            approved.windowId !== win.targetId ||
            approved.kind !== current.target.kind ||
            approved.pageUrl !== win.page.url() ||
            approved.frameUrl !== frame?.url()
          )
            throw new Error("The upload destination changed. Take a new snapshot and request approval again.");
          assertAuthorized();
        };
        const payload = { name: file.name, mimeType: file.mediaType, buffer: Buffer.from(file.bytes) };
        assertTarget();
        if (approved.kind === "input") {
          await el.setInputFiles(payload, { timeout: ACTION_MS });
          return;
        }
        if (win.onFileChooser) throw new Error("An upload is already waiting for a file chooser.");
        const picker = await el.evaluateHandle(
          (_node, timeout) => (window as OpenPickerWindow).__reiArmOpenFilePicker?.(timeout),
          this.#opts.guardMs,
        );
        let chooser: FileChooser | undefined;
        let timer: number | NodeJS.Timeout | undefined;
        const waiting = new Promise<FileChooser | undefined>((resolve) => {
          win.onFileChooser = (opened) => {
            if (chooser) return false;
            chooser = opened;
            resolve(opened);
            return true;
          };
          timer = setTimeout(resolve, ACTION_MS);
        });
        try {
          assertTarget();
          await el.click({ timeout: ACTION_MS });
          const opened = await waiting;
          if (!opened) throw new Error("The button did not open a file chooser.");
          if ((await opened.element().ownerFrame()) !== frame)
            throw new Error("The file chooser opened in a different frame. Select an upload control in that frame.");
          assertTarget();
          await opened.setFiles(payload, { timeout: ACTION_MS });
          const pickerError = await picker.evaluate((selection) => selection?.finished());
          if (pickerError) throw new Error(pickerError);
        } finally {
          clearTimeout(timer);
          delete win.onFileChooser;
          await picker.evaluate((selection) => selection?.cancel()).catch(() => undefined);
          await picker.dispose().catch(() => undefined);
          await chooser
            ?.element()
            .dispose()
            .catch(() => undefined);
        }
      });
    } finally {
      win.page.off("framenavigated", onNavigation);
    }
  }

  async type(key: string, ref: string, text: string, submit: boolean, slowly?: SlowTyping): Promise<void> {
    const win = this.#win(key);
    if (slowly && [...text].length > SLOW_TYPE_LIMIT)
      throw new Error(`Slow typing is limited to ${SLOW_TYPE_LIMIT} characters.`);
    const type = () =>
      this.#action(win, "type there", ref, async (el) => {
        if (slowly) return this.#typeSlowly(win, el, text, submit, slowly);
        await el.fill(text, { timeout: ACTION_MS });
        if (submit) await el.press("Enter", { timeout: ACTION_MS });
      });
    await (submit ? this.#settle(win, type) : type());
  }

  async #typeSlowly(
    win: Win,
    el: ElementHandle<Node>,
    text: string,
    submit: boolean,
    slowly: SlowTyping,
  ): Promise<void> {
    const url = win.page.url();
    const cleared = await el
      .fill("", { timeout: ACTION_MS })
      .then(() => true)
      .catch((error: unknown) => {
        if (actionFailure(error)?.reason === "not-fillable") return false;
        throw error;
      });
    if (!cleared) await el.click({ timeout: ACTION_MS });
    // Clicking a custom field can focus another input. Check it before sending any text.
    const { target, focused } = await el.evaluate(describeTypingFn);
    if (!focused || focused.role === "iframe" || focused.role === "frame") {
      throw new BrowserActionError(
        {
          reason: "field-refused",
          message: "Focus moved to another frame. Take a new snapshot and use that field's ref.",
        },
        url,
      );
    }
    const refusal = (cleared && target ? slowly.refusalForField(target) : undefined) ?? slowly.refusalForField(focused);
    if (refusal) throw new BrowserActionError({ reason: "field-refused", message: refusal }, url);
    const options = { delay: 30 };
    // Locator.pressSequentially delegates to this same typing path. Keep the original handle pinned.
    if (cleared) {
      await el.type(text, { ...options, timeout: ACTION_MS + 8_000 });
      if (submit) await el.press("Enter", { timeout: ACTION_MS });
    } else {
      await win.page.keyboard.type(text, options);
      if (submit) await win.page.keyboard.press("Enter");
    }
  }

  async select(key: string, ref: string, values: string[]): Promise<void> {
    const win = this.#win(key);
    await this.#action(win, "select that", ref, (el) => el.selectOption(values, { timeout: ACTION_MS }));
  }

  async scroll(key: string, scroll: BrowserScroll): Promise<void> {
    const win = this.#win(key);
    if ("ref" in scroll) {
      await this.#action(win, "scroll to that", scroll.ref, (el) => el.scrollIntoViewIfNeeded({ timeout: ACTION_MS }));
    } else {
      await this.#guard("scroll", async () => {
        const { width, height } = await this.viewport(key);
        const dy = scroll.direction === "down" ? height : -height;
        for (let page = 0; page < scroll.pages; page++) {
          await this.#dispatch(win, { type: "wheel", x: width / 2, y: height / 2, dx: 0, dy });
        }
      });
    }
    await this.#afterPaint(win);
  }

  async hover(key: string, ref: string): Promise<void> {
    const win = this.#win(key);
    await this.#action(win, "hover over that", ref, (el) => el.hover({ timeout: ACTION_MS }));
  }

  async check(key: string, ref: string, checked: boolean): Promise<boolean> {
    const win = this.#win(key);
    return this.#action(win, checked ? "check that" : "uncheck that", ref, async (el) => {
      const info = await el.evaluate(describeFn);
      const role = info?.role.split(/\s+/)[0];
      if (!checked && (role === "radio" || info?.type === "radio"))
        throw new BrowserActionError({ reason: "radio-uncheck" }, win.page.url());
      if (role !== "checkbox" && role !== "radio" && role !== "switch")
        throw new BrowserActionError({ reason: "not-checkable" }, win.page.url());
      const already = (await el.isChecked()) === checked;
      if (!already) await el.setChecked(checked, { timeout: ACTION_MS });
      return already;
    });
  }

  async press(key: string, name: string): Promise<void> {
    const win = this.#win(key);
    const press = () => this.#guard("press", () => win.page.keyboard.press(name));
    await (/^(numpad)?enter$/i.test(name) ? this.#settle(win, press) : press()).catch((e: unknown) => {
      throw new Error(`Could not press ${name.slice(0, 40)}: ${first(e)}`);
    });
  }

  async back(key: string): Promise<boolean> {
    const win = this.#win(key);
    // The response is null for a data: page or a same-document step, so ask the history instead. The blank page the
    // window started on is not a page to go back to.
    const history = (await this.#guard("back", () => win.cdp.send("Page.getNavigationHistory"))) as {
      currentIndex: number;
      entries: { url: string }[];
    };
    if (history.currentIndex <= 0 || history.entries[history.currentIndex - 1]?.url === "about:blank") return false;
    await this.#guard(
      "back",
      () => win.page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_MS }),
      NAV_MS + 5_000,
    ).catch((e: unknown) => {
      if (!/Timeout/i.test(first(e))) throw new Error(`Could not go back: ${first(e)}`);
    });
    return true;
  }

  async screenshot(
    key: string,
    options: { annotate?: boolean } = {},
  ): Promise<{ data: string; mimeType: "image/jpeg"; labels?: ScreenshotLabel[] }> {
    const win = this.#win(key);
    if (options.annotate !== true) {
      const buffer = await this.#guard("screenshot", () =>
        win.page.screenshot({ type: "jpeg", quality: 70, timeout: 15_000 }),
      );
      return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
    }
    return this.#guard("screenshot", () =>
      win.refs.capture(async (bind) => {
        const attr = `data-${randomBytes(6).toString("hex")}`;
        let drawn = false;
        try {
          const tree = await win.page.ariaSnapshotJSON({ mode: "ai", boxes: true, timeout: 20_000 });
          const [width, height] = (await win.page.evaluate("[window.innerWidth, window.innerHeight]")) as [
            number,
            number,
          ];
          const found = labelsOf(tree, { width, height });
          const scope = await bind(found.map(({ label }) => label.ref));
          const tagged = found.flatMap(({ label, box }) => {
            const ref = snapshotRef(scope, label.ref);
            return ref ? [{ label: { ...label, ref }, box }] : [];
          });
          if (tagged.length > 0) {
            drawn = true;
            await win.page.evaluate(
              `(${OVERLAY})(${JSON.stringify({ attr, items: tagged.map((f) => ({ ref: f.label.ref, ...f.box })) })})`,
            );
          }
          const buffer = await win.page.screenshot({ type: "jpeg", quality: 70, timeout: 15_000 });
          return {
            data: buffer.toString("base64"),
            mimeType: "image/jpeg" as const,
            labels: tagged.map((f) => f.label),
          };
        } finally {
          // Even a failed shot must not leave the layer on the user's page.
          if (drawn) await win.page.evaluate(`(${UNOVERLAY})(${JSON.stringify(attr)})`).catch(() => undefined);
        }
      }),
    );
  }

  // ---- live view and takeover --------------------------------------------------------------------------------------------

  async startScreencast(key: string, onFrame: (jpeg: Uint8Array) => void): Promise<() => Promise<void>> {
    const win = this.#win(key);
    if (win.screencast) this.#stopScreencast(win);
    const state = {
      onFrame,
      viewport: undefined as Viewport | undefined,
      timer: undefined as NodeJS.Timeout | undefined,
      frames: 0,
    };
    win.screencast = state;
    win.cdp.on(
      "Page.screencastFrame",
      (e: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }) => {
        if (win.screencast !== state) return;
        state.frames++;
        void win.cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => undefined);
        this.#noteViewport(win, state);
        state.onFrame(Buffer.from(e.data, "base64"));
      },
    );
    await this.#guard("start screencast", () =>
      win.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 1,
      }),
    );
    // An idle page sends no frame: give a new viewer one anyway.
    state.timer = setTimeout(() => {
      if (win.screencast !== state || state.frames > 0) return;
      void win.page.screenshot({ type: "jpeg", quality: 60, timeout: 5_000 }).then(
        (b) => win.screencast === state && state.onFrame(b),
        () => undefined,
      );
    }, 500);
    return async () => {
      if (win.screencast === state) {
        this.#stopScreencast(win);
        await win.cdp.send("Page.stopScreencast").catch(() => undefined);
      }
    };
  }

  /** The page area can change (the browser's own UI, a resize); tell the service when it did. */
  #noteViewport(win: Win, state: NonNullable<Win["screencast"]>): void {
    void win.page.evaluate("[window.innerWidth, window.innerHeight]").then(
      (v) => {
        const [width, height] = v as [number, number];
        if (win.screencast !== state || (state.viewport?.width === width && state.viewport.height === height)) return;
        if (state.viewport) this.#emit({ type: "viewport", key: win.key, width, height });
        state.viewport = { width, height };
      },
      () => undefined,
    );
  }

  #stopScreencast(win: Win): void {
    if (win.screencast?.timer) clearTimeout(win.screencast.timer);
    win.screencast = undefined;
  }

  async input(key: string, message: PointerInput): Promise<void> {
    const win = this.#win(key);
    // A key or click that opens an alert is not acknowledged by the page until the dialog is answered, and the answer
    // comes through this same path: return as soon as a dialog is waiting.
    let wake: (() => void) | undefined;
    const dialogUp = new Promise<void>((resolve) => {
      wake = resolve;
      win.onDialog.add(resolve);
    });
    const sent = this.#dispatch(win, message);
    sent.catch(() => undefined);
    try {
      await this.#guard("input", () => Promise.race([sent, dialogUp]));
    } finally {
      if (wake) win.onDialog.delete(wake);
    }
  }

  async #dispatch(win: Win, message: PointerInput): Promise<void> {
    switch (message.type) {
      case "mouse":
        await win.cdp.send("Input.dispatchMouseEvent", win.mapper.mouse(message));
        if (message.action === "up") await this.#offerSelect(win);
        break;
      case "wheel":
        await win.cdp.send("Input.dispatchMouseEvent", win.mapper.wheel(message));
        break;
      case "key":
        await win.cdp.send("Input.dispatchKeyEvent", win.mapper.key(message));
        break;
      case "text":
        await win.cdp.send("Input.insertText", { text: message.text });
        break;
    }
  }

  /** After a click: a <select> now has focus, so the PWA shows its own picker (the native one is not in the screencast). */
  async #offerSelect(win: Win): Promise<void> {
    const state = (await win.page.evaluate(SELECT_STATE).catch(() => null)) as {
      multiple: boolean;
      options: SelectOption[];
    } | null;
    if (!state) return;
    // Close the native popup that opened, so it does not eat the next click.
    await win.cdp
      .send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      })
      .catch(() => undefined);
    await win.cdp
      .send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      })
      .catch(() => undefined);
    this.#emit({ type: "select", key: win.key, options: state.options, multiple: state.multiple });
  }

  async setSelectValues(key: string, values: string[]): Promise<void> {
    const win = this.#win(key);
    await this.#guard("select", () => win.page.evaluate(`(${SET_SELECT})(${JSON.stringify(values.slice(0, 200))})`));
  }

  async navigate(key: string, action: "back" | "forward" | "reload"): Promise<void> {
    const win = this.#win(key);
    const opts = { waitUntil: "domcontentloaded" as const, timeout: NAV_MS };
    await this.#guard(
      "navigate",
      async () => {
        if (action === "back") await win.page.goBack(opts);
        else if (action === "forward") await win.page.goForward(opts);
        else await win.page.reload(opts);
      },
      NAV_MS + 5_000,
    ).catch(() => undefined);
  }

  async elementAt(key: string, x: number, y: number): Promise<{ role: string; name: string } | null> {
    const win = this.#win(key);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const info = (await win.page
      .evaluate(`(${DESCRIBE})(document.elementFromPoint(${Math.round(x)}, ${Math.round(y)}))`)
      .catch(() => null)) as ElementInfo | null;
    return info ? { role: info.role, name: info.name } : null;
  }

  async focusedField(key: string): Promise<{ role: string; name: string } | null> {
    const info = await this.describe(key, null);
    return info && info.editable ? { role: info.role, name: info.name } : null;
  }

  /** With no windows open, drops the connection (Chromium keeps running; the container stops it when no client is left). */
  release(): Promise<void> {
    const run = async (): Promise<void> => {
      await this.#connecting?.catch(() => undefined);
      const browser = this.#browser;
      if (!browser || this.#wins.size > 0) return;
      this.#releasing = true;
      try {
        await browser.close().catch(() => undefined);
        this.#lost(browser); // in case "disconnected" has not fired yet; a no-op once it has
      } finally {
        this.#releasing = false;
      }
    };
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = undefined;
    for (const win of this.#wins.values()) {
      win.closing = true;
      this.#stopScreencast(win);
    }
    this.#wins.clear();
    const browser = this.#browser;
    this.#browser = undefined;
    // Disconnects without closing Chromium itself: connectOverCDP's close() only drops the connection.
    await browser?.close().catch(() => undefined);
  }
}
