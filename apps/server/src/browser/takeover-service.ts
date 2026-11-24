// The host side of a takeover: the agent's request, your start, done and cancel, the 15 minute idle timeout, the
// 24 hour expiry, telling the agent how it went without a model turn, and the record of what you did (never what you
// typed). The rows and their messages are the TakeoverStore's; this is the behaviour around them.
import type { ConversationId } from "@earendil-works/pi-durable";
import type { BrowserStateResponse, Takeover } from "@rei/protocol";
import { TAKEOVER_NOTE_KIND } from "../conversation/ledger.ts";
import { createSignalTask, type SignalTask, TakeoverEnded } from "../pi/signals.ts";
import { context, type TreeManager } from "../pi/trees.ts";
import type { AppStore } from "../store/store.ts";
import {
  type ActKind,
  CANCEL_CLOSED,
  CANCEL_EXPIRED,
  CANCEL_TIMED_OUT,
  type TakeoverRow,
  type TakeoverStore,
} from "../store/takeovers.ts";
import type { Clock } from "../util/clock.ts";
import { HttpError, notFound } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import type { BrowserService } from "./service.ts";

export interface TakeoverConfig {
  /** How long an agent's request waits for you (default 24 h). */
  requestTtlMs: number;
  /** An active takeover with no input this long is cancelled (default 15 min). */
  idleMs: number;
}
export const DEFAULT_TAKEOVER_CONFIG: TakeoverConfig = { requestTtlMs: 24 * 3_600_000, idleMs: 15 * 60_000 };

/** The line the agent reads for an ended takeover that did not start a run. */
export function agentNote(row: Pick<TakeoverRow, "requested_by" | "status" | "note" | "reason">): string {
  const note = row.note ? `: ${row.note}` : "";
  if (row.requested_by === "user") {
    return `[Browser used by the user] The user used this chat's browser window${row.status === "cancelled" ? " and gave up control" : ""}${note}. The page may have changed: call browser_snapshot before relying on what you saw earlier.`;
  }
  if (row.note === CANCEL_EXPIRED)
    return `[Browser takeover expired] The user did not take over the browser in time, so what needed them was NOT done. Do not ask again unless the user does.`;
  if (row.note === CANCEL_TIMED_OUT)
    return `[Browser takeover timed out] The user stopped using the browser without finishing, so what needed them was NOT done. Do not ask again unless the user does.`;
  if (row.note === CANCEL_CLOSED)
    return `[Browser takeover ended] The browser window closed before the user finished, so what needed them was NOT done. Do not ask again unless the user does.`;
  return `[Browser takeover declined] The user did not take over the browser${note}, so what needed them was NOT done. Do not ask again unless the user does; say in one short sentence what you could not do.`;
}

export class TakeoverService {
  readonly #store: AppStore;
  readonly #takeovers: TakeoverStore;
  readonly #browser: BrowserService;
  readonly #trees: TreeManager;
  readonly #kick: (sessionId: string) => void;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #cfg: TakeoverConfig;
  #expiry: ReturnType<typeof setTimeout> | undefined;
  readonly #idle = new Map<string, ReturnType<typeof setTimeout>>();
  /** Typed characters since the last other act, by session: counts only. */
  readonly #typing = new Map<string, { chars: number; field: { role: string; name: string } | null }>();
  #notifying: Promise<unknown> = Promise.resolve();
  #stopped = false;
  readonly #control = new Set<(sessionId: string, control: boolean) => void>();
  readonly #signal: SignalTask;
  /** The browser calls parked on an active takeover, by takeover ID then task key: who to wake when it ends. */
  readonly #parked = new Map<string, Map<string, { treeId: string; taskId: string }>>();

  constructor(deps: {
    store: AppStore;
    takeovers: TakeoverStore;
    browser: BrowserService;
    trees: TreeManager;
    kick: (sessionId: string) => void;
    clock: Clock;
    log: Logger;
    config?: Partial<TakeoverConfig>;
  }) {
    this.#store = deps.store;
    this.#takeovers = deps.takeovers;
    this.#browser = deps.browser;
    this.#trees = deps.trees;
    this.#kick = deps.kick;
    this.#clock = deps.clock;
    this.#log = deps.log;
    this.#cfg = { ...DEFAULT_TAKEOVER_CONFIG, ...deps.config };
    this.#signal = createSignalTask(deps.trees, deps.log);
    deps.takeovers.onCreated = () => this.#arm();
    deps.browser.onWindowClosed = (sessionId, reason) => this.#windowClosed(sessionId, reason);
    deps.browser.onPage = (sessionId, page) => this.#pageChanged(sessionId, page.url);
  }

