// Callers, scopes, budgets and the two apps (docs/adr/0018). The apps are driven in process with a scripted upstream.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "@rei/logging";
import type { GatewayCaller, GatewayCallerCreated, GatewayCallRecord, GatewayCallsSummary } from "@rei/protocol";
import { PROVIDER_HEADER, STEP_ID_HEADER, UPSTREAM_HEADER } from "@rei/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBudgets } from "../src/core/budget.ts";
import type { Caller } from "../src/core/callers.ts";
import { DEFAULT_OUTSIDE_BUDGET, parseBudget, scopeFor, UNCAPPED_BUDGET } from "../src/core/callers.ts";
import { createGatewayApps } from "../src/core/proxy.ts";
import { createRedactor } from "../src/core/redact.ts";
import type { SecretStore } from "../src/core/secrets.ts";
import type { GatewayDeps, ProviderManager } from "../src/core/types.ts";
import { DEFAULT_UPSTREAMS } from "../src/core/upstream.ts";
import { callersCommand } from "../src/node/callers-cli.ts";
import { SqliteCallLog } from "../src/node/calllog.ts";
import { loadConfig, parseListen, parseReiBudget } from "../src/node/config.ts";
import { FileSecretStore } from "../src/node/secretstore.ts";

const REI = "rei-token-0123456789abcdef";
const UPSTREAM = "https://api.openai.com/v1/responses";

