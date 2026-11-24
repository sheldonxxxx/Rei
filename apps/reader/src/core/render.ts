// What a render engine is asked and answers, the slots that share an engine between renders, and the attempt rows that
// say what every render did (docs/reader.md). The engines themselves (Moli, Chromium over DevTools) are Node-only.
import type { ReadEngine } from "@rei/protocol";

/** A render's deadline once it has a slot (separate from the HTTP fetch's 15 s and the queue wait). */
export const RENDER_DEADLINE_MS = 20_000;
/** The HTML read back from a render is cut here. */
export const RENDER_MAX_HTML_CHARS = 5 * 1024 * 1024;
/** Renders running at once, per engine. */
export const RENDER_SLOTS = 2;
/** How long a render waits for a slot before it fails. */
export const RENDER_QUEUE_WAIT_MS = 30_000;
export const RENDER_BUSY = "The browser is busy rendering other pages; try again shortly.";

/** How an attempt ended (the `outcome` column). */
export type AttemptOutcome =
  | "ok"
  | "deadline"
  | "crash"
  | "cdp_error"
  | "unsupported"
  | "proxy_error"
  | "navigation_stopped"
  | "cancelled"
  | "busy";

export interface EngineRequest {
  url: string;
  /** The render job's proxy token, the password the browser answers its proxy's challenge with. */
  token: string;
  deadlineMs: number;
  maxHtmlChars: number;
  /** A main-frame navigation after the first request: undefined lets it through; a message stops the render. */
  checkNavigation(url: string): string | undefined;
  signal: AbortSignal;
}

export interface EngineResult {
  finalUrl: string;
  html: string;
  ended: "stable" | "deadline";
  truncated: boolean;
  blockedMedia: number;
  ms: number;
}

/** A render that produced nothing to read. `message` is meant for the model; `detail` for the attempt row only. */
export class RenderFailure extends Error {
  readonly outcome: Exclude<AttemptOutcome, "ok">;
  readonly detail: string;
  constructor(outcome: Exclude<AttemptOutcome, "ok">, message: string, detail = "") {
    super(message);
    this.name = "RenderFailure";
    this.outcome = outcome;
    this.detail = detail.slice(0, 300);
  }
}

/** Renders one page in a context of its own and returns its HTML. Throws a RenderFailure. */
export interface RenderEngine {
  readonly name: ReadEngine;
  /** "1.1.25" for Moli, the major version for Chromium; "unknown" until the engine has run once. */
  version(): string;
  render(request: EngineRequest): Promise<EngineResult>;
}

export interface Lease {
  waitedMs: number;
  release(): void;
}

interface Waiter {
  who: string;
  since: number;
  grant(lease: Lease): void;
  fail(error: RenderFailure): void;
}

export interface SlotsOptions {
  slots?: number;
  waitMs?: number;
  now?: () => number;
}

/**
 * At most `slots` renders at once, first come first served. A job that gets no slot within `waitMs` fails as busy. A
 * caller that already holds a slot gets another only while no other caller's job is waiting, so one caller opening many
 * pages cannot hold up the rest. A cancelled job leaves the queue at once.
 */
export class Slots {
  readonly #slots: number;
  readonly #waitMs: number;
  readonly #now: () => number;
  readonly #held = new Map<string, number>();
  readonly #waiting: Waiter[] = [];
  #running = 0;

  constructor(options: SlotsOptions = {}) {
    this.#slots = options.slots ?? RENDER_SLOTS;
    this.#waitMs = options.waitMs ?? RENDER_QUEUE_WAIT_MS;
    this.#now = options.now ?? Date.now;
  }

  get stats(): { running: number; waiting: number } {
    return { running: this.#running, waiting: this.#waiting.length };
  }

  /** A lease at once when a slot is free and nobody waits, else undefined (the shadow comparisons use this). */
  tryAcquire(who: string): Lease | undefined {
    if (this.#running >= this.#slots || this.#waiting.length > 0) return undefined;
    return this.#lease(who, 0);
  }

  acquire(who: string, signal?: AbortSignal): Promise<Lease> {
    if (signal?.aborted) return Promise.reject(new RenderFailure("cancelled", "The read was cancelled."));
    return new Promise<Lease>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const leave = () => {
        const at = this.#waiting.indexOf(waiter);
        if (at >= 0) this.#waiting.splice(at, 1);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        leave();
        reject(new RenderFailure("cancelled", "The read was cancelled."));
        this.#pump();
      };
      const waiter: Waiter = {
        who,
        since: this.#now(),
        grant: (lease) => {
          leave();
          resolve(lease);
        },
        fail: (error) => {
          leave();
          reject(error);
        },
      };
      this.#waiting.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        waiter.fail(new RenderFailure("busy", RENDER_BUSY));
        this.#pump();
      }, this.#waitMs);
      timer.unref?.();
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#running < this.#slots) {
      const next = this.#waiting.find(
        (w) => (this.#held.get(w.who) ?? 0) === 0 || !this.#waiting.some((o) => o.who !== w.who),
      );
      if (!next) return;
      next.grant(this.#lease(next.who, this.#now() - next.since));
    }
  }

  #lease(who: string, waitedMs: number): Lease {
    this.#running++;
    this.#held.set(who, (this.#held.get(who) ?? 0) + 1);
    let released = false;
    return {
      waitedMs,
      release: () => {
        if (released) return;
        released = true;
        this.#running--;
        const n = (this.#held.get(who) ?? 1) - 1;
        if (n <= 0) this.#held.delete(who);
        else this.#held.set(who, n);
        this.#pump();
      },
    };
  }
}

/** One row of `render_attempts`. */
export interface AttemptRow {
  readId: string;
  attempt: 1 | 2;
  caller: string;
  stepId: string | undefined;
  engine: ReadEngine;
  engineVersion: string;
  role: "primary" | "fallback" | "shadow";
  trigger: "requires_js" | "thin_low_quality" | "force";
  outcome: AttemptOutcome;
  errorDetail: string | undefined;
  quality: string | undefined;
  textChars: number | undefined;
  sections: number | undefined;
  ended: "stable" | "deadline" | undefined;
  renderMs: number | undefined;
  slotWaitMs: number | undefined;
  connections: number;
  bytes: number | undefined;
  refused: number;
  blockedMedia: number | undefined;
  url: string;
  host: string;
  fallbackReason: "failed" | "requires_js" | "thin" | undefined;
  used: boolean;
}

export interface AttemptSink {
  record(row: AttemptRow): void;
}
