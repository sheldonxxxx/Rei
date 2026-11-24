import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  ADDRESS_REFUSED,
  BUDGET_SPENT,
  createEgressProxy,
  DECIDE_UNAVAILABLE,
  LOCAL_NETWORK_DENIED,
  STEP_ID_HEADER,
} from "@rei/forward-proxy";
import { createLogger } from "@rei/logging";
import { CANARIES, leakedCanaries } from "@rei/logging/canaries";
import { parseCidr } from "@rei/network";
import { afterEach, describe, expect, it } from "vitest";
import { unixDecide } from "../src/decide.ts";
import { basic, connectVia, getThroughTunnel, type Rig, type RigOptions, requestVia, startRig, TOKEN } from "./rig.ts";

const rigs: Rig[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
async function rig(options?: RigOptions) {
  const r = await startRig(options);
  rigs.push(r);
  return r;
}
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((r) => r.close()));
  for (const c of cleanups.splice(0)) await c();
});

const rawConnect = (port: number, bytes: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
    socket.write(bytes);
  });

describe("CONNECT", () => {
  it("tunnels to the resolved address when the control plane allows it", async () => {
    const r = await rig({ answer: { decision: "allow" }, addresses: ["93.184.216.34"] });
    const result = await connectVia(r.port, "Example.test.:443");
    expect(result.status).toBe(200);
    const text = await getThroughTunnel(result.socket, "/tunnel");
    expect(text).toContain("200 OK");
    expect(text).toContain("hello from upstream: GET /tunnel");
    // asked with the normalized host and the token from the password field
    expect(r.decideCalls).toEqual([{ token: TOKEN, host: "example.test", port: 443 }]);
    // connected to the address it resolved, not to the name
    expect(r.connects).toEqual([{ address: "93.184.216.34", port: 443 }]);
    await vi_waitFor(() => r.logs.some((l) => l.event === "egress.allow"));
    const entry = r.logs.find((l) => l.event === "egress.allow")!;
    expect(entry).toMatchObject({ host: "example.test", port: 443, method: "CONNECT" });
    expect(entry.bytesUp).toBeGreaterThan(0);
    expect(entry.bytesDown).toBeGreaterThan(0);
  });

  it("ignores the user name and takes the password as the token", async () => {
    const r = await rig();
    const result = await connectVia(r.port, "example.test:443", { "proxy-authorization": basic("a:b:c", "whoever") });
    expect(result.status).toBe(200);
    result.socket.destroy();
    expect(r.decideCalls[0]).toMatchObject({ token: "a:b:c" });
  });

  it("answers 407 without a token, with a challenge and without asking anyone", async () => {
    const r = await rig();
    for (const headers of [
      {},
      { "proxy-authorization": "Bearer abc" },
      { "proxy-authorization": "Basic !!!not-base64!!!" },
      { "proxy-authorization": "Basic " + Buffer.from("no-colon").toString("base64") },
      { "proxy-authorization": "Basic " + Buffer.from("user:").toString("base64") },
    ]) {
      const result = await connectVia(r.port, "example.test:443", headers);
      expect(result.status).toBe(407);
      expect(result.headers["proxy-authenticate"]).toBe('Basic realm="rei"');
    }
    expect(r.decideCalls).toEqual([]);
    expect(r.resolveCalls).toEqual([]);
  });

  it("refuses ports other than 80 and 443 without asking", async () => {
    const r = await rig();
    for (const port of [22, 25, 8080, 3128]) {
      const result = await connectVia(r.port, `example.test:${port}`);
      expect(result.status).toBe(403);
      expect(result.headers["x-egress-decision"]).toBe("deny");
      expect(result.body).toContain("80 and 443");
    }
    expect(r.decideCalls).toEqual([]);
    expect(r.connects).toEqual([]);
    const port80 = await connectVia(r.port, "example.test:80");
    expect(port80.status).toBe(200);
    port80.socket.destroy();
  });

  it.each([["deny", "Network access to example.test is not allowed: nope."]] as const)(
    "%s: 403 with the decision header and the message as the body",
    async (decision, message) => {
      const r = await rig({ answer: { decision, message } });
      const result = await connectVia(r.port, "example.test:443");
      expect(result.status).toBe(403);
      expect(result.headers["x-egress-decision"]).toBe(decision);
      expect(result.headers["content-type"]).toContain("text/plain");
      expect(result.body).toBe(message);
      expect(r.resolveCalls).toEqual([]);
      expect(r.connects).toEqual([]);
      expect(r.logs.map((l) => l.event)).toEqual([`egress.${decision}`]);
    },
  );

  it("refuses a name that resolves to a special address, even if only one answer is special", async () => {
    for (const addresses of [
      ["127.0.0.1"],
      ["::ffff:7f00:1"],
      ["93.184.216.34", "127.0.0.2"],
      ["2606:4700::1111", "fe80::1"],
      ["169.254.169.254"],
      ["198.19.249.3"],
      ["::ffff:169.254.169.254"],
    ]) {
      const r = await rig({ addresses });
      const result = await connectVia(r.port, "rebind.test:443");
      expect(result.status, addresses.join()).toBe(403);
      expect(result.headers["x-egress-decision"]).toBe("deny");
      expect(result.body).toBe(ADDRESS_REFUSED);
      expect(r.connects).toEqual([]);
    }
  });

  it("checks IP-literal hosts the same way, without resolving", async () => {
    const r = await rig();
    for (const target of [
      "127.0.0.1:80",
      "[::1]:443",
      "[::ffff:127.0.0.1]:443",
      "169.254.169.254:80",
      "198.19.249.3:443",
      "[fe80::1]:443",
    ]) {
      const result = await connectVia(r.port, target);
      expect(result.status, target).toBe(403);
      expect(result.body).toBe(ADDRESS_REFUSED);
    }
    expect(r.resolveCalls).toEqual([]);
    expect(r.connects).toEqual([]);
    const ok = await connectVia(r.port, "93.184.216.34:443");
    expect(ok.status).toBe(200);
    ok.socket.destroy();
    expect(r.connects).toEqual([{ address: "93.184.216.34", port: 443 }]);
  });

  it("lets connections to the user's own network through", async () => {
    const r = await rig({ addresses: ["192.168.1.10"] });
    const named = await connectVia(r.port, "nas.test:443");
    expect(named.status).toBe(200);
    named.socket.destroy();
    for (const target of [
      "10.0.0.5:443",
      "172.20.1.1:80",
      "100.100.1.1:443",
      "[fd12::1]:443",
      "[::ffff:192.168.1.10]:443",
    ]) {
      const result = await connectVia(r.port, target);
      expect(result.status, target).toBe(200);
      result.socket.destroy();
    }
    expect(r.connects.map((c) => c.address)).toEqual([
      "192.168.1.10",
      "10.0.0.5",
      "172.20.1.1",
      "100.100.1.1",
      "fd12::1",
      "::ffff:192.168.1.10",
    ]);
  });

  it("refuses the stack's own networks, by name and by literal", async () => {
    const r = await rig({
      refuse: [parseCidr("10.89.232.0/24")!, parseCidr("fd00:abcd::/48")!],
      addresses: ["10.89.232.2"],
    });
    const named = await connectVia(r.port, "devtools.test:443");
    expect([named.status, named.headers["x-egress-decision"], named.body]).toEqual([403, "deny", ADDRESS_REFUSED]);
    for (const target of ["10.89.232.2:443", "10.89.232.10:443", "[::ffff:10.89.232.2]:443", "[fd00:abcd::5]:443"]) {
      const result = await connectVia(r.port, target);
      expect(result.status, target).toBe(403);
      expect(result.body).toBe(ADDRESS_REFUSED);
    }
    expect(r.connects).toEqual([]);
    expect(r.logs.every((l) => l.reason === "refused_address")).toBe(true);
    // a literal is refused before the control plane is asked; the name was asked about, then refused once it resolved
    expect(r.decideCalls.map((c) => c.host)).toEqual(["devtools.test"]);
    const outside = await connectVia(r.port, "10.89.233.2:443");
    expect(outside.status).toBe(200);
    outside.socket.destroy();
  });

  it("answers 400 for a malformed target or host, after the token check", async () => {
    const r = await rig();
    for (const target of [
      "example.test",
      "example.test:abc",
      "bad%host:443",
      "x".repeat(300) + ".test:443",
      "a..b:443",
    ]) {
      expect((await connectVia(r.port, target)).status, target).toBe(400);
    }
    expect(r.decideCalls).toEqual([]);
  });

  it("answers 502 when the name does not resolve or nothing answers", async () => {
    const none = await rig({ addresses: [] });
    expect((await connectVia(none.port, "nxdomain.test:443")).status).toBe(502);
    const failing = await rig({ addresses: () => Promise.reject(new Error("ENOTFOUND")) });
    expect((await connectVia(failing.port, "nxdomain.test:443")).status).toBe(502);
    expect(failing.logs[0]).toMatchObject({ event: "egress.error", reason: "resolve" });
    const refused = await rig({ connectHost: () => net.connect({ host: "127.0.0.1", port: 1 }) });
    expect((await connectVia(refused.port, "example.test:443")).status).toBe(502);
    expect(refused.logs[0]).toMatchObject({ event: "egress.error", reason: "connect" });
  });

  it("falls back to the next address when the first does not connect", async () => {
    let attempt = 0;
    const r = await rig({
      addresses: ["2606:4700::1111", "93.184.216.34"],
      connectHost: (address) => {
        attempt++;
        return address === "93.184.216.34"
          ? net.connect({ host: "127.0.0.1", port: r.upstream.port })
          : net.connect({ host: "127.0.0.1", port: 1 });
      },
    });
    const result = await connectVia(r.port, "example.test:443");
    expect(result.status).toBe(200);
    expect(attempt).toBe(1); // IPv4 goes first
    result.socket.destroy();
  });
});

