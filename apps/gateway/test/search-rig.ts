// A gateway with web search wired to one fake search upstream (loopback). The fake plays Brave, Tavily, SearXNG and Exa's
// MCP endpoint, told apart by method and path, and records what each one received.

import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createLogger } from "@rei/logging";
import type { GatewayCallRecord } from "@rei/protocol";
import { STEP_ID_HEADER } from "@rei/protocol";
import { createGatewayApp } from "../src/core/proxy.ts";
import { createRedactor } from "../src/core/redact.ts";
import type { ProviderId, SearchDeps } from "../src/core/search/service.ts";
import { DEFAULT_UPSTREAMS } from "../src/core/upstream.ts";
import { SqliteCallLog } from "../src/node/calllog.ts";
import { dataPaths } from "../src/node/config.ts";

export interface FakeSearchRequest {
  provider: ProviderId;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  json: unknown;
}
export interface FakeSearchReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Waits this long before answering (never answers when Infinity). */
  delayMs?: number;
}
export type FakeSearchHandler = (req: FakeSearchRequest) => FakeSearchReply | Promise<FakeSearchReply>;

export interface SearchRigOptions {
  providers?: ProviderId[];
  exaAuth?: "keyless" | "api_key";
  keys?: Partial<Record<"brave" | "tavily" | "exa" | "searxng", string>>;
  /** Give SearXNG a URL (the fake's); default true. */
  searxng?: boolean;
  /** What follows the fake's origin in the SearXNG URL (an instance under a path prefix, with or without a trailing slash). */
  searxngPath?: string;
  timeoutMs?: number;
  /** Do not pass any search deps at all. */
  noSearch?: boolean;
}

const whichProvider = (method: string, path: string): ProviderId | null =>
  path.startsWith("/res/v1/web/search")
    ? "brave"
    : path.startsWith("/mcp")
      ? "exa"
      : path.startsWith("/search")
        ? method === "POST"
          ? "tavily"
          : "searxng"
        : /^\/searx\/search/.test(path)
          ? "searxng"
          : null;

export async function startSearchRig(options: SearchRigOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gateway-search-test-"));
  const paths = dataPaths(dir);
  const handlers = new Map<ProviderId, FakeSearchHandler>();
  const requests: FakeSearchRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();

  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const provider = whichProvider(req.method ?? "GET", req.url ?? "");
      const raw = Buffer.concat(chunks).toString("utf8");
      let json: unknown;
      try {
        json = raw ? JSON.parse(raw) : undefined;
      } catch {
        json = undefined;
      }
      const handler = provider && handlers.get(provider);
      if (!provider || !handler) {
        res.writeHead(404).end("no fake handler");
        return;
      }
      const rec: FakeSearchRequest = {
        provider,
        method: req.method ?? "GET",
        path: req.url ?? "",
        headers: req.headers,
        raw,
        json,
      };
      requests.push(rec);
      const reply = await handler(rec);
      if (reply.delayMs === Number.POSITIVE_INFINITY) return; // hang until the gateway gives up
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(reply.body ?? "{}");
    });
  });
  fake.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  const standin = `standin-${randomBytes(24).toString("base64url")}`;
  const redactor = createRedactor();
  redactor.add(standin);
  const logs: string[] = [];
  const calls = new SqliteCallLog(paths.callsDb);
  const clock = { t: 1_700_000_000_000 };
  const keys = options.keys ?? {};
  const search: SearchDeps = {
    providers: options.providers ?? ["brave", "tavily", "searxng", "exa"],
    exaAuth: options.exaAuth ?? (options.keys?.exa ? "api_key" : "keyless"),
    keys: async (name) => keys[name] ?? null,
    ...(options.searxng === false ? {} : { searxngUrl: fakeUrl + (options.searxngPath ?? "") }),
    endpoints: { brave: fakeUrl, tavily: fakeUrl, exa: fakeUrl, searxng: fakeUrl + (options.searxngPath ?? "") },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
  const app = createGatewayApp({
    standin,
    tokens: {
      accessToken: async () => "unused-access-token",
      status: async () => ({ signedIn: false, accessExpiresInS: null }),
    },
    calls,
    models: () => [],
    version: "0.0.0-test",
    upstreams: DEFAULT_UPSTREAMS,
    redactor,
    log: createLogger({ service: "gateway", level: "debug", write: (line) => void logs.push(line) }),
    now: () => clock.t,
    ...(options.noSearch ? {} : { search }),
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const search$ = (body: unknown, o: { token?: string | null; step?: string; raw?: string } = {}) =>
    fetch(`${base}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? standin}` }),
        ...(o.step ? { [STEP_ID_HEADER]: o.step } : {}),
      },
      body: o.raw ?? JSON.stringify(body),
    });

  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

  return {
    base,
    fakeUrl,
    searchDeps: search,
    standin,
    logs,
    clock,
    requests,
    forProvider: (p: ProviderId) => requests.filter((r) => r.provider === p),
    on: (p: ProviderId, h: FakeSearchHandler | FakeSearchReply) =>
      void handlers.set(p, typeof h === "function" ? h : () => h),
    search: search$,
    getCalls: async (stepId: string) =>
      (await (
        await fetch(`${base}/calls?stepId=${encodeURIComponent(stepId)}`, {
          headers: { authorization: `Bearer ${standin}` },
        })
      ).json()) as GatewayCallRecord[],
    /** Raw bytes of every file the gateway wrote (SQLite incl. -wal/-shm). */
    files: () => walk(dir).map((f) => readFileSync(f)),
    stop: async () => {
      for (const s of sockets) s.destroy();
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => fake.close(() => resolve()));
      calls.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type SearchRig = Awaited<ReturnType<typeof startSearchRig>>;
