import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { totpCode } from "../../src/auth/totp.ts";
import type { BrowserDriver } from "../../src/browser/driver.ts";
import { type ControlPlaneConfig, DEFAULT_CONFIG } from "../../src/control-plane.ts";
import type { ExecBackend } from "../../src/exec/backend.ts";
import type { NodeConfig } from "../../src/node/config.ts";
import { createNodeHost, type NodeHost, type NodeHostOptions } from "../../src/node/host.ts";
import type { Clock } from "../../src/util/clock.ts";
import { Client, SseReader } from "./client.ts";

export const PASSWORD = "correct horse battery staple";
export const STANDIN = "standin-test-token-0123456789abcdef";

/** A clock tests can push forward (to leave a TOTP step, or to age a login). */
export class TestClock implements Clock {
  offset = 0;
  now(): number {
    return Date.now() + this.offset;
  }
  advance(ms: number): void {
    this.offset += ms;
  }
}

export interface TestServerOptions {
  codexImageGateway?: string;
  dir?: string;
  config?: Partial<ControlPlaneConfig>;
  gatewayUrl?: string;
  standin?: string | false;
  modelsJson?: unknown;
  webDist?: string;
  fetchImpl?: typeof fetch;
  clock?: TestClock;
  /** The execution backend, instead of the one `config.exec` asks for. */
  exec?: ExecBackend;
  /** The browser driver (a fake): turns the agent computer's browser on. */
  browserDriver?: BrowserDriver;
  /** The web tools' outside connections (a fake egress fetcher, a fake /search). */
  web?: NodeHostOptions["web"];
  /** Model-written chat titles are off unless a test asks for them: they would be one more gateway call among the ones tests count. */
  titles?: boolean;
  /** MCP connectors' gateway address (faux mode has none); the gateway itself is `fetchImpl`. */
  mcp?: NodeHostOptions["mcp"];
  /** The embedder's fetch (a fake) and the indexer's timers and batch sizes; set `config.embedder` too. */
  memory?: NodeHostOptions["memory"];
  /** The file store (a fake that can be made to fail), instead of the folder store a test server would use. */
  fileObjects?: NodeHostOptions["fileObjects"];
  /** The search service (a fake): the retrieval index runs, without a Qdrant container. */
  retrieval?: NodeHostOptions["retrieval"];
}

export interface TestServer {
  dir: string;
  host: NodeHost;
  client: Client;
  clock: TestClock;
  logs: string[];
  announced: string[];
  /** Stops the control plane (closes trees and the app database) but keeps the folder. */
  stop(): Promise<void>;
  /** Stops and deletes the folder. */
  destroy(): Promise<void>;
  /** Creates the account through the API (setup, TOTP confirm) and leaves the client signed in. */
  createAccount(): Promise<{ totpSecret: string; setupCode: string }>;
  sse(path: string, headers?: Record<string, string>): Promise<SseReader>;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "rei-server-"));
  mkdirSync(dir, { recursive: true });
  const standinFile = join(dir, "standin.txt");
  if (options.standin !== false) writeFileSync(standinFile, `${options.standin ?? STANDIN}\n`, { mode: 0o600 });
  if (options.modelsJson !== undefined) writeFileSync(join(dir, "models.json"), JSON.stringify(options.modelsJson));
  const control: ControlPlaneConfig = {
    ...DEFAULT_CONFIG,
    mode: options.gatewayUrl ? "gateway" : "faux",
    ...(options.gatewayUrl ? { gatewayUrl: options.gatewayUrl } : {}),
    fauxTokensPerSecond: 600,
    commitIntervalMs: 200,
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 50, maxAgentDelayMs: 100 },
    tickMs: 200,
    // Every contract route's answer is checked against its schema, so a drifting response fails the test.
    checkContract: true,
    ...(options.browserDriver ? { browser: { mode: "cdp" as const, cdpUrl: "http://fake:9223" } } : {}),
    ...options.config,
  };
  const config: NodeConfig = {
    logLevel: "debug",
    dataDir: dir,
    port: 0,
    host: "127.0.0.1",
    webDist: options.webDist ?? join(dir, "no-web"),
    standinFile: options.standin === false ? undefined : standinFile,
    eventsKey: "ab".repeat(32),
    // Test hosts run without Garage and Qdrant: file bytes go to a folder, and history search stays keyword-only.
    garage: undefined,
    qdrant: undefined,
    control,
    ...(options.codexImageGateway ? { codexImageGateway: options.codexImageGateway } : {}),
  };
  const logs: string[] = [];
  const announced: string[] = [];
  const clock = options.clock ?? new TestClock();
  const host = await createNodeHost(config, {
    write: (l) => logs.push(l),
    announce: (l) => announced.push(l),
    clock,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.exec ? { exec: options.exec } : {}),
    ...(options.browserDriver ? { browserDriver: options.browserDriver } : {}),
    ...(options.web ? { web: options.web } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.mcp ? { mcp: options.mcp } : {}),
    ...(options.fileObjects ? { fileObjects: options.fileObjects } : {}),
    ...(options.retrieval ? { retrieval: options.retrieval } : {}),
  });
  await host.plane.start();
  if (!options.titles) host.plane.store.metaSet("title_enabled", "0");
  const client = new Client((path, init) => Promise.resolve(host.plane.app.request(path, init)));
  let stopped = false;
  const server: TestServer = {
    dir,
    host,
    client,
    clock,
    logs,
    announced,
    async stop() {
      if (stopped) return;
      stopped = true;
      await host.plane.stop();
      host.closeDb();
    },
    async destroy() {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
    async createAccount() {
      const setupCode = (await import("node:fs")).readFileSync(join(dir, "setup-code.txt"), "utf8").trim();
      const start = await client.post("/api/auth/setup", { setupCode, password: PASSWORD });
      if (start.status !== 200) throw new Error(`setup failed: ${JSON.stringify(start.body)}`);
      const enrol = await client.post("/api/auth/totp/start", { password: PASSWORD });
      const totpSecret = enrol.body.totpSecret as string;
      const confirm = await client.post("/api/auth/totp/confirm", {
        password: PASSWORD,
        totpCode: await totpCode(totpSecret, clock.now()),
      });
      if (confirm.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(confirm.body)}`);
      return { totpSecret, setupCode };
    },
    async sse(path, headers = {}) {
      const res = await client.raw("GET", path, { headers });
      if (res.status !== 200) throw new Error(`sse ${path} -> ${res.status}`);
      return new SseReader(res, path);
    },
  };
  return server;
}

/** Creates a signed-in server in one go. */
export async function startSignedIn(options: TestServerOptions = {}): Promise<TestServer & { totpSecret: string }> {
  const server = await startTestServer(options);
  const { totpSecret } = await server.createAccount();
  return Object.assign(server, { totpSecret });
}
