// web_fetch always requests isolated browser reading through the shared reader.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type EngineRequest,
  type EngineResult,
  type RenderEngine,
  RenderFailure,
  Slots,
} from "../../reader/src/core/render.ts";
import { approve, askApproval, setProfile, tool } from "./helpers/approvals.ts";
import { chat, stepPayloads } from "./helpers/sessions.ts";
import { callTool, html, startWebServer, toolResults, type WebServer } from "./helpers/web.ts";

/** An app shell: nothing to read until its script runs. */
const SHELL = html(
  '<html><head><title>Loading</title><script src="/app.js"></script></head><body><div id="root"></div></body></html>',
);
/** The same page once the browser ran it. */
const RENDERED = `<html><head><title>Trail guide</title></head><body><main><h1>Trail guide</h1><p>${"The ridge trail opens at dawn and closes at dusk in winter. ".repeat(8)}</p></main></body></html>`;

class FakeEngine implements RenderEngine {
  readonly name = "moli" as const;
  requests: EngineRequest[] = [];
  pages = new Map<string, string>();
  /** Runs inside the render, before it answers. */
  hook: ((request: EngineRequest) => Promise<void>) | undefined;
  version = () => "1.1.25";
  async render(request: EngineRequest): Promise<EngineResult> {
    this.requests.push(request);
    await this.hook?.(request);
    const page = this.pages.get(request.url);
    if (page === undefined) throw new RenderFailure("crash", "The page could not be rendered in the browser.");
    return { finalUrl: request.url, html: page, ended: "stable", truncated: false, blockedMedia: 2, ms: 40 };
  }
}

let server: WebServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

async function start(options: { engine?: FakeEngine | false } = {}) {
  const engine = options.engine === false ? undefined : (options.engine ?? new FakeEngine());
  const s = await startWebServer();
  server = s;
  if (engine)
    s.web.render = {
      engines: [{ engine, slots: new Slots({ slots: 2, waitMs: 200 }) }],
      attempts: { record: () => undefined },
      shadowRate: 0,
      openJob: () => ({ token: "job", revoke: () => ({ connections: 7, refused: 1 }) }),
    };
  if (!engine)
    s.web.render = {
      engines: [],
      attempts: { record: () => undefined },
      shadowRate: 0,
      openJob: () => {
        throw new Error("No engines");
      },
    };
  return { s, engine: engine! };
}

/** The details each web_fetch result recorded for the trace, oldest first. */
// biome-ignore lint/suspicious/noExplicitAny: trace details are JSON read back for assertions
const fetchDetails = (s: WebServer, sessionId: string): Record<string, any>[] =>
  s.host.plane.store.db
    .all<{ payload_blob: string | null }>(
      "SELECT payload_blob FROM steps WHERE session_id = ? AND type = 'tool.call' AND tool_name = 'web_fetch' ORDER BY started_at, id",
      sessionId,
    )
    .flatMap((r) => {
      if (!r.payload_blob) return [];
      const hex = r.payload_blob.slice("sha256:".length);
      const payload = JSON.parse(readFileSync(join(s.dir, "blobs", hex.slice(0, 2), hex), "utf8")) as {
        details?: Record<string, unknown>;
      };
      return payload.details ? [payload.details] : [];
    });

describe("the JS rendering setting", () => {
  it("always requests browser rendering without a setting", async () => {
    const { s, engine } = await start();
    engine.pages.set("https://app.example/", RENDERED);
    const settings = (await s.client.get("/api/settings/behavior")).body;
    expect(settings.settings).not.toHaveProperty("web");
    const id = await chat(s);
    expect((await callTool(s, id, "web_fetch", { url: "https://app.example/" })).last?.isError).toBe(false);
    expect(engine.requests).toHaveLength(1);
    expect(s.search.reads.at(-1)?.body).toMatchObject({ render: "force" });
  });

  it("says rendering is unavailable when the reader has no engine", async () => {
    const { s } = await start({ engine: false });
    s.web.page("https://app.example/", SHELL);
    const id = await chat(s);
    expect((await callTool(s, id, "web_fetch", { url: "https://app.example/" })).last?.isError).toBe(true);
    expect(fetchDetails(s, id).at(-1)?.render).toEqual({ reason: "forced", skipped: "unavailable" });
  });
});

