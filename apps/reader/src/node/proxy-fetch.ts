// The reader's own HTTP client: one GET through its proxy, authenticated by a job token. https goes through a CONNECT
// tunnel and TLS made here (the proxy sees only host and port); http uses an absolute-URI request. It never follows
// redirects and never reads more than `maxBytes` of the (decoded) body.
import http from "node:http";
import tls from "node:tls";
import zlib from "node:zlib";
import { STEP_ID_HEADER } from "@rei/protocol";
import { type FetchOptions, type FetchResponse, type FetchViaProxy, ProxyRefused } from "../core/types.ts";

const MAX_PROXY_MESSAGE = 2_000;

/** `host:port` (or `http://host:port`) of the egress proxy. */
export function parseProxy(proxy: string): { host: string; port: number } {
  const text = proxy
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  const m = /^(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(text);
  if (!m) throw new Error("the proxy address must be host:port");
  const port = m[2] === undefined ? 3128 : Number(m[2]);
  return { host: m[1]!.replace(/^\[|\]$/g, ""), port };
}

const headersOf = (raw: http.IncomingHttpHeaders): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw))
    if (value !== undefined) out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  return out;
};

function decoderFor(encoding: string | undefined): NodeJS.ReadWriteStream | undefined {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return undefined;
  }
}

/** Reads a small plain-text body (a proxy refusal) from a stream, cut at MAX_PROXY_MESSAGE characters. */
function readMessage(stream: NodeJS.ReadableStream, initial?: Buffer): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = initial?.length ? [initial] : [];
    let size = initial?.length ?? 0;
    const done = () => resolve(Buffer.concat(chunks).toString("utf8").slice(0, MAX_PROXY_MESSAGE).trim());
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 8_192) chunks.push(chunk);
    });
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", done);
  });
}

export function createProxyFetch(proxy: string): FetchViaProxy {
  const { host: proxyHost, port: proxyPort } = parseProxy(proxy);

  return (rawUrl: string, token: string, options: FetchOptions): Promise<FetchResponse> =>
    new Promise<FetchResponse>((resolve, reject) => {
      const url = new URL(rawUrl);
      url.hash = "";
      const secure = url.protocol === "https:";
      const targetPort = url.port !== "" ? Number(url.port) : secure ? 443 : 80;
      const hostText = url.hostname; // brackets kept for IPv6 literals
      const auth = `Basic ${Buffer.from(`run:${token}`).toString("base64")}`;
      // Proxy-only headers: the proxy strips both before anything reaches the site.
      const proxyHeaders: http.OutgoingHttpHeaders = {
        "proxy-authorization": auth,
        ...(options.stepId ? { [STEP_ID_HEADER]: options.stepId } : {}),
      };
      const { signal } = options;
      const cleanups: (() => void)[] = [];
      let settled = false;
      const sockets: { destroy(): unknown }[] = [];
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        for (const c of cleanups) c();
        fn();
      };
      const fail = (error: unknown) =>
        finish(() => {
          for (const s of sockets) s.destroy();
          reject(error);
        });
      const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));

      const requestHeaders: http.OutgoingHttpHeaders = {
        ...options.headers,
        host: url.port !== "" ? `${hostText}:${url.port}` : hostText,
        "accept-encoding": "gzip, deflate, br",
        connection: "close",
      };

      const handle = (res: http.IncomingMessage, viaProxyRequest: boolean) => {
        const status = res.statusCode ?? 0;
        const headers = headersOf(res.headers);
        if (viaProxyRequest && (headers["x-egress-decision"] !== undefined || status === 407)) {
          void readMessage(res).then((message) =>
            fail(new ProxyRefused(message || "The proxy refused the connection.")),
          );
          return;
        }
        if (status >= 300 && status < 400) {
          res.destroy();
          return finish(() => {
            for (const s of sockets) s.destroy();
            resolve({ status, headers, body: new Uint8Array(0), truncated: false });
          });
        }
        const decoder = decoderFor(headers["content-encoding"]);
        const source: NodeJS.ReadableStream = decoder
          ? res.pipe(decoder as NodeJS.WritableStream & NodeJS.ReadableStream)
          : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const complete = () =>
          finish(() => {
            for (const s of sockets) s.destroy();
            resolve({ status, headers, body: new Uint8Array(Buffer.concat(chunks)), truncated });
          });
        source.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > options.maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - options.maxBytes))));
            complete();
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        source.on("end", complete);
        source.on("error", fail);
        res.on("error", fail);
        res.on("aborted", () => fail(Object.assign(new Error("connection lost"), { code: "ECONNRESET" })));
      };

      if (!secure) {
        const req = http.request({
          host: proxyHost,
          port: proxyPort,
          method: "GET",
          path: url.href,
          headers: { ...requestHeaders, ...proxyHeaders },
          agent: false,
        });
        req.on("response", (res) => handle(res, true));
        req.on("error", fail);
        sockets.push(req);
        req.end();
        return;
      }

      const connect = http.request({
        host: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: `${hostText}:${targetPort}`,
        headers: { host: `${hostText}:${targetPort}`, ...proxyHeaders },
        agent: false,
      });
      sockets.push(connect);
      connect.on("error", fail);
      connect.on("connect", (res, socket, head) => {
        sockets.push(socket);
        socket.on("error", fail);
        if (res.statusCode !== 200) {
          void readMessage(socket, head).then((message) =>
            fail(new ProxyRefused(message || `The proxy refused the connection (HTTP ${res.statusCode}).`)),
          );
          return;
        }
        const secureSocket = tls.connect({
          socket,
          servername: /^[\d.]+$|:/.test(url.hostname) ? undefined : url.hostname.replace(/^\[|\]$/g, ""),
          ALPNProtocols: ["http/1.1"],
        });
        sockets.push(secureSocket);
        secureSocket.on("error", fail);
        secureSocket.once("secureConnect", () => {
          const agent = Object.assign(new http.Agent({ keepAlive: false }), { createConnection: () => secureSocket });
          const req = http.request({
            method: "GET",
            path: `${url.pathname}${url.search}`,
            headers: requestHeaders,
            agent,
          });
          req.on("response", (res2) => handle(res2, false));
          req.on("error", fail);
          sockets.push(req);
          req.end();
        });
      });
      connect.end();
    });
}
