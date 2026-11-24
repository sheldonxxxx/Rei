// The live view of a session's window, the portable half: who watches, the one screencast shared by all of a
// window's viewers, what is sent to them, and what their input does. The socket itself (ws, auth, Origin) is the Node
// glue in src/node/browser-live.ts; here a viewer is anything that can send text and frames.
//
// Anyone signed in may watch. Input is honoured only while this session's takeover is active, and is otherwise dropped.
import type { LiveClientMessage, LiveServerMessage, MouseButton } from "@rei/protocol";
import type { BrowserDriver, DriverEvent, SelectOption } from "./driver.ts";
import type { BrowserService } from "./service.ts";
import type { TakeoverService } from "./takeover-service.ts";

export interface LiveConnection {
  sendText(text: string): void;
  sendFrame(frame: Uint8Array): void;
  /** Bytes queued to the client and not yet sent; a frame is skipped while this is high. */
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}
export interface LiveViewer {
  /** A text message from the client. */
  message(text: string): void;
  /** The socket closed. */
  closed(): void;
}

/** A frame is dropped for a viewer whose queue is longer than this (a slow client skips frames, newest wins). */
export const FRAME_BACKLOG_BYTES = 512 * 1024;
const MAX_TEXT = 10_000;
const MAX_URL = 2_000;
/** Per window: whether the last Backspace press became "back" (so its release is not forwarded to the page). */
const backspaces = new Map<string, Promise<boolean>>();

const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const BUTTONS: readonly string[] = ["left", "middle", "right"];

/** The client's message if it is well formed, else undefined. Everything is bounded: the socket is not trusted with sizes. */
export function parseClientMessage(text: string): LiveClientMessage | undefined {
  if (text.length > MAX_TEXT + 1_000) return undefined;
  let m: any;
  try {
    m = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof m !== "object" || m === null || typeof m.type !== "string") return undefined;
  switch (m.type) {
    case "mouse":
      if (
        (m.action === "down" || m.action === "up" || m.action === "move") &&
        finite(m.x, -1, 100_000) &&
        finite(m.y, -1, 100_000) &&
        BUTTONS.includes(m.button) &&
        finite(m.clickCount, 0, 5)
      ) {
        return {
          type: "mouse",
          action: m.action,
          x: m.x,
          y: m.y,
          button: m.button as MouseButton,
          clickCount: Math.trunc(m.clickCount),
        };
      }
      return undefined;
    case "wheel":
      return finite(m.x, -1, 100_000) &&
        finite(m.y, -1, 100_000) &&
        finite(m.dx, -100_000, 100_000) &&
        finite(m.dy, -100_000, 100_000)
        ? { type: "wheel", x: m.x, y: m.y, dx: m.dx, dy: m.dy }
        : undefined;
    case "key":
      if (
        (m.action === "down" || m.action === "up") &&
        typeof m.key === "string" &&
        m.key.length >= 1 &&
        m.key.length <= 40 &&
        typeof m.code === "string" &&
        m.code.length <= 40 &&
        finite(m.modifiers, 0, 15)
      ) {
        if (m.text !== undefined && (typeof m.text !== "string" || m.text.length > 8)) return undefined;
        return {
          type: "key",
          action: m.action,
          key: m.key,
          code: m.code,
          ...(m.text !== undefined ? { text: m.text } : {}),
          modifiers: Math.trunc(m.modifiers),
        };
      }
      return undefined;
    case "text":
      return typeof m.text === "string" && m.text.length >= 1 && m.text.length <= MAX_TEXT
        ? { type: "text", text: m.text }
        : undefined;
    case "select":
      return Array.isArray(m.values) &&
        m.values.length <= 200 &&
        m.values.every((v: unknown) => typeof v === "string" && v.length <= 1_000)
        ? { type: "select", values: m.values }
        : undefined;
    case "dialog":
      return typeof m.accept === "boolean" &&
        (m.text === undefined || (typeof m.text === "string" && m.text.length <= MAX_TEXT))
        ? { type: "dialog", accept: m.accept, ...(m.text !== undefined ? { text: m.text } : {}) }
        : undefined;
    case "nav":
      return m.action === "back" || m.action === "forward" || m.action === "reload"
        ? { type: "nav", action: m.action }
        : undefined;
    case "goto":
      return typeof m.url === "string" && m.url.length >= 1 && m.url.length <= MAX_URL
        ? { type: "goto", url: m.url }
        : undefined;
    default:
      return undefined;
  }
}

