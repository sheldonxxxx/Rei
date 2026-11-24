// The live view's WebSocket: GET /api/sessions/:id/browser/live. Hono's Node server has no upgrade handling, so this
// listens for the http server's `upgrade` itself, with `ws` in noServer mode. Web clients authenticate with the session
// cookie and a same-host Origin. Native clients send the device credential in the Authorization header. A failed check
// still completes the handshake and closes with LIVE_CLOSE_DENIED, so clients can tell "denied" from a network error.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { LIVE_CLOSE_DENIED, SESSION_COOKIE } from "@rei/protocol";
import { type RawData, WebSocketServer } from "ws";
import { type AuthService, bearerToken } from "../auth/service.ts";
import type { LiveConnection, LiveHub, LiveViewer } from "../browser/live.ts";
import type { AppStore } from "../store/store.ts";
import type { Logger } from "../util/log.ts";

const PATH = /^\/api\/sessions\/([^/]+)\/browser\/live$/;
const PING_MS = 25_000;
/** Client messages are small (a key, a click); a paste is the largest. */
const MAX_PAYLOAD = 64 * 1024;

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * The Origin is this app's own origin: the same host (and port) as one of `hosts`. Those are the Host the request was made
 * to and, behind an HTTPS proxy that rewrites Host, the X-Forwarded-Host it sent and the host of REI_PUBLIC_URL. A web
 * page elsewhere cannot set either header on a WebSocket, so its Origin still fails.
 */
export function sameOrigin(origin: string | undefined, ...hosts: (string | undefined)[]): boolean {
  if (!origin) return false;
  let from: string;
  try {
    from = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((host) => host !== undefined && host !== "" && host.split(",")[0]!.trim().toLowerCase() === from);
}

/** The host (and port) of an http(s) URL, or undefined. */
const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

export interface BrowserLiveDeps {
  live: LiveHub;
  auth: AuthService;
  store: AppStore;
  log: Logger;
  /** REI_PUBLIC_URL, whose host is accepted as the app's own origin. */
  publicUrl?: string | undefined;
}

/** Handles the live view's upgrades on `server`; every other upgrade is refused. Returns a function that closes the sockets. */
export function attachBrowserLive(
  server: { on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown },
  deps: BrowserLiveDeps,
): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = PATH.exec(new URL(req.url ?? "/", "http://x").pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const sessionId = decodeURIComponent(match[1]!);
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Messages that arrive while the checks run wait for them.
      const queued: string[] = [];
      let viewer: LiveViewer | undefined;
      let unwatchRevocation: (() => void) | undefined;
      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary || ws.readyState !== ws.OPEN) return;
        const text = data.toString();
        if (viewer) viewer.message(text);
        else queued.push(text);
      });
      ws.on("close", () => {
        unwatchRevocation?.();
        viewer?.closed();
      });
      ws.on("error", () => ws.terminate());
      const alive = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), PING_MS);
      alive.unref();
      ws.on("close", () => clearInterval(alive));

      const deny = () => ws.close(LIVE_CLOSE_DENIED, "denied");
      void (async () => {
        const bearer = bearerToken(req.headers.authorization);
        if (!bearer) {
          const forwarded = req.headers["x-forwarded-host"];
          const hosts = [req.headers.host, Array.isArray(forwarded) ? forwarded[0] : forwarded, hostOf(deps.publicUrl)];
          if (!sameOrigin(req.headers.origin, ...hosts)) return deny();
        }
        const device = await deps.auth.device(bearer ?? cookieValue(req.headers.cookie, SESSION_COOKIE));
        if (!device) return deny();
        if (!deps.store.getSession(sessionId)) return deny();
        if (ws.readyState !== ws.OPEN) return;
        unwatchRevocation = deps.auth.watchDeviceRevocation(device.id, deny);
        if (!unwatchRevocation) return deny();
        const conn: LiveConnection = {
          sendText: (text) => ws.readyState === ws.OPEN && ws.send(text),
          sendFrame: (frame) => ws.readyState === ws.OPEN && ws.send(frame, { binary: true }),
          bufferedAmount: () => ws.bufferedAmount,
          close: (code, reason) => ws.close(code, reason.slice(0, 100)),
        };
        const attached = await deps.live.attach(sessionId, conn);
        if (!attached) return; // the hub told the client and closed the socket
        if (ws.readyState !== ws.OPEN) return attached.closed();
        viewer = attached;
        for (const text of queued.splice(0)) viewer.message(text);
      })().catch((error: unknown) => {
        deps.log.warn("browser.live_failed", { sessionId, error: error instanceof Error ? error.name : "error" });
        ws.close(1011, "error");
      });
    });
  });

  return () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
