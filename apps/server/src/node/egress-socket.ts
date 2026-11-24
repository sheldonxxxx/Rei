// The decision channel between the egress proxy and the control plane: a small HTTP server on a unix socket, apart from
// the main app. Whoever can reach the socket can ask; what a token is worth is decided by the token.
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { EgressHandler, EgressListener, EgressRequest } from "../exec/egress.ts";
import type { Logger } from "../util/log.ts";

const MAX_BODY = 4_096;

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      // Drain oversized bodies before replying: closing while the client is still writing can produce EPIPE.
      // Further chunks are discarded so the buffer stays bounded by MAX_BODY.
    });
    req.on("end", () => resolve(size > MAX_BODY ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...(status >= 400 ? { connection: "close" } : {}),
  });
  res.end(text);
}

export class EgressSocketListener implements EgressListener {
  readonly path: string;
  readonly #log: Logger;
  #server: Server | undefined;

  constructor(path: string, log: Logger) {
    this.path = path;
    this.#log = log;
  }

  async start(handler: EgressHandler): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    // A stale socket from the last run is removed; anything else at that path is left alone (and listen fails).
    try {
      if (lstatSync(this.path).isSocket()) rmSync(this.path);
    } catch {
      // nothing there
    }
    const server = createServer((req, res) => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/egress/decide") return reply(res, 404, { error: "not_found" });
        const text = await readBody(req);
        let body: unknown;
        try {
          body = text === undefined ? undefined : JSON.parse(text);
        } catch {
          body = undefined;
        }
        const b = body as { token?: unknown; source?: unknown; host?: unknown; port?: unknown } | null | undefined;
        const valid = b && typeof b.host === "string" && typeof b.port === "number" && Number.isInteger(b.port);
        // A run's token (the sandbox), or source "browser" (the browser listener, no token).
        const browser = valid && b.source === "browser" && b.token === undefined;
        if (!valid || (!browser && (typeof b.token !== "string" || b.source !== undefined)))
          return reply(res, 400, { error: "bad_request" });
        const host = b.host as string;
        const port = b.port as number;
        const request: EgressRequest = browser
          ? { source: "browser", host, port }
          : { token: b.token as string, host, port };
        try {
          reply(res, 200, await handler(request));
        } catch (error) {
          this.#log.error("egress.decide_failed", { error: error instanceof Error ? error.name : "error" });
          reply(res, 500, { error: "internal_error" });
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.path, 0o600);
    this.#server = server;
    this.#log.info("egress.listening", {});
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(this.path, { force: true });
  }
}
