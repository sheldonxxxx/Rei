// A fake gateway for the offline tests: speaks the OpenAI Responses SSE format on 127.0.0.1, checks the stand-in
// bearer, and keeps every request (headers + raw body) so tests can compare bytes.
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { FakeMcpGateway } from "./fake-mcp.ts";

export interface Seen {
  n: number;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
  json: any;
  bearerOk: boolean;
}

export type Behavior =
  | { kind: "text"; text: string; chunkDelayMs?: number; usage?: unknown }
  | { kind: "stall_first" } // headers go out, then nothing
  | { kind: "stall_mid"; text: string } // one delta, then nothing
  | { kind: "hang_headers" } // never answer at all
  | { kind: "status"; status: number; body?: string };

export interface FakeGatewayOptions {
  bearer: string;
  behavior?: (seen: Seen) => Behavior | Promise<Behavior>;
  mcp?: { fixture: FakeMcpGateway; hangCalls?: boolean };
}

const sse = (res: ServerResponse, event: string, data: unknown) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startFakeGateway(options: FakeGatewayOptions) {
  const seen: Seen[] = [];
  /** What the control plane asks the gateway about outside a model call: providers, connectors, their tools. */
  const control: Seen[] = [];
  const sockets = new Set<Socket>();
  let behavior: NonNullable<FakeGatewayOptions["behavior"]> =
    options.behavior ?? (() => ({ kind: "text", text: "pong" }));
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
      const rec: Seen = {
        n: seen.length + 1,
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        raw,
        json,
        bearerOk: req.headers.authorization === `Bearer ${options.bearer}`,
      };
      // `seen` records model calls only: provider discovery and the connector endpoints are control traffic, and a
      // scripted test counts model calls, so they must not consume a call number. They are recorded in `control`.
      if (!(rec.method === "POST" && rec.path.startsWith("/v1/"))) {
        control.push(rec);
        if (options.mcp && rec.path.startsWith("/mcp/")) {
          const reply = await options.mcp.fixture.fetch(`http://gateway.test${rec.path}`, {
            method: rec.method,
            ...(rec.raw ? { body: rec.raw } : {}),
          });
          if (options.mcp.hangCalls && rec.path.endsWith("/call")) return;
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(await reply.text());
          return;
        }
        const body =
          rec.path === "/providers"
            ? { connections: [] }
            : rec.path === "/mcp/connectors"
              ? { connectors: [] }
              : rec.path.endsWith("/tools")
                ? { tools: [] }
                : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      seen.push(rec);
      if (!rec.bearerOk) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "bad_token", message: "Missing or wrong gateway token." } }));
        return;
      }
      const b = await behavior(rec);
      if (b.kind === "status") {
        res.writeHead(b.status, { "content-type": "application/json" });
        res.end(b.body ?? JSON.stringify({ error: { message: `scripted ${b.status}`, type: "server_error" } }));
        return;
      }
      if (b.kind === "hang_headers") return;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = `resp_${rec.n}`;
      const base = {
        id,
        object: "response",
        model: (rec.json as { model?: string })?.model ?? "m",
        status: "in_progress",
        output: [],
      };
      if (b.kind === "stall_first") return; // headers flushed below by the first write we never make
      sse(res, "response.created", { type: "response.created", response: base });
      sse(res, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_0", role: "assistant", status: "in_progress", content: [] },
      });
      if (b.kind === "stall_mid") {
        sse(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: "msg_0",
          output_index: 0,
          content_index: 0,
          delta: b.text,
        });
        return;
      }
      const pieces = b.text.match(/.{1,12}/gs) ?? [b.text];
      for (const p of pieces) {
        sse(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: "msg_0",
          output_index: 0,
          content_index: 0,
          delta: p,
        });
        if (b.chunkDelayMs) await sleep(b.chunkDelayMs);
      }
      const item = {
        type: "message",
        id: "msg_0",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: b.text, annotations: [] }],
      };
      sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
      sse(res, "response.completed", {
        type: "response.completed",
        response: {
          ...base,
          status: "completed",
          output: [item],
          usage:
            b.usage === undefined
              ? {
                  input_tokens: 11,
                  output_tokens: 7,
                  total_tokens: 18,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 },
                }
              : b.usage,
        },
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
    /** What GATEWAY_URL is set to. */
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    control,
    setBehavior: (b: NonNullable<FakeGatewayOptions["behavior"]>): void => {
      behavior = b;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export type FakeGateway = Awaited<ReturnType<typeof startFakeGateway>>;
