// Rendering one page over the DevTools protocol, for both engines (docs/reader.md; ADR 0017's rules, kept): all traffic
// goes to the reader's own proxy under the job's token, images, media and fonts are failed before they are requested,
// service workers, WebRTC and WebSockets are removed, downloads are denied, main-frame navigations are checked by the
// caller, and nothing is kept but the HTML read back. Moli and Chromium speak the same protocol for all of this.
import type { EngineRequest, EngineResult } from "../core/render.ts";
import { RenderFailure } from "../core/render.ts";

/**
 * Runs before any page script, in every frame of the context, and in every worker before it starts: removes service
 * workers (they would outlive the page's interception), WebRTC (it sends UDP around the proxy) and WebSockets (a
 * rendered page is read, not talked to).
 */
const SERVICE_WORKER = [
  "try { Object.defineProperty((globalThis.Navigator ?? globalThis.WorkerNavigator).prototype, 'serviceWorker', { get: () => undefined, configurable: false }); } catch {}",
].join("\n");
const HARDEN_REST = [
  "for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription', 'WebSocket', 'WebSocketStream', 'WebTransport'])",
  "  try { delete globalThis[name]; } catch {}",
].join("\n");
export const HARDEN = `${SERVICE_WORKER}\n${HARDEN_REST}`;
/** WebSockets again, at the network layer, for the page and its frames. */
const BLOCKED_URLS = ["ws://*", "wss://*"];
const BLOCKED_TYPES = new Set(["Image", "Media", "Font"]);
const POLL_MS = 250;
const STABLE_MS = 1_000;

// biome-ignore lint/suspicious/noExplicitAny: DevTools protocol payloads are untyped JSON, read field by field
export type Json = any;

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { message: string };
  sessionId?: string;
}

/** The engine answered a command with an error. */
export class CdpError extends Error {
  readonly unsupported: boolean;
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
    this.unsupported = /wasn't found|not found|not supported|unsupported|not implemented/i.test(message);
  }
}

