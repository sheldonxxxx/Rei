// A running egress proxy for tests: real HTTP server on loopback, injected decide/resolve/connectHost, and a local
// upstream standing in for "the internet" (the proxy only ever connects where connectHost sends it).
import http from "node:http";
import net from "node:net";
import {
  createEgressProxy,
  type Decide,
  type DecideRequest,
  type DecideResponse,
  type EgressOptions,
  type LogEntry,
} from "@rei/forward-proxy";
import { createLogger } from "@rei/logging";

export const TOKEN = "run1.s3cr3t-token-value";
export const basic = (token = TOKEN, user = "run") => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

export interface Upstream {
  port: number;
  /** Raw TCP connections accepted. */
  connections: number;
  /** HTTP requests seen (headers lower-cased), for the plain-HTTP path. */
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

/** HTTP server that also answers CONNECT-tunneled raw bytes: it is a plain http server, tunnels speak http to it. */
export async function startUpstream(): Promise<Upstream> {
  const requests: Upstream["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, {
        "content-type": "text/plain",
        "x-upstream": "yes",
        "set-cookie": ["a=1", "b=2"],
        "keep-alive": "timeout=5",
      });
      res.end(`hello from upstream: ${req.method} ${req.url}`);
    });
  });
  const state = { connections: 0 };
  server.on("connection", () => state.connections++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    get connections() {
      return state.connections;
    },
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export interface Rig {
  port: number;
  logs: LogEntry[];
  decideCalls: DecideRequest[];
  resolveCalls: string[];
  connects: { address: string; port: number }[];
  upstream: Upstream;
  close(): Promise<void>;
}

export interface RigOptions extends Partial<EgressOptions> {
  /** What decide answers (default: allow, with every local-network address in scope). */
  answer?: DecideResponse | ((request: DecideRequest) => DecideResponse | Promise<DecideResponse>);
  /** What the resolver returns (default: a public address). */
  addresses?: string[] | ((host: string) => string[] | Promise<string[]>);
}

export async function startRig(options: RigOptions = {}): Promise<Rig> {
  const { answer: answerOption, addresses: addressesOption, ...overrides } = options;
  const upstream = await startUpstream();
  const logs: LogEntry[] = [];
  const decideCalls: DecideRequest[] = [];
  const resolveCalls: string[] = [];
  const connects: Rig["connects"] = [];
  // The default control plane allows the destination and all of its addresses; a test narrows the scope itself.
  const answer = answerOption ?? { decision: "allow", localNetworks: "all" };
  const decide: Decide = async (request) => {
    decideCalls.push(request);
    return typeof answer === "function" ? answer(request) : answer;
  };
  const addresses = addressesOption ?? ["93.184.216.34"];
  const server = createEgressProxy({
    decide,
    resolve: async (host) => {
      resolveCalls.push(host);
      return typeof addresses === "function" ? addresses(host) : addresses;
    },
    // The "internet" is the local upstream, whatever address and port the proxy chose.
    connectHost: (address, port) => {
      connects.push({ address, port });
      return net.connect({ host: "127.0.0.1", port: upstream.port });
    },
    log: createLogger({
      service: "egress",
      level: "debug",
      write: (line) => void logs.push(JSON.parse(line) as LogEntry),
    }),
    ...overrides,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    logs,
    decideCalls,
    resolveCalls,
    connects,
    upstream,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await upstream.close();
    },
  };
}

export interface ConnectResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  socket: net.Socket;
}

/** CONNECT through the proxy; resolves with the proxy's answer (and the tunnel socket on 2xx). */
export function connectVia(
  port: number,
  target: string,
  headers: http.OutgoingHttpHeaders = { "proxy-authorization": basic() },
): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target, headers });
    // Node reports every answer to CONNECT through "connect"; a refusal's body is whatever follows on the socket.
    req.on("connect", (res, socket, head) => {
      const status = res.statusCode ?? 0;
      if (status >= 200 && status < 300) return resolve({ status, headers: res.headers, body: "", socket });
      const chunks: Buffer[] = [head];
      socket.on("data", (c: Buffer) => chunks.push(c));
      socket.on("error", () => {});
      socket.on("close", () =>
        resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString(), socket }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** A request sent to the proxy; `url` is what goes on the request line. */
export function requestVia(
  port: number,
  url: string,
  options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: options.method ?? "GET",
      path: url,
      headers: Object.fromEntries(
        Object.entries({ "proxy-authorization": basic(), ...options.headers }).filter(([, v]) => v !== undefined),
      ),
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

/** Speak HTTP to the upstream through an established tunnel. */
export function getThroughTunnel(socket: net.Socket, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
    socket.write(`GET ${path} HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n`);
  });
}
