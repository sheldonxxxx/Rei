import {
  BrowserActionError,
  type BrowserDriver,
  type BrowserScroll,
  type BrowserSnapshot,
  type BrowserUploadFile,
  type BrowserUploadTarget,
  type BrowserWait,
  type DriverEvent,
  type ElementInfo,
  type PageInfo,
  type PointerInput,
  type ScreenshotLabel,
  type SlowTyping,
  type Viewport,
} from "../../src/browser/driver.ts";
import { startSignedIn, type TestServer, type TestServerOptions } from "./server.ts";

// A browser that is a table of pages: what the control plane does with a browser, without one.

export interface FakePage {
  title?: string;
  /** What browser_snapshot shows. */
  snapshot?: string;
  /** The facts about the elements, by ref. */
  elements?: Record<string, ElementInfo>;
  /** A click on a ref goes to this URL. */
  links?: Record<string, string>;
  /** What an annotated screenshot labels. */
  labels?: ScreenshotLabel[];
}

/** A real 16x16 grey JPEG, as a browser's screenshot: images are decoded before a model sees them, so a stub would not pass. */
export const SCREENSHOT_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/wAALCAAQABABAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AIA//9k=";

export const el = (role: string, name: string, extra: Partial<ElementInfo> = {}): ElementInfo => ({
  role,
  name,
  type: null,
  autocomplete: null,
  editable: false,
  ...extra,
});

interface Win {
  id: string;
  generation: number;
  url: string;
  title: string;
  history: string[];
  dialogMode: "auto" | "ask";
  guard: ((url: URL) => boolean) | null;
  frame: ((jpeg: Uint8Array) => void) | undefined;
  stopped: number;
}

export class FakeBrowser implements BrowserDriver {
  pages = new Map<string, FakePage>();
  wins = new Map<string, Win>();
  /** Every call, as "name key detail". */
  calls: string[] = [];
  inputs = new Map<string, PointerInput[]>();
  selected: string[][] = [];
  uploads: BrowserUploadFile[] = [];
  dialogs: { key: string; accept: boolean; text?: string }[] = [];
  viewportSize: Viewport = { width: 1000, height: 700 };
  /** While set, openWindow waits for it. */
  openGate: Promise<void> | undefined;
  /** What elementAt answers. */
  at: { role: string; name: string } | null = { role: "button", name: "Pay now" };
  focusedFieldValue: { role: string; name: string } | null = { role: "textbox", name: "Card number" };
  readonly #listeners = new Set<(e: DriverEvent) => void>();