/** The address you typed as an http(s) URL: a bare host gets https://. Undefined for anything else (no javascript:, file:, ...). */
export function gotoUrl(text: string): string | undefined {
  const t = text.trim();
  const candidates = /^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/\s]+:\d+(\/|$)/.test(t) ? [t] : [`https://${t}`];
  for (const c of candidates) {
    try {
      const u = new URL(c);
      if (
        (u.protocol === "http:" || u.protocol === "https:") &&
        u.hostname !== "" &&
        u.username === "" &&
        u.password === ""
      )
        return u.href;
    } catch {
      // not a URL
    }
  }
  return undefined;
}

interface Feed {
  viewers: Set<Viewer>;
  frame: Uint8Array | undefined;
  stop: (() => Promise<void>) | undefined;
  starting: Promise<void> | undefined;
  select: SelectOption[];
}

class Viewer {
  readonly conn: LiveConnection;
  constructor(conn: LiveConnection) {
    this.conn = conn;
  }
  send(message: LiveServerMessage): void {
    try {
      this.conn.sendText(JSON.stringify(message));
    } catch {
      // the socket is going away; its close handler cleans up
    }
  }
}

export class LiveHub {
  readonly #driver: BrowserDriver;
  readonly #browser: BrowserService;
  readonly #takeovers: TakeoverService;
  readonly #feeds = new Map<string, Feed>();

