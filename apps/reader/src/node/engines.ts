// The two render engines (docs/reader.md). Moli is a process per render: its proxy setting is process-wide, so one
// process carries one job's token, and nothing outlives the render. Chromium is one headless process kept for the
// reader's lifetime (restarted if it dies) with a disposable browser context per render. Both listen on loopback only,
// keep no profile, and send everything to the reader's own proxy.
import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import type { ReadEngine } from "@rei/protocol";
import { type EngineRequest, type EngineResult, type RenderEngine, RenderFailure } from "../core/render.ts";
import { CdpConnection, renderOverCdp } from "./cdp.ts";

const START_TIMEOUT_MS = 8_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

interface Version {
  browser: string;
  moli?: string;
  ws: string;
}

/** The DevTools endpoint's /json/version, retried until the engine is up (or the process exits). */
async function waitForVersion(port: number, exited: () => boolean): Promise<Version> {
  const until = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < until) {
    if (exited()) throw new RenderFailure("crash", "The browser that renders pages did not start.", "exited early");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
      const body = (await res.json()) as Record<string, string>;
      if (body.webSocketDebuggerUrl)
        return {
          browser: body.Browser ?? "",
          ...(body["Moli-Version"] ? { moli: body["Moli-Version"] } : {}),
          ws: body.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`),
        };
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new RenderFailure("crash", "The browser that renders pages did not start.", "start timeout");
}

function stopProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1_000).unref();
}

export interface MoliOptions {
  /** Path of the moli binary. */
  binary: string;
  /** The reader's proxy as `host:port`. */
  proxy: string;
  /** DevTools port (tests: a known one); default a free port per render. */
  port?: number;
}

export class MoliEngine implements RenderEngine {
  readonly name: ReadEngine = "moli";
  readonly #opts: MoliOptions;
  #version: string | undefined;

  constructor(opts: MoliOptions) {
    this.#opts = opts;
  }

  version(): string {
    return this.#version ?? "unknown";
  }

  async render(request: EngineRequest): Promise<EngineResult> {
    if (request.signal.aborted) throw new RenderFailure("cancelled", "The read was cancelled.");
    const port = this.#opts.port ?? (await freePort());
    const child = spawn(
      this.#opts.binary,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--http-proxy",
        `http://rei:${request.token}@${this.#opts.proxy}`,
      ],
      { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: "/tmp", LANG: "C.UTF-8" } },
    );
    let exited = false;
    let spawnError: Error | undefined;
    child.on("exit", () => {
      exited = true;
    });
    child.on("error", (error) => {
      spawnError = error;
      exited = true;
    });
    try {
      const version = await waitForVersion(port, () => exited).catch((error) => {
        if (spawnError)
          throw new RenderFailure("crash", "The browser that renders pages is not available.", spawnError.message);
        throw error;
      });
      if (version.moli) this.#version = version.moli;
      const conn = await CdpConnection.open(version.ws, 5_000).catch((error) => {
        throw new RenderFailure("crash", "The browser that renders pages is not reachable.", String(error?.message));
      });
      return await renderOverCdp({ conn, request, noServiceWorkerPatch: true });
    } finally {
      stopProcess(child);
    }
  }
}

export interface ChromiumOptions {
  binary: string;
  /** The reader's proxy as `host:port`. */
  proxy: string;
  /** DevTools port (tests: a known one); default a free port. */
  port?: number;
}

const CHROMIUM_FLAGS = [
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-client-side-phishing-detection",
  "--no-pings",
  "--deny-permission-prompts",
  "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
  "--proxy-server=http://127.0.0.1:1",
  "--proxy-bypass-list=<-loopback>",
];

export class ChromiumEngine implements RenderEngine {
  readonly name: ReadEngine = "chromium";
  readonly #opts: ChromiumOptions;
  #version: string | undefined;
  #starting: Promise<{ child: ChildProcess; ws: string }> | undefined;
  #child: ChildProcess | undefined;

  constructor(opts: ChromiumOptions) {
    this.#opts = opts;
  }

  version(): string {
    return this.#version ?? "unknown";
  }

  #start(): Promise<{ child: ChildProcess; ws: string }> {
    this.#starting ??= (async () => {
      const port = this.#opts.port ?? (await freePort());
      const child = spawn(
        this.#opts.binary,
        [
          ...CHROMIUM_FLAGS,
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          "--user-data-dir=/tmp/chromium-profile",
          "about:blank",
        ],
        { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: "/tmp", LANG: "C.UTF-8" } },
      );
      let exited = false;
      let spawnError: Error | undefined;
      child.on("exit", () => {
        exited = true;
        if (this.#child === child) {
          this.#child = undefined;
          this.#starting = undefined;
        }
      });
      child.on("error", (error) => {
        spawnError = error;
        exited = true;
      });
      try {
        const version = await waitForVersion(port, () => exited);
        this.#version = /\/(\d+)/.exec(version.browser)?.[1] ?? version.browser;
        this.#child = child;
        return { child, ws: version.ws };
      } catch (error) {
        stopProcess(child);
        this.#starting = undefined;
        if (spawnError)
          throw new RenderFailure("crash", "The browser that renders pages is not available.", spawnError.message);
        throw error;
      }
    })();
    return this.#starting;
  }

  async render(request: EngineRequest): Promise<EngineResult> {
    if (request.signal.aborted) throw new RenderFailure("cancelled", "The read was cancelled.");
    const { ws } = await this.#start();
    const conn = await CdpConnection.open(ws, 5_000).catch((error) => {
      throw new RenderFailure("crash", "The browser that renders pages is not reachable.", String(error?.message));
    });
    return renderOverCdp({ conn, request, context: { proxy: this.#opts.proxy } });
  }

  /** Browser contexts open now: after every render has ended it is the number there was before (the smoke suite checks). */
  async contextCount(): Promise<number> {
    const { ws } = await this.#start();
    const conn = await CdpConnection.open(ws, 5_000);
    try {
      return ((await conn.send("Target.getBrowserContexts")).browserContextIds as string[]).length;
    } finally {
      conn.close();
    }
  }

  /** Stops the browser (the reader is shutting down). */
  close(): void {
    if (this.#child) stopProcess(this.#child);
  }
}
