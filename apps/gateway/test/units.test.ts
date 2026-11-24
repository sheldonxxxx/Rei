import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classifyUpstreamError, parseUsage, SseMeter } from "../src/core/meter.ts";
import { constantTimeEqual, createRedactor } from "../src/core/redact.ts";
import {
  checkUpstream,
  DEFAULT_UPSTREAMS,
  downstreamResponseHeaders,
  parseUpstreamRules,
  upstreamRequestHeaders,
} from "../src/core/upstream.ts";
import { SqliteCallLog } from "../src/node/calllog.ts";
import { dataPaths, loadConfig, readStandin, resolveStandin } from "../src/node/config.ts";
import { FileCredentialStore } from "../src/node/credstore.ts";
import { makeToken } from "./fake-upstream.ts";

const tmp = mkdtempSync(join(tmpdir(), "gateway-units-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const gatewayDir = new URL("..", import.meta.url).pathname;

describe("upstream allowlist", () => {
  it("accepts api.openai.com under /v1 and nothing else by default", () => {
    expect(checkUpstream("https://api.openai.com/v1/responses", DEFAULT_UPSTREAMS)?.href).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(checkUpstream("https://api.openai.com/v1/responses?x=1", DEFAULT_UPSTREAMS)).not.toBeNull();
    for (const bad of [
      null,
      "",
      "https://chatgpt.com/backend-api/x",
      "https://auth.openai.com/v1/x",
      "http://api.openai.com/v1/x",
      "https://API.OPENAI.COM.evil.test/v1/x",
    ]) {
      expect(checkUpstream(bad, DEFAULT_UPSTREAMS), String(bad)).toBeNull();
    }
  });
  it("parses extra rules for chatgpt.com/backend-api (legacy codex provider) and local test hosts", () => {
    const rules = [
      ...DEFAULT_UPSTREAMS,
      ...parseUpstreamRules("https://chatgpt.com/backend-api, http://127.0.0.1:9000"),
    ];
    expect(checkUpstream("https://chatgpt.com/backend-api/codex/responses", rules)).not.toBeNull();
    expect(checkUpstream("https://chatgpt.com/other", rules)).toBeNull();
    expect(checkUpstream("http://127.0.0.1:9000/anything", rules)).not.toBeNull();
    expect(() => parseUpstreamRules("ftp://x")).toThrow();
  });
});

describe("headers", () => {
  it("drops hop-by-hop, credential, forwarded and x-rei headers on the way up", () => {
    const incoming = new Headers({
      authorization: "Bearer standin",
      host: "gateway",
      connection: "keep-alive, x-secret-hop",
      "x-secret-hop": "1",
      "keep-alive": "5",
      "transfer-encoding": "chunked",
      "x-rei-step-id": "s",
      "x-rei-upstream": "u",
      "x-rei-other": "o",
      "x-forwarded-for": "10.0.0.1",
      "content-length": "5",
      "content-type": "application/json",
      "openai-beta": "x",
      cookie: "c=1",
    });
    const out = upstreamRequestHeaders(incoming, "REAL");
    expect([...out.keys()].sort()).toEqual(["accept-encoding", "authorization", "content-type", "openai-beta"]);
    expect(out.get("authorization")).toBe("Bearer REAL");
    expect(out.get("accept-encoding")).toBe("identity");
  });
  it("drops hop-by-hop and secret-bearing headers on the way down", () => {
    const redactor = createRedactor();
    redactor.add("real-access-token-value");
    const up = new Headers({
      "content-type": "text/event-stream",
      connection: "close",
      "keep-alive": "1",
      "set-cookie": "a=b",
      "x-echo": "Bearer real-access-token-value",
      "x-request-id": "r1",
    });
    const out = downstreamResponseHeaders(up, redactor.redact);
    expect([...out.keys()].sort()).toEqual(["content-type", "x-request-id"]);
  });
});

describe("redactor", () => {
  it("masks known values (also after rotation), bearer tokens and JWTs", () => {
    const r = createRedactor();
    const a = makeToken("access");
    const b = makeToken("refresh");
    r.add(a, b, "short");
    const text = r.redact(
      `x ${a} y ${b} z short Bearer abcdefghijklmnopqrstuvwxyz and eyJhbGciOiJSUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz123456`,
    );
    expect(text).not.toContain(a);
    expect(text).not.toContain(b);
    expect(text).toContain("short"); // under 8 characters: not treated as a secret
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("eyJhbGci");
  });
  it("compares in constant time by digest", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
    expect(await constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("meter", () => {
  it("meters Chat Completions usage and termination across split chunks", () => {
    const m = new SseMeter();
    const bytes = new TextEncoder().encode(
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
    );
    for (let i = 0; i < bytes.length; i += 7) m.feed(bytes.slice(i, i + 7));
    m.end();
    expect(m.outcome).toEqual({
      sawTerminal: true,
      error: null,
      usage: { inputTokens: 20, outputTokens: 3, cachedInputTokens: 0 },
    });
    const error = new SseMeter();
    error.feed(new TextEncoder().encode('data: {"error":{"code":"invalid_key","message":"secret-value"}}\n\n'));
    expect(error.outcome.sawTerminal).toBe(true);
    expect(error.outcome.error?.code).toBe("invalid_key");
    expect(error.outcome.error?.message).not.toContain("secret-value");
  });

  it("reads usage from a completed event split over arbitrary chunk boundaries", () => {
    const sse = `event: response.created\ndata: {"type":"response.created","response":{}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":120,"output_tokens":30,"input_tokens_details":{"cached_tokens":64}}}}\n\n`;
    const m = new SseMeter();
    const bytes = new TextEncoder().encode(sse);
    for (let i = 0; i < bytes.length; i += 7) m.feed(bytes.subarray(i, i + 7));
    m.end();
    expect(m.outcome).toEqual({
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 64 },
      error: null,
      sawTerminal: true,
    });
  });
  it("does not mistake an error field on a nonterminal event for the end of the response", () => {
    const meter = new SseMeter();
    meter.feed(new TextEncoder().encode('data: {"type":"response.created","response":{"error":null}}\n\n'));
    expect(meter.outcome.sawTerminal).toBe(false);
  });
  it("reports failed responses and error events by code only", () => {
    const m = new SseMeter();
    m.feed(
      new TextEncoder().encode(
        'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"secret detail"}}}\n\n',
      ),
    );
    expect(m.outcome.error).toEqual({ code: "server_error", message: "The upstream response failed (server_error)." });
    expect(parseUsage({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cachedInputTokens: 0,
    });
  });
  it.each([
    [{ choices: [{ finish_reason: "content_filter" }] }, "content_filter"],
    [{ choices: [{ finish_reason: "network_error" }] }, "network_error"],
    [{ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }, "content_filter"],
    [{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }, undefined],
    [{ type: "response.incomplete", response: {} }, "response_incomplete"],
  ])("records unsuccessful terminal events as failures", (event, code) => {
    const meter = new SseMeter();
    meter.feed(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    expect(meter.outcome.sawTerminal).toBe(true);
    expect(meter.outcome.error?.code).toBe(code);
  });

  it("derives reset times from the body, resets_at, or headers", () => {
    const now = 1_000_000_000_000;
    const h = (o: Record<string, string> = {}) => new Headers(o);
    expect(
      classifyUpstreamError(429, '{"error":{"type":"usage_limit_reached","resets_in_seconds":120}}', h(), now).limit
        ?.resetsInSeconds,
    ).toBe(120);
    expect(
      classifyUpstreamError(429, `{"error":{"type":"usage_limit_reached","resets_at":${now / 1000 + 90}}}`, h(), now)
        .limit?.resetsInSeconds,
    ).toBe(90);
    expect(classifyUpstreamError(429, "{}", h({ "retry-after": "30" }), now)).toMatchObject({
      error: { code: "rate_limited" },
      limit: { resetsInSeconds: 30 },
    });
    expect(
      classifyUpstreamError(429, "not json", h({ "x-codex-primary-reset-after-seconds": "18000" }), now).limit
        ?.resetsInSeconds,
    ).toBe(18000);
    expect(classifyUpstreamError(500, "boom", h(), now)).toEqual({
      error: { code: "upstream_500", message: "The upstream returned HTTP 500." },
      limit: null,
    });
  });
});

describe("call store retention", () => {
  const record = (startedAt: number, stepId = "s") => ({
    stepId,
    caller: "rei",
    provider: "openai",
    model: "m",
    startedAt,
    firstByteMs: 1,
    totalMs: 2,
    status: 200,
    usage: null,
    limit: null,
    error: null,
  });
  it("keeps at most maxRows, dropping the oldest", () => {
    const log = new SqliteCallLog(join(tmp, "rows.sqlite"), { maxRows: 5, maxAgeMs: 1e12 });
    for (let i = 0; i < 12; i++) log.insert(record(Date.now(), `s${i}`));
    log.prune();
    expect(log.count()).toBe(5);
    expect(log.recent(10).map((r) => r.stepId)).toEqual(["s11", "s10", "s9", "s8", "s7"]);
    log.close();
  });
  it("drops rows older than maxAgeMs", () => {
    let now = 1_000_000;
    const log = new SqliteCallLog(join(tmp, "age.sqlite"), { maxAgeMs: 1000, now: () => now });
    log.insert(record(now - 5000, "old"));
    log.insert(record(now - 100, "new"));
    log.prune();
    expect(log.recent(10).map((r) => r.stepId)).toEqual(["new"]);
    now += 2000;
    log.prune();
    expect(log.count()).toBe(0);
    log.close();
  });
  it("defaults to 30 days and 100k rows", () => {
    const log = new SqliteCallLog(join(tmp, "defaults.sqlite"), { now: () => 100 * 24 * 3_600_000 });
    log.insert(record(60 * 24 * 3_600_000, "forty-day-old"));
    log.insert(record(80 * 24 * 3_600_000, "twenty-day-old"));
    log.prune();
    expect(log.recent(10).map((r) => r.stepId)).toEqual(["twenty-day-old"]);
    log.close();
  });
});

describe("configuration", () => {
  it("takes the stand-in token from REI_STANDIN, or from the file REI_STANDIN_FILE names", () => {
    expect(() => loadConfig({})).toThrow(/REI_STANDIN/);
    const fromEnv = loadConfig({ REI_STANDIN: "  token-abcdefghijklmnop \n" });
    expect(resolveStandin(fromEnv)).toBe("token-abcdefghijklmnop");
    expect(() => resolveStandin(loadConfig({ REI_STANDIN: "tiny" }))).toThrow(/at least 16/);
    writeFileSync(join(tmp, "named"), "from-file-abcdefghijkl\n");
    expect(resolveStandin(loadConfig({ REI_STANDIN_FILE: join(tmp, "named") }))).toBe("from-file-abcdefghijkl");
    // The token wins when both are set: it is what secrets.env supplies.
    expect(resolveStandin(loadConfig({ REI_STANDIN: "token-abcdefghijklmnop", REI_STANDIN_FILE: "/nope" }))).toBe(
      "token-abcdefghijklmnop",
    );
  });
  it("refuses to start without a readable stand-in file", () => {
    expect(() => readStandin(join(tmp, "missing"))).toThrow(/cannot read the stand-in file/);
    writeFileSync(join(tmp, "short"), "tiny\n");
    expect(() => readStandin(join(tmp, "short"))).toThrow(/at least 16/);
    writeFileSync(join(tmp, "ok"), "standin-abcdefghijklmnop\n");
    expect(readStandin(join(tmp, "ok"))).toBe("standin-abcdefghijklmnop");
  });
  it("reads port, data dir and extra upstreams from the environment", () => {
    const c = loadConfig({
      REI_STANDIN_FILE: "/x",
      GATEWAY_PORT: "9001",
      GATEWAY_DATA: "/d",
      GATEWAY_ALLOWED_UPSTREAMS: "http://127.0.0.1:1",
    });
    expect(c).toMatchObject({
      port: 9001,
      dataDir: "/d",
      credentialsFile: "/d/secret/credentials.json",
      callsDb: "/d/calls.sqlite",
    });
    expect(c.upstreams).toHaveLength(2);
    expect(loadConfig({ REI_STANDIN_FILE: "/x" }).port).toBe(8780);
  });
  it("the process exits non-zero at start-up when the stand-in file is missing", () => {
    const r = spawnSync(process.execPath, ["src/main.ts"], {
      cwd: gatewayDir,
      env: {
        PATH: process.env.PATH ?? "",
        REI_STANDIN_FILE: join(tmp, "nope"),
        GATEWAY_DATA: join(tmp, "d1"),
        GATEWAY_PORT: "0",
      },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cannot read the stand-in file");
  });
  it("the process starts, answers /healthz and shuts down on SIGTERM", async () => {
    writeFileSync(join(tmp, "standin"), "standin-0123456789abcdef\n");
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const child = spawn(process.execPath, ["src/main.ts"], {
      cwd: gatewayDir,
      env: {
        PATH: process.env.PATH ?? "",
        REI_STANDIN_FILE: join(tmp, "standin"),
        GATEWAY_DATA: join(tmp, "d2"),
        GATEWAY_PORT: String(port),
        GATEWAY_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    try {
      let ok = false;
      for (let i = 0; i < 100 && !ok; i++) {
        ok = await fetch(`http://127.0.0.1:${port}/healthz`).then(
          (r) => r.ok,
          () => false,
        );
        if (!ok) await new Promise((r) => setTimeout(r, 100));
      }
      expect(ok, out).toBe(true);
      const status = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as { signedIn: boolean };
      expect(status.signedIn).toBe(false);
      expect(out).not.toContain("standin-0123456789abcdef");
    } finally {
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
    }
  });
});

describe("credential file", () => {
  it("is written 0600 in a 0700 directory, atomically, without leftovers", async () => {
    const store = new FileCredentialStore(join(tmp, "cred", "secret", "credentials.json"));
    const cred = {
      type: "oauth" as const,
      access: makeToken("access"),
      refresh: makeToken("refresh"),
      expires: Date.now() + 1000,
    };
    await store.modify("openai", async () => cred);
    expect(statSync(join(tmp, "cred", "secret")).mode & 0o777).toBe(0o700);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(await store.read("openai")).toEqual(cred);
    await store.delete("openai");
    expect(await store.read("openai")).toBeUndefined();
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
  });
});

describe("cli", () => {
  it("status shows fingerprints and expiry, never a token; logout removes the credential", async () => {
    const dir = join(tmp, "cli");
    const paths = dataPaths(dir);
    const cred = {
      type: "oauth" as const,
      access: makeToken("access"),
      refresh: makeToken("refresh"),
      expires: Date.now() + 3_600_000,
      scopes: ["openid"],
    };
    await new FileCredentialStore(paths.credentialsFile).modify("openai", async () => cred);
    const env = { PATH: process.env.PATH ?? "", GATEWAY_DATA: dir };
    const run = (cmd: string) =>
      spawnSync(process.execPath, ["src/cli.ts", cmd], { cwd: gatewayDir, env, encoding: "utf8" });
    const status = run("status");
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/Signed in\. access sha256:[0-9a-f]{12}/);
    expect(status.stdout + status.stderr).not.toContain(cred.access);
    expect(status.stdout + status.stderr).not.toContain(cred.refresh);
    expect(status.stdout).not.toContain(cred.access.slice(40, 80));
    expect(run("logout").status).toBe(0);
    expect(run("status").stdout).toContain("Not signed in");
    expect(
      spawnSync(process.execPath, ["src/cli.ts", "bogus"], { cwd: gatewayDir, env, encoding: "utf8" }).status,
    ).toBe(2);
  });
});

describe("offline guard (test harness self-check)", () => {
  it("refuses non-loopback fetches and sockets", async () => {
    await expect(fetch("https://api.openai.com/v1/models")).rejects.toThrow(/offline guard/);
    await expect(fetch("https://example.com/")).rejects.toThrow(/offline guard/);
    const error = await new Promise<Error>((resolve) =>
      net.connect({ host: "example.com", port: 80 }).once("error", resolve),
    );
    expect(error.message).toMatch(/offline guard/);
  });
});
