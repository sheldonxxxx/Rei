// The egress proxy: the sandbox's only way out. For every connection it checks the run's token, asks the control plane
// whether the destination host may be reached (the approval policy decides), then connects to the address it resolved
// itself, never to a loopback, link-local or special one and never into the stack's own networks. HTTPS goes through
// CONNECT tunnels, plain HTTP through absolute-URI requests. A render job's connections (source "render") also share one
// byte and time budget per token, from the control plane's answer (ADR 0017).
//
// The dependencies that touch the outside world (decide, resolve, connectHost, log) are injectable for tests.
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { createLogger, type Logger } from "@rei/logging";
import { addressInScope, type Cidr, isPrivateAddress, isRefusedAddress, type LocalScope } from "@rei/network";
import type { Decide, DecideRequest } from "./decide.ts";
import { parseConnectTarget, parseProxyUrl } from "./host.ts";

/** One service-log line per request, as the shared logger writes it (ADR 0003: hosts and codes, never a path). */
export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  service: "egress";
  event: "egress.allow" | "egress.deny" | "egress.error";
  host?: string;
  port?: number;
  method?: string;
  reason?: string;
  bytesUp?: number;
  bytesDown?: number;
  /** The control plane's step that made the request (its own web fetches send it); absent for sandbox and browser. */
  stepId?: string;
  durationMs: number;
}
type Entry = Omit<LogEntry, "timestamp" | "level" | "service" | "durationMs" | "stepId">;

/**
 * The step-ID header the control plane sends with its own requests (the same name as the gateway's, from
 * @rei/protocol), so its egress lines join that step's gateway and control lines. It is a log label only: never
 * used to decide anything, and never forwarded to the destination.
 */
export const STEP_ID_HEADER = "x-rei-step-id";
const stepIdOf = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" && /^[\w.:-]{1,128}$/.test(value) ? value : undefined;

// An allowed connection is routine; a refusal or an ask is worth seeing by default; a failure to connect is a warning.
const LEVEL: Readonly<Record<Entry["event"], "debug" | "info" | "warn">> = {
  "egress.allow": "debug",
  "egress.deny": "info",
  "egress.error": "warn",
};

export interface EgressOptions {
  decide: Decide;
  /**
   * "browser": no Proxy-Authorization (the listener's network is the identity) and the question carries source:"browser".
   * "render": a render job's token is required (as for "exec") and the question carries source:"render".
   */
  source?: "exec" | "browser" | "render";
  /** All addresses of a host name (default: the system resolver). */
  resolve?: (host: string) => Promise<string[]>;
  /** Networks to refuse on top of the special ranges: the stack's own subnets (see main.ts). */
  refuse?: Cidr[];
  /** Opens the upstream connection to an already-resolved address (default: net.connect). */
  connectHost?: (address: string, port: number) => net.Socket;
  /** One event per request (default: JSON lines on stdout at info). Events never hold the token or a URL path. */
  log?: Logger;
  allowedPorts?: number[];
  decideTimeoutMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxHeaderBytes?: number;
  maxConnections?: number;
}

export const DECIDE_UNAVAILABLE = "The network decision service is not available.";
export const ADDRESS_REFUSED = "Connections to this stack's own networks and to special addresses are not allowed.";
export const LOCAL_NETWORK_DENIED =
  "That address is on the user's local network, which this agent may not reach. Its sandbox network must be Any site, or Whitelist with the host name and its address both on the sandbox whitelist.";

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  407: "Proxy Authentication Required",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
};

// Headers that belong to one hop; the Proxy-Authorization header carries the token and must never go upstream.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export const BUDGET_SPENT = "This render job's network allowance is used up or has ended.";

/**
 * What one token's connections may still move, from the control plane's answer (render jobs). Shared by every
 * connection of the token; when the bytes or the time run out, every one of them is cut and new ones are refused.
 */
interface Budget {
  left: number;
  spent: boolean;
  sockets: Set<net.Socket>;
  timer: NodeJS.Timeout;
}

interface Reply {
  status: number;
  message: string;
  event: "egress.deny" | "egress.error";
  decision?: "deny";
  headers?: Record<string, string>;
  reason?: string;
}
type Admission = { reply: Reply } | { socket: net.Socket; budget?: Budget };

const replyHeaders = (reply: Reply): Record<string, string> => ({
  ...(reply.decision ? { "X-Egress-Decision": reply.decision } : {}),
  ...reply.headers,
  "Content-Type": "text/plain; charset=utf-8",
  "Content-Length": String(Buffer.byteLength(reply.message)),
  Connection: "close",
});

