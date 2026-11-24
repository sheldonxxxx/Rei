// A fake OpenAI side: the Responses API (SSE) and the OAuth token endpoint. It accepts only the current real access
// token, records every request, and reports deterministic usage so the gateway's metering can be compared with it.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface Recorded {
  n: number;
  headers: IncomingHttpHeaders;
  raw: string;
  json: { model?: string; input?: { content?: { text?: string }[] }[] } | undefined;
  /** "ok" when the Bearer matched the current real access token. */
  auth: "ok" | "stale" | "missing";
  /** The exact bytes written as the response body (SSE). */
  sent: Buffer[];
  reported?: { input_tokens: number; output_tokens: number; cached: number };
  /** Set when the client side closed the connection before the response ended. */
  closedEarly?: boolean;
}

export type Reply =
  | { kind: "text"; text: string; headers?: Record<string, string> }
  | { kind: "slow"; chunks: string[]; gapMs: number }
  /** Sends the first text delta, then holds the rest until the owning test releases it. */
  | { kind: "gated"; chunks: string[]; release: Promise<void> }
  /** SSE with no Content-Type header, as the ChatGPT backend sends it. */
  | { kind: "bare"; text: string }
  /** A non-streaming JSON response with usage. */
  | { kind: "json"; text: string }
  | { kind: "status"; status: number; body: string; headers?: Record<string, string> }
  /** First chunk, then silence for `stallMs`. */
  | { kind: "stall"; stallMs: number }
  /** Waits before sending any headers. */
  | { kind: "late"; delayMs: number; text: string };

export type Handler = (rec: Recorded) => Reply | Promise<Reply>;

export const makeToken = (kind: "access" | "refresh"): string =>
  kind === "access"
    ? `eyJhbGciOiJSUzI1NiJ9.${randomBytes(200).toString("base64url")}.${randomBytes(48).toString("base64url")}`
    : `rt_${randomBytes(48).toString("base64url")}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FakeOptions {
  access?: string;
  refresh?: string;
  tokenDelayMs?: number;
  /** Adds `x-echo-auth: <Authorization header>` to every /v1 response, to prove the gateway strips it. */
  echoAuthHeader?: boolean;
  defaultHeaders?: Record<string, string>;
}

export async function startFakeUpstream(handler: Handler, options: FakeOptions = {}) {
  const state = { access: options.access ?? makeToken("access"), refresh: options.refresh ?? makeToken("refresh") };
  const requests: Recorded[] = [];
  const tokenRequests: { form: Record<string, string>; ok: boolean }[] = [];
  const sockets = new Set<Socket>();
  let current = handler;
  let failNextToken: { status: number; body: string } | undefined;
  /** Every access/refresh pair this fake ever issued, so tests can scan for all of them. */
  const issued = new Set<string>([state.access, state.refresh]);

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";

      if (url.startsWith("/api/accounts/oauth/token")) {
        const form = Object.fromEntries(new URLSearchParams(raw));
        if (options.tokenDelayMs) await sleep(options.tokenDelayMs);
        if (failNextToken) {
          const f = failNextToken;
          failNextToken = undefined;
          tokenRequests.push({ form, ok: false });
          res.writeHead(f.status, { "content-type": "application/json" });
          res.end(f.body);
          return;
        }
        const valid = form.grant_type === "refresh_token" && form.refresh_token === state.refresh;
        tokenRequests.push({ form, ok: valid });
        if (!valid) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        state.access = makeToken("access");
        state.refresh = makeToken("refresh"); // rotating, like the real endpoint
        issued.add(state.access).add(state.refresh);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: state.access,
            refresh_token: state.refresh,
            id_token: "fake-id-token",
            scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            expires_in: 3600,
            token_type: "Bearer",
          }),
        );
        return;
      }

      let json: Recorded["json"];
      try {
        json = raw ? JSON.parse(raw) : undefined;
      } catch {
        json = undefined;
      }
      const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
      const rec: Recorded = {
        n: requests.length + 1,
        headers: req.headers,
        raw,
        json,
        auth: bearer === undefined ? "missing" : bearer === state.access ? "ok" : "stale",
        sent: [],
      };
      requests.push(rec);
      res.on("close", () => {
        if (!res.writableFinished) rec.closedEarly = true;
      });
      const extra: Record<string, string> = {
        ...options.defaultHeaders,
        ...(options.echoAuthHeader ? { "x-echo-auth": String(req.headers.authorization ?? "") } : {}),
      };
      if (rec.auth !== "ok") {
        res.writeHead(401, { "content-type": "application/json", ...extra });
        res.end(
          JSON.stringify({
            error: {
              message: "Provided authentication token is expired or invalid.",
              type: "invalid_request_error",
              code: "invalid_token",
            },
          }),
        );
        return;
      }

      const write = (text: string) => {
        const buf = Buffer.from(text);
        rec.sent.push(buf);
        res.write(buf);
      };
      const sse = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const completed = (text: string) => {
        const input_tokens = Math.ceil(raw.length / 4);
        const output_tokens = Math.ceil(text.length / 4) + 3;
        rec.reported = { input_tokens, output_tokens, cached: Math.min(input_tokens, 5) };
        return {
          input_tokens,
          output_tokens,
          total_tokens: input_tokens + output_tokens,
          input_tokens_details: { cached_tokens: rec.reported.cached },
          output_tokens_details: { reasoning_tokens: 3 },
        };
      };
      const model = json?.model ?? "unknown";
      const base = { id: `resp_${rec.n}`, object: "response", model, status: "in_progress", output: [] };

      const reply = await current(rec);
      const headers = { ...extra, ...("headers" in reply ? reply.headers : {}) };
      if (reply.kind === "status") {
        res.writeHead(reply.status, { "content-type": "application/json", ...headers });
        res.end(reply.body);
        return;
      }
      if (reply.kind === "json") {
        const body = JSON.stringify({ ...base, status: "completed", usage: completed(reply.text) });
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(body);
        return;
      }
      if (reply.kind === "late") await sleep(reply.delayMs);
      if (reply.kind === "bare") res.writeHead(200, headers);
      else res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
      res.flushHeaders();
      sse("response.created", { type: "response.created", response: base });
      if (reply.kind === "stall") {
        write(": first chunk\n\n");
        await sleep(reply.stallMs);
        res.end();
        return;
      }
      // The full Responses sequence, as OpenAI sends it: pi-ai builds the message from output_item.added/done.
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
      });
      const pieces = reply.kind === "slow" || reply.kind === "gated" ? reply.chunks : [reply.text];
      for (const [index, piece] of pieces.entries()) {
        sse("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: piece,
        });
        if (reply.kind === "slow") await sleep(reply.gapMs);
        if (reply.kind === "gated" && index === 0) await reply.release;
      }
      const text = pieces.join("");
      const item = {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
      sse("response.completed", {
        type: "response.completed",
        response: { ...base, status: "completed", output: [item], usage: completed(text) },
      });
      res.end();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    tokenUrl: `http://127.0.0.1:${port}/api/accounts/oauth/token`,
    state,
    issued,
    requests,
    tokenRequests,
    setHandler: (h: Handler) => void (current = h),
    failNextToken: (status: number, body: string) => void (failNextToken = { status, body }),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type FakeUpstream = Awaited<ReturnType<typeof startFakeUpstream>>;
