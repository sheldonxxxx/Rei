import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { CANARIES, CANARY_MARKERS, leakedCanaries } from "@rei/logging/canaries";
import type { GatewayStatus } from "@rei/protocol";
import { STEP_ID_HEADER, UPSTREAM_HEADER } from "@rei/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PING_MODEL, pingModel } from "../src/node/diagnose.ts";
import type { Handler } from "./fake-upstream.ts";
import { type Rig, startRig } from "./rig.ts";

/** The gateway's outbound fetch for pingModel: api.openai.com/v1 goes to the rig's fake upstream. */
const toFake =
  (rig: Rig): typeof fetch =>
  (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return fetch(
      url.startsWith("https://api.openai.com/v1") ? rig.fake.url + url.slice("https://api.openai.com/v1".length) : url,
      init,
    );
  };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const LIMIT_BODY = JSON.stringify({
  error: {
    message: "You've reached your usage limit.",
    type: "usage_limit_reached",
    code: "subscription_sharing_usage_limit_exceeded",
    resets_in_seconds: 3600,
  },
});
const RATE_HEADERS = {
  "x-ratelimit-remaining-requests": "99",
  "x-codex-primary-used-percent": "12",
  "x-codex-turn-state": "opaque-state",
};

const textOf = (rec: { json?: { input?: { content?: { text?: string }[] }[] } }) =>
  rec.json?.input?.[0]?.content?.[0]?.text ?? "";
const handler: Handler = (rec) => {
  const text = textOf(rec);
  if (text.startsWith("SLOW")) return { kind: "slow", chunks: ["one ", "two ", "three ", "four"], gapMs: 250 };
  if (text.startsWith("BARE")) return { kind: "bare", text: "PONG" };
  if (text.startsWith("JSON")) return { kind: "json", text: "PONG" };
  if (text.startsWith("LIMIT"))
    return { kind: "status", status: 429, body: LIMIT_BODY, headers: { "retry-after": "3600", ...RATE_HEADERS } };
  if (text.startsWith("BAD"))
    return {
      kind: "status",
      status: 400,
      body: JSON.stringify({
        error: { message: "Model not supported", type: "invalid_request_error", code: "model_not_found" },
      }),
    };
  if (text.startsWith("BOOM")) return { kind: "status", status: 503, body: "upstream is down" };
  return { kind: "text", text: `echo: ${text}` };
};