/** The password of a Basic Proxy-Authorization header (the user name is ignored), or null. */
function tokenFrom(header: string | undefined): string | null {
  const m = /^Basic +([A-Za-z0-9+/=_-]+)$/i.exec(header ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const token = decoded.slice(decoded.indexOf(":") + 1);
  return decoded.includes(":") && token !== "" && token.length <= 512 ? token : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createEgressProxy(options: EgressOptions): http.Server {
  const allowedPorts = options.allowedPorts ?? [80, 443];
  const decideTimeoutMs = options.decideTimeoutMs ?? 3000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 600_000;
  const resolve =
    options.resolve ??
    (async (host: string) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address));
  const connectHost = options.connectHost ?? ((address: string, port: number) => net.connect({ host: address, port }));
  const log = options.log ?? createLogger({ service: "egress" });
  const emit = ({ event, ...fields }: Entry, started: number, stepId: string | undefined) =>
    log[LEVEL[event]](event, { ...fields, stepId, durationMs: Date.now() - started });

  const refuse = options.refuse ?? [];
  const browser = options.source === "browser";
  const render = options.source === "render";
  const budgets = new Map<string, Budget>();

  function cut(budget: Budget): void {
    budget.spent = true;
    for (const socket of budget.sockets) socket.destroy();
    budget.sockets.clear();
  }

  /** The token's budget, made from the first answer that carries one; later answers do not refill it. */
  function budgetFor(token: string, given: { bytes: number; ms: number }): Budget {
    const existing = budgets.get(token);
    if (existing) return existing;
    const budget: Budget = {
      left: given.bytes,
      spent: false,
      sockets: new Set(),
      timer: setTimeout(() => {
        cut(budget);
        budgets.delete(token);
      }, given.ms),
    };
    budget.timer.unref();
    budgets.set(token, budget);
    return budget;
  }

  /** Counts what a connection moved against its budget; over it, the token's connections are cut. */
  function spend(budget: Budget | undefined, bytes: number): void {
    if (!budget || budget.spent) return;
    budget.left -= bytes;
    if (budget.left < 0) cut(budget);
  }

  function track(budget: Budget | undefined, ...sockets: net.Socket[]): void {
    if (!budget) return;
    for (const socket of sockets) {
      if (budget.spent) socket.destroy();
      else {
        budget.sockets.add(socket);
        socket.once("close", () => budget.sockets.delete(socket));
      }
    }
  }

  async function ask(
    token: string | null,
    host: string,
    port: number,
  ): Promise<{
    decision: "allow" | "deny";
    message?: string;
    unavailable?: boolean;
    localNetworks?: LocalScope;
    budget?: { bytes: number; ms: number } | undefined;
  }> {
    const signal = AbortSignal.timeout(decideTimeoutMs);
    try {
      const question: DecideRequest =
        token === null
          ? { source: "browser", host, port }
          : render
            ? { source: "render", token, host, port }
            : { token, host, port };
      const answer = await withTimeout(options.decide(question, signal), decideTimeoutMs, "decide timed out");
      if (answer?.decision !== "allow" && answer?.decision !== "deny") throw new Error("unknown decision");
      return answer;
    } catch {
      return { decision: "deny", message: DECIDE_UNAVAILABLE, unavailable: true }; // fail closed
    }
  }

  function connectOne(address: string, port: number, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolveSocket, reject) => {
      const socket = connectHost(address, port);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("connect timeout"));
      }, timeoutMs);
      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        socket.on("error", () => {}); // later errors end the tunnel through "close"
        resolveSocket(socket);
      });
    });
  }

  /** Everything between "a request arrived" and "an upstream socket is open"; the two request kinds share it. */
  async function admit(
    proxyAuthorization: string | undefined,
    target: { host: string; port: number } | null,
  ): Promise<Admission> {
    const token = browser ? null : tokenFrom(proxyAuthorization);
    if (!browser && !token) {
      return {
        reply: {
          status: 407,
          message: "Proxy authentication required.",
          event: "egress.deny",
          reason: "no_token",
          headers: { "Proxy-Authenticate": 'Basic realm="rei"' },
        },
      };
    }
    if (!target)
      return { reply: { status: 400, message: "Bad request.", event: "egress.error", reason: "bad_target" } };
    const { host, port } = target;
    if (!allowedPorts.includes(port)) {
      return {
        reply: {
          status: 403,
          message: `Only ports ${allowedPorts.join(" and ")} are allowed.`,
          event: "egress.deny",
          decision: "deny",
          reason: "port",
        },
      };
    }
    // An address we would refuse anyway is refused before the control plane is asked, so the answer doesn't depend on it.
    if (net.isIP(host) && isRefusedAddress(host, refuse)) {
      return {
        reply: {
          status: 403,
          message: ADDRESS_REFUSED,
          event: "egress.deny",
          decision: "deny",
          reason: "refused_address",
        },
      };
    }
    // A render token whose allowance is gone is refused here: the job is over, so the control plane need not be asked.
    if (token !== null && budgets.get(token)?.spent) {
      return {
        reply: { status: 403, message: BUDGET_SPENT, event: "egress.deny", decision: "deny", reason: "budget" },
      };
    }
    const answer = await ask(token, host, port);
    if (answer.decision !== "allow") {
      const message = (answer.message ?? "Network access is not allowed.").slice(0, 2000);
      return {
        reply: {
          status: 403,
          message,
          event: "egress.deny",
          decision: answer.decision,
          reason: answer.unavailable ? "decide_unavailable" : undefined,
        },
      };
    }
    // Resolved only now, once the control plane has allowed the name: a denied name is never looked up.
    let addresses: string[];
    try {
      addresses = net.isIP(host) ? [host] : await withTimeout(resolve(host), connectTimeoutMs, "resolve timed out");
    } catch {
      return {
        reply: { status: 502, message: "The host could not be resolved.", event: "egress.error", reason: "resolve" },
      };
    }
    if (addresses.length === 0)
      return {
        reply: { status: 502, message: "The host could not be resolved.", event: "egress.error", reason: "resolve" },
      };
    // One refused answer is enough to refuse: a name that also resolves into the stack is an SSRF attempt, not a CDN.
    if (addresses.some((address) => isRefusedAddress(address, refuse))) {
      return {
        reply: {
          status: 403,
          message: ADDRESS_REFUSED,
          event: "egress.deny",
          decision: "deny",
          reason: "refused_address",
        },
      };
    }
    // A local-network address is reached only where the control plane's answer says so (the sandbox setting decides).
    const scope: LocalScope = answer.localNetworks ?? "none";
    if (addresses.some((address) => isPrivateAddress(address) && !addressInScope(address, scope))) {
      return {
        reply: {
          status: 403,
          message: LOCAL_NETWORK_DENIED,
          event: "egress.deny",
          decision: "deny",
          reason: "local_network",
        },
      };
    }
    // Connect to the address we checked (never the name again), IPv4 first, within one overall budget.
    const ordered = [...addresses.filter((a) => net.isIPv4(a)), ...addresses.filter((a) => !net.isIPv4(a))];
    const deadline = Date.now() + connectTimeoutMs;
    const budget = token !== null && answer.budget ? budgetFor(token, answer.budget) : undefined;
    for (const address of ordered) {
      try {
        const socket = await connectOne(address, port, Math.max(1, deadline - Date.now()));
        if (budget?.spent) {
          socket.destroy();
          return {
            reply: { status: 403, message: BUDGET_SPENT, event: "egress.deny", decision: "deny", reason: "budget" },
          };
        }
        return { socket, ...(budget ? { budget } : {}) };
      } catch {
        // try the next address
      }
    }
    return {
      reply: { status: 502, message: "Could not connect to the host.", event: "egress.error", reason: "connect" },
    };
  }

  const server = http.createServer({
    maxHeaderSize: options.maxHeaderBytes ?? 16 * 1024,
    headersTimeout: 15_000,
    requestTimeout: 0,
  });
  server.maxConnections = options.maxConnections ?? 256;

  server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
    if (!socket.writable) return socket.destroy();
    const status = error.code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
    const body = status === 431 ? "Request headers too large." : "Bad request.";
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    );
  });

  // ---- HTTPS: CONNECT host:port ----------------------------------------------------------------------------------
  server.on("connect", async (req, client: net.Socket, head: Buffer) => {
    const started = Date.now();
    const stepId = stepIdOf(req.headers[STEP_ID_HEADER]);
    client.on("error", () => {});
    let gone = false;
    client.once("close", () => (gone = true));
    const target = parseConnectTarget(req.url ?? "");
    const admission = await admit(req.headers["proxy-authorization"], target);
    if (gone) return;
    if ("reply" in admission) {
      const { reply } = admission;
      emit(
        { event: reply.event, host: target?.host, port: target?.port, method: "CONNECT", reason: reply.reason },
        started,
        stepId,
      );
      const lines = Object.entries(replyHeaders(reply)).map(([k, v]) => `${k}: ${v}`);
      client.end(
        `HTTP/1.1 ${reply.status} ${STATUS_TEXT[reply.status]}\r\n${lines.join("\r\n")}\r\n\r\n${reply.message}`,
      );
      return;
    }
    const { socket: upstream, budget } = admission;
    let bytesUp = 0;
    let bytesDown = 0;
    client.on("data", (chunk: Buffer) => {
      bytesUp += chunk.length;
      spend(budget, chunk.length);
    });
    upstream.on("data", (chunk: Buffer) => {
      bytesDown += chunk.length;
      spend(budget, chunk.length);
    });
    track(budget, client, upstream);
    client.setTimeout(idleTimeoutMs, () => client.destroy());
    upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) {
      bytesUp += head.length;
      upstream.write(head);
    }
    upstream.pipe(client);
    client.pipe(upstream);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      client.destroy();
      upstream.destroy();
      emit(
        { event: "egress.allow", host: target!.host, port: target!.port, method: "CONNECT", bytesUp, bytesDown },
        started,
        stepId,
      );
    };
    client.once("close", finish);
    upstream.once("close", finish);
  });

  // ---- plain HTTP: GET http://host/path ---------------------------------------------------------------------------
  server.on("request", async (req, res) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    const stepId = stepIdOf(req.headers[STEP_ID_HEADER]);
    const parsed = parseProxyUrl(req.url ?? "");
    const sendReply = (reply: Reply, host?: string, port?: number) => {
      emit({ event: reply.event, host, port, method, reason: reply.reason }, started, stepId);
      res.writeHead(reply.status, replyHeaders(reply));
      res.end(method === "HEAD" ? undefined : reply.message);
    };
    // Origin-form requests (the proxy being used as a web server) and https:// URLs without CONNECT are not proxy requests.
    if (!parsed && !/^https?:\/\//i.test(req.url ?? "")) {
      return sendReply({
        status: 400,
        message: "This is a proxy: send absolute-URI or CONNECT requests.",
        event: "egress.error",
        reason: "not_proxy_request",
      });
    }
    const admission = await admit(req.headers["proxy-authorization"], parsed);
    if ("reply" in admission) return sendReply(admission.reply, parsed?.host, parsed?.port);
    const target = parsed!;
    const { socket: upstreamSocket, budget } = admission;
    track(budget, req.socket, upstreamSocket);
    upstreamSocket.setTimeout(idleTimeoutMs, () => upstreamSocket.destroy());

    const headers: http.OutgoingHttpHeaders = {};
    const named = String(req.headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim());
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.includes(name) && !named.includes(name) && name !== STEP_ID_HEADER) headers[name] = value;
    }
    const hostText = target.host.includes(":") ? `[${target.host}]` : target.host;
    headers.host = target.port === 80 ? hostText : `${hostText}:${target.port}`;
    headers.connection = "close";

    let bytesUp = 0;
    let bytesDown = 0;
    let answered = false;
    const done = (event: LogEntry["event"], reason?: string) =>
      emit({ event, host: target.host, port: target.port, method, bytesUp, bytesDown, reason }, started, stepId);
    // An agent that hands out the socket we already opened to the address we checked.
    const agent = Object.assign(new http.Agent({ keepAlive: false }), { createConnection: () => upstreamSocket });
    const upstreamReq = http.request({ method, path: target.path, headers, agent });
    upstreamReq.on("response", (upstreamRes) => {
      answered = true;
      const out: http.OutgoingHttpHeaders = {};
      const hop = String(upstreamRes.headers.connection ?? "")
        .toLowerCase()
        .split(",")
        .map((s) => s.trim());
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.includes(name) && !hop.includes(name)) out[name] = value;
      }
      out.connection = "close";
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, out);
      upstreamRes.on("data", (chunk: Buffer) => {
        bytesDown += chunk.length;
        spend(budget, chunk.length);
      });
      upstreamRes.on("error", () => res.destroy());
      upstreamRes.on("end", () => done("egress.allow"));
      upstreamRes.pipe(res);
    });
    upstreamReq.on("error", () => {
      if (answered || res.headersSent) return res.destroy();
      answered = true;
      done("egress.error", "upstream");
      res.writeHead(502, replyHeaders({ status: 502, message: "The upstream request failed.", event: "egress.error" }));
      res.end("The upstream request failed.");
    });
    req.on("data", (chunk: Buffer) => {
      bytesUp += chunk.length;
      spend(budget, chunk.length);
    });
    req.on("aborted", () => upstreamSocket.destroy());
    res.on("close", () => upstreamSocket.destroy());
    req.pipe(upstreamReq);
  });

  return server;
}