function memorySecrets(): SecretStore {
  const data = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    read: async <T>(key: string) => {
      await chain.catch(() => {});
      return data.get(key) as T | undefined;
    },
    modify<T>(key: string, fn: (current: T | undefined) => T | undefined) {
      const run = chain
        .catch(() => {})
        .then(() => {
          const next = fn(data.get(key) as T | undefined);
          if (next === undefined) data.delete(key);
          else data.set(key, next);
          return next;
        });
      chain = run.catch(() => {});
      return run;
    },
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gateway-callers-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

interface WorldOptions extends Partial<GatewayDeps> {
  upstream?: (url: string, init: RequestInit) => Response | Promise<Response>;
}

function world(options: WorldOptions = {}) {
  const { upstream, ...deps } = options;
  const logs: string[] = [];
  const upstreamUrls: string[] = [];
  const redactor = createRedactor();
  const calls = new SqliteCallLog(join(tmp, `calls-${Math.random().toString(36).slice(2)}.sqlite`));
  const secrets = deps.secrets ?? memorySecrets();
  const apps = createGatewayApps({
    standin: REI,
    tokens: {
      accessToken: async () => "real-upstream-token-000000",
      status: async () => ({ signedIn: true, accessExpiresInS: 60 }),
    },
    calls,
    models: () => [],
    version: "test",
    upstreams: DEFAULT_UPSTREAMS,
    redactor,
    log: createLogger({ service: "gateway", level: "debug", write: (line) => void logs.push(line) }),
    secrets,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      upstreamUrls.push(String(input));
      return upstream ? upstream(String(input), init ?? {}) : Response.json({ ok: true });
    }) as typeof fetch,
    ...deps,
  });
  const send = (
    app: "internal" | "shared",
    path: string,
    o: { token?: string | null; method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    apps[app].request(`http://gateway${path}`, {
      method: o.method ?? (o.body === undefined ? "GET" : "POST"),
      headers: {
        ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? REI}` }),
        ...(o.body === undefined ? {} : { "content-type": "application/json" }),
        ...o.headers,
      },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    });
  /** A model call. Its body is read to the end (which is what ends the call) unless `stream` asks for it open. */
  const model = async (
    token: string,
    o: { app?: "internal" | "shared"; headers?: Record<string, string>; stream?: boolean } = {},
  ) => {
    const res = await send(o.app ?? "internal", "/v1/responses", {
      token,
      body: { model: "m", input: "hi" },
      headers: { [UPSTREAM_HEADER]: UPSTREAM, ...o.headers },
    });
    if (o.stream) return res;
    return new Response(await res.text(), { status: res.status, headers: res.headers });
  };
  const create = async (id: string, extra: Record<string, unknown> = {}) => {
    const res = await send("internal", "/callers", { body: { id, ...extra } });
    expect(res.status).toBe(201);
    return (await res.json()) as GatewayCallerCreated;
  };
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
  return { apps, send, model, create, code, logs, calls, secrets, upstreamUrls };
}

/** An upstream whose body stays open until `end()`. */
function heldStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: () => new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    end: () => controller.close(),
  };
}

const ADMIN_PATHS = [
  "/calls",
  "/calls/summary",
  "/callers",
  "/providers",
  "/mcp/connectors",
  "/notify/webpush/key",
  "/setup/search",
  "/setup/embedding",
];

describe("authorization by caller", () => {
  it("refuses a missing, wrong or unknown token on every guarded route", async () => {
    const w = world();
    const unknown = `gw.nobody.${"A".repeat(43)}`;
    for (const path of [...ADMIN_PATHS, "/v1/responses", "/search", "/embedding/v1/models"])
      for (const token of [null, "wrong-token-000000000000", unknown, "gw.bad"]) {
        const res = await w.send("internal", path, { token });
        expect(res.status, `${path} ${token}`).toBe(401);
        expect(await w.code(res)).toBe("bad_token");
      }
    expect(w.upstreamUrls).toEqual([]);
  });

  it("leaves /healthz and /status open on the internal app", async () => {
    const w = world();
    expect((await w.send("internal", "/healthz", { token: null })).status).toBe(200);
    expect((await w.send("internal", "/status", { token: null })).status).toBe(200);
  });

  it("guards every registered route: none answers without a token", async () => {
    const w = world();
    const seen = new Set<string>();
    for (const route of w.apps.internal.routes) {
      if (route.path === "*" || route.path === "/healthz" || route.path === "/status") continue;
      const path = route.path.replace(/:[a-z]+/gi, "x").replace(/\*$/, "x");
      const method = route.method === "ALL" ? "POST" : route.method;
      seen.add(route.path);
      const res = await w.send("internal", path, { token: null, method });
      expect(res.status, `${method} ${route.path}`).toBe(401);
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  it("an unlisted path needs the admin scope, so it is never open", () => {
    expect(scopeFor("/v1/responses")).toBe("models");
    expect(scopeFor("/search")).toBe("search");
    expect(scopeFor("/embedding/v1/embeddings")).toBe("embeddings");
    expect(scopeFor("/read")).toBe("read");
    for (const path of [
      "/v1",
      "/search/",
      "/read/",
      "/READ",
      "/embedding",
      "/CALLS",
      "/anything/new",
      "/V1/responses",
      "/statusx",
    ])
      expect(scopeFor(path), path).toBe("admin");
  });

  it("lets a caller with only the models scope use /v1 and nothing else", async () => {
    const w = world();
    const { token } = await w.create("batch", { scopes: ["models"] });
    expect((await w.model(token)).status).toBe(200);
    for (const path of [...ADMIN_PATHS, "/search", "/read", "/embedding/v1/models"]) {
      const res = await w.send("internal", path, { token });
      expect(res.status, path).toBe(403);
      expect(await w.code(res)).toBe("route_not_allowed");
    }
    // Paths shaped to slip past the table: each is refused or simply is not the admin handler.
    for (const path of ["//calls", "/v1/../calls", "/v1/%2e%2e/calls", "/CALLS", "/calls/", "/callers/x/revoke"])
      for (const method of ["GET", "POST", "HEAD", "OPTIONS"]) {
        const res = await w.send("internal", path, { token, method });
        expect([401, 403, 404], `${method} ${path}`).toContain(res.status);
        if (res.status === 200) throw new Error(`${method} ${path} was served`);
      }
    expect(w.calls.recent(100).every((r) => r.caller !== "batch" || r.provider === "openai")).toBe(true);
    expect((await w.send("internal", "/callers")).status).toBe(200);
  });
});

describe("caller store", () => {
  it("creates a caller whose token works, lists it without secrets and survives a restart", async () => {
    const file = join(tmp, "secret", "gateway-state.json");
    const secrets = new FileSecretStore(file);
    const w = world({ secrets });
    const created = await w.create("worker", { note: "a note" });
    expect(created.token).toMatch(/^gw\.worker\.[A-Za-z0-9_-]{43}$/);
    expect(created.caller).toMatchObject({
      id: "worker",
      scopes: ["models", "search", "embeddings", "read"],
      source: "store",
    });
    expect(created.caller.budget).toEqual(DEFAULT_OUTSIDE_BUDGET);
    expect((await w.model(created.token)).status).toBe(200);

    const stored = readFileSync(file, "utf8");
    expect(stored).not.toContain(created.token);
    expect(stored).not.toContain(created.token.split(".")[2]);
    expect(w.logs.join("\n")).not.toContain(created.token);
    expect(w.logs.some((l) => l.includes("callers.created"))).toBe(true);

    const listed = ((await (await w.send("internal", "/callers")).json()) as { callers: GatewayCaller[] }).callers;
    expect(listed.map((c) => c.id)).toEqual(["rei", "worker"]);
    expect(listed[0]).toMatchObject({
      source: "environment",
      scopes: ["models", "search", "embeddings", "read", "read-local", "admin"],
    });
    expect(listed[1]!.lastUsedAt).toBeTypeOf("number");
    expect(JSON.stringify(listed)).not.toMatch(/sha256"|[0-9a-f]{64}/);

    const again = world({ secrets: new FileSecretStore(file) });
    expect((await again.model(created.token)).status).toBe(200);
  });

  it("validates ids, reserves rei and never reuses an id", async () => {
    const w = world();
    for (const id of ["", "Upper", "-lead", "a".repeat(41), "has space", 7])
      expect((await w.send("internal", "/callers", { body: { id } })).status, String(id)).toBe(400);
    const reserved = await w.send("internal", "/callers", { body: { id: "rei" } });
    expect([reserved.status, await w.code(reserved)]).toEqual([409, "caller_exists"]);
    await w.create("once");
    await w.send("internal", "/callers/once/revoke", { body: {} });
    const reuse = await w.send("internal", "/callers", { body: { id: "once" } });
    expect([reuse.status, await w.code(reuse)]).toEqual([409, "caller_exists"]);
    expect((await w.send("internal", "/callers", { body: { id: "x", scopes: ["admin"] } })).status).toBe(400);
    expect((await w.send("internal", "/callers", { body: { id: "x", budget: { search: 99 } } })).status).toBe(400);
  });

  it("keeps the old token for the grace after a rotation, then only the new one works", async () => {
    let now = 1_000_000;
    const w = world({ now: () => now });
    const first = await w.create("rot");
    const rotated = (await (
      await w.send("internal", "/callers/rot/rotate", { body: { graceSeconds: 60 } })
    ).json()) as GatewayCallerCreated;
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.caller.fingerprints).toHaveLength(2);
    expect(rotated.caller.graceUntil).toBe(now + 60_000);
    expect((await w.model(first.token)).status).toBe(200);
    expect((await w.model(rotated.token)).status).toBe(200);
    now += 61_000;
    expect((await w.model(first.token)).status).toBe(401);
    expect((await w.model(rotated.token)).status).toBe(200);

    const atOnce = (await (
      await w.send("internal", "/callers/rot/rotate", { body: { graceSeconds: 0 } })
    ).json()) as GatewayCallerCreated;
    expect((await w.model(rotated.token)).status).toBe(401);
    expect((await w.model(atOnce.token)).status).toBe(200);
  });

  it("revokes at once, and does not manage Rei's own caller", async () => {
    const w = world();
    const { token } = await w.create("gone");
    const revoked = await w.send("internal", "/callers/gone/revoke", { body: {} });
    expect(((await revoked.json()) as { caller: GatewayCaller }).caller.revokedAt).toBeTypeOf("number");
    expect((await w.model(token)).status).toBe(401);
    for (const [path, method] of [
      ["/callers/rei", "PATCH"],
      ["/callers/rei/rotate", "POST"],
      ["/callers/rei/revoke", "POST"],
    ] as const) {
      const res = await w.send("internal", path, { method, body: {} });
      expect([res.status, await w.code(res)]).toEqual([400, "caller_managed_by_environment"]);
    }
    expect((await w.send("internal", "/callers/none/revoke", { body: {} })).status).toBe(404);
    expect((await w.model(REI)).status).toBe(200);
  });

  it("persists two callers created at the same time", async () => {
    const w = world();
    await Promise.all([w.create("one"), w.create("two")]);
    const listed = ((await (await w.send("internal", "/callers")).json()) as { callers: GatewayCaller[] }).callers;
    expect(listed.map((c) => c.id).sort()).toEqual(["one", "rei", "two"]);
  });

  it("changes scopes and budget through PATCH", async () => {
    const w = world();
    const { token } = await w.create("patchy");
    const res = await w.send("internal", "/callers/patchy", {
      method: "PATCH",
      body: { scopes: ["search"], budget: { providers: { openai: 0 }, search: null } },
    });
    const { caller } = (await res.json()) as { caller: GatewayCaller };
    expect(caller.scopes).toEqual(["search"]);
    expect(caller.budget).toEqual({
      providers: { openai: 0 },
      defaultProvider: 1,
      search: null,
      embeddings: 2,
      reads: 2,
    });
    expect((await w.model(token)).status).toBe(403);
  });
});

describe("call records", () => {
  it("names the caller and the provider, and keeps one caller's step from another", async () => {
    const w = world();
    const a = await w.create("aa");
    const b = await w.create("bb");
    await w.model(a.token, { headers: { [STEP_ID_HEADER]: "same-step" } });
    await w.model(b.token, { headers: { [STEP_ID_HEADER]: "same-step" } });
    await w.model(REI, { headers: { [STEP_ID_HEADER]: "same-step" } });
    const mine = (await (await w.send("internal", "/calls?stepId=same-step")).json()) as GatewayCallRecord[];
    expect(mine.map((r) => [r.caller, r.provider])).toEqual([["rei", "openai"]]);
    const filtered = (await (await w.send("internal", "/calls?caller=aa")).json()) as GatewayCallRecord[];
    expect(filtered.map((r) => r.caller)).toEqual(["aa"]);
    const all = (await (await w.send("internal", "/calls")).json()) as GatewayCallRecord[];
    expect(all.map((r) => r.caller).sort()).toEqual(["aa", "bb", "rei"]);
    expect(w.logs.some((l) => l.includes('"caller":"aa"') && l.includes('"call"'))).toBe(true);
  });

  it("records an embedding call with its token count", async () => {
    const w = world({
      embedding: { baseUrl: "https://embedding.test", apiModel: "emb" },
      upstream: () =>
        Response.json({ model: "emb", data: [{ index: 0, embedding: [0.1] }], usage: { prompt_tokens: 7 } }),
    });
    const { token } = await w.create("embedder");
    const ok = await w.send("shared", "/embedding/v1/embeddings", {
      token,
      body: { model: "emb", input: ["text"], encoding_format: "float" },
    });
    expect(ok.status).toBe(200);
    const bad = await w.send("shared", "/embedding/v1/embeddings", { token, body: { model: "other" } });
    expect(bad.status).toBe(400);
    const rows = w.calls.recent(10, "embedder");
    expect(
      rows.map((r) => [r.provider, r.model, r.status, r.usage?.inputTokens ?? null, r.error?.code ?? null]),
    ).toEqual([
      ["embedding", "emb", 400, null, "http_400"],
      ["embedding", "emb", 200, 7, null],
    ]);
  });

  it("sums calls per caller and provider", async () => {
    const w = world({
      upstream: () => Response.json({ usage: { input_tokens: 5, output_tokens: 2 } }),
    });
    const { token } = await w.create("sum");
    await w.model(token);
    await w.model(token);
    await w.model(REI);
    const summary = (await (await w.send("internal", "/calls/summary?since=1")).json()) as GatewayCallsSummary;
    expect(summary.rows.map((r) => [r.caller, r.provider, r.calls, r.ok, r.inputTokens])).toEqual([
      ["rei", "openai", 1, 1, 5],
      ["sum", "openai", 2, 2, 10],
    ]);
    expect(summary.refusals).toEqual([]);
  });
});

describe("call log schema", () => {
  const OLD_SCHEMA = `CREATE TABLE calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, step_id TEXT, model TEXT, started_at INTEGER NOT NULL,
    first_byte_ms INTEGER, total_ms INTEGER, status INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
    cached_tokens INTEGER, limit_resets_s INTEGER, limit_code TEXT, limit_headers TEXT, error_code TEXT)`;

  it("migrates a store from before callers, once", () => {
    const file = join(tmp, "old.sqlite");
    const old = new DatabaseSync(file);
    old.exec(OLD_SCHEMA);
    old.prepare("INSERT INTO calls (step_id, model, started_at, status) VALUES ('s', 'm', ?, 200)").run(Date.now());
    old.close();
    for (let pass = 0; pass < 2; pass++) {
      const log = new SqliteCallLog(file);
      expect(log.recent(10).map((r) => [r.caller, r.provider, r.stepId])).toEqual([["rei", null, "s"]]);
      expect(log.byStep("s", "rei")).toHaveLength(1);
      log.close();
    }
    const check = new DatabaseSync(file);
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    check.close();
  });

  it("backfills daily usage on migration and keeps it forever after calls prune", () => {
    const day1 = Date.parse("2026-10-01T12:00:00Z");
    const day2 = Date.parse("2026-11-20T12:00:00Z");
    const file = join(tmp, "daily-backfill.sqlite");
    const v1 = new DatabaseSync(file);
    v1.exec(`
      CREATE TABLE calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, caller TEXT, provider TEXT, step_id TEXT, model TEXT,
        started_at INTEGER NOT NULL, first_byte_ms INTEGER, total_ms INTEGER, status INTEGER NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
        limit_resets_s INTEGER, limit_code TEXT, limit_headers TEXT, error_code TEXT
      );
      PRAGMA user_version = 1;
    `);
    v1.prepare(
      `INSERT INTO calls (caller, provider, model, started_at, total_ms, status, input_tokens, output_tokens, cached_tokens)
       VALUES ('reports', 'openai', 'gpt-5', ?, 400, 200, 1000, 200, 250)`,
    ).run(day1);
    v1.close();

    // Open at day2 (>30 days later): prune() deletes the raw row, but daily usage and lastUsed survive.
    const log = new SqliteCallLog(file, { now: () => day2 });
    expect(log.count()).toBe(0);
    expect(log.trackingSince()).toBe("2026-10-01T12:00:00.000Z");
    expect(log.lastUsed().get("reports")).toBe(day1);
    const usage = log.usage("2026-10-01", "2026-11-20", "reports");
    expect(usage.models.summary).toMatchObject({
      inputTotal: 1000,
      inputCached: 250,
      inputUncached: 750,
      outputTotal: 200,
      totalProcessed: 1200,
      cacheHitPercent: 25,
      calls: 1,
      callsReported: 1,
      callsUnreported: 0,
      ok: 1,
      errors: 0,
    });
    log.close();
  });

  it("caps rows per caller, so one caller cannot push out another's", () => {
    const log = new SqliteCallLog(join(tmp, "prune.sqlite"), { maxRows: 3, maxAgeMs: 1e12 });
    const row = (caller: string, stepId: string): GatewayCallRecord => ({
      caller,
      provider: "openai",
      stepId,
      model: "m",
      startedAt: Date.now(),
      firstByteMs: 1,
      totalMs: 1,
      status: 200,
      usage: null,
      limit: null,
      error: null,
    });
    log.insert(row("quiet", "q1"));
    for (let i = 0; i < 20; i++) log.insert(row("busy", `b${i}`));
    log.prune();
    expect(log.recent(100, "quiet").map((r) => r.stepId)).toEqual(["q1"]);
    expect(log.recent(100, "busy").map((r) => r.stepId)).toEqual(["b19", "b18", "b17"]);
    expect([...log.lastUsed().keys()].sort()).toEqual(["busy", "quiet"]);
    log.close();
  });
});

describe("budgets", () => {
  const caller = (id: string, budget = DEFAULT_OUTSIDE_BUDGET): Caller => ({
    id,
    scopes: ["models"],
    budget,
    source: "store",
  });

  it("caps calls in flight per caller and provider, and nothing else", () => {
    const budgets = createBudgets();
    const a = caller("a");
    const first = budgets.admit(a, "models", "openai");
    expect(first).toMatchObject({ ok: true, capped: true });
    expect(budgets.admit(a, "models", "openai")).toMatchObject({
      ok: false,
      status: 429,
      code: "caller_concurrency",
      retryAfterS: 2,
    });
    expect(budgets.admit(a, "models", "other")).toMatchObject({ ok: true });
    expect(budgets.admit(caller("b"), "models", "openai")).toMatchObject({ ok: true });
    if (first.ok) {
      first.release();
      first.release(); // a second release frees nothing more
    }
    expect(budgets.admit(a, "models", "openai")).toMatchObject({ ok: true });
    expect(budgets.admit(a, "models", "openai")).toMatchObject({ ok: false });
    expect(budgets.snapshot().refusals).toEqual([{ caller: "a", code: "caller_concurrency", count: 2 }]);
  });

  it("refuses a provider capped at 0 before it counts, and never refuses without a cap", () => {
    const budgets = createBudgets();
    const barred = caller("barred", { ...DEFAULT_OUTSIDE_BUDGET, providers: { openai: 0 } });
    expect(budgets.admit(barred, "models", "openai")).toMatchObject({
      ok: false,
      status: 403,
      code: "provider_not_allowed",
    });
    const free = caller("free", UNCAPPED_BUDGET);
    for (let i = 0; i < 50; i++)
      expect(budgets.admit(free, "models", "openai")).toMatchObject({ ok: true, capped: false });
    expect(budgets.snapshot().inFlight).toEqual([]);
  });

  it("reads a partial budget over a base and rejects bad values", () => {
    expect(parseBudget({ providers: { openai: 2 }, search: null }, DEFAULT_OUTSIDE_BUDGET)).toEqual({
      providers: { openai: 2 },
      defaultProvider: 1,
      search: null,
      embeddings: 2,
      reads: 2,
    });
    for (const bad of [
      { search: 17 },
      { search: -1 },
      { search: 1.5 },
      { providers: { "Bad Id": 1 } },
      { extra: 1 },
      [],
    ])
      expect(() => parseBudget(bad, DEFAULT_OUTSIDE_BUDGET), JSON.stringify(bad)).toThrow();
  });

  it("answers 429 with the contract while a call is in flight, and admits again when it ends", async () => {
    const held = heldStream();
    let hold = true;
    const w = world({ upstream: () => (hold ? held.response() : Response.json({ ok: true })) });
    const a = await w.create("aa");
    const b = await w.create("bb");
    const first = await w.model(a.token, { stream: true });
    expect(first.status).toBe(200);
    hold = false;

    const refused = await w.model(a.token, { app: "shared" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("2");
    expect(refused.headers.get("x-rei-refused-by")).toBe("gateway");
    expect(await refused.json()).toEqual({
      error: {
        code: "caller_concurrency",
        message: "This caller has its maximum calls to this provider in flight; try again shortly.",
        retryAfterS: 2,
      },
    });
    // Another caller, and Rei, are not affected; a refusal is not a call record.
    expect((await w.model(b.token)).status).toBe(200);
    expect((await w.model(REI)).status).toBe(200);
    expect(w.calls.recent(10, "aa")).toHaveLength(0);

    held.end();
    await first.text();
    expect((await w.model(a.token)).status).toBe(200);
    const summary = (await (await w.send("internal", "/calls/summary")).json()) as GatewayCallsSummary;
    expect(summary.refusals).toEqual([{ caller: "aa", code: "caller_concurrency", count: 1 }]);
    expect(w.logs.some((l) => l.includes("budget.refused"))).toBe(true);
  });

  it("frees the slot when the client stops reading, and on every early failure", async () => {
    const held = heldStream();
    let mode: "hold" | "throw" | "ok" = "hold";
    const w = world({
      upstream: () => {
        if (mode === "throw") throw new Error("down");
        return mode === "hold" ? held.response() : Response.json({ ok: true });
      },
    });
    const { token } = await w.create("aa");
    const first = await w.model(token, { stream: true });
    await first.body!.cancel();
    mode = "throw";
    expect((await w.model(token)).status).toBe(502);
    expect((await w.model(token, { headers: { [UPSTREAM_HEADER]: "https://evil.example/v1/x" } })).status).toBe(403);
    mode = "ok";
    expect((await w.model(token)).status).toBe(200);
    expect(w.calls.recent(10, "aa").map((r) => r.error?.code ?? null)).toEqual([
      null,
      "upstream_not_allowed",
      "upstream_unreachable",
      "client_aborted",
    ]);
  });

  it("passes an upstream 429 through and keeps sending later calls upstream", async () => {
    let limited = true;
    const w = world({
      upstream: () =>
        limited
          ? new Response(JSON.stringify({ error: { message: "rate limit" } }), {
              status: 429,
              headers: { "retry-after": "30" },
            })
          : Response.json({ ok: true }),
    });
    const { token } = await w.create("aa");
    const res = await w.model(token);
    expect(res.status).toBe(429);
    expect(res.headers.get("x-rei-refused-by")).toBeNull();
    await res.text();
    limited = false;
    expect((await w.model(token)).status).toBe(200);
    expect(w.upstreamUrls).toHaveLength(2);
  });

  it("cuts a capped call whose reader stalled, records it and frees the slot", async () => {
    const held = heldStream();
    let hold = true;
    const w = world({ cappedCallMaxMs: 40, upstream: () => (hold ? held.response() : Response.json({ ok: true })) });
    const { token } = await w.create("aa");
    const stalled = await w.model(token, { stream: true });
    expect(stalled.status).toBe(200);
    hold = false;
    expect((await w.model(token)).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(w.calls.recent(10, "aa").map((r) => r.error?.code)).toEqual(["capped_call_timeout"]);
    expect((await w.model(token)).status).toBe(200);
    await expect(stalled.text()).rejects.toThrow();
  });

  it("does not cap Rei unless a budget is set for it", async () => {
    const helds = [heldStream(), heldStream(), heldStream()];
    let n = 0;
    const free = world({ cappedCallMaxMs: 30, upstream: () => helds[n++]!.response() });
    for (let i = 0; i < 3; i++) expect((await free.model(REI, { stream: true })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(free.calls.recent(10)).toHaveLength(0); // no ceiling: all three still run

    const held = heldStream();
    const capped = world({
      reiBudget: { ...UNCAPPED_BUDGET, providers: { openai: 1 } },
      upstream: () => held.response(),
    });
    expect((await capped.model(REI, { stream: true })).status).toBe(200);
    expect((await capped.model(REI)).status).toBe(429);
  });

  it("skips subscription search for a caller barred from the subscription", async () => {
    const asked: string[] = [];
    const w = world({
      search: {
        providers: ["codex-subscription", "exa"],
        exaAuth: "keyless",
        keys: async () => null,
        subscription: {
          accessToken: async () => {
            asked.push("subscription");
            throw new Error("should be skipped for the barred caller");
          },
        } as never,
      },
      upstream: (url) => {
        asked.push(new URL(url).host);
        return new Response("", { status: 500 });
      },
    });
    const barred = await w.create("barred", { budget: { providers: { openai: 0 } } });
    const res = await w.send("shared", "/search", { token: barred.token, body: { query: "q" } });
    const trace = ((await res.json()) as { attempts: { provider: string }[] }).attempts;
    expect(trace.map((a) => a.provider)).toEqual(["exa"]);
    expect(asked).not.toContain("subscription");
    expect(w.calls.recent(10, "barred").every((r) => r.provider === "search")).toBe(true);
  });
});

describe("the shared app", () => {
  it("serves models to an outside caller and has no other route, whoever asks", async () => {
    const w = world();
    const { token } = await w.create("out");
    expect((await w.model(token, { app: "shared" })).status).toBe(200);
    expect((await w.send("shared", "/healthz", { token: null })).status).toBe(200);
    for (const path of [...ADMIN_PATHS, "/status", "/nothing"])
      for (const who of [REI, token, null]) {
        const res = await w.send("shared", path, { token: who });
        expect(res.status, `${path} ${who === REI ? "rei" : who ? "outside" : "none"}`).toBe(404);
      }
    expect((await w.send("shared", "/v1/responses", { token: null, body: {} })).status).toBe(401);
  });

  it("shares one budget with the internal app", async () => {
    const held = heldStream();
    const w = world({ upstream: () => held.response() });
    const { token } = await w.create("out");
    expect((await w.model(token, { app: "shared", stream: true })).status).toBe(200);
    expect((await w.model(token, { app: "internal" })).status).toBe(429);
  });
});

describe("derived upstream", () => {
  const providers = {
    list: async () => [
      {
        id: "local",
        name: "Local",
        kind: "openai-compatible",
        auth: "api_key",
        connected: true,
        baseUrl: "http://127.0.0.1:9000/v1",
        models: [],
      },
    ],
    upstreams: async () => [{ protocol: "http:", host: "127.0.0.1", port: "9000", pathPrefix: "/v1/" }],
    token: async () => "local-key-0000000000",
  } as unknown as ProviderManager;

  it("builds the upstream from the provider and the path when the header is absent", async () => {
    const w = world({ providers });
    const { token } = await w.create("sdk");
    const call = async (headers: Record<string, string>, path = "/v1/chat/completions?x=1") => {
      const res = await w.send("shared", path, { token, body: { model: "m" }, headers });
      return new Response(await res.text(), { status: res.status });
    };
    expect((await call({})).status).toBe(200);
    expect((await call({ [PROVIDER_HEADER]: "local" })).status).toBe(200);
    expect((await call({ [UPSTREAM_HEADER]: UPSTREAM })).status).toBe(200);
    expect(w.upstreamUrls).toEqual([
      "https://api.openai.com/v1/chat/completions?x=1",
      "http://127.0.0.1:9000/v1/chat/completions?x=1",
      UPSTREAM,
    ]);
    const unknown = await call({ [PROVIDER_HEADER]: "nope" });
    expect([unknown.status, await w.code(unknown)]).toEqual([400, "missing_upstream"]);
  });

  it("accepts a provider's name for its id, unless the name is shared", async () => {
    const row = (id: string, name: string, port: number) => ({
      id,
      name,
      kind: "openai-compatible",
      auth: "api_key",
      connected: true,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [],
    });
    const named = {
      list: async () => [
        row("a894560a-4d6", "bailian", 9001),
        row("05217c20-b51", "Model Scope", 9002),
        row("x1", "twin", 9003),
        row("x2", "Twin", 9004),
      ],
      upstreams: async () =>
        [9001, 9002, 9003, 9004].map((port) => ({
          protocol: "http:",
          host: "127.0.0.1",
          port: String(port),
          pathPrefix: "/v1/",
        })),
      token: async () => "local-key-0000000000",
    } as unknown as ProviderManager;
    const w = world({ providers: named });
    const { token } = await w.create("sdk");
    const call = async (provider: string) => {
      const res = await w.send("shared", "/v1/models", { token, body: {}, headers: { [PROVIDER_HEADER]: provider } });
      // Reading the body frees the caller's slot.
      if (res.status === 200) return [res.status, await res.text().then(() => "")];
      return [res.status, await w.code(res)];
    };
    expect(await call("bailian")).toEqual([200, ""]);
    expect(await call("BAILIAN")).toEqual([200, ""]);
    expect(await call("a894560a-4d6")).toEqual([200, ""]);
    expect(await call("Model_Scope")).toEqual([200, ""]);
    expect(await call("twin")).toEqual([400, "ambiguous_provider"]);
    expect(await call("x2")).toEqual([200, ""]);
    expect(w.upstreamUrls).toEqual([
      "http://127.0.0.1:9001/v1/models",
      "http://127.0.0.1:9001/v1/models",
      "http://127.0.0.1:9001/v1/models",
      "http://127.0.0.1:9002/v1/models",
      "http://127.0.0.1:9004/v1/models",
    ]);
  });
});

describe("configuration", () => {
  const base = { REI_STANDIN: REI };
  it("reads a list of hosts, the shared listener, Rei's budget and the ceiling", () => {
    const plain = loadConfig(base);
    expect([plain.hosts, plain.sharedListen, plain.reiBudget, plain.cappedCallMaxMs]).toEqual([
      ["0.0.0.0"],
      undefined,
      undefined,
      600_000,
    ]);
    const set = loadConfig({
      ...base,
      GATEWAY_HOST: "10.0.0.2, 127.0.0.1",
      GATEWAY_SHARED_LISTEN: "10.0.1.2:8781",
      GATEWAY_REI_BUDGET: '{"providers":{"openai":3}}',
      GATEWAY_CAPPED_CALL_MAX_MS: "5000",
    });
    expect(set.hosts).toEqual(["10.0.0.2", "127.0.0.1"]);
    expect(set.sharedListen).toEqual({ host: "10.0.1.2", port: 8781 });
    expect(set.reiBudget).toEqual({
      providers: { openai: 3 },
      defaultProvider: null,
      search: null,
      embeddings: null,
      reads: null,
    });
    expect(set.cappedCallMaxMs).toBe(5000);
  });
  it("stops on a bad listener or budget instead of ignoring it", () => {
    expect(parseListen("[::1]:8781")).toEqual({ host: "::1", port: 8781 });
    for (const bad of ["8781", "host:", "host:99999", "a b:1"]) expect(() => parseListen(bad), bad).toThrow();
    for (const bad of ["{", '{"search":-1}', '{"nope":1}'])
      expect(() => parseReiBudget(bad), bad).toThrow(/GATEWAY_REI_BUDGET/);
    expect(() => loadConfig({ ...base, GATEWAY_CAPPED_CALL_MAX_MS: "10" })).toThrow();
  });
});

describe("the callers command", () => {
  const run = async (w: ReturnType<typeof world>, argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await callersCommand(argv, {
      baseUrl: "http://gateway",
      token: REI,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        w.apps.internal.request(String(input), init)) as typeof fetch,
      out: (line) => void out.push(line),
      err: (line) => void err.push(line),
    });
    return { code, out, err };
  };

  it("adds, lists, changes, rotates and revokes a caller, and prints usage", async () => {
    const w = world();
    const added = await run(w, [
      "add",
      "cli",
      "--note",
      "from the cli",
      "--provider",
      "openai=2",
      "--search",
      "none",
      "--scopes",
      "models,search",
    ]);
    expect(added.code).toBe(0);
    const token = added.out.at(-1)!;
    expect(token).toMatch(/^gw\.cli\./);
    expect(added.out.join("\n")).toContain("openai=2 other providers=1 search=none embeddings=2 reads=2");
    expect((await w.model(token)).status).toBe(200);

    expect((await run(w, ["set", "cli", "--embeddings=0"])).out.join("\n")).toContain("embeddings=0");
    const listed = await run(w, ["list"]);
    expect(listed.out.join("\n")).toMatch(/rei {2}environment/);
    expect(listed.out.join("\n")).toContain("note: from the cli");
    expect(listed.out.join("\n")).not.toContain(token);

    const rotated = await run(w, ["rotate", "cli", "--grace", "0"]);
    expect(rotated.out.at(-1)).not.toBe(token);
    expect((await w.model(token)).status).toBe(401);
    expect((await run(w, ["usage", "--since", "1h"])).out.join("\n")).toMatch(/cli {2}openai {2}calls 1/);
    expect((await run(w, ["revoke", "cli"])).out.join("\n")).toContain("revoked");
  });

  it("explains a bad command and a refusal", async () => {
    const w = world();
    expect((await run(w, ["nope"])).code).toBe(2);
    expect((await run(w, ["add"])).code).toBe(2);
    expect((await run(w, ["add", "x", "--search", "many"])).code).toBe(2);
    const refused = await run(w, ["revoke", "rei"]);
    expect(refused.code).toBe(1);
    expect(refused.err.join("\n")).toContain("caller_managed_by_environment");
  });
});

it("only mounts Codex Images for Rei on the internal listener when enabled", async () => {
  const body = { prompt: "draw", references: [{ type: "image/png", base64: "AQID" }] };
  const render = async (prompt: string, images: string[]) => {
    expect(prompt).toBe("draw");
    expect(images).toEqual(["data:image/png;base64,AQID"]);
    return new Uint8Array([4, 5, 6]);
  };
  const enabled = world({ codexImages: render });
  const other = await enabled.create("reporter");
  expect((await enabled.send("shared", "/codex-images", { body })).status).toBe(404);
  expect((await enabled.send("internal", "/codex-images", { token: other.token, body })).status).toBe(403);
  expect((await enabled.send("internal", "/codex-images", { token: null, body })).status).toBe(401);
  expect((await world().send("internal", "/codex-images", { body })).status).toBe(404);
  const result = await enabled.send("internal", "/codex-images", { body });
  expect(result.status).toBe(200);
  expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([4, 5, 6]);
  expect(
    (
      await enabled.send("internal", "/codex-images", {
        body: { prompt: "draw", references: [{ type: "image/svg+xml", base64: "AQID" }] },
      })
    ).status,
  ).toBe(400);
});

describe("gateway daily usage endpoint", () => {
  it("reserves the id 'all' alongside 'rei'", async () => {
    const w = world();
    const res = await w.send("internal", "/callers", { body: { id: "all" } });
    expect([res.status, await w.code(res)]).toEqual([409, "caller_exists"]);
  });

  it("aggregates models, services, mcp exclusion, and durable refusals for one caller and all callers", async () => {
    const now = Date.parse("2026-11-24T10:00:00Z");
    const w = world({ now: () => now });
    const reports = await w.create("reports", { budget: { providers: { openai: 0 } } });
    // Budget refusal on openai is persisted to refusals_daily.
    const refused = await w.model(reports.token);
    expect([refused.status, await w.code(refused)]).toEqual([403, "provider_not_allowed"]);

    // Insert mixed records directly to exercise models, search, embeddings, reads, mcp, and errors.
    w.calls.insert({
      caller: "rei",
      provider: "openai",
      stepId: "s1",
      model: "gpt-5",
      startedAt: now,
      firstByteMs: 50,
      totalMs: 300,
      status: 200,
      usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400 },
      limit: null,
      error: null,
    });
    w.calls.insert({
      caller: "rei",
      provider: "mcp",
      stepId: "s2",
      model: "mcp:con_1/list",
      startedAt: now,
      firstByteMs: null,
      totalMs: 80,
      status: 200,
      usage: null,
      limit: null,
      error: null,
    });
    w.calls.insert({
      caller: "reports",
      provider: "custom-a",
      stepId: "r1",
      model: "fast-1",
      startedAt: now,
      firstByteMs: 20,
      totalMs: 120,
      status: 200,
      usage: { inputTokens: 500, outputTokens: 100, cachedInputTokens: 0 },
      limit: null,
      error: null,
    });
    w.calls.insert({
      caller: "reports",
      provider: "custom-a",
      stepId: "r2",
      model: "fast-1",
      startedAt: now,
      firstByteMs: null,
      totalMs: 50,
      status: 429,
      usage: null,
      limit: { resetsInSeconds: 10, code: "rate_limit", headers: {} },
      error: { code: "rate_limited" },
    });
    w.calls.insert({
      caller: "reports",
      provider: "search",
      stepId: null,
      model: "search:brave",
      startedAt: now,
      firstByteMs: null,
      totalMs: 240,
      status: 200,
      usage: null,
      limit: null,
      error: null,
    });
    w.calls.insert({
      caller: "reports",
      provider: "embedding",
      stepId: null,
      model: "text-embedding-3-small",
      startedAt: now,
      firstByteMs: null,
      totalMs: 90,
      status: 200,
      usage: { inputTokens: 320, outputTokens: 0, cachedInputTokens: 0 },
      limit: null,
      error: null,
    });
    w.calls.insert({
      caller: "reports",
      provider: "read",
      stepId: null,
      model: "read",
      startedAt: now,
      firstByteMs: 150,
      totalMs: 150,
      status: 200,
      usage: null,
      limit: null,
      error: null,
    });

    // Guarded: outside callers and shared listener cannot read /usage.
    expect((await w.send("shared", "/usage?from=2026-11-24&to=2026-11-24")).status).toBe(404);
    expect((await w.send("internal", "/usage?from=2026-11-24&to=2026-11-24", { token: reports.token })).status).toBe(
      403,
    );
    expect((await w.send("internal", "/usage?from=2026-11-25&to=2026-11-24")).status).toBe(400);
    expect((await w.send("internal", "/usage?from=2026-02-30&to=2026-11-24")).status).toBe(400);

    // Single caller view.
    const oneRes = await w.send("internal", "/usage?from=2026-11-24&to=2026-11-24&caller=reports");
    expect(oneRes.status).toBe(200);
    const one = (await oneRes.json()) as import("@rei/protocol").GatewayUsageResponse;
    expect(one.caller).toBe("reports");
    expect(one.byCaller).toEqual([]);
    expect(one.models.summary).toMatchObject({
      inputTotal: 500,
      inputCached: 0,
      inputUncached: 500,
      outputTotal: 100,
      totalProcessed: 600,
      cacheHitPercent: 0,
      calls: 2,
      callsReported: 1,
      callsUnreported: 1,
      ok: 1,
      errors: 1,
      upstreamLimited: 1,
    });
    expect(one.models.byModel).toHaveLength(1);
    expect(one.search).toEqual({
      calls: 1,
      ok: 1,
      errors: 0,
      averageMs: 240,
      byProvider: [{ provider: "brave", calls: 1, ok: 1, errors: 0, averageMs: 240 }],
    });
    expect(one.embeddings).toEqual({ calls: 1, ok: 1, errors: 0, inputTokens: 320, averageMs: 90 });
    expect(one.reads).toEqual({ calls: 1, ok: 1, errors: 0, averageMs: 150 });
    expect(one.refusals).toEqual([{ code: "provider_not_allowed", count: 1 }]);
    expect(one.errorBreakdown).toEqual([{ code: "rate_limited", count: 1 }]);

    // Combined All view (excludes MCP from models/byCaller).
    const allRes = await w.send("internal", "/usage?from=2026-11-24&to=2026-11-24");
    expect(allRes.status).toBe(200);
    const all = (await allRes.json()) as import("@rei/protocol").GatewayUsageResponse;
    expect(all.caller).toBeNull();
    expect(all.models.summary).toMatchObject({
      inputTotal: 1500,
      inputCached: 400,
      outputTotal: 300,
      calls: 3,
    });
    expect(all.byCaller).toEqual([
      {
        caller: "reports",
        inputTotal: 500,
        inputCached: 0,
        outputTotal: 100,
        modelCalls: 2,
        searchCalls: 1,
        embeddingCalls: 1,
        readCalls: 1,
        errors: 1,
        upstreamLimited: 1,
        refusals: 1,
      },
      {
        caller: "rei",
        inputTotal: 1000,
        inputCached: 400,
        outputTotal: 200,
        modelCalls: 1,
        searchCalls: 0,
        embeddingCalls: 0,
        readCalls: 0,
        errors: 0,
        upstreamLimited: 0,
        refusals: 0,
      },
    ]);
  });
});