describe("proxy", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await startRig({
      handler,
      fake: { echoAuthHeader: true, defaultHeaders: { "x-ratelimit-remaining-requests": "99" } },
    });
  });
  afterAll(() => rig.stop());

  it("swaps the stand-in for the real token and streams the upstream's answer", async () => {
    const res = await rig.post("PING", {
      step: "step-swap",
      headers: { "x-note": "hello", cookie: "a=b", "x-api-key": "k", "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("echo: PING");
    const req = rig.fake.requests.at(-1)!;
    expect(req.auth).toBe("ok");
    expect(req.headers.authorization).toBe(`Bearer ${rig.access}`);
    expect(req.headers["x-note"]).toBe("hello");
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers["accept-encoding"]).toBe("identity");
    expect(req.headers[STEP_ID_HEADER]).toBeUndefined();
    expect(req.headers[UPSTREAM_HEADER]).toBeUndefined();
    expect(JSON.stringify(req.headers) + req.raw).not.toContain(rig.standin);
    // Ordinary response headers pass; the echoed Authorization header must not reach the control plane.
    expect(res.headers.get("x-ratelimit-remaining-requests")).toBe("99");
    expect(res.headers.get("x-echo-auth")).toBeNull();
    expect([...res.headers].join("\n")).not.toContain(rig.access);
  });

  it("answers 401 bad_token to a missing or wrong token and never calls the upstream", async () => {
    const before = rig.fake.requests.length;
    const cases: [string, Response][] = [
      ["no authorization", await rig.post("PING", { token: null })],
      ["wrong bearer", await rig.post("PING", { token: "standin-not-issued" })],
      ["real token as bearer", await rig.post("PING", { token: rig.access })],
      ["stand-in only in x-api-key", await rig.post("PING", { token: null, headers: { "x-api-key": rig.standin } })],
      ["stand-in plus suffix", await rig.post("PING", { token: `${rig.standin}x` })],
      ["stand-in prefix", await rig.post("PING", { token: rig.standin.slice(0, -1) })],
      ["calls without token", await fetch(`${rig.base}/calls?stepId=x`)],
    ];
    for (const [name, res] of cases) {
      expect(res.status, name).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code, name).toBe("bad_token");
      expect(JSON.stringify(body)).not.toContain(rig.access);
    }
    expect(rig.fake.requests.length).toBe(before);
  });

  it("forwards only to allowlisted upstreams", async () => {
    const before = rig.fake.requests.length;
    const port = rig.fake.port;
    const rejected = [
      "https://evil.example.com/v1/responses",
      "https://api.openai.com.evil.com/v1/responses",
      "https://api.openai.com@evil.example.com/v1/responses",
      "https://user:pw@api.openai.com/v1/responses",
      "http://api.openai.com/v1/responses",
      "https://api.openai.com:8443/v1/responses",
      "https://api.openai.com/v2/responses",
      "https://api.openai.com/v1/../admin",
      "https://chatgpt.com/backend-api/codex/responses",
      `http://127.0.0.1:${port}/v2/responses`,
      `http://127.0.0.1:${port + 1}/v1/responses`,
      `https://127.0.0.1:${port}/v1/responses`,
      `http://localhost:${port}/v1/responses`,
      "not a url",
    ];
    for (const upstream of rejected) {
      const res = await rig.post("PING", { upstream, step: "step-allow" });
      expect(res.status, upstream).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("upstream_not_allowed");
    }
    // Without the header the upstream is derived from the provider; one that is not connected has none.
    const missing = await rig.post("PING", { upstream: null, headers: { "x-rei-provider-id": "not-connected" } });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("missing_upstream");
    expect(rig.fake.requests.length).toBe(before);
    // Refusals are recorded under their step id.
    const recorded = await rig.getCalls("step-allow");
    expect(recorded).toHaveLength(rejected.length);
    expect(recorded.every((r) => r.status === 403 && r.error?.code === "upstream_not_allowed")).toBe(true);
  });

  it("delivers initial SSE data while the upstream is held open, then preserves every byte", async () => {
    const release = Promise.withResolvers<void>();
    const streaming = await startRig({
      handler: () => ({ kind: "gated", chunks: ["one ", "two"], release: release.promise }),
    });
    const abort = new AbortController();
    // A deadlock guard: a buffering gateway cannot deliver data until the gate opens.
    const timer = setTimeout(
      () => abort.abort(new Error("No initial SSE data while the upstream was held open")),
      5000,
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const res = await streaming.post("GATED", { signal: abort.signal });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      reader = res.body!.getReader();
      const chunks: Buffer[] = [];
      while (!Buffer.concat(chunks).toString().includes('"delta":"one "')) {
        const { done, value } = await reader.read();
        expect(done, "the first text delta must arrive before the upstream completes").toBe(false);
        chunks.push(Buffer.from(value!));
      }
      expect(Buffer.concat(chunks).toString()).not.toContain("response.completed");
      clearTimeout(timer);
      release.resolve();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      expect(Buffer.concat(chunks)).toEqual(Buffer.concat(streaming.fake.requests[0]!.sent));
    } finally {
      clearTimeout(timer);
      release.resolve();
      await reader?.cancel().catch(() => {});
      await streaming.stop();
    }
  });

  it("passes a stream without a Content-Type header through unchanged and still reads its usage", async () => {
    const res = await rig.post("BARE", { step: "step-bare" });
    expect(res.status).toBe(200);
    // (@hono/node-server adds `text/plain` to a body that has no Content-Type; the bytes themselves are untouched.)
    expect(res.headers.get("content-type")).not.toContain("json");
    const text = await res.text();
    expect(text).toBe(Buffer.concat(rig.fake.requests.at(-1)!.sent).toString());
    const [call] = await rig.getCalls("step-bare");
    expect(call?.usage?.inputTokens).toBe(rig.fake.requests.at(-1)!.reported!.input_tokens);
  });

  it("passes upstream 4xx and 5xx through and records them without the raw body in the error", async () => {
    const bad = await rig.post("BAD", { step: "step-400" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: { message: "Model not supported", type: "invalid_request_error", code: "model_not_found" },
    });
    const boom = await rig.post("BOOM", { step: "step-503" });
    expect(boom.status).toBe(503);
    expect(await boom.text()).toBe("upstream is down");
    const [c400] = await rig.getCalls("step-400");
    expect(c400).toMatchObject({
      status: 400,
      usage: null,
      limit: null,
      error: { code: "upstream_400" },
    });
    expect(JSON.stringify(c400)).not.toContain("Model not supported");
    const [c503] = await rig.getCalls("step-503");
    expect(c503).toMatchObject({ status: 503, error: { code: "upstream_503" } });
    expect(JSON.stringify(c503)).not.toContain("upstream is down");
  });

  it("records usage, model and timings per step id; /calls needs the stand-in", async () => {
    await (await rig.post("one", { step: "step-A", model: "gpt-test-a" })).text();
    await (await rig.post("two two", { step: "step-A", model: "gpt-test-a" })).text();
    await (await rig.post("three", { step: "step-B", model: "gpt-test-b" })).text();
    const a = await rig.getCalls("step-A");
    const b = await rig.getCalls("step-B");
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    const reported = rig.fake.requests
      .filter((r) => r.reported && r.json?.model === "gpt-test-a")
      .map((r) => r.reported!);
    expect(reported).toHaveLength(2);
    a.forEach((call, i) => {
      expect(call.stepId).toBe("step-A");
      expect(call.model).toBe("gpt-test-a");
      expect(call.status).toBe(200);
      expect(call.usage).toEqual({
        inputTokens: reported[i]!.input_tokens,
        outputTokens: reported[i]!.output_tokens,
        cachedInputTokens: reported[i]!.cached,
      });
      expect(call.error).toBeNull();
      expect(call.limit).toBeNull();
      expect(call.firstByteMs).not.toBeNull();
      expect(call.totalMs!).toBeGreaterThanOrEqual(call.firstByteMs!);
      expect(call.startedAt).toBeGreaterThan(Date.now() - 60_000);
    });
    expect(b[0]!.model).toBe("gpt-test-b");
    expect((await fetch(`${rig.base}/calls?stepId=step-A`)).status).toBe(401);
    expect(await rig.getCalls("no-such-step")).toEqual([]);
    const recent = (await (
      await fetch(`${rig.base}/calls?limit=5`, { headers: { authorization: `Bearer ${rig.standin}` } })
    ).json()) as unknown[];
    expect(recent.length).toBe(5);
  });

  it("reads usage from a non-streaming JSON response", async () => {
    const res = await rig.post("JSON", { step: "step-json" });
    expect(((await res.json()) as { status: string }).status).toBe("completed");
    const [call] = await rig.getCalls("step-json");
    expect(call?.usage).toMatchObject({ outputTokens: rig.fake.requests.at(-1)!.reported!.output_tokens });
  });

  it("records the usage-limit 429 with resets_in_seconds and the limit headers, and passes it through", async () => {
    const res = await rig.post("LIMIT", { step: "step-limit" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3600");
    expect(await res.text()).toBe(LIMIT_BODY);
    const [call] = await rig.getCalls("step-limit");
    expect(call).toMatchObject({ status: 429, usage: null, error: { code: "usage_limit_reached" } });
    expect(call!.limit!.resetsInSeconds).toBe(3600);
    expect(call!.limit).toEqual({
      resetsInSeconds: 3600,
      code: "usage_limit",
      headers: { "retry-after": "3600", "x-ratelimit-remaining-requests": "99", "x-codex-primary-used-percent": "12" },
    });
    // Neither the upstream body nor the error message is stored (ADR 0003).
    expect(JSON.stringify(call)).not.toContain("subscription_sharing_usage_limit_exceeded");
    expect(call!.error).toEqual({ code: "usage_limit_reached" });
  });

  it("serves /healthz and /status without authentication", async () => {
    expect(await (await fetch(`${rig.base}/healthz`)).text()).toBe("ok");
    rig.writeProbe(["gpt-test", "gpt-other"]);
    const status = (await (await fetch(`${rig.base}/status`)).json()) as GatewayStatus;
    expect(status.signedIn).toBe(true);
    expect(status.models).toEqual(["gpt-test", "gpt-other"]);
    expect(status.version).toBe("0.0.0-test");
    expect(status.accessExpiresInS).toBeGreaterThan(3000);
    expect(status.accessExpiresInS).toBeLessThanOrEqual(3600);
    expect(status.search).toEqual({ providers: [], searxngUrl: null }); // this rig has no search deps
    const text = JSON.stringify(status);
    for (const secret of [rig.access, rig.refresh, rig.standin]) expect(text).not.toContain(secret);
    expect(status.providers).toEqual([]); // this rig has no provider manager
    expect(Object.keys(status).sort()).toEqual([
      "accessExpiresInS",
      "models",
      "providers",
      "search",
      "signedIn",
      "version",
    ]);
  });

  it("ping: one tiny completion with the first probed model; prints ok and the model; writes nothing", async () => {
    rig.writeProbe(["gpt-probed", "gpt-other"]);
    const before = rig.fake.requests.length;
    const files = rig.nonSecretFiles().map((f) => `${f.file}:${f.bytes.length}`);
    const result = await pingModel({ store: rig.store, modelsFile: rig.paths.modelsFile, fetch: toFake(rig) });
    expect(result.ok).toBe(true);
    expect(result.line).toMatch(/^ok gpt-probed \d+ms$/);
    expect(rig.fake.requests).toHaveLength(before + 1);
    expect(rig.fake.requests.at(-1)!.json?.model).toBe("gpt-probed");
    expect(rig.nonSecretFiles().map((f) => `${f.file}:${f.bytes.length}`)).toEqual(files);
  });

  it("ping: without a probe it asks for the default standard-tier model, and a named model wins", async () => {
    const fresh = await startRig({ handler });
    try {
      await pingModel({ store: fresh.store, modelsFile: fresh.paths.modelsFile, fetch: toFake(fresh) });
      expect(fresh.fake.requests.at(-1)!.json?.model).toBe(DEFAULT_PING_MODEL);
      fresh.writeProbe(["gpt-probed"]);
      await pingModel({
        store: fresh.store,
        modelsFile: fresh.paths.modelsFile,
        model: "gpt-named",
        fetch: toFake(fresh),
      });
      expect(fresh.fake.requests.at(-1)!.json?.model).toBe("gpt-named");
    } finally {
      await fresh.stop();
    }
  });

  it("ping: reports an upstream refusal without leaking the token", async () => {
    const bad = await startRig({
      handler: () => ({
        kind: "status",
        status: 400,
        body: JSON.stringify({ error: { message: "Model not supported", code: "model_not_found" } }),
      }),
    });
    try {
      const result = await pingModel({ store: bad.store, modelsFile: bad.paths.modelsFile, fetch: toFake(bad) });
      expect(result.ok).toBe(false);
      expect(result.line).toMatch(/^failed: /);
      for (const secret of [bad.access, bad.refresh]) expect(result.line).not.toContain(secret);
    } finally {
      await bad.stop();
    }
  });

  it("ping: not signed in", async () => {
    const out = await startRig({ handler, signedOut: true });
    try {
      expect(await pingModel({ store: out.store, modelsFile: out.paths.modelsFile })).toEqual({
        ok: false,
        line: "failed: not signed in; run login first",
      });
      expect(out.fake.requests).toHaveLength(0);
    } finally {
      await out.stop();
    }
  });

  it("returns a JSON error for unknown routes", async () => {
    // An unknown path needs the admin scope like any other unlisted one, so only Rei's token learns it is not there.
    expect((await fetch(`${rig.base}/admin`)).status).toBe(401);
    const res = await fetch(`${rig.base}/admin`, { headers: { authorization: `Bearer ${rig.standin}` } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("stops the upstream request when the client goes away, and records client_aborted", async () => {
    const ac = new AbortController();
    const res = await rig.post("SLOW abort", { step: "step-abort", signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.read().catch(() => {});
    await sleep(400);
    expect(rig.fake.requests.at(-1)!.closedEarly).toBe(true);
    const [call] = await rig.getCalls("step-abort");
    expect(call?.error?.code).toBe("client_aborted");
  });
});

describe("credentials", () => {
  it("refreshes an expired token once under 10 concurrent requests and persists the rotated refresh token", async () => {
    const rig = await startRig({ handler, expired: true, fake: { tokenDelayMs: 150 } });
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => rig.post(`PING ${i}`, { step: `step-r${i}` })),
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      await Promise.all(results.map((r) => r.text()));
      expect(rig.fake.tokenRequests).toHaveLength(1);
      expect(rig.fake.tokenRequests[0]!.form.grant_type).toBe("refresh_token");
      expect(rig.fake.tokenRequests[0]!.form.refresh_token).toBe(rig.refresh);
      expect(rig.fake.requests.filter((r) => r.json).every((r) => r.auth === "ok")).toBe(true);
      expect(rig.fake.state.access).not.toBe(rig.access);

      const stored = JSON.parse(readFileSync(rig.paths.credentialsFile, "utf8")) as {
        openai: { access: string; refresh: string; expires: number };
      };
      expect(stored.openai.access).toBe(rig.fake.state.access);
      expect(stored.openai.refresh).toBe(rig.fake.state.refresh); // rotated, and the new one is what is on disk
      expect(stored.openai.refresh).not.toBe(rig.refresh);
      expect(stored.openai.expires).toBeGreaterThan(Date.now() + 3_000_000);

      // A later burst needs no refresh.
      await Promise.all((await Promise.all([rig.post("again"), rig.post("again")])).map((r) => r.text()));
      expect(rig.fake.tokenRequests).toHaveLength(1);
      expect(rig.logs.map((l) => JSON.parse(l))).toContainEqual(
        expect.objectContaining({ event: "credential.refreshed", refreshRotated: true }),
      );

      // Files: secret dir 0700, credentials 0600, no stray temp or lock files.
      expect(statSync(rig.paths.secretDir).mode & 0o777).toBe(0o700);
      expect(statSync(rig.paths.credentialsFile).mode & 0o777).toBe(0o600);
      expect(readdirSync(rig.paths.secretDir).sort()).toEqual(["credentials.json"]);
    } finally {
      await rig.stop();
    }
  });

  it("answers 502 credential_refresh_failed when the refresh fails, keeps the credential, and recovers", async () => {
    const rig = await startRig({ handler, expired: true });
    try {
      // A token endpoint that echoes the refresh token back in its error, as some do.
      rig.fake.failNextToken(
        400,
        JSON.stringify({ error: "invalid_grant", detail: `refresh token ${rig.refresh} rejected` }),
      );
      const bad = await rig.post("PING", { step: "step-fail" });
      expect(bad.status).toBe(502);
      const text = await bad.text();
      expect(JSON.parse(text).error.code).toBe("credential_refresh_failed");
      expect(text).not.toContain(rig.refresh);
      expect(rig.fake.requests.filter((r) => r.json)).toHaveLength(0);
      expect(JSON.parse(readFileSync(rig.paths.credentialsFile, "utf8")).openai.refresh).toBe(rig.refresh);
      const good = await rig.post("PING");
      expect(good.status).toBe(200);
      await good.text();
      const [call] = await rig.getCalls("step-fail");
      expect(call).toMatchObject({ status: 502, error: { code: "credential_refresh_failed" } });
    } finally {
      await rig.stop();
    }
  });

  it("backs off after a failed refresh instead of hammering the token endpoint", async () => {
    const rig = await startRig({ handler, expired: true, failureBackoffMs: 60_000 });
    try {
      rig.fake.failNextToken(400, JSON.stringify({ error: "invalid_grant" }));
      expect((await rig.post("PING")).status).toBe(502);
      expect((await rig.post("PING")).status).toBe(502);
      expect(rig.fake.tokenRequests).toHaveLength(1);
    } finally {
      await rig.stop();
    }
  });

  it("answers 503 not_signed_in with no credential, and /status says so", async () => {
    const rig = await startRig({ handler, signedOut: true });
    try {
      const res = await rig.post("PING", { step: "step-out" });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_signed_in");
      const status = (await (await fetch(`${rig.base}/status`)).json()) as GatewayStatus;
      expect(status).toMatchObject({ signedIn: false, accessExpiresInS: null, models: [] });
      expect(rig.fake.requests).toHaveLength(0);
    } finally {
      await rig.stop();
    }
  });
});

describe("timeouts and failures", () => {
  it("answers 504 upstream_timeout when the upstream does not answer within the connect timeout", async () => {
    const rig = await startRig({
      handler: () => ({ kind: "late", delayMs: 1000, text: "late" }),
      connectTimeoutMs: 150,
    });
    try {
      const res = await rig.post("PING", { step: "step-late" });
      expect(res.status).toBe(504);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("upstream_timeout");
    } finally {
      await rig.stop();
    }
  });

  it("errors the stream and records upstream_idle_timeout when the upstream goes silent", async () => {
    const rig = await startRig({ handler: () => ({ kind: "stall", stallMs: 2000 }), idleTimeoutMs: 200 });
    try {
      const res = await rig.post("PING", { step: "step-idle" });
      expect(res.status).toBe(200);
      await expect(res.text()).rejects.toThrow();
      await sleep(50);
      const [call] = await rig.getCalls("step-idle");
      expect(call?.error?.code).toBe("upstream_idle_timeout");
    } finally {
      await rig.stop();
    }
  });

  it("answers 502 upstream_unreachable when the connection is refused", async () => {
    const rig = await startRig({ handler });
    try {
      await rig.fake.close();
      const res = await rig.post("PING", { step: "step-down" });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("upstream_unreachable");
    } finally {
      await rig.stop().catch(() => {});
    }
  });
});

describe("upstream content never reaches the gateway log or call log (ADR 0003)", () => {
  it("keeps canaries in 429 and 5xx bodies and headers out of logs and calls.sqlite, keeping the codes", async () => {
    const body = JSON.stringify({
      error: { type: "rate_limit_exceeded", message: Object.values(CANARIES).join(" | "), code: CANARIES.personal },
    });
    const canaryHandler: Handler = (rec) => {
      const text = JSON.stringify(rec.json ?? {});
      if (text.includes("CANARY-429"))
        return {
          kind: "status",
          status: 429,
          body,
          headers: { "retry-after": "30", "x-ratelimit-note": CANARIES.urlWithToken, "x-request-echo": CANARIES.email },
        };
      return { kind: "status", status: 502, body: body.replace("rate_limit_exceeded", "server_error") };
    };
    const rig = await startRig({ handler: canaryHandler });
    try {
      await (await rig.post("CANARY-429", { step: "canary-429" })).text();
      await (await rig.post("CANARY-5XX", { step: "canary-5xx" })).text();
      const [limited] = await rig.getCalls("canary-429");
      expect(limited).toMatchObject({
        status: 429,
        error: { code: "rate_limited" },
        limit: { resetsInSeconds: 30, code: "rate_limit", headers: { "retry-after": "30" } },
      });
      const [failed] = await rig.getCalls("canary-5xx");
      expect(failed).toMatchObject({ status: 502, error: { code: "upstream_502" }, limit: null });
      // Positive control: the scan below would find a marker that is present.
      expect(leakedCanaries(body)).toEqual([...CANARY_MARKERS]);
      expect(leakedCanaries(rig.logs.join("\n"))).toEqual([]);
      expect(leakedCanaries(JSON.stringify([limited, failed]))).toEqual([]);
      for (const f of rig.nonSecretFiles())
        expect(leakedCanaries(f.bytes.toString("latin1")), `${f.file} leaked a canary`).toEqual([]);
    } finally {
      await rig.stop();
    }
  });
});

describe("secrets never leave the gateway", () => {
  it("keeps every token value out of logs, stdout, the calls database and gateway-made error responses", async () => {
    const rig = await startRig({ handler, expired: true, fake: { echoAuthHeader: true, tokenDelayMs: 30 } });
    try {
      const gatewayErrors: string[] = [];
      const keep = async (res: Response) => {
        gatewayErrors.push(await res.text());
        return res;
      };
      // Refresh with an echoing failure first, then a success (rotation), then assorted traffic.
      rig.fake.failNextToken(
        400,
        JSON.stringify({ error: "invalid_grant", detail: `refresh token ${rig.refresh} rejected` }),
      );
      await keep(await rig.post("PING", { step: "leak-0" }));
      await (await rig.post("SECRET-PROMPT-XYZ ordinary", { step: "leak-1" })).text();
      await (await rig.post("LIMIT", { step: "leak-2" })).text();
      await (await rig.post("BAD", { step: "leak-3" })).text();
      await keep(await rig.post("PING", { token: rig.access }));
      await keep(await rig.post("PING", { token: rig.refresh }));
      await keep(await rig.post("PING", { upstream: "https://evil.example.com/x" }));
      await (await rig.post("PING", { headers: { "x-leak": `Bearer ${rig.standin}` } })).text();
      await (await fetch(`${rig.base}/status`)).text();
      await sleep(100);

      expect(rig.fake.issued.size).toBeGreaterThanOrEqual(4); // original pair plus the rotated pair
      const secrets = [...rig.fake.issued, rig.standin];
      const haystacks: { name: string; text: string }[] = [
        { name: "gateway log lines", text: rig.logs.join("\n") },
        { name: "stdout/stderr", text: rig.printed.join("") },
        { name: "gateway error responses", text: gatewayErrors.join("\n") },
        ...rig.nonSecretFiles().map((f) => ({ name: f.file, text: f.bytes.toString("latin1") })),
      ];
      expect(
        rig.nonSecretFiles().some((f) => f.file.endsWith("calls.sqlite") || f.file.endsWith("calls.sqlite-wal")),
      ).toBe(true);
      for (const { name, text } of haystacks) {
        for (const secret of secrets) expect(text.includes(secret), `${name} contains a token`).toBe(false);
        expect(text.includes("SECRET-PROMPT-XYZ"), `${name} contains a request body`).toBe(false);
        expect(text.includes("upstream is down"), `${name} contains a response body`).toBe(false);
      }
      expect(rig.logs.length).toBeGreaterThan(5);

      // Positive control: the scan would have found the tokens where they are meant to be.
      const secretFile = readFileSync(rig.paths.credentialsFile, "utf8");
      expect(secretFile).toContain(rig.fake.state.access);
      expect(secretFile).toContain(rig.fake.state.refresh);
      expect(existsSync(rig.paths.credentialsFile)).toBe(true);
    } finally {
      await rig.stop();
    }
  });

  it("logs one line per call with ids, status and timings", async () => {
    const rig = await startRig({ handler });
    try {
      await (await rig.post("PING", { step: "step-log", model: "gpt-test" })).text();
      const line = rig.logs.map((l) => JSON.parse(l)).find((e) => e.event === "call" && e.stepId === "step-log");
      expect(line).toEqual({
        timestamp: expect.any(String),
        level: "debug",
        service: "gateway",
        event: "call",
        caller: "rei",
        provider: "openai",
        stepId: "step-log",
        model: "gpt-test",
        method: "POST",
        status: 200,
        firstByteMs: expect.any(Number),
        totalMs: expect.any(Number),
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        cachedInputTokens: expect.any(Number),
      });
    } finally {
      await rig.stop();
    }
  });
});
