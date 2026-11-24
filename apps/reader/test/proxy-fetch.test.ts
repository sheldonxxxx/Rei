import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { STEP_ID_HEADER } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyRefused } from "../src/core/types.ts";
import { createProxyFetch, parseProxy } from "../src/node/proxy-fetch.ts";

// The Node client for web_fetch against a stand-in for the egress proxy.
interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}
let proxy: Server | undefined;
let seen: Seen[] = [];
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!proxy) return resolve();
    proxy.closeAllConnections();
    proxy.close(() => resolve());
  });
  proxy = undefined;
  seen = [];
});

async function startProxy(
  handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void,
  onConnect?: (req: IncomingMessage, socket: Socket) => void,
): Promise<string> {
  proxy = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  proxy.on("connect", (req, socket: Socket) => {
    seen.push({ method: "CONNECT", url: req.url ?? "", headers: req.headers });
    onConnect?.(req, socket);
  });
  await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
  return `127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}
const options = (extra: Partial<{ maxBytes: number; signal: AbortSignal }> = {}) => ({
  signal: AbortSignal.timeout(5_000),
  maxBytes: 1_000_000,
  headers: { accept: "text/html", "user-agent": "rei/0.1" },
  ...extra,
});

describe("the egress proxy client", () => {
  it("parses the proxy address", () => {
    expect(parseProxy("egress:3128")).toEqual({ host: "egress", port: 3128 });
    expect(parseProxy("http://127.0.0.1:8080/")).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(parseProxy("egress")).toEqual({ host: "egress", port: 3128 });
    expect(() => parseProxy("a b")).toThrow();
  });

  it("sends http as an absolute-URI request to the proxy with the call token as Basic credentials", async () => {
    const addr = await startProxy((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-other": "y" });
      res.end("<p>hello</p>");
    });
    const response = await createProxyFetch(addr)("http://site.example/a/b?q=1#frag", "c.id.mac", options());
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(new TextDecoder().decode(response.body)).toBe("<p>hello</p>");
    expect(response.truncated).toBe(false);
    const [req] = seen;
    expect(req!.method).toBe("GET");
    expect(req!.url).toBe("http://site.example/a/b?q=1");
    expect(req!.headers.host).toBe("site.example");
    expect(req!.headers["user-agent"]).toBe("rei/0.1");
    expect(req!.headers.accept).toBe("text/html");
    expect(req!.headers["accept-encoding"]).toBe("gzip, deflate, br");
    expect(Buffer.from(String(req!.headers["proxy-authorization"]).replace(/^Basic /, ""), "base64").toString()).toBe(
      "run:c.id.mac",
    );
  });

  it("decodes gzip and does not follow redirects", async () => {
    const addr = await startProxy((req, res) => {
      if (req.url!.endsWith("/moved")) {
        res.writeHead(302, { location: "https://elsewhere.example/" });
        return res.end("moved");
      }
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(gzipSync("zipped text"));
    });
    const fetch = createProxyFetch(addr);
    expect(new TextDecoder().decode((await fetch("http://site.example/z", "t", options())).body)).toBe("zipped text");
    const moved = await fetch("http://site.example/moved", "t", options());
    expect(moved.status).toBe(302);
    expect(moved.headers.location).toBe("https://elsewhere.example/");
    expect(moved.body.length).toBe(0);
  });

  it("stops reading at maxBytes and says so, also for a body that inflates beyond it", async () => {
    const addr = await startProxy((req, res) => {
      if (req.url!.endsWith("/zip")) {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        return res.end(gzipSync("a".repeat(100_000)));
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("x".repeat(5_000));
      setTimeout(() => res.end("y".repeat(5_000)), 20);
    });
    const fetch = createProxyFetch(addr);
    const plain = await fetch("http://site.example/big", "t", options({ maxBytes: 1_000 }));
    expect(plain.truncated).toBe(true);
    expect(plain.body.length).toBe(1_000);
    const zipped = await fetch("http://site.example/zip", "t", options({ maxBytes: 2_000 }));
    expect(zipped.truncated).toBe(true);
    expect(zipped.body.length).toBe(2_000);
  });

  it("turns the proxy's own refusals into ProxyRefused with its message", async () => {
    const addr = await startProxy(
      (_req, res) => {
        res.writeHead(403, { "content-type": "text/plain", "x-egress-decision": "deny" });
        res.end("Connections to private addresses are not allowed.");
      },
      (_req, socket) =>
        socket.end(
          "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 34\r\nConnection: close\r\n\r\nOnly ports 80 and 443 are allowed.",
        ),
    );
    const fetch = createProxyFetch(addr);
    await expect(fetch("http://10.0.0.1/", "t", options())).rejects.toThrow(
      new ProxyRefused("Connections to private addresses are not allowed."),
    );
    await expect(fetch("https://site.example/", "t", options())).rejects.toThrow(
      new ProxyRefused("Only ports 80 and 443 are allowed."),
    );
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET http://10.0.0.1/", "CONNECT site.example:443"]);
    expect(
      Buffer.from(String(seen[1]!.headers["proxy-authorization"]).replace(/^Basic /, ""), "base64").toString(),
    ).toBe("run:t");
  });

  it("sends the step id to the proxy on both paths, and nothing when there is none", async () => {
    const addr = await startProxy(
      (_req, res) => res.writeHead(403, { "x-egress-decision": "deny" }).end("no"),
      (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno"),
    );
    const fetch = createProxyFetch(addr);
    const withStep = { ...options(), stepId: "stp_1" };
    await expect(fetch("http://site.example/", "t", withStep)).rejects.toThrow(ProxyRefused);
    await expect(fetch("https://site.example/", "t", withStep)).rejects.toThrow(ProxyRefused);
    await expect(fetch("http://site.example/", "t", options())).rejects.toThrow(ProxyRefused);
    expect(seen.map((r) => r.headers[STEP_ID_HEADER])).toEqual(["stp_1", "stp_1", undefined]);
  });

  it("is a real error when the site itself answers 403 (no proxy decision header)", async () => {
    const addr = await startProxy((_req, res) => {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<p>forbidden</p>");
    });
    const response = await createProxyFetch(addr)("http://site.example/", "t", options());
    expect(response.status).toBe(403);
  });

  it("aborts on the signal, and fails when the proxy is not there", async () => {
    const addr = await startProxy(() => {
      /* never answers */
    });
    const ac = new AbortController();
    const pending = createProxyFetch(addr)("http://site.example/", "t", options({ signal: ac.signal }));
    setTimeout(() => ac.abort(new Error("stop")), 50);
    await expect(pending).rejects.toThrow("stop");
    await expect(createProxyFetch("127.0.0.1:1")("http://site.example/", "t", options())).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    await expect(
      createProxyFetch(addr)("http://site.example/", "t", options({ signal: AbortSignal.abort(new Error("early")) })),
    ).rejects.toThrow("early");
  });
});