  page(url: string, page: FakePage): this {
    this.pages.set(url, page);
    return this;
  }
  onEvent(listener: (e: DriverEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(event: DriverEvent): void {
    for (const l of this.#listeners) l(event);
  }
  /** The window of `key` goes away as if the user or a crash closed it. */
  drop(key: string, reason: "closed" | "crashed" | "restarted" = "closed"): void {
    this.wins.delete(key);
    this.emit({ type: "closed", key, reason });
  }
  /** The whole browser restarted. */
  restart(): void {
    for (const key of [...this.wins.keys()]) this.drop(key, "restarted");
  }
  frame(key: string, bytes: Uint8Array): void {
    this.wins.get(key)?.frame?.(bytes);
  }
  count(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }

  #win(key: string): Win {
    const w = this.wins.get(key);
    if (!w) throw new Error("No page is open. Call browser_open first.");
    return w;
  }
  #load(win: Win, key: string, url: string): PageInfo {
    win.generation++;
    const page = this.pages.get(url);
    win.url = url;
    win.title =
      page?.title ??
      (url === "about:blank"
        ? ""
        : (() => {
            try {
              return new URL(url).hostname;
            } catch {
              return url;
            }
          })());
    this.emit({ type: "page", key, url, title: win.title });
    return { url, title: win.title };
  }

  async openWindow(key: string, url?: string): Promise<PageInfo> {
    this.calls.push(`openWindow ${key}`);
    await this.openGate;
    const win: Win = {
      id: crypto.randomUUID(),
      generation: 0,
      url: "about:blank",
      title: "",
      history: [],
      dialogMode: "auto",
      guard: null,
      frame: undefined,
      stopped: 0,
    };
    this.wins.set(key, win);
    return url ? this.goto(key, url) : { url: win.url, title: win.title };
  }
  async release(): Promise<void> {
    this.calls.push("release");
  }
  async closeWindow(key: string): Promise<void> {
    this.calls.push(`closeWindow ${key}`);
    this.wins.delete(key);
  }
  hasWindow(key: string): boolean {
    return this.wins.has(key);
  }
  async pageInfo(key: string): Promise<PageInfo> {
    const w = this.#win(key);
    return { url: w.url, title: w.title };
  }
  async viewport(key: string): Promise<Viewport> {
    this.#win(key);
    return this.viewportSize;
  }

  async goto(key: string, url: string): Promise<PageInfo> {
    this.calls.push(`goto ${key} ${url}`);
    const w = this.#win(key);
    if (w.guard && !w.guard(new URL(url))) {
      this.emit({ type: "blocked", key, host: new URL(url).hostname });
      throw new Error("That navigation was blocked.");
    }
    if (w.url !== "about:blank") w.history.push(w.url);
    return this.#load(w, key, url);
  }
  async snapshot(key: string): Promise<BrowserSnapshot> {
    const w = this.#win(key);
    this.calls.push(`snapshot ${key}`);
    return {
      raw: this.pages.get(w.url)?.snapshot ?? `- heading "${w.title}" [ref=e1]`,
      generation: w.generation,
      prefixes: new Map([["", `p${w.generation}`]]),
    };
  }
  async wait(key: string, condition: BrowserWait, timeoutMs: number): Promise<boolean> {
    this.#win(key);
    this.calls.push(`wait ${key} ${condition.target} ${condition.value} ${condition.gone} ${timeoutMs}`);
    return true;
  }
  #native(w: Win, ref: string): string {
    const prefix = `p${w.generation}e`;
    if (!ref.startsWith(prefix)) throw new BrowserActionError({ reason: "earlier-page" }, w.url);
    return ref.slice(prefix.length - 1);
  }
  async describe(key: string, ref: string | null): Promise<ElementInfo | null> {
    const w = this.#win(key);
    if (ref === null) return null;
    const native = this.#native(w, ref);
    return this.pages.get(w.url)?.elements?.[native] ?? null;
  }
  async uploadTarget(key: string, ref: string): Promise<BrowserUploadTarget> {
    const win = this.#win(key);
    const field = await this.describe(key, ref);
    if (!field || (field.type !== "file" && field.role !== "button")) throw new Error("No upload control.");
    return {
      windowId: win.id,
      pageUrl: win.url,
      frameUrl: field.frameUrl ?? win.url,
      kind: field.type === "file" ? "input" : "chooser",
    };
  }
  async upload(
    key: string,
    ref: string,
    target: BrowserUploadTarget,
    file: BrowserUploadFile,
    assertAuthorized: () => void,
  ): Promise<void> {
    if (JSON.stringify(await this.uploadTarget(key, ref)) !== JSON.stringify(target))
      throw new Error("The upload destination changed.");
    assertAuthorized();
    this.uploads.push(file);
  }
  async click(key: string, ref: string): Promise<void> {
    this.calls.push(`click ${key} ${ref}`);
    const w = this.#win(key);
    const native = this.#native(w, ref);
    const to = this.pages.get(w.url)?.links?.[native];
    if (to) {
      w.history.push(w.url);
      this.#load(w, key, to);
    }
  }
  async type(key: string, ref: string, text: string, submit: boolean, slowly?: SlowTyping): Promise<void> {
    this.#native(this.#win(key), ref);
    this.calls.push(`type ${key} ${ref} ${text.length} ${submit}${slowly ? " slowly" : ""}`);
  }
  async select(key: string, ref: string, values: string[]): Promise<void> {
    this.#native(this.#win(key), ref);
    this.calls.push(`select ${key} ${ref} ${values.join(",")}`);
  }
  async scroll(key: string, scroll: BrowserScroll): Promise<void> {
    const win = this.#win(key);
    if ("ref" in scroll) this.#native(win, scroll.ref);
    this.calls.push(`scroll ${key} ${"ref" in scroll ? scroll.ref : `${scroll.direction} ${scroll.pages}`}`);
  }
  async hover(key: string, ref: string): Promise<void> {
    this.#native(this.#win(key), ref);
    this.calls.push(`hover ${key} ${ref}`);
  }
  async check(key: string, ref: string, checked: boolean): Promise<boolean> {
    this.#native(this.#win(key), ref);
    this.calls.push(`check ${key} ${ref} ${checked}`);
    return false;
  }
  async press(key: string, name: string): Promise<void> {
    this.#win(key);
    this.calls.push(`press ${key} ${name}`);
  }
  async back(key: string): Promise<boolean> {
    const w = this.#win(key);
    const prev = w.history.pop();
    if (prev === undefined) return false;
    this.#load(w, key, prev);
    return true;
  }
  async screenshot(
    key: string,
    options: { annotate?: boolean } = {},
  ): Promise<{ data: string; mimeType: "image/jpeg"; labels?: ScreenshotLabel[] }> {
    const w = this.#win(key);
    this.calls.push(`screenshot ${key}${options.annotate ? " annotate" : ""}`);
    const shot = { data: SCREENSHOT_JPEG, mimeType: "image/jpeg" as const };
    if (!options.annotate) return shot;
    const labels = (this.pages.get(w.url)?.labels ?? []).map((label) => ({
      ...label,
      ref: `p${w.generation}${label.ref}`,
    }));
    return { ...shot, labels };
  }
  setDialogMode(key: string, mode: "auto" | "ask"): void {
    const w = this.wins.get(key);
    if (w) w.dialogMode = mode;
    this.calls.push(`dialogMode ${key} ${mode}`);
  }
  setNavigationGuard(key: string, allow: ((url: URL) => boolean) | null): void {
    const w = this.wins.get(key);
    if (w) w.guard = allow;
  }

