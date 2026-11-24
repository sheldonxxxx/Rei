// What the control plane needs from a browser. The Node adapter (src/node/browser-cdp.ts) implements it with
// playwright-core over the DevTools protocol; tests use a fake. One window per key (the key is the session id), each a
// window of the one Chromium with your profile.
import type { LiveClientMessage } from "@rei/protocol";

export type ActionFailure =
  | { reason: "covered"; coveringElement: string }
  | { reason: "options-not-found"; labels: string[] }
  | { reason: "field-refused"; message: string }
  | {
      reason:
        | "hidden"
        | "disabled"
        | "read-only"
        | "moving"
        | "off-screen"
        | "stale"
        | "earlier-page"
        | "not-checkable"
        | "radio-uncheck"
        | "not-fillable";
    };

/** A known action failure. The tool formats and fences its page-derived details. */
export class BrowserActionError extends Error {
  readonly failure: ActionFailure;
  readonly pageUrl: string;

  constructor(failure: ActionFailure, pageUrl: string) {
    super(failure.reason);
    this.name = "BrowserActionError";
    this.failure = failure;
    this.pageUrl = pageUrl;
  }
}

export interface Viewport {
  width: number;
  height: number;
}
export interface PageInfo {
  url: string;
  title: string;
}
export interface BrowserSnapshot {
  /** The accessibility tree before rewriting refs. */
  raw: string;
  /** Generation of the main frame's document, even if the tree is empty. */
  generation: number;
  /** Playwright prefix (empty or fN) to the prefix Rei exposes (pN or pNfN). */
  prefixes: ReadonlyMap<string, string>;
}
export interface BrowserWait {
  target: "text" | "url" | "ref";
  value: string;
  gone: boolean;
}
export type BrowserScroll = { ref: string } | { direction: "up" | "down"; pages: number };
export const SLOW_TYPE_LIMIT = 500;

/** Checks the actual focus after a slowly action clears or clicks the requested element. */
export interface SlowTyping {
  refusalForField: (element: ElementInfo) => string | undefined;
}
export interface SelectOption {
  label: string;
  value: string;
  selected: boolean;
}
/** One element an annotated screenshot outlines, by the ref the snapshot gives it. */
export interface ScreenshotLabel {
  ref: string;
  role: string;
  name: string;
}
export type DialogKind = "alert" | "confirm" | "prompt" | "beforeunload";

/** What the control plane needs to know about one element: to refuse a secret field, and to name it in a takeover record. */
export interface ElementInfo {
  /** ARIA role (or the tag when it has none). */
  role: string;
  /** Accessible name; falls back to the element's value or text. Clipped. */
  name: string;
  /** The input's type attribute, lower case. */
  type: string | null;
  autocomplete: string | null;
  /** URL of the frame that owns an element resolved by ref. */
  frameUrl?: string | null;
  /** A text-entry field (input other than button-like types, textarea, contenteditable). */
  editable: boolean;
}

export type DriverEvent =
  /** The window's page changed (navigation, title, or load finished). */
  | { type: "page"; key: string; url: string; title: string }
  /** The window is gone: the user or the page closed it, it crashed, or the whole browser restarted. */
  | { type: "closed"; key: string; reason: "closed" | "crashed" | "restarted" }
  /** A JS dialog. `handled`: the driver already answered it (mode "auto"); else it waits for `handleDialog`. */
  | {
      type: "dialog";
      key: string;
      kind: DialogKind;
      message: string;
      defaultPrompt: string | null;
      handled: boolean;
      accepted: boolean;
    }
  /** A <select> has focus (after a mouse up in a takeover). */
  | { type: "select"; key: string; options: SelectOption[]; multiple: boolean }
  /** The page tried to open another window; the driver closed it. */
  | { type: "popup"; key: string; url: string }
  /** Private-session guard refused a navigation. */
  | { type: "blocked"; key: string; host: string }
  | { type: "viewport"; key: string; width: number; height: number }
  /** Something the agent should know on its next call (a file chooser or a download the driver refused). */
  | { type: "note"; key: string; text: string };

