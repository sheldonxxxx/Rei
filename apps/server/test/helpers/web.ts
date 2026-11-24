import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
// The reader is the other half of web_fetch (ADR 0020): these tests run its real core behind a fake gateway /read, so
// the pages below go through the same extraction a live read does.
import { performRead, type ReadDeps } from "../../../reader/src/core/read.ts";
import { parseReadRequest } from "../../../reader/src/core/request.ts";
import type { FetchOptions, FetchResponse, FetchViaProxy } from "../../../reader/src/core/types.ts";
import { tool } from "./approvals.ts";
import { lastAssistant, run as runPlain } from "./exec.ts";
import { startSignedIn, type TestServer, type TestServerOptions } from "./server.ts";
import { chat } from "./sessions.ts";

// ---- a fake gateway /search ---------------------------------------------------------------------------------------

export interface SearchRequestSeen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: any;
}
export interface FakeSearch {
  url: string;
  requests: SearchRequestSeen[];
  /** What the next requests get: status and JSON. */
  reply: { status: number; json: unknown };
  /** POST /read: the fake reader behind the gateway (set by startWebServer). */
  read?: ((body: unknown, headers: IncomingHttpHeaders) => Promise<{ status: number; json: unknown }>) | undefined;
  reads: SearchRequestSeen[];
  close(): Promise<void>;
}

export const SEARCH_OK = {
  provider: "brave",
  results: [
    { title: "Kyoto in autumn", url: "https://example.com/kyoto", snippet: "Temples and maples." },
    { title: "Best time to visit", url: "https://example.org/when", snippet: "Mid November.", published: "2026-10-01" },
  ],
};