  async startScreencast(key: string, onFrame: (jpeg: Uint8Array) => void): Promise<() => Promise<void>> {
    const w = this.#win(key);
    this.calls.push(`startScreencast ${key}`);
    w.frame = onFrame;
    return async () => {
      w.frame = undefined;
      w.stopped++;
      this.calls.push(`stopScreencast ${key}`);
    };
  }
  async input(key: string, message: PointerInput): Promise<void> {
    this.#win(key);
    const list = this.inputs.get(key) ?? [];
    list.push(message);
    this.inputs.set(key, list);
  }
  async navigate(key: string, action: "back" | "forward" | "reload"): Promise<void> {
    this.calls.push(`navigate ${key} ${action}`);
  }
  async setSelectValues(key: string, values: string[]): Promise<void> {
    this.#win(key);
    this.selected.push(values);
  }
  async handleDialog(key: string, accept: boolean, text?: string): Promise<void> {
    this.dialogs.push({ key, accept, ...(text !== undefined ? { text } : {}) });
  }
  async elementAt(): Promise<{ role: string; name: string } | null> {
    return this.at;
  }
  async focusedField(): Promise<{ role: string; name: string } | null> {
    return this.focusedFieldValue;
  }
  async close(): Promise<void> {
    this.calls.push("close");
  }
}

export type BrowserServer = TestServer & { totpSecret: string; fake: FakeBrowser };

/** A signed-in faux server with the browser on, driven by a FakeBrowser. */
export async function startBrowserServer(
  options: TestServerOptions & { fake?: FakeBrowser } = {},
): Promise<BrowserServer> {
  const fake = options.fake ?? new FakeBrowser();
  const server = await startSignedIn({ ...options, browserDriver: fake });
  return Object.assign(server, { fake });
}