export type PointerInput = Extract<LiveClientMessage, { type: "mouse" | "wheel" | "key" | "text" }>;

export interface BrowserUploadTarget {
  windowId: string;
  pageUrl: string;
  frameUrl: string;
  kind: "input" | "chooser";
}

export interface BrowserUploadFile {
  name: string;
  mediaType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface BrowserDriver {
  onEvent(listener: (event: DriverEvent) => void): () => void;

  // ---- windows --------------------------------------------------------------------------------------------------
  /** A new window (about:blank, or `url`). Resolves when it is ready. Replaces a window already open for the key. */
  openWindow(key: string, url?: string): Promise<PageInfo>;
  closeWindow(key: string): Promise<void>;
  hasWindow(key: string): boolean;
  pageInfo(key: string): Promise<PageInfo>;
  /** CSS pixels of the page area. */
  viewport(key: string): Promise<Viewport>;

  // ---- what the agent does --------------------------------------------------------------------------------------
  goto(key: string, url: string): Promise<PageInfo>;
  snapshot(key: string): Promise<BrowserSnapshot>;
  /** False when the condition still has not held by the timeout. */
  wait(key: string, condition: BrowserWait, timeoutMs: number): Promise<boolean>;
  /** The element behind a ref, or the focused one when `ref` is null; null when there is none. */
  describe(key: string, ref: string | null): Promise<ElementInfo | null>;
  uploadTarget(key: string, ref: string): Promise<BrowserUploadTarget>;
  upload(
    key: string,
    ref: string,
    target: BrowserUploadTarget,
    file: BrowserUploadFile,
    assertAuthorized: () => void,
  ): Promise<void>;
  click(key: string, ref: string): Promise<void>;
  type(key: string, ref: string, text: string, submit: boolean, slowly?: SlowTyping): Promise<void>;
  select(key: string, ref: string, values: string[]): Promise<void>;
  scroll(key: string, scroll: BrowserScroll): Promise<void>;
  hover(key: string, ref: string): Promise<void>;
  /** True if it was already in the requested state. */
  check(key: string, ref: string, checked: boolean): Promise<boolean>;
  press(key: string, name: string): Promise<void>;
  /** False when there was nothing to go back to. */
  back(key: string): Promise<boolean>;
  /** With `annotate`, what can be acted on in the viewport is outlined and tagged with its ref in the picture, and listed in `labels`. */
  screenshot(
    key: string,
    options?: { annotate?: boolean },
  ): Promise<{ data: string; mimeType: "image/jpeg"; labels?: ScreenshotLabel[] }>;
  /** "auto": accept alerts, dismiss the rest, tell the service. "ask": wait for `handleDialog` (a takeover). */
  setDialogMode(key: string, mode: "auto" | "ask"): void;
  /** Refuse navigations (documents and frames) for which this returns false; null: no guard. */
  setNavigationGuard(key: string, allow: ((url: URL) => boolean) | null): void;

  // ---- live view and takeover -----------------------------------------------------------------------------------
  /** JPEG frames of the window's page area; the returned function stops it. Frames are acknowledged by the driver. */
  startScreencast(key: string, onFrame: (jpeg: Uint8Array) => void): Promise<() => Promise<void>>;
  input(key: string, message: PointerInput): Promise<void>;
  navigate(key: string, action: "back" | "forward" | "reload"): Promise<void>;
  setSelectValues(key: string, values: string[]): Promise<void>;
  handleDialog(key: string, accept: boolean, text?: string): Promise<void>;
  /** The role and accessible name of what is at a point, and of the focused field, for the takeover record. */
  elementAt(key: string, x: number, y: number): Promise<{ role: string; name: string } | null>;
  focusedField(key: string): Promise<{ role: string; name: string } | null>;

  /** With no window open, drops the connection to the browser without closing it; the next `openWindow` connects again. */
  release(): Promise<void>;
  close(): Promise<void>;
}