export async function startFakeSearch(): Promise<FakeSearch> {
  const fake: FakeSearch = {
    url: "",
    requests: [],
    reads: [],
    reply: { status: 200, json: SEARCH_OK },
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
      const seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      const answer = (reply: { status: number; json: unknown }) => {
        const text = JSON.stringify(reply.json);
        res.writeHead(reply.status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };
      if (req.url === "/read") {
        fake.reads.push(seen);
        const unavailable = { status: 503, json: { error: { code: "read_unavailable", message: "no reader" } } };
        if (!fake.read) return answer(unavailable);
        void fake.read(body, req.headers).then(answer, () => answer({ status: 502, json: unavailable.json }));
        return;
      }
      fake.requests.push(seen);
      answer(fake.reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  server.unref();
  return fake;
}

// ---- a fake web behind a fake egress -------------------------------------------------------------------------------

export interface FakePage {
  status?: number;
  type?: string;
  body?: string | Uint8Array;
  location?: string;
  truncated?: boolean;
  headers?: Record<string, string>;
}
export const html = (body: string, extra: FakePage = {}): FakePage => ({
  type: "text/html; charset=utf-8",
  body,
  ...extra,
});
export const redirect = (location: string, status = 302): FakePage => ({ status, location });

/** A web the fetcher serves. It asks the control plane's egress service about every request, as the proxy would. */
export class FakeWeb {
  pages = new Map<string, FakePage>();
  calls: { url: string; token: string; options: FetchOptions }[] = [];
  /** The reader's own fetch deadline (a short one for the timeout test). */
  timeoutMs: number | undefined;
  /** The engines of the fake reader (web-render tests); none: it cannot render. */
  render: ReadDeps["render"];
  /** Held until released, to keep a run going. */
  gate: Promise<void> | undefined;
  failWith: Error | undefined;
  /** Runs inside the fetch, while the run is still going (before the request is answered). */
  hook: ((url: string, token: string) => Promise<void>) | undefined;

  page(url: string, page: FakePage): this {
    this.pages.set(url, page);
    return this;
  }

  /** The reader's own proxy fetch, as the reader core calls it. */
  fetch: FetchViaProxy = async (url, token, options) => {
    this.calls.push({ url, token, options });
    await this.hook?.(url, token);
    if (this.failWith) throw this.failWith;
    if (this.gate) {
      const aborted = new Promise<never>((_, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
      await Promise.race([this.gate, aborted]);
    }
    const u = new URL(url);
    const page = this.pages.get(url) ?? this.pages.get(u.origin + u.pathname);
    if (!page)
      return {
        status: 404,
        headers: { "content-type": "text/plain" },
        body: new TextEncoder().encode("not found"),
        truncated: false,
      };
    const body = typeof page.body === "string" ? new TextEncoder().encode(page.body) : (page.body ?? new Uint8Array(0));
    const headers: Record<string, string> = {
      ...(page.type ? { "content-type": page.type } : {}),
      ...(page.location ? { location: page.location } : {}),
      ...page.headers,
    };
    return { status: page.status ?? 200, headers, body, truncated: page.truncated ?? false } satisfies FetchResponse;
  };

  /** POST /read on the gateway: the reader core over this web. */
  read = async (body: unknown, _headers: IncomingHttpHeaders): Promise<{ status: number; json: unknown }> => {
    let parsed: ReturnType<typeof parseReadRequest>;
    try {
      parsed = parseReadRequest(body);
    } catch {
      return { status: 400, json: { error: { code: "bad_request" } } };
    }
    const deps: ReadDeps = {
      fetch: this.fetch,
      openFetchJob: () => ({ token: "fake-job", revoke: () => undefined }),
      ...(this.render ? { render: this.render } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    };
    // Tests without a render fixture exercise the HTTP reader's policy/extraction contract.
    // Browser integration tests supply render explicitly, including an empty engine list for unavailability.
    const json = await performRead(this.render ? parsed : { ...parsed, render: "auto" }, deps, undefined, {
      readId: "fake-read",
      caller: "rei",
      defer: () => undefined,
    });
    return { status: 200, json };
  };
}

export type WebServer = TestServer & { totpSecret: string; web: FakeWeb; search: FakeSearch };

export async function startWebServer(options: TestServerOptions & { fetcher?: false } = {}): Promise<WebServer> {
  const web = new FakeWeb();
  const search = await startFakeSearch();
  const { fetcher, ...rest } = options;
  if (fetcher !== false) search.read = web.read;
  const server = await startSignedIn({
    ...rest,
    web: { searchUrl: search.url, ...options.web },
  });
  const destroy = server.destroy;
  server.destroy = async () => {
    await destroy();
    await search.close();
  };
  return Object.assign(server, { web, search });
}

// ---- reading what the model saw ------------------------------------------------------------------------------------

/** Every tool result in the newest model call of a session: its text and whether it was an error. */
export function toolResults(s: TestServer, sessionId: string): { text: string; isError: boolean }[] {
  const rows = s.host.plane.store.db.all<{ payload_blob: string | null }>(
    "SELECT payload_blob FROM steps WHERE session_id = ? AND type = 'llm.call' AND payload_blob IS NOT NULL ORDER BY started_at DESC, id DESC",
    sessionId,
  );
  for (const r of rows) {
    const hex = r.payload_blob!.slice("sha256:".length);
    const path = join(s.dir, "blobs", hex.slice(0, 2), hex);
    if (!existsSync(path)) continue;
    const payload = JSON.parse(readFileSync(path, "utf8")) as {
      messages: { role: string; content: unknown; isError?: boolean }[];
    };
    return payload.messages
      .filter((m) => m.role === "toolResult")
      .map((m) => ({
        text: Array.isArray(m.content)
          ? m.content.map((c: { text?: string }) => c.text ?? "").join("")
          : String(m.content),
        isError: m.isError === true,
      }));
  }
  return [];
}

/** Sends a message with the given tool calls and returns the session detail; `results` are all tool results so far. */
export async function callTool(s: TestServer, sessionId: string, name: string, args: unknown) {
  const d = await runPlain(s, sessionId, tool(name, args));
  return {
    detail: d,
    results: toolResults(s, sessionId),
    last: toolResults(s, sessionId).at(-1),
    reply: lastAssistant(d),
  };
}

export { chat };
