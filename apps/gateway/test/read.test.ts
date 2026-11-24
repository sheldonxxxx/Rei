// POST /read (docs/gateway-callers.md): the scope, the read-local rule, the budget, and the hand-off to the reader.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@rei/logging";
import type { GatewayCallerCreated } from "@rei/protocol";
import { READ_CALLER_HEADER, READ_ID_HEADER, STEP_ID_HEADER } from "@rei/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayApps } from "../src/core/proxy.ts";
import { createRedactor } from "../src/core/redact.ts";
import type { SecretStore } from "../src/core/secrets.ts";
import { DEFAULT_UPSTREAMS } from "../src/core/upstream.ts";
import { SqliteCallLog } from "../src/node/calllog.ts";
import { parseReaderUrl } from "../src/node/config.ts";

const REI = "rei-token-0123456789abcdef";

function memorySecrets(): SecretStore {
  const data = new Map<string, unknown>();
  return {
    read: async <T>(key: string) => data.get(key) as T | undefined,
    modify: async <T>(key: string, fn: (current: T | undefined) => T | undefined) => {
      const next = fn(data.get(key) as T | undefined);
      if (next === undefined) data.delete(key);
      else data.set(key, next);
      return next;
    },
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gateway-read-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function world(reader: ((seen: Seen) => Response | Promise<Response>) | null) {
  const seen: Seen[] = [];
  const calls = new SqliteCallLog(join(tmp, "calls.sqlite"));
  const logs: string[] = [];
  const apps = createGatewayApps({
    standin: REI,
    tokens: { accessToken: async () => "x", status: async () => ({ signedIn: true, accessExpiresInS: 60 }) },
    calls,
    models: () => [],
    version: "test",
    upstreams: DEFAULT_UPSTREAMS,
    redactor: createRedactor(),
    log: createLogger({ service: "gateway", level: "debug", write: (line) => void logs.push(line) }),
    secrets: memorySecrets(),
    ...(reader ? { reader: { url: "http://reader:8790" } } : {}),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const entry = {
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body ?? ""),
      };
      seen.push(entry);
      if (!reader) throw new Error("no reader");
      return reader(entry);
    }) as typeof fetch,
  });
  const read = (app: "internal" | "shared", o: { token?: string; body?: unknown; headers?: Record<string, string> }) =>
    apps[app].request("http://gateway/read", {
      method: "POST",
      headers: { authorization: `Bearer ${o.token ?? REI}`, "content-type": "application/json", ...o.headers },
      body: JSON.stringify(o.body ?? { url: "https://example.com/", allowHosts: ["example.com"] }),
    });
  const create = async (id: string, extra: Record<string, unknown> = {}) => {
    const res = await apps.internal.request("http://gateway/callers", {
      method: "POST",
      headers: { authorization: `Bearer ${REI}`, "content-type": "application/json" },
      body: JSON.stringify({ id, ...extra }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as GatewayCallerCreated;
  };
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
  return { read, create, code, seen, calls, logs };
}

const page = () => Response.json({ outcome: "failed", message: "x", details: { method: "http", redirects: 0 } });

describe("POST /read", () => {
  it("hands the body to the reader with the caller, the call id and the step id, and returns its answer", async () => {
    const w = world(() => Response.json({ outcome: "redirect", location: "https://other.test/", hops: 1 }));
    const { token } = await w.create("worker");
    const res = await w.read("shared", { token, headers: { [STEP_ID_HEADER]: "step-1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "redirect", location: "https://other.test/", hops: 1 });
    expect(w.seen).toHaveLength(1);
    const [forwarded] = w.seen;
    expect(forwarded!.url).toBe("http://reader:8790/read");
    expect(forwarded!.headers[READ_CALLER_HEADER]).toBe("worker");
    expect(forwarded!.headers[STEP_ID_HEADER]).toBe("step-1");
    expect(forwarded!.headers[READ_ID_HEADER]).toBe(res.headers.get("x-rei-read-id"));
    expect(forwarded!.headers.authorization).toBeUndefined();
    expect(JSON.parse(forwarded!.body)).toEqual({ url: "https://example.com/", allowHosts: ["example.com"] });
  });

  it("records the call against the caller without the URL", async () => {
    const w = world(page);
    const { token } = await w.create("worker");
    await w.read("shared", { token, headers: { [STEP_ID_HEADER]: "s9" } });
    const row = w.calls.recent(5, "worker")[0]!;
    expect(row).toMatchObject({ caller: "worker", provider: "read", model: "read", status: 200, stepId: "s9" });
    expect(JSON.stringify(row)).not.toContain("example.com");
    expect(w.logs.join("\n")).not.toContain("example.com");
  });

  it("serves the shared listener only to a caller with the read scope", async () => {
    const w = world(page);
    const { token } = await w.create("nope", { scopes: ["models"] });
    const res = await w.read("shared", { token });
    expect(res.status).toBe(403);
    expect(await w.code(res)).toBe("route_not_allowed");
    expect(w.seen).toHaveLength(0);
    expect((await w.read("shared", { token: "gw.nope.bad" })).status).toBe(401);
  });

  it("refuses a local-network read without read-local, and allows it with the scope", async () => {
    const w = world(page);
    const plain = await w.create("plain");
    const local = await w.create("local", { scopes: ["read", "read-local"] });
    for (const localNetworks of ["all", ["192.168.1.0/24"]]) {
      const refused = await w.read("shared", {
        token: plain.token,
        body: { url: "http://nas/", allowHosts: ["nas"], localNetworks },
      });
      expect(refused.status).toBe(403);
      expect(await w.code(refused)).toBe("route_not_allowed");
    }
    expect(w.seen).toHaveLength(0);
    for (const token of [plain.token, local.token]) {
      const ok = await w.read("shared", {
        token,
        body: { url: "https://a.test/", allowHosts: ["a.test"], localNetworks: "none" },
      });
      expect(ok.status).toBe(200);
    }
    const allowed = await w.read("shared", {
      token: local.token,
      body: { url: "http://nas/", allowHosts: ["nas"], localNetworks: ["192.168.1.0/24"] },
    });
    expect(allowed.status).toBe(200);
    // Rei holds every scope.
    expect(
      (await w.read("internal", { body: { url: "http://nas/", allowHosts: ["nas"], localNetworks: "all" } })).status,
    ).toBe(200);
  });

  it("caps reads in flight per caller, and turns reads off at 0", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const w = world(async () => {
      await gate;
      return page();
    });
    const { token } = await w.create("busy", { budget: { reads: 1 } });
    const first = w.read("shared", { token });
    await new Promise((r) => setTimeout(r, 20));
    const second = await w.read("shared", { token });
    expect(second.status).toBe(429);
    expect(second.headers.get("x-rei-refused-by")).toBe("gateway");
    expect(await w.code(second)).toBe("caller_concurrency");
    release();
    expect((await first).status).toBe(200);
    expect((await w.read("shared", { token })).status).toBe(200);

    const off = await w.create("off", { budget: { reads: 0 } });
    const refused = await w.read("shared", { token: off.token });
    expect(refused.status).toBe(403);
    expect(await w.code(refused)).toBe("route_not_allowed");
  });

  it("gives a new caller two reads in flight", async () => {
    const w = world(page);
    const created = await w.create("two");
    expect(created.caller.budget.reads).toBe(2);
  });

  it("answers 503 without a reader and 502 when the reader does not answer", async () => {
    const none = world(null);
    const r = await none.read("internal", {});
    expect(r.status).toBe(503);
    expect(await none.code(r)).toBe("read_unavailable");
    const down = world(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const bad = await down.read("internal", {});
    expect(bad.status).toBe(502);
    expect(await down.code(bad)).toBe("read_unavailable");
    expect(down.calls.recent(1)[0]).toMatchObject({ status: 502, error: { code: "read_unavailable" } });
  });

  it("rejects a body that is not a JSON object", async () => {
    const w = world(page);
    for (const body of ["nope", "[]"]) {
      const res = await w.read("internal", { body });
      expect(res.status).toBe(400);
    }
  });

  it("passes the reader's own error status through", async () => {
    const w = world(
      () =>
        new Response(JSON.stringify({ error: { code: "bad_request", message: "no" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const res = await w.read("internal", {});
    expect(res.status).toBe(400);
    expect(w.calls.recent(1)[0]!.error).toEqual({ code: "http_400" });
  });
});

describe("GATEWAY_READER_URL", () => {
  it("accepts an origin, ignores an empty value and stops on a bad one", () => {
    expect(parseReaderUrl("http://reader:8790/")).toBe("http://reader:8790");
    expect(parseReaderUrl("")).toBeUndefined();
    expect(parseReaderUrl(undefined)).toBeUndefined();
    for (const bad of ["reader:8790", "ftp://reader", "http://u:p@reader", "http://reader/?x=1"])
      expect(() => parseReaderUrl(bad), bad).toThrow();
  });
});
