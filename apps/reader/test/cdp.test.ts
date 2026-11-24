import { describe, expect, it } from "vitest";
import type { EngineRequest } from "../src/core/render.ts";
import { CdpError, type CdpMessage, type CdpSession, HARDEN, renderOverCdp } from "../src/node/cdp.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted DevTools payloads are untyped JSON
type Json = Record<string, any>;
type Handler = (params: Json, sessionId: string | undefined, session: FakeSession) => unknown;
class FakeSession implements CdpSession {
  onEvent: (message: CdpMessage) => void = () => {};
  sent: { method: string; params: Json; sessionId?: string | undefined }[] = [];
  closed = 0;
  readonly handlers: Record<string, Handler>;
  readonly text: () => string;
  constructor(handlers: Record<string, Handler> = {}, text = () => "Hello world") {
    this.handlers = handlers;
    this.text = text;
  }
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    this.sent.push({ method, params, sessionId });
    const handler = this.handlers[method];
    if (handler) return handler(params, sessionId, this);
    switch (method) {
      case "Target.createBrowserContext":
        return { browserContextId: "ctx" };
      case "Target.createTarget":
        return { targetId: "T1" };
      case "Target.attachToTarget":
        return { sessionId: "S1" };
      case "Page.navigate":
        return {};
      case "Runtime.evaluate": {
        const expression = String(params.expression);
        if (expression.includes("innerText")) return { result: { value: this.text() } };
        if (expression.includes("outerHTML"))
          return {
            result: {
              value: { url: "https://a.test/final", html: "<html><body>Hello world</body></html>", cut: false },
            },
          };
        return {};
      }
      default:
        return {};
    }
  }
  close() {
    this.closed++;
  }
  methods = () => this.sent.map((s) => s.method);
}

const request = (over: Partial<EngineRequest> = {}): EngineRequest => ({
  url: "https://a.test/x",
  token: "j.tok",
  deadlineMs: 600,
  maxHtmlChars: 1000,
  checkNavigation: () => undefined,
  signal: new AbortController().signal,
  ...over,
});