/** One flat-session DevTools connection over the global WebSocket. */
export class CdpConnection {
  readonly #ws: WebSocket;
  readonly #pending = new Map<number, { ok: (value: Json) => void; fail: (error: Error) => void }>();
  #next = 1;
  #closed = false;
  onEvent: (message: CdpMessage) => void = () => {};

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(String(event.data)) as CdpMessage;
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id);
        if (!waiter) return;
        this.#pending.delete(message.id);
        if (message.error) waiter.fail(new CdpError(message.error.message));
        else waiter.ok(message.result);
      } else if (message.method) this.onEvent(message);
    };
    ws.onclose = () => this.#fail(new Error("the DevTools connection closed"));
  }

  static open(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("the browser did not answer"));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("the browser is not reachable"));
      };
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Json> {
    if (this.#closed) return Promise.reject(new Error("the DevTools connection closed"));
    return new Promise((ok, fail) => {
      const id = this.#next++;
      this.#pending.set(id, { ok, fail });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  #fail(error: Error): void {
    this.#closed = true;
    for (const waiter of this.#pending.values()) waiter.fail(error);
    this.#pending.clear();
  }

  close(): void {
    this.#fail(new Error("the DevTools connection closed"));
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a render needs of a DevTools connection (the real one, or a scripted one in tests). */
export interface CdpSession {
  onEvent: (message: CdpMessage) => void;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Json>;
  close(): void;
}

export interface CdpRenderOptions {
  conn: CdpSession;
  request: EngineRequest;
  /**
   * Chromium: the browser is shared, so the render gets a context of its own that sends its traffic to this proxy
   * (`host:port`) and answers the proxy's challenge with the job's token. Moli: undefined; the process is the
   * context and its proxy setting already carries the token.
   */
  context?: { proxy: string };
  /**
   * Moli has no service workers and throws when a page reads a `serviceWorker` property that was redefined, so for it
   * the script leaves that property alone (the smoke suite checks that the page still sees none).
   */
  noServiceWorkerPatch?: boolean;
}

/** Maps what went wrong during a render to the failure the orchestrator reasons about. */
function asFailure(error: unknown): RenderFailure {
  if (error instanceof RenderFailure) return error;
  const text = error instanceof Error ? error.message : String(error);
  if (error instanceof CdpError)
    return new RenderFailure(
      error.unsupported ? "unsupported" : "cdp_error",
      "The page could not be rendered in the browser.",
      text,
    );
  return new RenderFailure("crash", "The page could not be rendered in the browser.", text);
}

/** Renders the page of `request` on `conn` and reads its HTML back. Throws a RenderFailure. */
export async function renderOverCdp({
  conn,
  request,
  context,
  noServiceWorkerPatch,
}: CdpRenderOptions): Promise<EngineResult> {
  const started = Date.now();
  const deadline = started + request.deadlineMs;
  if (request.signal.aborted) throw new RenderFailure("cancelled", "The read was cancelled.");
  let stopped: RenderFailure | undefined;
  let wake: (() => void) | undefined;
  const stop = (failure: RenderFailure) => {
    stopped ??= failure;
    wake?.();
  };
  const onAbort = () => {
    stop(new RenderFailure("cancelled", "The read was cancelled."));
    conn.close();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  const harden = noServiceWorkerPatch ? HARDEN_REST : HARDEN;
  let contextId: string | undefined;
  let blockedMedia = 0;
  try {
    if (context) {
      ({ browserContextId: contextId } = await conn.send("Target.createBrowserContext", {
        disposeOnDetach: true,
        proxyServer: `http://${context.proxy}`,
        proxyBypassList: "<-loopback>",
      }));
    }
    await conn.send("Browser.setDownloadBehavior", {
      behavior: "deny",
      ...(contextId ? { browserContextId: contextId } : {}),
    });

    let pageSession: string | undefined;
    let mainFrame: string | undefined;
    let documents = 0;
    const arm = async (sessionId: string, type: string) => {
      if (type === "page" || type === "iframe")
        await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: harden }, sessionId);
      await conn
        .send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId)
        .then(() => conn.send("Network.setBlockedURLs", { urls: BLOCKED_URLS }, sessionId))
        .catch(() => undefined);
      // Dedicated workers have no Fetch domain: they reuse the credentials the context already holds.
      await conn
        .send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] }, sessionId)
        .catch(() => undefined);
      await conn
        .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
        .catch(() => undefined);
      if (type !== "page") {
        // A worker is paused before its first line: strip it the same way, then let it run.
        if (type !== "iframe")
          await conn.send("Runtime.evaluate", { expression: harden }, sessionId).catch(() => undefined);
        await conn.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      }
    };
    conn.onEvent = (m) => {
      const sid = m.sessionId;
      const p = m.params;
      if (m.method === "Fetch.authRequired") {
        void conn
          .send(
            "Fetch.continueWithAuth",
            {
              requestId: p.requestId,
              authChallengeResponse:
                context && p.authChallenge?.source === "Proxy"
                  ? { response: "ProvideCredentials", username: "rei", password: request.token }
                  : { response: "CancelAuth" },
            },
            sid,
          )
          .catch(() => undefined);
      } else if (m.method === "Fetch.requestPaused") {
        const fail = () =>
          void conn
            .send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, sid)
            .catch(() => undefined);
        if (BLOCKED_TYPES.has(p.resourceType)) {
          blockedMedia++;
          return fail();
        }
        if (p.request?.headers?.["Service-Worker"] === "script") return fail();
        if (p.resourceType === "Document" && sid === pageSession && p.frameId === mainFrame) {
          // The first document is the page the caller allowed; every later one is a redirect or a navigation.
          if (documents++ > 0) {
            const refusal = request.checkNavigation(String(p.request?.url ?? ""));
            if (refusal !== undefined) {
              stop(new RenderFailure("navigation_stopped", refusal));
              return fail();
            }
          }
        }
        void conn.send("Fetch.continueRequest", { requestId: p.requestId }, sid).catch(() => undefined);
      } else if (m.method === "Target.attachedToTarget") {
        const { sessionId, targetInfo } = p;
        if (targetInfo.type === "service_worker") {
          void conn.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => undefined);
          return;
        }
        void arm(sessionId, targetInfo.type).catch(() => undefined);
      }
    };

    const { targetId } = await conn.send("Target.createTarget", {
      url: "about:blank",
      ...(contextId ? { browserContextId: contextId } : {}),
    });
    mainFrame = targetId;
    ({ sessionId: pageSession } = await conn.send("Target.attachToTarget", { targetId, flatten: true }));
    await arm(pageSession!, "page");
    await conn.send("Page.enable", {}, pageSession);
    const navigated = await conn.send("Page.navigate", { url: request.url }, pageSession);
    if (stopped) throw stopped;
    if (navigated?.errorText) {
      const text = String(navigated.errorText);
      throw new RenderFailure(
        /PROXY|TUNNEL/i.test(text) ? "proxy_error" : "cdp_error",
        `The page could not be loaded in the browser (${text.replace(/[^\w:.-]/g, "")}).`,
        text,
      );
    }

    // A page whose script never yields cannot be read: past the deadline (and a grace second) the render fails.
    const evaluate = async (expression: string): Promise<unknown> => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RenderFailure("deadline", "The page did not finish rendering in time.")),
          Math.max(500, deadline + 1_000 - Date.now()),
        );
      });
      try {
        const sent = conn.send("Runtime.evaluate", { expression, returnByValue: true }, pageSession);
        return (await Promise.race([sent, late]))?.result?.value;
      } finally {
        clearTimeout(timer);
      }
    };
    // Read once the body text has not changed for a second, or at the deadline with whatever is there.
    let last = "";
    let stableSince = Date.now();
    let ended: EngineResult["ended"] = "deadline";
    while (Date.now() < deadline) {
      await Promise.race([sleep(POLL_MS), new Promise<void>((resolve) => (wake = resolve))]);
      if (stopped) throw stopped;
      const text = String((await evaluate("document.body ? document.body.innerText : ''")) ?? "");
      if (text !== last) {
        last = text;
        stableSince = Date.now();
      } else if (text.trim() !== "" && Date.now() - stableSince >= STABLE_MS) {
        ended = "stable";
        break;
      }
    }
    const read = (await evaluate(
      `(() => { const h = document.documentElement ? document.documentElement.outerHTML : ''; return { url: location.href, html: h.slice(0, ${request.maxHtmlChars}), cut: h.length > ${request.maxHtmlChars} }; })()`,
    )) as { url?: unknown; html?: unknown; cut?: unknown } | undefined;
    if (stopped) throw stopped;
    const html = typeof read?.html === "string" ? read.html : "";
    if (html === "") throw new RenderFailure("cdp_error", "The page could not be rendered in the browser.", "no html");
    return {
      finalUrl: typeof read?.url === "string" ? read.url : request.url,
      html,
      ended,
      truncated: read?.cut === true,
      blockedMedia,
      ms: Date.now() - started,
    };
  } catch (error) {
    if (stopped) throw stopped;
    throw asFailure(error);
  } finally {
    request.signal.removeEventListener("abort", onAbort);
    if (contextId)
      await conn.send("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => undefined);
    conn.close();
  }
}