  constructor(deps: { driver: BrowserDriver; browser: BrowserService; takeovers: TakeoverService }) {
    this.#driver = deps.driver;
    this.#browser = deps.browser;
    this.#takeovers = deps.takeovers;
    deps.browser.onEvent((event) => this.#onEvent(event));
    deps.takeovers.onControl((sessionId, control) => this.#broadcast(sessionId, { type: "control", control }));
  }

  /** Viewers watching a session now (tests). */
  viewerCount(sessionId: string): number {
    return this.#feeds.get(sessionId)?.viewers.size ?? 0;
  }

  /**
   * A new viewer: `hello` first (the real page-area viewport), then frames. Returns undefined, after telling the
   * client the window is not there, when the session has no window.
   */
  async attach(sessionId: string, conn: LiveConnection): Promise<LiveViewer | undefined> {
    const viewer = new Viewer(conn);
    const page = this.#browser.page(sessionId);
    if (!page || !this.#driver.hasWindow(sessionId)) {
      viewer.send({ type: "closed", reason: "no_window" });
      conn.close(1000, "no window");
      return undefined;
    }
    let viewport;
    try {
      viewport = await this.#driver.viewport(sessionId);
    } catch {
      viewer.send({ type: "closed", reason: "no_window" });
      conn.close(1000, "no window");
      return undefined;
    }
    viewer.send({
      type: "hello",
      viewport,
      url: page.url,
      title: page.title,
      control: this.#takeovers.isActive(sessionId),
    });
    let feed = this.#feeds.get(sessionId);
    if (!feed) {
      feed = { viewers: new Set(), frame: undefined, stop: undefined, starting: undefined, select: [] };
      this.#feeds.set(sessionId, feed);
    }
    feed.viewers.add(viewer);
    if (feed.frame) viewer.conn.sendFrame(feed.frame);
    await this.#ensureScreencast(sessionId, feed);
    return {
      message: (text) => void this.#message(sessionId, feed!, text),
      closed: () => void this.#detach(sessionId, feed!, viewer),
    };
  }

  async #ensureScreencast(sessionId: string, feed: Feed): Promise<void> {
    if (feed.stop || feed.starting) return void (await feed.starting);
    feed.starting = (async () => {
      try {
        feed.stop = await this.#driver.startScreencast(sessionId, (frame) => {
          feed.frame = frame;
          for (const v of feed.viewers) if (v.conn.bufferedAmount() < FRAME_BACKLOG_BYTES) v.conn.sendFrame(frame);
        });
        // Every viewer left while it started.
        if (feed.viewers.size === 0) await this.#stopFeed(sessionId, feed);
      } catch {
        for (const v of feed.viewers) v.send({ type: "closed", reason: "screencast_failed" });
      } finally {
        feed.starting = undefined;
      }
    })();
    await feed.starting;
  }

  async #stopFeed(sessionId: string, feed: Feed): Promise<void> {
    const stop = feed.stop;
    feed.stop = undefined;
    if (this.#feeds.get(sessionId) === feed && feed.viewers.size === 0) this.#feeds.delete(sessionId);
    await stop?.().catch(() => undefined);
  }

  async #detach(sessionId: string, feed: Feed, viewer: Viewer): Promise<void> {
    feed.viewers.delete(viewer);
    if (feed.viewers.size === 0) await this.#stopFeed(sessionId, feed);
  }

  #broadcast(sessionId: string, message: LiveServerMessage): void {
    const feed = this.#feeds.get(sessionId);
    if (feed) for (const v of feed.viewers) v.send(message);
  }

  #onEvent(event: DriverEvent): void {
    const feed = this.#feeds.get(event.key);
    if (!feed) return;
    switch (event.type) {
      case "page":
        this.#broadcast(event.key, { type: "page", url: event.url, title: event.title });
        break;
      case "viewport":
        this.#broadcast(event.key, { type: "viewport", width: event.width, height: event.height });
        break;
      case "select":
        if (this.#takeovers.isActive(event.key)) {
          feed.select = event.options;
          this.#broadcast(event.key, { type: "select", options: event.options, multiple: event.multiple });
        }
        break;
      case "dialog":
        if (!event.handled && this.#takeovers.isActive(event.key))
          this.#broadcast(event.key, {
            type: "dialog",
            kind: event.kind,
            message: event.message,
            defaultPrompt: event.defaultPrompt,
          });
        break;
      case "closed": {
        this.#broadcast(event.key, { type: "closed", reason: event.reason });
        const viewers = [...feed.viewers];
        feed.viewers.clear();
        this.#feeds.delete(event.key);
        void feed.stop?.().catch(() => undefined);
        feed.stop = undefined;
        for (const v of viewers) v.conn.close(1000, "closed");
        break;
      }
      default:
        break;
    }
  }

  // ---- input -------------------------------------------------------------------------------------------------------

  async #message(sessionId: string, feed: Feed, text: string): Promise<void> {
    const message = parseClientMessage(text);
    if (!message) return;
    // Watching is for everyone; input is honoured only in this session's active takeover.
    if (!this.#takeovers.isActive(sessionId)) return;
    this.#takeovers.touchInput(sessionId);
    const key = sessionId;
    try {
      switch (message.type) {
        case "mouse":
          if (message.action === "down" && message.button === "left") {
            // Looked up as the click starts, so it names what was under the pointer, not what the click changed.
            const at = this.#driver.elementAt(key, message.x, message.y).catch(() => null);
            await this.#driver.input(key, message);
            this.#takeovers.act(sessionId, "click", {
              x: Math.round(message.x),
              y: Math.round(message.y),
              element: await at,
            });
            break;
          }
          await this.#driver.input(key, message);
          break;
        case "wheel":
          await this.#driver.input(key, message);
          break;
        case "key":
          // Backspace with nothing being edited is "back", as in a browser; in a field it deletes as usual.
          if (message.key === "Backspace" && !(message.modifiers & (1 | 2 | 4 | 8))) {
            if (message.action === "down") {
              const decision = this.#driver
                .focusedField(key)
                .catch(() => ({ role: "", name: "" }))
                .then((field) => field === null);
              backspaces.set(key, decision);
              if (await decision) {
                await this.#driver.navigate(key, "back");
                break;
              }
            } else if (await backspaces.get(key)) {
              backspaces.delete(key); // its press became "back"; the release goes nowhere
              break;
            }
          }
          // A key that types a character counts as one typed character (never its value); Enter and shortcuts do not.
          if (
            message.action === "down" &&
            message.text &&
            message.text !== "\r" &&
            message.text !== "\n" &&
            !(message.modifiers & (2 | 4))
          ) {
            this.#takeovers.typed(sessionId, 1, () => this.#driver.focusedField(key));
          }
          await this.#driver.input(key, message);
          break;
        case "text":
          this.#takeovers.typed(sessionId, [...message.text].length, () => this.#driver.focusedField(key));
          await this.#driver.input(key, message);
          break;
        case "select": {
          const labels = feed.select.filter((o) => message.values.includes(o.value)).map((o) => o.label);
          const field = await this.#driver.focusedField(key).catch(() => null);
          this.#takeovers.act(sessionId, "select", { field, labels });
          await this.#driver.setSelectValues(key, message.values);
          break;
        }
        case "dialog":
          await this.#driver.handleDialog(key, message.accept, message.text);
          break;
        case "nav":
          await this.#driver.navigate(key, message.action);
          break;
        case "goto": {
          const url = gotoUrl(message.url);
          if (url) await this.#driver.goto(key, url);
          break;
        }
      }
    } catch {
      // A failed input (the page closed under it) is not the client's problem; a closed window says so by itself.
    }
  }
}