/** The web note in the newest system message of the session's last model call. */
const webNote = (s: WebServer, sessionId: string): string => {
  const payload = JSON.parse(stepPayloads(s, sessionId).at(-1)!) as {
    messages: { role: string; sections?: Record<string, string> }[];
  };
  return payload.messages.filter((m) => m.role === "system").at(-1)?.sections?.web ?? "";
};

describe("what the model is told", () => {
  it("tells the model that pages needing JavaScript are rendered, in the tool description and not the note", async () => {
    const { s } = await start();
    const id = await chat(s);
    await callTool(s, id, "web_fetch", { url: "https://a.example/" });
    expect(stepPayloads(s, id).at(-1)).toContain("Pages that need JavaScript are rendered first");
    expect(webNote(s, id)).not.toContain("rendered");
  });
});

describe("rendering through the reader", () => {
  it("renders an app shell, keeps it as rendered, and records how", async () => {
    const { s, engine } = await start({});
    s.web.page("https://app.example/", SHELL);
    engine.pages.set("https://app.example/", RENDERED);
    const id = await chat(s);
    const first = await callTool(s, id, "web_fetch", { url: "https://app.example/" });
    expect(first.last?.isError).toBe(false);
    expect(first.last?.text).toContain("The ridge trail opens at dawn");
    expect(s.search.reads.at(-1)?.body).toMatchObject({ render: "force" });
    expect(engine.requests).toHaveLength(1);
    expect(fetchDetails(s, id).at(-1)).toMatchObject({
      method: "render",
      cache: "miss",
      title: "Trail guide",
      quality: "success",
      extractor: "readability",
      render: {
        reason: "forced",
        engine: "moli",
        engineVersion: "1.1.25",
        ended: "stable",
        renderMs: 40,
        blockedMedia: 2,
        connections: 7,
        refused: 1,
      },
    });
    // The stored copy is the rendered page, and says so on a later read; no second render.
    await callTool(s, id, "web_fetch", { url: "https://app.example/", query: "ridge trail" });
    expect(engine.requests).toHaveLength(1);
    expect(fetchDetails(s, id).at(-1)).toMatchObject({ method: "render", cache: "hit" });
    expect(fetchDetails(s, id).at(-1)?.render).toBeUndefined();
  });

  it("fails clearly when rendering fails without fetching a summary", async () => {
    const { s, engine } = await start({});
    s.web.page(
      "https://app.example/",
      html(
        '<html><head><title>App</title><meta name="description" content="Opens 5 December."><script src="/a.js"></script></head><body><div id="root"></div></body></html>',
      ),
    );
    s.web.page("https://shell.example/", SHELL);
    const id = await chat(s);
    const summary = await callTool(s, id, "web_fetch", { url: "https://app.example/" });
    expect(summary.last).toEqual({ isError: true, text: "The page could not be rendered in the browser." });
    expect(fetchDetails(s, id).at(-1)?.render).toMatchObject({ reason: "forced" });
    const none = await callTool(s, id, "web_fetch", { url: "https://shell.example/" });
    expect(none.last).toEqual({ isError: true, text: "The page could not be rendered in the browser." });
    expect(engine.requests).toHaveLength(2);
  });

  it("checks a render navigation against the Strict destination grant", async () => {
    const { s, engine } = await start({});
    engine.hook = async (request) => {
      s.host.plane.store.addTaint(sessionId, ["private"]);
      throw new RenderFailure("navigation_stopped", request.checkNavigation("https://another.example/") ?? "");
    };
    s.web.page("https://app.example/", SHELL);
    const sessionId = await chat(s);
    await setProfile(s, sessionId, "strict");
    await askApproval(s, sessionId, tool("web_fetch", { url: "https://app.example/" }));
    await approve(s, sessionId, { length: "session" });
    expect(toolResults(s, sessionId).at(-1)).toEqual({
      isError: true,
      text: "The page redirects to another.example, which is not allowed without the user's approval, so the redirect was not followed.",
    });
  });
});