  /** Told when you gain or lose control of a session's window (the live view sends it to its viewers). */
  onControl(listener: (sessionId: string, control: boolean) => void): void {
    this.#control.add(listener);
  }
  #emitControl(sessionId: string, control: boolean): void {
    for (const l of this.#control) l(sessionId, control);
  }

  get ttlMs(): number {
    return this.#cfg.requestTtlMs;
  }
  list(): Takeover[] {
    return this.#takeovers.listOpen();
  }

  state(sessionId: string): BrowserStateResponse {
    if (!this.#store.getSessionRow(sessionId)) throw notFound("That session does not exist.");
    const open = this.#takeovers.openFor(sessionId);
    const page = this.#browser.page(sessionId);
    return {
      window: this.#browser.hasWindow(sessionId),
      url: page?.url ?? null,
      title: page?.title ?? null,
      viewport: null, // filled in by the route: the driver knows the page area
      takeover: open ? this.#takeovers.get(open.id)! : null,
    };
  }

  // ---- calls parked on a takeover ---------------------------------------------------------------------------------

  /**
   * The gate of every browser call: the ID of the takeover the session has active (the call parks on it and is
   * remembered, so the end wakes it), or undefined (the call goes on). It reads the stored row and nothing else, so a
   * rerun of the gates answers the same for the same state, and it registers the task under a set, so it never doubles.
   */
  park(sessionId: string, treeId: string, taskId: string): string | undefined {
    const open = this.#takeovers.openFor(sessionId);
    const key = `${treeId}:${taskId}`;
    if (open?.status !== "active") {
      for (const tasks of this.#parked.values()) tasks.delete(key);
      return undefined;
    }
    const tasks = this.#parked.get(open.id) ?? new Map();
    tasks.set(key, { treeId, taskId });
    this.#parked.set(open.id, tasks);
    return open.id;
  }

  /** Wakes every call parked on an ended takeover; the row is already written, so each re-reads it and finds it over. */
  async #wakeParked(takeoverId: string): Promise<void> {
    const tasks = this.#parked.get(takeoverId);
    if (!tasks) return;
    this.#parked.delete(takeoverId);
    await Promise.all(
      [...tasks.values()].map(({ treeId, taskId }) =>
        // A tree that is not open has no parked call in this process: it runs its gates again when it opens.
        this.#signal(treeId, taskId, TakeoverEnded, takeoverId, context, { open: false }),
      ),
    );
  }

  // ---- the agent asks ------------------------------------------------------------------------------------------------

  /** browser_takeover: a pending request on the session's current page. */
  request(sessionId: string, reason: string): Takeover {
    const session = this.#store.getSessionRow(sessionId);
    if (!session) throw notFound("That session does not exist.");
    const page = this.#browser.page(sessionId);
    const running = this.#store.runningRun(sessionId);
    const { takeover } = this.#takeovers.create({
      session,
      requestedBy: "agent",
      reason,
      url: page?.url ?? null,
      title: page?.title ?? null,
      runId: running?.id ?? null,
      ttlMs: this.#cfg.requestTtlMs,
    });
    this.#log.info("takeover.requested", { takeoverId: takeover.id, sessionId });
    return takeover;
  }

  // ---- you start, finish or cancel ------------------------------------------------------------------------------------

  async start(sessionId: string): Promise<Takeover> {
    if (!this.#store.getSessionRow(sessionId)) throw notFound("That session does not exist.");
    const open = this.#takeovers.openFor(sessionId);
    if (open?.status === "active") throw new HttpError(409, "already_active", "You are already in control.");
    if (!this.#browser.hasWindow(sessionId)) {
      // The window went away while the request waited (an eviction cannot happen to it; a browser restart can).
      if (open?.url) {
        try {
          await this.#browser.reopen(sessionId, open.url);
        } catch {
          throw new HttpError(409, "no_window", "The browser window could not be opened right now.");
        }
      } else {
        throw new HttpError(409, "no_window", "This chat has no browser window.");
      }
    }
    let takeover: Takeover;
    if (open) {
      takeover = this.#takeovers.start(open.id);
    } else {
      const session = this.#store.getSessionRow(sessionId)!;
      const page = this.#browser.page(sessionId);
      takeover = this.#takeovers.create({
        session,
        requestedBy: "user",
        reason: null,
        url: page?.url ?? null,
        title: page?.title ?? null,
        runId: null,
        ttlMs: this.#cfg.requestTtlMs,
      }).takeover;
    }
    this.#browser.setControl(sessionId, true);
    this.#browser.markActivity(sessionId);
    this.#armIdle(takeover);
    this.#emitControl(sessionId, true);
    this.#log.info("takeover.started", { takeoverId: takeover.id, sessionId, by: takeover.requestedBy });
    return takeover;
  }

  async end(id: string, action: "done" | "cancel", note?: string): Promise<Takeover> {
    const before = this.#takeovers.row(id);
    const wasActive = before?.status === "active";
    const done = this.#takeovers.end(id, action, note);
    const row = this.#takeovers.row(id)!;
    if (wasActive) await this.#releaseControl(row);
    this.#log.info("takeover.ended", { takeoverId: id, sessionId: row.session_id, outcome: done.takeover.status });
    if (done.runId) this.#kick(row.session_id);
    else await this.#notify(row);
    this.#arm();
    return done.takeover;
  }

  /** Stops what a takeover held: control, the idle timer, the typed-character count; the agent's waiting calls go on. */
  async #releaseControl(row: TakeoverRow): Promise<void> {
    this.#flushTyping(row.session_id, row.id);
    const timer = this.#idle.get(row.id);
    if (timer) clearTimeout(timer);
    this.#idle.delete(row.id);
    this.#browser.setControl(row.session_id, false);
    this.#emitControl(row.session_id, false);
    // Whatever you opened is outside content for the session from now on.
    this.#store.addTaint(row.session_id, ["external"]);
    this.#browser.wake();
    await this.#wakeParked(row.id);
  }

  // ---- input while in control -----------------------------------------------------------------------------------------

  /** True while this session's takeover is active (input is honoured). */
  isActive(sessionId: string): boolean {
    return this.#takeovers.openFor(sessionId)?.status === "active";
  }

  /** Any input from you resets the idle timer. */
  touchInput(sessionId: string): void {
    const open = this.#takeovers.openFor(sessionId);
    if (open?.status !== "active") return;
    this.#browser.markActivity(sessionId);
    this.#armIdle(this.#takeovers.get(open.id)!);
  }

  #armIdle(takeover: Takeover): void {
    if (this.#stopped) return;
    const old = this.#idle.get(takeover.id);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.#idle.delete(takeover.id);
      void this.#autoCancel(takeover.id, CANCEL_TIMED_OUT).catch(() => undefined);
    }, this.#cfg.idleMs);
    (timer as { unref?: () => void }).unref?.();
    this.#idle.set(takeover.id, timer);
  }

  async #autoCancel(id: string, reason: string): Promise<void> {
    const before = this.#takeovers.row(id);
    const t = this.#takeovers.cancelAuto(id, reason);
    if (!t || !before) return;
    const row = this.#takeovers.row(id)!;
    if (before.status === "active") await this.#releaseControl(row);
    this.#log.info("takeover.cancelled", {
      takeoverId: id,
      sessionId: row.session_id,
      reason: reason === CANCEL_TIMED_OUT ? "timed_out" : reason === CANCEL_CLOSED ? "window_closed" : "expired",
    });
    await this.#notify(row);
  }

  #windowClosed(sessionId: string, reason: string): void {
    const open = this.#takeovers.openFor(sessionId);
    if (!open) return;
    // A browser restart leaves a request that still waits for you; the window is opened again when you start it.
    if (open.status === "pending" && reason === "restarted") return;
    void this.#autoCancel(open.id, CANCEL_CLOSED).catch(() => undefined);
  }

  // ---- the record of what you did -------------------------------------------------------------------------------------

  /** An act of yours in the active takeover. Typed text is never passed here: only `typed` counts characters. */
  act(sessionId: string, kind: Exclude<ActKind, "type">, detail: Record<string, unknown>): void {
    const open = this.#takeovers.openFor(sessionId);
    if (open?.status !== "active") return;
    this.#flushTyping(sessionId, open.id);
    this.#takeovers.recordAct(open.id, kind, detail);
  }
  typed(sessionId: string, chars: number, field: () => Promise<{ role: string; name: string } | null>): void {
    const open = this.#takeovers.openFor(sessionId);
    if (open?.status !== "active" || chars <= 0) return;
    const have = this.#typing.get(sessionId);
    if (have) {
      have.chars += chars;
      return;
    }
    const entry = { chars, field: null as { role: string; name: string } | null };
    this.#typing.set(sessionId, entry);
    void field().then(
      (f) => (entry.field = f),
      () => undefined,
    );
  }
  #flushTyping(sessionId: string, takeoverId: string): void {
    const have = this.#typing.get(sessionId);
    if (!have) return;
    this.#typing.delete(sessionId);
    this.#takeovers.recordAct(takeoverId, "type", { chars: have.chars, field: have.field });
  }
  #pageChanged(sessionId: string, url: string): void {
    const open = this.#takeovers.openFor(sessionId);
    if (open?.status === "active") this.act(sessionId, "navigate", { url });
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------------

  /**
   * On start: a takeover that was active belongs to a window that no longer exists, so it ends; requests past their time
   * expire; agents are told what they have not been told; the timer is armed for the next expiry.
   */
  async boot(): Promise<void> {
    for (const row of this.#takeovers.activeRows()) await this.#autoCancel(row.id, CANCEL_CLOSED);
    await this.sweep();
  }

  async sweep(): Promise<void> {
    for (const t of this.#takeovers.expireDue())
      this.#log.info("takeover.expired", { takeoverId: t.id, sessionId: t.sessionId });
    for (const row of this.#takeovers.unnotified()) await this.#notify(row);
    this.#arm();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#expiry) clearTimeout(this.#expiry);
    for (const timer of this.#idle.values()) clearTimeout(timer);
    this.#idle.clear();
  }

  /** The sessions are being deleted: their takeovers end and nobody is told. */
  cancelForSessions(sessionIds: readonly string[]): void {
    for (const t of this.#takeovers.cancelForSessions(sessionIds)) {
      const timer = this.#idle.get(t.id);
      if (timer) clearTimeout(timer);
      this.#idle.delete(t.id);
      this.#typing.delete(t.sessionId);
      // The call ends with its session: nothing is left to wake.
      this.#parked.delete(t.id);
      this.#emitControl(t.sessionId, false);
      this.#log.info("takeover.cancelled", { takeoverId: t.id, sessionId: t.sessionId, reason: "session_deleted" });
    }
    this.#browser.wake();
  }

  #arm(): void {
    if (this.#stopped) return;
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = undefined;
    const next = this.#takeovers.nextExpiry();
    if (next === undefined) return;
    const wait = Math.min(Math.max(0, next - this.#clock.now()) + 5, 2 ** 31 - 1);
    this.#expiry = setTimeout(
      () =>
        void this.sweep().catch((error) =>
          this.#log.error("takeover.sweep_failed", { error: error instanceof Error ? error.name : "error" }),
        ),
      wait,
    );
    (this.#expiry as { unref?: () => void }).unref?.();
  }

  /**
   * Tells the agent how it went, without a model turn: a `write` entry (Pi appends it at once when idle, or at the next
   * boundary), idempotent by request id. A crash in between is repaired by the sweep at the next start.
   */
  #notify(row: TakeoverRow): Promise<void> {
    // An Edit can switch the session's current conversation while the write waits in this queue.
    const session = this.#store.getSessionRow(row.session_id);
    const next = this.#notifying.then(async () => {
      if (!session || this.#stopped) {
        if (!session) this.#takeovers.markNotified(row.id);
        return;
      }
      try {
        const tree = await this.#trees.open(session.tree_id);
        const ts = tree.session(session.id);
        if (!ts) return;
        const conversationId = session.pi_conversation_id;
        const conv =
          conversationId && conversationId !== String(ts.conv.id)
            ? await tree.harness.conversation(Number(conversationId) as ConversationId, context)
            : ts.conv;
        if (!conv) return;
        const fresh = this.#takeovers.row(row.id) ?? row;
        const at = this.#clock.now();
        await conv.submit(
          {
            type: "write",
            requestId: `takeover-note:${row.id}`,
            entry: {
              kind: TAKEOVER_NOTE_KIND,
              model: [{ role: "user", content: agentNote(fresh), timestamp: at }],
              data: {
                id: row.id,
                status: fresh.status,
                ...(fresh.requested_by === "user" && fresh.status === "done"
                  ? { notice: "You used the browser.", at }
                  : {}),
              },
            },
          },
          context,
        );
        this.#takeovers.markNotified(row.id);
      } catch (error) {
        this.#log.error("takeover.notify_failed", {
          takeoverId: row.id,
          error: error instanceof Error ? error.name : "error",
        });
      }
    });
    this.#notifying = next.catch(() => undefined);
    return next;
  }
}
