// The browser windows of the sessions: who has one, the cap, which one gives way, who waits, what the page showed
// the agent between its calls, and whether the browser is "in use" (the egress proxy asks). The portable core: the
// driver (DevTools in production, a fake in tests) is the only thing that touches a browser.
import type { TaintLabel } from "@rei/protocol";
import type { ApprovalStore } from "../store/approvals.ts";
import type { AppStore } from "../store/store.ts";
import type { TakeoverStore } from "../store/takeovers.ts";
import type { Clock } from "../util/clock.ts";
import type { Logger } from "../util/log.ts";
import {
  BrowserActionError,
  type BrowserDriver,
  type BrowserSnapshot,
  type DriverEvent,
  type PageInfo,
} from "./driver.ts";
import { replacementRef, type SnapshotTarget, type SnapshotView, uniqueSnapshotTarget } from "./snapshot-view.ts";

export interface BrowserConfig {
  /** Windows open at once (default 3). */
  maxWindows: number;
  /** How long a call waits for a window to free up (default 120 s) before the busy error. */
  busyWaitMs: number;
  /** How often a waiting call looks again (a run that ended frees its window without telling anyone). */
  busyPollMs: number;
  /** How long a call that was already running waits for a takeover that began under it to end (default 15 min). */
  takeoverWaitMs: number;
  /** The browser counts as in use this long after a tool call or an input (default 60 s). */
  activityMs: number;
  /** The session's page (url, title) is pushed at most this often (default 1 s). */
  pageThrottleMs: number;
  /** A window nobody used for this long is closed (default 60 min); 0 keeps windows until something else closes them. */
  idleMs: number;
}
/** How often the service looks for idle windows. */
export const IDLE_CHECK_MS = 60_000;
export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  maxWindows: 3,
  busyWaitMs: 120_000,
  busyPollMs: 1_000,
  takeoverWaitMs: 15 * 60_000,
  activityMs: 60_000,
  pageThrottleMs: 1_000,
  idleMs: 60 * 60_000,
};

/** An error whose message is meant for the model as it stands. */
export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserError";
  }
}

interface Win {
  url: string;
  title: string;
  /** Hosts this session opened with browser_open (or was allowed to): a private session's navigation stays inside them. */
  hosts: Set<string>;
  inflight: number;
  /** When the window was last used or last busy (see `sweep`). */
  lastUsed: number;
  lastEmit: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** What the page did since the agent's last call (a dialog, a blocked navigation), told with the next result. */
  notes: string[];
}

const BROWSER_CONNECTOR = "browser";
const BROWSER_OPEN = "open";
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const bareHost = (host: string): string => host.replace(/^www\./, "");

export class BrowserService {
  readonly driver: BrowserDriver;
  readonly config: BrowserConfig;
  readonly #store: AppStore;
  readonly #approvals: ApprovalStore;
  readonly #takeovers: TakeoverStore;
  readonly #clock: Clock;
  readonly #log: Logger;
  /** In least-recently-used order: the first entry gives way first. */
  readonly #wins = new Map<string, Win>();
  readonly #waiters = new Set<() => void>();
  readonly #listeners = new Set<(event: DriverEvent) => void>();
  readonly #lost = new Map<string, string>();
  readonly #snapshots = new Map<string, { view: SnapshotView; text: string }>();
  /** What the agent last saw of the page (kept through a takeover, so the next diff shows what the user did). */
  readonly #baselines = new Map<string, BrowserSnapshot>();
  #lock: Promise<unknown> = Promise.resolve();
  #lastActivity = Number.NEGATIVE_INFINITY;
  #off: (() => void) | undefined;
  #sweeper: ReturnType<typeof setInterval> | undefined;
  /** Set by the takeover service: a window went away while the session had a takeover open. */
  onWindowClosed: ((sessionId: string, reason: string) => void) | undefined;
  /** Set by the takeover service: the page changed (for the takeover's record). */
  onPage: ((sessionId: string, page: PageInfo) => void) | undefined;
  /** Set by the host: someone is watching the session's window in the live view. */
  watched: ((sessionId: string) => boolean) | undefined;