describe("renderOverCdp", () => {
  it("renders in a context of its own with the proxy, reads the html and cleans up (Chromium)", async () => {
    const conn = new FakeSession();
    const result = await renderOverCdp({ conn, request: request(), context: { proxy: "127.0.0.1:3129" } });
    expect(result).toMatchObject({
      finalUrl: "https://a.test/final",
      html: expect.stringContaining("Hello"),
      ended: "deadline",
      truncated: false,
    });
    const create = conn.sent.find((s) => s.method === "Target.createBrowserContext")!;
    expect(create.params).toMatchObject({ proxyServer: "http://127.0.0.1:3129", disposeOnDetach: true });
    expect(conn.sent.find((s) => s.method === "Browser.setDownloadBehavior")!.params).toMatchObject({
      behavior: "deny",
      browserContextId: "ctx",
    });
    const scripts = conn.sent.filter((s) => s.method === "Page.addScriptToEvaluateOnNewDocument");
    expect(scripts[0]!.params.source).toBe(HARDEN);
    expect(conn.sent.find((s) => s.method === "Page.navigate")!.params).toEqual({ url: "https://a.test/x" });
    expect(conn.methods()).toContain("Target.disposeBrowserContext");
    expect(conn.closed).toBe(1);
  });

  it("ends as soon as the text has been stable for a second", async () => {
    const started = Date.now();
    const result = await renderOverCdp({ conn: new FakeSession(), request: request({ deadlineMs: 10_000 }) });
    expect(result.ended).toBe("stable");
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 8_000);

  it("leaves the service worker property alone for Moli and uses no context", async () => {
    const conn = new FakeSession();
    await renderOverCdp({ conn, request: request(), noServiceWorkerPatch: true });
    const source = conn.sent.find((s) => s.method === "Page.addScriptToEvaluateOnNewDocument")!.params.source as string;
    expect(source).not.toContain("serviceWorker");
    expect(source).toContain("RTCPeerConnection");
    expect(conn.methods()).not.toContain("Target.createBrowserContext");
  });

  it("answers the proxy challenge with the job token, and cancels any other challenge", async () => {
    const conn = new FakeSession();
    const done = renderOverCdp({ conn, request: request(), context: { proxy: "p:1" } });
    await new Promise((r) => setTimeout(r, 50));
    conn.onEvent({
      method: "Fetch.authRequired",
      sessionId: "S1",
      params: { requestId: "a", authChallenge: { source: "Proxy" } },
    });
    conn.onEvent({
      method: "Fetch.authRequired",
      sessionId: "S1",
      params: { requestId: "b", authChallenge: { source: "Server" } },
    });
    await done;
    const auths = conn.sent.filter((s) => s.method === "Fetch.continueWithAuth");
    expect(auths[0]!.params.authChallengeResponse).toEqual({
      response: "ProvideCredentials",
      username: "rei",
      password: "j.tok",
    });
    expect(auths[1]!.params.authChallengeResponse).toEqual({ response: "CancelAuth" });
  });

  it("fails images, media, fonts and service worker scripts, and lets other requests through", async () => {
    const conn = new FakeSession();
    const done = renderOverCdp({ conn, request: request() });
    await new Promise((r) => setTimeout(r, 50));
    const paused = (requestId: string, resourceType: string, headers: Record<string, string> = {}) =>
      conn.onEvent({
        method: "Fetch.requestPaused",
        sessionId: "S1",
        params: { requestId, resourceType, frameId: "T1", request: { url: "https://a.test/i", headers } },
      });
    paused("img", "Image");
    paused("font", "Font");
    paused("sw", "Script", { "Service-Worker": "script" });
    paused("js", "Script");
    paused("doc", "Document"); // the first document is the page itself
    const result = await done;
    expect(result.blockedMedia).toBe(2);
    expect(conn.sent.filter((s) => s.method === "Fetch.failRequest").map((s) => s.params.requestId)).toEqual([
      "img",
      "font",
      "sw",
    ]);
    expect(conn.sent.filter((s) => s.method === "Fetch.continueRequest").map((s) => s.params.requestId)).toEqual([
      "js",
      "doc",
    ]);
  });

  it("stops the render when a later main-frame document is refused", async () => {
    const conn = new FakeSession();
    const checked: string[] = [];
    const done = renderOverCdp({
      conn,
      request: request({
        checkNavigation: (url) => {
          checked.push(url);
          return "stop here";
        },
      }),
    });
    const outcome = done.catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    const doc = (requestId: string, url: string) =>
      conn.onEvent({
        method: "Fetch.requestPaused",
        sessionId: "S1",
        params: { requestId, resourceType: "Document", frameId: "T1", request: { url, headers: {} } },
      });
    doc("first", "https://a.test/x");
    doc("second", "https://other.test/y");
    const error = await outcome;
    expect(error).toMatchObject({ outcome: "navigation_stopped", message: "stop here" });
    expect(checked).toEqual(["https://other.test/y"]);
    expect(conn.sent.some((s) => s.method === "Fetch.failRequest" && s.params.requestId === "second")).toBe(true);
  });

  it("closes service worker targets and arms new ones", async () => {
    const conn = new FakeSession();
    const done = renderOverCdp({ conn, request: request() });
    await new Promise((r) => setTimeout(r, 50));
    conn.onEvent({
      method: "Target.attachedToTarget",
      params: { sessionId: "W", targetInfo: { type: "service_worker", targetId: "sw1" } },
    });
    conn.onEvent({
      method: "Target.attachedToTarget",
      params: { sessionId: "F", targetInfo: { type: "iframe", targetId: "f1" } },
    });
    conn.onEvent({
      method: "Target.attachedToTarget",
      params: { sessionId: "D", targetInfo: { type: "worker", targetId: "w1" } },
    });
    await done;
    expect(conn.sent.find((s) => s.method === "Target.closeTarget")!.params).toEqual({ targetId: "sw1" });
    expect(conn.sent.some((s) => s.method === "Page.addScriptToEvaluateOnNewDocument" && s.sessionId === "F")).toBe(
      true,
    );
    expect(conn.sent.some((s) => s.method === "Runtime.runIfWaitingForDebugger" && s.sessionId === "D")).toBe(true);
  });

  it("maps failures: unsupported commands, protocol errors, proxy errors, empty html and crashes", async () => {
    const run = (handlers: Record<string, Handler>) =>
      renderOverCdp({ conn: new FakeSession(handlers), request: request() }).catch((e) => e);
    expect(
      await run({
        "Target.createTarget": () => {
          throw new CdpError("'Target.createTarget' wasn't found");
        },
      }),
    ).toMatchObject({ outcome: "unsupported" });
    expect(
      await run({
        "Target.createTarget": () => {
          throw new CdpError("Something odd");
        },
      }),
    ).toMatchObject({ outcome: "cdp_error" });
    expect(await run({ "Page.navigate": () => ({ errorText: "net::ERR_PROXY_CONNECTION_FAILED" }) })).toMatchObject({
      outcome: "proxy_error",
    });
    expect(await run({ "Page.navigate": () => ({ errorText: "net::ERR_ABORTED" }) })).toMatchObject({
      outcome: "cdp_error",
    });
    expect(
      await run({
        "Target.createTarget": () => {
          throw new Error("socket closed");
        },
      }),
    ).toMatchObject({ outcome: "crash", detail: "socket closed" });
    const empty = await run({
      "Runtime.evaluate": (p) => ({
        result: { value: String(p.expression).includes("innerText") ? "x" : { html: "" } },
      }),
    });
    expect(empty).toMatchObject({ outcome: "cdp_error" });
  });

  it("is cancelled by the signal, before and during the render", async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      renderOverCdp({ conn: new FakeSession(), request: request({ signal: before.signal }) }),
    ).rejects.toMatchObject({ outcome: "cancelled" });
    const during = new AbortController();
    const conn = new FakeSession();
    const running = renderOverCdp({ conn, request: request({ signal: during.signal, deadlineMs: 5_000 }) }).catch(
      (e) => e,
    );
    await new Promise((r) => setTimeout(r, 100));
    during.abort();
    expect(await running).toMatchObject({ outcome: "cancelled" });
    expect(conn.closed).toBeGreaterThan(0);
  });

  it("reports a truncated read", async () => {
    const conn = new FakeSession({
      "Runtime.evaluate": (p) => ({
        result: {
          value: String(p.expression).includes("innerText")
            ? "text"
            : { url: "https://a.test/x", html: "<p>x</p>", cut: true },
        },
      }),
    });
    expect(await renderOverCdp({ conn, request: request() })).toMatchObject({
      truncated: true,
      finalUrl: "https://a.test/x",
    });
  });
});