describe("decide failures fail closed", () => {
  const unavailable = async (decide: RigOptions["decide"], decideTimeoutMs?: number) => {
    const r = await rig({ decide, decideTimeoutMs });
    const result = await connectVia(r.port, "example.test:443");
    expect(result.status).toBe(403);
    expect(result.headers["x-egress-decision"]).toBe("deny");
    expect(result.body).toBe(DECIDE_UNAVAILABLE);
    expect(r.connects).toEqual([]);
    expect(r.resolveCalls).toEqual([]);
    expect(r.logs[0]).toMatchObject({ event: "egress.deny", reason: "decide_unavailable" });
  };
  it("when the decide call throws", () => unavailable(() => Promise.reject(new Error("ECONNREFUSED"))));
  it("when it never answers (3 s default, shortened here)", () => unavailable(() => new Promise(() => {}), 150));
  it("when it answers nonsense", () => unavailable(async () => ({ decision: "maybe" }) as never));
  it("when the socket does not exist (real unix-socket client)", () =>
    unavailable(unixDecide(path.join(os.tmpdir(), "no-such-egress.sock"))));
});

describe("with a real unix-socket decide service", () => {
  it("round-trips the token, host and port, and enforces what it answers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-"));
    const socketPath = path.join(dir, "d.sock");
    const seen: { method?: string; url?: string; type?: string; body: unknown }[] = [];
    const service = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { host: string };
        seen.push({ method: req.method, url: req.url, type: req.headers["content-type"], body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            body.host === "ok.test" ? { decision: "allow" } : { decision: "deny", message: "Outside the whitelist." },
          ),
        );
      });
    });
    await new Promise<void>((r) => service.listen(socketPath, r));
    cleanups.push(async () => {
      service.closeAllConnections();
      await new Promise<void>((r) => service.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const r = await rig({ decide: unixDecide(socketPath) });

    const allowed = await connectVia(r.port, "ok.test:443");
    expect(allowed.status).toBe(200);
    allowed.socket.destroy();
    const denied = await connectVia(r.port, "other.test:443");
    expect(denied.status).toBe(403);
    expect(denied.headers["x-egress-decision"]).toBe("deny");
    expect(denied.body).toBe("Outside the whitelist.");

    expect(seen[0]).toEqual({
      method: "POST",
      url: "/egress/decide",
      type: "application/json",
      body: { token: TOKEN, host: "ok.test", port: 443 },
    });
    expect(seen).toHaveLength(2);
  });

  it("unixDecide rejects on a bad status, bad JSON and an abort", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-"));
    const socketPath = path.join(dir, "d.sock");
    let mode = "500";
    const service = http.createServer((req, res) => {
      req.resume();
      if (mode === "500") return void res.writeHead(500).end("boom");
      if (mode === "html") return void res.writeHead(200).end("<html>");
      if (mode === "hang") return;
      if (mode === "budget")
        return void res.writeHead(200).end(JSON.stringify({ decision: "allow", budget: { bytes: 100, ms: 5_000 } }));
      if (mode === "bad-budget")
        return void res.writeHead(200).end(JSON.stringify({ decision: "allow", budget: { bytes: -1, ms: "soon" } }));
      res.writeHead(200).end(JSON.stringify({ decision: "allow", message: 5 }));
    });
    await new Promise<void>((r) => service.listen(socketPath, r));
    cleanups.push(async () => {
      service.closeAllConnections();
      await new Promise<void>((r) => service.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const decide = unixDecide(socketPath);
    const request = { token: "t", host: "h.test", port: 443 };
    await expect(decide(request, AbortSignal.timeout(2000))).rejects.toThrow(/500/);
    mode = "html";
    await expect(decide(request, AbortSignal.timeout(2000))).rejects.toThrow();
    mode = "hang";
    await expect(decide(request, AbortSignal.timeout(100))).rejects.toThrow();
    mode = "ok";
    await expect(decide(request, AbortSignal.timeout(2000))).resolves.toEqual({
      decision: "allow",
      message: undefined,
    });
    mode = "budget";
    await expect(decide(request, AbortSignal.timeout(2000))).resolves.toEqual({
      decision: "allow",
      budget: { bytes: 100, ms: 5_000 },
    });
    mode = "bad-budget";
    expect((await decide(request, AbortSignal.timeout(2000))).budget).toBeUndefined();
  });
});

describe("plain HTTP (absolute-URI)", () => {
  it("forwards the request without the proxy credentials and returns the response", async () => {
    const r = await rig();
    const response = await requestVia(r.port, "http://Example.test/a/b?x=1", {
      headers: {
        host: "example.test",
        authorization: "Bearer end-to-end",
        "proxy-connection": "keep-alive",
        "x-keep": "1",
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe("hello from upstream: GET /a/b?x=1");
    expect(response.headers["x-upstream"]).toBe("yes");
    expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(response.headers["keep-alive"]).toBeUndefined();
    const seen = r.upstream.requests[0]!;
    expect(seen.url).toBe("/a/b?x=1");
    expect(seen.headers["proxy-authorization"]).toBeUndefined();
    expect(seen.headers["proxy-connection"]).toBeUndefined();
    expect(seen.headers.authorization).toBe("Bearer end-to-end");
    expect(seen.headers["x-keep"]).toBe("1");
    expect(seen.headers.host).toBe("example.test");
    expect(r.decideCalls).toEqual([{ token: TOKEN, host: "example.test", port: 80 }]);
    expect(r.connects).toEqual([{ address: "93.184.216.34", port: 80 }]);
    expect(r.logs.at(-1)).toMatchObject({ event: "egress.allow", host: "example.test", port: 80, method: "GET" });
  });

  it("forwards a request body", async () => {
    const r = await rig();
    const response = await requestVia(r.port, "http://example.test/upload", {
      method: "POST",
      body: "payload-123",
      headers: { "content-type": "text/plain" },
    });
    expect(response.status).toBe(200);
    expect(r.upstream.requests[0]).toMatchObject({ method: "POST", url: "/upload", body: "payload-123" });
    expect(r.logs.at(-1)?.bytesUp).toBe(11);
  });

  it("answers 407 without a token", async () => {
    const r = await rig();
    const response = await requestVia(r.port, "http://example.test/", {
      headers: { "proxy-authorization": undefined },
    });
    expect(response.status).toBe(407);
    expect(response.headers["proxy-authenticate"]).toBe('Basic realm="rei"');
    expect(r.decideCalls).toEqual([]);
  });

  it("refuses other ports, and denials carry the header and message", async () => {
    const r = await rig({
      answer: { decision: "deny", message: "Blocked." },
    });
    const port = await requestVia(r.port, "http://example.test:8080/");
    expect(port.status).toBe(403);
    expect(port.headers["x-egress-decision"]).toBe("deny");
    expect(r.decideCalls).toEqual([]);
    const deny = await requestVia(r.port, "http://deny.test/");
    expect([deny.status, deny.headers["x-egress-decision"], deny.body]).toEqual([403, "deny", "Blocked."]);
    expect(r.upstream.requests).toEqual([]);
  });

  it("refuses special resolutions and IP literals, and lets the user's own network through", async () => {
    const r = await rig({ addresses: ["::ffff:169.254.169.254"] });
    const named = await requestVia(r.port, "http://rebind.test/");
    expect([named.status, named.headers["x-egress-decision"], named.body]).toEqual([403, "deny", ADDRESS_REFUSED]);
    for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"]) {
      expect((await requestVia(r.port, url)).status, url).toBe(403);
    }
    expect(r.upstream.requests).toEqual([]);
    const lan = await rig({ refuse: [parseCidr("10.89.232.0/24")!] });
    expect((await requestVia(lan.port, "http://192.168.1.10/router")).body).toContain("GET /router");
    expect((await requestVia(lan.port, "http://10.89.232.2/")).status).toBe(403);
  });

  it("answers 400 to origin-form requests and https:// URLs", async () => {
    const r = await rig();
    expect((await requestVia(r.port, "/")).status).toBe(400);
    expect((await requestVia(r.port, "/healthz", { method: "POST" })).status).toBe(400);
    const https = await requestVia(r.port, "https://example.test/");
    expect(https.status).toBe(400);
    expect(r.decideCalls).toEqual([]);
  });

  it("answers 502 when the upstream is unreachable", async () => {
    const r = await rig({ connectHost: () => net.connect({ host: "127.0.0.1", port: 1 }) });
    expect((await requestVia(r.port, "http://example.test/")).status).toBe(502);
  });
});

describe("limits", () => {
  it("answers 431 to headers over the limit and never calls decide", async () => {
    const r = await rig({ maxHeaderBytes: 2048 });
    const big = "x".repeat(4000);
    const head = await rawConnect(
      r.port,
      `GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: ${basic()}\r\nX-Big: ${big}\r\n\r\n`,
    );
    expect(head).toMatch(/^HTTP\/1.1 431 /);
    const connect = await rawConnect(
      r.port,
      `CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: ${basic()}\r\nX-Big: ${big}\r\n\r\n`,
    );
    expect(connect).toMatch(/^HTTP\/1.1 431 /);
    expect(r.decideCalls).toEqual([]);
  });

  it("limits concurrent connections", async () => {
    const r = await rig({ maxConnections: 1 });
    const first = net.connect({ host: "127.0.0.1", port: r.port });
    await new Promise((resolve) => first.once("connect", resolve));
    const second = net.connect({ host: "127.0.0.1", port: r.port });
    second.on("error", () => {});
    const closed = await new Promise<boolean>((resolve) => {
      second.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    first.destroy();
    second.destroy();
    expect(closed).toBe(true);
  });

  it("closes idle tunnels", async () => {
    const r = await rig({ idleTimeoutMs: 100 });
    const result = await connectVia(r.port, "example.test:443");
    expect(result.status).toBe(200);
    const closed = await new Promise<boolean>((resolve) => {
      result.socket.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    expect(closed).toBe(true);
  });

  it("times out connecting", async () => {
    const r = await rig({
      connectTimeoutMs: 100,
      connectHost: () => new net.Socket(), // never connects
    });
    const result = await connectVia(r.port, "example.test:443");
    expect(result.status).toBe(502);
  });
});

describe("logs", () => {
  it("label each line with the step that sent it, under concurrency, and never forward the label", async () => {
    const r = await rig({ answer: { decision: "allow" }, addresses: ["93.184.216.34"] });
    const auth = basic();
    // Two steps at once: a plain-HTTP fetch and a CONNECT tunnel each, plus one request without a label (the sandbox).
    const [a, b] = await Promise.all([
      requestVia(r.port, "http://example.test/a", {
        headers: { "proxy-authorization": auth, [STEP_ID_HEADER]: "stp_a" },
      }),
      requestVia(r.port, "http://example.test/b", {
        headers: { "proxy-authorization": auth, [STEP_ID_HEADER]: "stp_b" },
      }),
      (async () => {
        const t = await connectVia(r.port, "example.test:443", {
          "proxy-authorization": auth,
          [STEP_ID_HEADER]: "stp_a",
        });
        return getThroughTunnel(t.socket, "/tunnel-a");
      })(),
      (async () => {
        const t = await connectVia(r.port, "example.test:443", {
          "proxy-authorization": auth,
          [STEP_ID_HEADER]: "stp_b",
        });
        return getThroughTunnel(t.socket, "/tunnel-b");
      })(),
      requestVia(r.port, "http://example.test/none", {
        headers: { "proxy-authorization": auth, [STEP_ID_HEADER]: "not a step id" },
      }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await vi_waitFor(() => r.logs.length >= 5);
    const byStep = (step: string | undefined) =>
      r.logs
        .filter((l) => l.stepId === step)
        .map((l) => l.method)
        .sort();
    expect(byStep("stp_a")).toEqual(["CONNECT", "GET"]);
    expect(byStep("stp_b")).toEqual(["CONNECT", "GET"]);
    expect(byStep(undefined)).toEqual(["GET"]);
    // The destination never sees the label.
    for (const seen of r.upstream.requests) expect(seen.headers[STEP_ID_HEADER]).toBeUndefined();
  });

  it("never hold the token, a path or a query", async () => {
    const printed: string[] = [];
    // The production logger's formatting, every level, written to an array instead of stdout.
    const upstream = await rig();
    const server = createEgressProxy({
      log: createLogger({ service: "egress", level: "debug", write: (line) => void printed.push(line) }),
      decide: async () => ({ decision: "allow" }),
      resolve: async () => ["93.184.216.34"],
      connectHost: () => net.connect({ host: "127.0.0.1", port: upstream.upstream.port }),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    const port = (server.address() as net.AddressInfo).port;
    await requestVia(port, "http://example.test/secret/path?key=abc123", {
      headers: { "proxy-authorization": basic("tok-LEAK-CHECK") },
    });
    const tunnel = await connectVia(port, "example.test:443", { "proxy-authorization": basic("tok-LEAK-CHECK") });
    await getThroughTunnel(tunnel.socket, "/secret/tunnel?key=abc123");
    await connectVia(port, "example.test:22", { "proxy-authorization": basic("tok-LEAK-CHECK") });
    await vi_waitFor(() => printed.length >= 3);
    const text = printed.join("\n");
    expect(text).not.toContain("tok-LEAK-CHECK");
    expect(text).not.toContain(Buffer.from("run:tok-LEAK-CHECK").toString("base64"));
    expect(text).not.toContain("secret");
    expect(text).not.toContain("abc123");
    for (const line of printed) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(typeof entry.timestamp).toBe("string");
      expect(entry.service).toBe("egress");
      expect(String(entry.event)).toMatch(/^egress\.(allow|deny|error)$/);
      expect(entry.level).toBe(entry.event === "egress.allow" ? "debug" : "info");
      expect(typeof entry.durationMs).toBe("number");
    }
  });
});

async function vi_waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the browser listener (source: browser)", () => {
  it("needs no token, asks with source browser and tunnels on allow", async () => {
    const r = await rig({ source: "browser" });
    const result = await connectVia(r.port, "Example.test:443", {});
    expect(result.status).toBe(200);
    const text = await getThroughTunnel(result.socket, "/x");
    expect(text).toContain("hello from upstream: GET /x");
    expect(r.decideCalls).toEqual([{ source: "browser", host: "example.test", port: 443 }]);
    expect(r.connects).toEqual([{ address: "93.184.216.34", port: 443 }]);
  });

  it("ignores a Proxy-Authorization header: it is never forwarded as an identity", async () => {
    const r = await rig({ source: "browser" });
    const result = await connectVia(r.port, "example.test:443");
    expect(result.status).toBe(200);
    result.socket.destroy();
    expect(r.decideCalls).toEqual([{ source: "browser", host: "example.test", port: 443 }]);
  });

  it("refuses with the control plane's message when it says deny, and fails closed when it cannot be asked", async () => {
    const denied = await rig({
      source: "browser",
      answer: { decision: "deny", message: "The browser is not in use." },
    });
    const refusal = await connectVia(denied.port, "example.test:443", {});
    expect(refusal.status).toBe(403);
    expect(refusal.body).toBe("The browser is not in use.");
    expect(denied.connects).toEqual([]);
    const down = await rig({ source: "browser", decide: () => Promise.reject(new Error("ECONNREFUSED")) });
    const closed = await connectVia(down.port, "example.test:443", {});
    expect(closed.status).toBe(403);
    expect(closed.body).toBe(DECIDE_UNAVAILABLE);
  });

  it("reaches the user's network but not the stack's, refuses other ports, and serves plain http", async () => {
    const lan = await rig({ source: "browser", addresses: ["10.0.0.5"], refuse: [parseCidr("10.89.232.0/24")!] });
    const intranet = await connectVia(lan.port, "intranet.test:443", {});
    expect(intranet.status).toBe(200);
    intranet.socket.destroy();
    const devtools = await connectVia(lan.port, "10.89.232.2:443", {});
    expect([devtools.status, devtools.body]).toEqual([403, ADDRESS_REFUSED]);
    expect((await connectVia(lan.port, "169.254.169.254:80", {})).status).toBe(403);
    const r = await rig({ source: "browser" });
    expect((await connectVia(r.port, "example.test:22", {})).status).toBe(403);
    const ok = await rig({ source: "browser" });
    const res = await requestVia(ok.port, "http://example.test/p", { headers: { "proxy-authorization": undefined } });
    expect(res.status).toBe(200);
    expect(res.body).toContain("hello from upstream: GET /p");
    expect(ok.decideCalls).toEqual([{ source: "browser", host: "example.test", port: 80 }]);
  });
});

const closed = (socket: net.Socket): Promise<void> =>
  new Promise((resolve) => (socket.destroyed ? resolve() : socket.once("close", () => resolve())));

describe("the render listener (source: render, ADR 0017)", () => {
  const RENDER = "r.job1.mac";
  const budgeted = (bytes: number, ms = 60_000) => ({
    decision: "allow" as const,
    localNetworks: "none" as const,
    budget: { bytes, ms },
  });

  it("requires the job's token and asks with source render", async () => {
    const r = await rig({ source: "render", answer: budgeted(1_000_000) });
    const anonymous = await connectVia(r.port, "example.test:443", {});
    expect(anonymous.status).toBe(407);
    expect(anonymous.headers["proxy-authenticate"]).toBe('Basic realm="rei"');
    const result = await connectVia(r.port, "example.test:443", { "proxy-authorization": basic(RENDER, "rei") });
    expect(result.status).toBe(200);
    expect(await getThroughTunnel(result.socket, "/x")).toContain("hello from upstream: GET /x");
    expect(r.decideCalls).toEqual([{ source: "render", token: RENDER, host: "example.test", port: 443 }]);
  });

  it("cuts every connection of the token once its bytes are used, and refuses new ones without asking", async () => {
    const r = await rig({ source: "render", answer: budgeted(1_000) });
    const auth = { "proxy-authorization": basic(RENDER, "rei") };
    const first = await connectVia(r.port, "a.test:443", auth);
    const second = await connectVia(r.port, "b.test:443", auth);
    expect([first.status, second.status]).toEqual([200, 200]);
    first.socket.on("error", () => {});
    second.socket.on("error", () => {});
    first.socket.write("x".repeat(2_000));
    await Promise.all([closed(first.socket), closed(second.socket)]);
    const third = await connectVia(r.port, "c.test:443", auth);
    expect([third.status, third.body]).toEqual([403, BUDGET_SPENT]);
    expect(r.decideCalls).toHaveLength(2);
    // Another job's token has its own budget.
    const other = await connectVia(r.port, "c.test:443", { "proxy-authorization": basic("r.job2.mac", "rei") });
    expect(other.status).toBe(200);
    other.socket.destroy();
  });

  it("cuts the token's connections when its time runs out", async () => {
    const r = await rig({ source: "render", answer: budgeted(1_000_000, 100) });
    const tunnel = await connectVia(r.port, "a.test:443", { "proxy-authorization": basic(RENDER, "rei") });
    expect(tunnel.status).toBe(200);
    tunnel.socket.on("error", () => {});
    const started = Date.now();
    await closed(tunnel.socket);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("never reaches the user's network when the answer says none", async () => {
    const r = await rig({ source: "render", answer: budgeted(1_000_000), addresses: ["192.168.1.20"] });
    const lan = await connectVia(r.port, "router.test:443", { "proxy-authorization": basic(RENDER, "rei") });
    expect([lan.status, lan.body]).toEqual([403, LOCAL_NETWORK_DENIED]);
    expect(r.connects).toEqual([]);
  });

  it("refuses loopback, metadata and stack addresses, and a name that rebinds to one, whatever the answer", async () => {
    const auth = { "proxy-authorization": basic(RENDER, "rei") };
    const literals = await rig({ source: "render", answer: budgeted(1_000_000) });
    for (const target of ["127.0.0.1:80", "[::1]:443", "169.254.169.254:80", "0.0.0.0:80"]) {
      const result = await connectVia(literals.port, target, auth);
      expect([result.status, result.body], target).toEqual([403, ADDRESS_REFUSED]);
    }
    expect(literals.decideCalls).toEqual([]);
    for (const addresses of [["169.254.169.254"], ["127.0.0.1"], ["93.184.216.34", "10.89.232.2"]]) {
      const rebind = await rig({ source: "render", answer: budgeted(1_000_000), addresses });
      const result = await connectVia(rebind.port, "rebind.example:443", auth);
      expect(result.status, addresses.join()).toBe(403);
      expect(rebind.connects).toEqual([]);
    }
  });

  it("counts plain-http requests against the budget too", async () => {
    const r = await rig({ source: "render", answer: budgeted(10) });
    const auth = { "proxy-authorization": basic(RENDER, "rei") };
    await requestVia(r.port, "http://example.test/p", { headers: auth }).catch(() => undefined);
    const after = await requestVia(r.port, "http://example.test/q", { headers: auth });
    expect([after.status, after.body]).toEqual([403, BUDGET_SPENT]);
  });
});

describe("log entries carry no request content (ADR 0003)", () => {
  it("keeps the denial message, URL path and query, and credentials out of the log", async () => {
    const r = await rig({ answer: { decision: "deny", message: `Denied: ${Object.values(CANARIES).join(" | ")}` } });
    const plain = await requestVia(
      r.port,
      `http://example.test/private/${encodeURIComponent(CANARIES.email)}?token=${encodeURIComponent(CANARIES.apiKey)}`,
    );
    expect(plain.status).toBe(403);
    const tunnel = await connectVia(r.port, "example.test:443");
    expect(tunnel.status).toBe(403);
    expect(r.logs.map((l) => l.event)).toEqual(["egress.deny", "egress.deny"]);
    expect(r.logs[0]).toMatchObject({ host: "example.test", port: 80, method: "GET" });
    expect(leakedCanaries(JSON.stringify(r.logs))).toEqual([]);
    expect(JSON.stringify(r.logs)).not.toContain("private");
  });
});

describe("the local-network scope", () => {
  it("refuses a resolved local-network address unless the answer's scope covers it", async () => {
    const denied = await rig({ answer: { decision: "allow" }, addresses: ["192.168.1.20"] });
    const refused = await connectVia(denied.port, "nas.test:80");
    expect([refused.status, refused.body]).toEqual([403, LOCAL_NETWORK_DENIED]);
    expect(denied.connects).toEqual([]);
    expect(denied.logs.at(-1)).toMatchObject({ event: "egress.deny", reason: "local_network" });

    const listed = await rig({
      answer: { decision: "allow", localNetworks: ["192.168.1.0/24"] },
      addresses: ["192.168.1.20"],
    });
    const through = await connectVia(listed.port, "nas.test:80");
    expect(through.status).toBe(200);
    through.socket.destroy();
    expect(listed.connects).toEqual([{ address: "192.168.1.20", port: 80 }]);

    const outside = await rig({
      answer: { decision: "allow", localNetworks: ["192.168.1.0/24"] },
      addresses: ["192.168.2.20"],
    });
    expect((await connectVia(outside.port, "nas.test:80")).status).toBe(403);
  });

  it("never looks a name up unless the control plane allowed it", async () => {
    const r = await rig({ answer: { decision: "deny" } });
    expect((await connectVia(r.port, "exfil-data.test:443")).status).toBe(403);
    expect(r.resolveCalls).toEqual([]);
  });
});