  constructor(deps: {
    driver: BrowserDriver;
    store: AppStore;
    approvals: ApprovalStore;
    takeovers: TakeoverStore;
    clock: Clock;
    log: Logger;
    config?: Partial<BrowserConfig>;
  }) {
    this.driver = deps.driver;
    this.#store = deps.store;
    this.#approvals = deps.approvals;
    this.#takeovers = deps.takeovers;
    this.#clock = deps.clock;
    this.#log = deps.log;
    this.config = { ...DEFAULT_BROWSER_CONFIG, ...deps.config };
    this.#off = this.driver.onEvent((event) => this.#onDriverEvent(event));
  }

  /** The state the PWA starts from after a restart: no window survives it, so no session shows one (a takeover still waiting keeps its card). */
  start(): void {
    for (const id of this.#store.sessionsWithBrowser())
      if (!this.#takeovers.openFor(id)) this.#store.setBrowser(id, null);
  }

  async stop(): Promise<void> {
    this.#off?.();
    this.#stopSweeper();
    for (const win of this.#wins.values()) if (win.timer) clearTimeout(win.timer);
    this.#wins.clear();
    await this.driver.close().catch(() => undefined);
    this.#wake();
  }

  // ---- events --------------------------------------------------------------------------------------------------------

  /** Every driver event, for the live view; `key` is the session id. */
  onEvent(listener: (event: DriverEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #onDriverEvent(event: DriverEvent): void {
    const win = this.#wins.get(event.key);
    switch (event.type) {
      case "page":
        if (win) {
          win.url = event.url;
          win.title = event.title;
          this.#pushPage(event.key, win);
          this.onPage?.(event.key, { url: event.url, title: event.title });
        }
        break;
      case "closed":
        if (win) {
          if (win.timer) clearTimeout(win.timer);
          this.#wins.delete(event.key);
          this.#snapshots.delete(event.key);
          this.#baselines.delete(event.key);
          this.#lost.set(
            event.key,
            event.reason === "restarted"
              ? "The browser restarted, so the page is gone. Open it again with browser_open."
              : "The browser window was closed. Open the page again with browser_open.",
          );
          // "restarted": the driver already let go of the connection. Otherwise this may have been the last window.
          if (event.reason !== "restarted") this.#releaseIfEmpty();
          if (!this.#takeovers.openFor(event.key)) this.#store.setBrowser(event.key, null);
          // Reason "restarted": a takeover still waiting survives it (its window is opened again when you start it); an active one cannot.
          this.onWindowClosed?.(event.key, event.reason);
          this.#log.debug("browser.window_closed", { sessionId: event.key, reason: event.reason });
          this.#wake();
          if (this.#wins.size === 0) this.#stopSweeper();
        }
        break;
      case "dialog":
        if (win && event.handled)
          win.notes.push(
            `The page showed ${event.kind === "alert" ? "an alert" : `a ${event.kind} dialog`} "${clip(event.message, 200)}"; it was ${event.accepted ? "accepted" : "dismissed"}.`,
          );
        break;
      case "popup":
        if (win)
          win.notes.push(
            `The page tried to open a new window: ${clip(event.url, 200)}. It was closed. Open the address with browser_open if you need it.`,
          );
        break;
      case "blocked":
        if (win) win.notes.push(`Navigation to ${event.host} was blocked: open it with browser_open to ask.`);
        break;
      case "note":
        if (win) win.notes.push(event.text);
        break;
      default:
        break;
    }
    for (const listener of this.#listeners) listener(event);
  }

  /** Pushes the window's page to the session (at most once per throttle interval, the last value wins). */
  #pushPage(sessionId: string, win: Win, now = false): void {
    const send = () => {
      win.timer = undefined;
      win.lastEmit = this.#clock.now();
      this.#store.setBrowser(sessionId, { url: win.url, title: win.title });
    };
    if (win.timer) clearTimeout(win.timer);
    win.timer = undefined;
    const wait = win.lastEmit + this.config.pageThrottleMs - this.#clock.now();
    if (now || wait <= 0) return send();
    win.timer = setTimeout(send, wait);
    (win.timer as { unref?: () => void }).unref?.();
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------

  hasWindow(sessionId: string): boolean {
    return this.#wins.has(sessionId);
  }
  windowCount(): number {
    return this.#wins.size;
  }
  page(sessionId: string): PageInfo | undefined {
    const win = this.#wins.get(sessionId);
    return win ? { url: win.url, title: win.title } : undefined;
  }

  /** What to tell a call that finds no window: why it is gone, if the service knows. */
  noWindowMessage(sessionId: string): string {
    return this.#lost.get(sessionId) ?? "No page is open. Call browser_open first.";
  }

  takeNotes(sessionId: string): string[] {
    const win = this.#wins.get(sessionId);
    if (!win) return [];
    return win.notes.splice(0);
  }

  // ---- activity and "in use" ------------------------------------------------------------------------------------------

  /** A browser call or input happened: the browser is in use, and (with a session) that window was used. */
  markActivity(sessionId?: string): void {
    const now = this.#clock.now();
    this.#lastActivity = now;
    if (sessionId !== undefined) {
      const win = this.#wins.get(sessionId);
      if (win) win.lastUsed = now;
    }
  }

  /**
   * Whether the egress proxy may let the browser's connections through: some window's session has a run going or
   * a takeover active, or a browser call or user input happened lately. Idle windows' background traffic is refused.
   */
  inUse(): boolean {
    if (this.#wins.size === 0) return false;
    if (this.#clock.now() - this.#lastActivity < this.config.activityMs) return true;
    for (const sessionId of this.#wins.keys()) {
      if (this.#takeovers.openFor(sessionId)?.status === "active") return true;
      if (this.#store.nonTerminalRuns(sessionId).some((r) => r.status === "running")) return true;
    }
    return false;
  }

  // ---- windows -------------------------------------------------------------------------------------------------------

  #evictable(sessionId: string): boolean {
    const win = this.#wins.get(sessionId);
    if (!win || win.inflight > 0) return false;
    if (this.#takeovers.openFor(sessionId)) return false;
    return !this.#store.nonTerminalRuns(sessionId).some((r) => r.status === "running");
  }

  async #closeWindow(sessionId: string, reason: string): Promise<void> {
    const win = this.#wins.get(sessionId);
    if (!win) return;
    if (win.timer) clearTimeout(win.timer);
    this.#wins.delete(sessionId);
    this.#snapshots.delete(sessionId);
    this.#baselines.delete(sessionId);
    this.#store.setBrowser(sessionId, this.#takeovers.openFor(sessionId) ? { url: win.url, title: win.title } : null);
    await this.driver
      .closeWindow(sessionId)
      .catch((error) =>
        this.#log.warn("browser.close_failed", { sessionId, error: error instanceof Error ? error.name : "error" }),
      );
    this.#log.debug("browser.window_closed", { sessionId, reason });
    if (reason === "idle") this.#lost.set(sessionId, this.#idleMessage());
    else if (reason === "evicted")
      this.#lost.set(
        sessionId,
        "The browser window was given to another session, so the page is gone. Open it again with browser_open.",
      );
    // An eviction is followed by the window it made room for, so the connection stays.
    if (reason !== "evicted") this.#releaseIfEmpty();
    this.#wake();
  }

  #idleMessage(): string {
    const minutes = Math.max(1, Math.round(this.config.idleMs / 60_000));
    const span =
      minutes % 60 === 0
        ? minutes === 60
          ? "an hour"
          : `${minutes / 60} hours`
        : minutes === 1
          ? "a minute"
          : `${minutes} minutes`;
    return `The browser window was closed after ${span} without use, so the page is gone. Open it again with browser_open.`;
  }

  /** The last window is gone: stop sweeping and let go of the browser, so its container can stop Chromium. */
  #releaseIfEmpty(): void {
    if (this.#wins.size > 0) return;
    this.#stopSweeper();
    void this.driver
      .release()
      .catch((error) =>
        this.#log.warn("browser.release_failed", { error: error instanceof Error ? error.name : "error" }),
      );
  }

  #startSweeper(): void {
    if (this.#sweeper || this.config.idleMs <= 0) return;
    this.#sweeper = setInterval(() => void this.sweep(), IDLE_CHECK_MS);
    (this.#sweeper as { unref?: () => void }).unref?.();
  }
  #stopSweeper(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }

  #busy(sessionId: string, win: Win): boolean {
    return (
      win.inflight > 0 ||
      this.#takeovers.openFor(sessionId) !== undefined ||
      this.#store.nonTerminalRuns(sessionId).some((r) => r.status === "running") ||
      this.watched?.(sessionId) === true
    );
  }

  /**
   * One cleanup check (every IDLE_CHECK_MS; public for tests): windows that are busy count as used now, and windows
   * unused for `idleMs` are closed, under the same lock as window creation and eviction.
   */
  async sweep(): Promise<void> {
    if (this.config.idleMs <= 0) return;
    const now = this.#clock.now();
    for (const [id, win] of this.#wins) if (this.#busy(id, win)) win.lastUsed = now;
    const due = [...this.#wins].filter(([, win]) => now - win.lastUsed >= this.config.idleMs).map(([id]) => id);
    for (const id of due) {
      await this.#serial(async () => {
        const win = this.#wins.get(id);
        if (!win || !this.#evictable(id)) return;
        if (this.watched?.(id) === true) return;
        if (this.#clock.now() - win.lastUsed < this.config.idleMs) return;
        await this.#closeWindow(id, "idle");
        this.#log.info("browser.window_idle_closed", { sessionId: id });
      });
    }
  }

  /**
   * The session's window, opened when it has none: under the cap, or in place of the least recently used window whose
   * session has no run going and no takeover open. When none can give way the call waits, then fails as busy.
   */
  async acquire(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.waitForControl(sessionId, signal);
    const have = this.#wins.get(sessionId);
    this.markActivity(sessionId);
    if (have) {
      this.#touch(sessionId, have);
      return;
    }
    const deadline = Date.now() + this.config.busyWaitMs;
    for (;;) {
      const made = await this.#serial(async () => {
        if (this.#wins.has(sessionId)) return true;
        if (this.#wins.size >= this.config.maxWindows) {
          const victim = [...this.#wins.keys()].find((id) => id !== sessionId && this.#evictable(id));
          if (victim === undefined) return false;
          await this.#closeWindow(victim, "evicted");
          this.#log.info("browser.window_evicted", { sessionId: victim, for: sessionId });
        }
        const page = await this.driver.openWindow(sessionId);
        const win: Win = {
          url: page.url,
          title: page.title,
          hosts: new Set(),
          inflight: 0,
          lastUsed: this.#clock.now(),
          lastEmit: Number.NEGATIVE_INFINITY,
          timer: undefined,
          notes: [],
        };
        this.#wins.set(sessionId, win);
        this.#lost.delete(sessionId);
        this.#startSweeper();
        this.driver.setDialogMode(sessionId, "auto");
        this.driver.setNavigationGuard(sessionId, (url) => this.#allowNavigation(sessionId, url));
        this.#log.debug("browser.window_opened", { sessionId, windows: this.#wins.size });
        return true;
      });
      if (made) return;
      if (signal?.aborted) throw new BrowserError("The call was cancelled.");
      if (Date.now() >= deadline)
        throw new BrowserError(`The browser is busy (${this.config.maxWindows} chats are using it); try again later.`);
      await this.#sleepOrWake(Math.min(this.config.busyPollMs, Math.max(1, deadline - Date.now())), signal);
    }
  }

  #touch(sessionId: string, win: Win): void {
    this.#wins.delete(sessionId);
    this.#wins.set(sessionId, win);
  }

  /** Window creation and eviction one at a time, so two calls cannot both take the last slot. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(fn, fn);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.#serial(() => this.#closeWindow(sessionId, "session_deleted"));
    this.#store.setBrowser(sessionId, null);
    this.#lost.delete(sessionId);
  }

  // ---- waiting -------------------------------------------------------------------------------------------------------

  #wake(): void {
    for (const resolve of [...this.#waiters]) resolve();
  }
  /** Something a waiting call cares about changed (a takeover ended, a window closed). */
  wake(): void {
    this.#wake();
  }
  #sleepOrWake(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * While you are in control of the session's window a browser call waits here (up to 15 minutes). A call made during a
   * takeover never gets this far: it parks on the takeover signal, holding nothing. This waits out a takeover that began
   * after the call passed that gate.
   */
  async waitForControl(sessionId: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.config.takeoverWaitMs;
    while (this.#takeovers.openFor(sessionId)?.status === "active") {
      if (signal?.aborted) throw new BrowserError("The call was cancelled.");
      if (Date.now() >= deadline)
        throw new BrowserError(
          "The user is still in control of the browser. Wait for them to finish, or tell them you are waiting.",
        );
      await this.#sleepOrWake(Math.min(1_000, deadline - Date.now()), signal);
    }
  }

  /** Runs one driver operation on the session's existing window. */
  async run<T>(sessionId: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    await this.waitForControl(sessionId, signal);
    const win = this.#wins.get(sessionId);
    if (!win) throw new BrowserError(this.noWindowMessage(sessionId));
    this.markActivity(sessionId);
    this.#touch(sessionId, win);
    win.inflight++;
    try {
      return await fn();
    } finally {
      win.inflight--;
      void this.syncPage(sessionId);
    }
  }

  async runWithRef<T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    ref: string,
    step: (ref: string) => Promise<T>,
  ): Promise<{ result: T; replacement?: SnapshotTarget & { ref: string; pageUrl: string } }> {
    return this.run(sessionId, signal, async () => {
      const before = this.baseline(sessionId);
      try {
        return { result: await step(ref) };
      } catch (error) {
        if (!(error instanceof BrowserActionError) || error.failure.reason !== "stale" || !before) throw error;
        const target = uniqueSnapshotTarget(before, ref);
        if (!target) throw error;
        const after = await this.driver.snapshot(sessionId).catch(() => undefined);
        if (!after || after.generation !== before.generation) throw error;
        const replacement = replacementRef(after, target, ref);
        if (!replacement) throw error;
        if (signal?.aborted) throw new BrowserError("The call was cancelled.");
        const result = await step(replacement);
        this.setBaseline(sessionId, after);
        return { result, replacement: { ...target, ref: replacement, pageUrl: error.pageUrl } };
      }
    });
  }

  /** Reads the window's page and pushes it to the session at once. */
  async syncPage(sessionId: string): Promise<PageInfo | undefined> {
    const win = this.#wins.get(sessionId);
    if (!win) return undefined;
    try {
      const page = await this.driver.pageInfo(sessionId);
      if (this.#wins.get(sessionId) !== win) return undefined;
      win.url = page.url;
      win.title = page.title;
      this.#pushPage(sessionId, win, true);
      return page;
    } catch {
      return undefined;
    }
  }

  // ---- what a page may open, and what the agent has read --------------------------------------------------------------

  allowHost(sessionId: string, host: string): void {
    this.#wins.get(sessionId)?.hosts.add(host.toLowerCase());
  }

  /** A private session's navigations stay inside the sites it opened with browser_open or was granted; others go anywhere. */
  #allowNavigation(sessionId: string, url: URL): boolean {
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;
    const row = this.#store.getSessionRow(sessionId);
    if (!row) return false;
    if (!(JSON.parse(row.taint) as TaintLabel[]).includes("private")) return true;
    const host = url.hostname.toLowerCase();
    const win = this.#wins.get(sessionId);
    if (win && [...win.hosts].some((h) => bareHost(h) === bareHost(host))) return true;
    return (
      this.#approvals.findGrant({
        connector: BROWSER_CONNECTOR,
        operation: BROWSER_OPEN,
        destination: host,
        sessionId,
        agentId: row.agent_id,
      }) !== undefined
    );
  }

  /** The rendered text of the latest look, and which view it is, for paging. */
  setSnapshot(sessionId: string, view: SnapshotView, text: string): void {
    this.#snapshots.set(sessionId, { view, text });
    if (this.#snapshots.size > 20) this.#snapshots.delete(this.#snapshots.keys().next().value!);
  }
  cachedSnapshot(sessionId: string): { view: SnapshotView; text: string } | undefined {
    return this.#snapshots.get(sessionId);
  }
  setBaseline(sessionId: string, baseline: BrowserSnapshot): void {
    this.#baselines.set(sessionId, baseline);
    if (this.#baselines.size > 20) this.#baselines.delete(this.#baselines.keys().next().value!);
  }
  baseline(sessionId: string): BrowserSnapshot | undefined {
    return this.#baselines.get(sessionId);
  }

  // ---- takeover -------------------------------------------------------------------------------------------------------

  /** You are in control (true) or not (false): dialogs go to you and the private-session guard stands down. */
  setControl(sessionId: string, control: boolean): void {
    if (!this.#wins.has(sessionId)) return;
    this.driver.setDialogMode(sessionId, control ? "ask" : "auto");
    this.driver.setNavigationGuard(sessionId, control ? null : (url) => this.#allowNavigation(sessionId, url));
    this.#snapshots.delete(sessionId); // the page may look different when the agent next looks
  }

  /** Opens a window for a pending takeover whose window is gone, at the page it was on. */
  async reopen(sessionId: string, url: string | null): Promise<void> {
    await this.acquire(sessionId);
    if (url && /^https?:/i.test(url)) {
      const host = new URL(url).hostname;
      this.allowHost(sessionId, host);
      await this.driver.goto(sessionId, url).catch(() => undefined);
    }
    await this.syncPage(sessionId);
  }
}
