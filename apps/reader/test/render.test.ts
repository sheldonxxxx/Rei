import type { ReadEngine, ReadResponse } from "@rei/protocol";
import { describe, expect, it, vi } from "vitest";
import { type EngineEntry, performRead, type ReadContext, type ReadDeps } from "../src/core/read.ts";
import {
  type AttemptRow,
  type EngineRequest,
  type EngineResult,
  type RenderEngine,
  RenderFailure,
  Slots,
} from "../src/core/render.ts";
import { parseReadRequest } from "../src/core/request.ts";
import type { FetchResponse } from "../src/core/types.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const page = (body: string, head = "") =>
  `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const SHELL = page('<div id="root"></div><script src="/app.js"></script>');
const SUMMARY = (text: string) =>
  page('<div id="root"></div><script src="/app.js"></script>', `<meta name="description" content="${text}">`);
const THIN = SUMMARY("Only a short summary of the page lives here, written for search engines to show.");
const ARTICLE = page(
  `<main><article><h1>Trail</h1><p>${"The ridge trail opens at dawn and closes at dusk. ".repeat(12)}</p></article></main>`,
);
const SHORT = page(`<main><article><h1>Trail</h1><p>${"Ridge. ".repeat(10)}</p></article></main>`);
const WALL = page(
  '<div id="challenge-running"><h1>Verify you are human</h1><p>Checking if the site connection is secure. Complete the security check to continue.</p><div class="cf-turnstile"></div></div>',
);
const html = (text: string): FetchResponse => ({
  status: 200,
  headers: { "content-type": "text/html" },
  body: enc(text),
  truncated: false,
});

type Script = (request: EngineRequest) => Promise<EngineResult> | EngineResult;
const result = (text: string, finalUrl = "https://a.test/x"): EngineResult => ({
  finalUrl,
  html: text,
  ended: "stable",
  truncated: false,
  blockedMedia: 3,
  ms: 120,
});
function fakeEngine(name: ReadEngine, script: Script, version = "1.0"): RenderEngine & { calls: EngineRequest[] } {
  const calls: EngineRequest[] = [];
  return {
    name,
    calls,
    version: () => version,
    async render(request) {
      calls.push(request);
      return script(request);
    },
  };
}

function rig(options: {
  fetched?: string;
  engines?: RenderEngine[];
  shadowRate?: number;
  render?: boolean;
  slots?: Slots[];
}) {
  const rows: AttemptRow[] = [];
  const jobs: string[] = [];
  const revoked: string[] = [];
  const entries: EngineEntry[] = (options.engines ?? []).map((engine, i) => ({
    engine,
    slots: options.slots?.[i] ?? new Slots({ slots: 2, waitMs: 50 }),
  }));
  const deferred: (() => Promise<void>)[] = [];
  const logs: { event: string; level: string; fields?: Record<string, unknown> }[] = [];
  const logger = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    void logs.push({ event, level, fields });
  const deps: ReadDeps = {
    fetch: vi.fn(async () => html(options.fetched ?? SHELL)),
    openFetchJob: vi.fn(() => ({ token: "fetch", revoke: () => undefined })),
    log: { debug: logger("debug"), info: logger("info"), warn: logger("warn"), error: logger("error") } as never,
    ...(options.render === false
      ? {}
      : {
          render: {
            engines: entries,
            attempts: { record: (row: AttemptRow) => void rows.push(row) },
            shadowRate: options.shadowRate ?? 0,
            random: () => 0,
            openJob: () => {
              const token = `job${jobs.length}`;
              jobs.push(token);
              return {
                token,
                revoke: () => {
                  revoked.push(token);
                  return { connections: 4, refused: 1 };
                },
              };
            },
          },
        }),
  };
  const context: ReadContext = { readId: "r1", caller: "rei", defer: (task) => void deferred.push(task) };
  const read = (extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ReadResponse> =>
    performRead(parseReadRequest({ url: "https://a.test/x", allowHosts: ["a.test"], ...extra }), deps, signal, context);
  return { read, rows, jobs, revoked, deferred, logs, deps };
}

describe("rendering a page that needs JavaScript", () => {
  it("reads forced pages without opening an HTTP fetch job", async () => {
    const r = rig({ engines: [fakeEngine("moli", () => result(ARTICLE))] });
    expect(await r.read({ render: "force" })).toMatchObject({ outcome: "page", method: "render" });
    expect(r.deps.fetch).not.toHaveBeenCalled();
    expect(r.deps.openFetchJob).not.toHaveBeenCalled();
  });
  it("renders an app shell with the first engine and records one row", async () => {
    const moli = fakeEngine("moli", () => result(ARTICLE), "1.1.25");
    const { read, rows, revoked, logs } = rig({ engines: [moli] });
    const out = await read();
    expect(out).toMatchObject({ outcome: "page", method: "render", quality: "success" });
    if (out.outcome !== "page") return;
    expect(out.details.render).toMatchObject({
      reason: "requires_js",
      engine: "moli",
      engineVersion: "1.1.25",
      ended: "stable",
      blockedMedia: 3,
      connections: 4,
      refused: 1,
    });
    expect(out.details.render?.fallback).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      readId: "r1",
      caller: "rei",
      attempt: 1,
      role: "primary",
      trigger: "requires_js",
      outcome: "ok",
      quality: "success",
      used: true,
      url: "https://a.test/x",
      host: "a.test",
      connections: 4,
    });
    expect(revoked).toEqual(["job0"]);
    expect(moli.calls[0]).toMatchObject({ url: "https://a.test/x", token: "job0" });
    expect(logs.some((l) => l.event === "read.render" && l.level === "debug")).toBe(true);
    // No log field may carry a URL.
    expect(JSON.stringify(logs)).not.toContain("https://");
  });

  it("does not render when the request says off, and says so", async () => {
    const moli = fakeEngine("moli", () => result(ARTICLE));
    const { read, rows } = rig({ engines: [moli] });
    const out = await read({ render: "off" });
    expect(out).toMatchObject({ outcome: "failed", quality: "requires_js" });
    if (out.outcome === "failed") expect(out.details.render).toEqual({ reason: "requires_js", skipped: "off" });
    expect(moli.calls).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("says unavailable when no engine is configured", async () => {
    for (const r of [rig({ engines: [] }), rig({ render: false })]) {
      const out = await r.read();
      expect(out).toMatchObject({ outcome: "failed", quality: "requires_js" });
      if (out.outcome === "failed") expect(out.details.render?.skipped).toBe("unavailable");
    }
  });

  it("returns a thin page as fetched when rendering is off, with the render noted as skipped", async () => {
    const { read } = rig({ fetched: THIN, engines: [fakeEngine("moli", () => result(ARTICLE))] });
    const out = await read({ render: "off" });
    expect(out).toMatchObject({ outcome: "page", method: "http", extractor: "meta" });
    if (out.outcome === "page") expect(out.details.render).toEqual({ reason: "low_quality", skipped: "off" });
  });

  it("renders a thin page and reports it as low_quality", async () => {
    const { read, rows } = rig({ fetched: THIN, engines: [fakeEngine("moli", () => result(ARTICLE))] });
    const out = await read();
    expect(out).toMatchObject({ outcome: "page", method: "render" });
    expect(rows[0]).toMatchObject({ trigger: "thin_low_quality" });
    if (out.outcome === "page") expect(out.details.render?.reason).toBe("low_quality");
  });

  it("renders an ordinary page only when forced", async () => {
    const moli = fakeEngine("moli", () => result(ARTICLE));
    const { read } = rig({ fetched: ARTICLE, engines: [moli] });
    expect(await read()).toMatchObject({ outcome: "page", method: "http" });
    expect(moli.calls).toHaveLength(0);
    const forced = await read({ render: "force" });
    expect(forced).toMatchObject({ outcome: "page", method: "render" });
    if (forced.outcome === "page") expect(forced.details.render?.reason).toBe("forced");
  });

  it("renders the final URL after redirects within the allowed hosts", async () => {
    const moli = fakeEngine("moli", () => result(ARTICLE, "https://a.test/final"));
    const { read } = rig({ engines: [moli] });
    const out = await read();
    expect(out).toMatchObject({ outcome: "page", finalUrl: "https://a.test/final" });
  });
});

describe("the fallback", () => {
  const failing = (outcome: "crash" | "cdp_error" | "unsupported" | "proxy_error" | "deadline") =>
    fakeEngine("moli", () => {
      throw new RenderFailure(outcome, "The page could not be rendered in the browser.", "detail from the engine");
    });

  it.each(["crash", "cdp_error", "unsupported", "proxy_error", "deadline"] as const)(
    "falls back to Chromium when Moli fails with %s",
    async (outcome) => {
      const chromium = fakeEngine("chromium", () => result(ARTICLE), "146");
      const { read, rows, logs } = rig({ engines: [failing(outcome), chromium] });
      const out = await read();
      expect(out).toMatchObject({ outcome: "page", method: "render" });
      if (out.outcome === "page")
        expect(out.details.render).toMatchObject({ engine: "chromium", fallback: { from: "moli", reason: "failed" } });
      expect(rows.map((r) => [r.attempt, r.engine, r.role, r.outcome, r.used, r.fallbackReason])).toEqual([
        [1, "moli", "primary", outcome, false, undefined],
        [2, "chromium", "fallback", "ok", true, "failed"],
      ]);
      expect(rows[0]!.errorDetail).toBe("detail from the engine");
      expect(logs.some((l) => l.event === "read.fallback" && l.level === "info")).toBe(true);
      expect(logs.some((l) => l.event === "read.render" && l.level === "info")).toBe(true);
    },
  );

  it("falls back when Moli's result still needs JavaScript", async () => {
    const moli = fakeEngine("moli", () => result(SHELL));
    const { read, rows } = rig({ engines: [moli, fakeEngine("chromium", () => result(ARTICLE))] });
    const out = await read();
    expect(out).toMatchObject({ outcome: "page", method: "render" });
    expect(rows[1]).toMatchObject({ role: "fallback", fallbackReason: "requires_js", used: true });
  });

  it("falls back when Moli's result holds only the summary, and uses the better of the two", async () => {
    const rig1 = rig({
      engines: [fakeEngine("moli", () => result(THIN)), fakeEngine("chromium", () => result(ARTICLE))],
    });
    const out = await rig1.read();
    expect(out).toMatchObject({ outcome: "page", quality: "success" });
    expect(rig1.rows[1]).toMatchObject({ fallbackReason: "thin", used: true });
    expect(rig1.rows[0]!.used).toBe(false);
    // Chromium no better: the first result stands (equal quality, more text wins).
    const rig2 = rig({
      engines: [fakeEngine("moli", () => result(ARTICLE)), fakeEngine("chromium", () => result(SHORT))],
      fetched: THIN,
    });
    const out2 = await rig2.read();
    expect(out2).toMatchObject({ outcome: "page", quality: "success" });
    expect(rig2.rows).toHaveLength(1); // a good first result needs no fallback
    const rig3 = rig({
      engines: [
        fakeEngine("moli", () => result(THIN)),
        fakeEngine("chromium", () =>
          result(SUMMARY("A different but equally short summary of the page, also written for search engines.")),
        ),
      ],
    });
    const out3 = await rig3.read();
    expect(out3).toMatchObject({ outcome: "page", quality: "low_quality" });
    expect(rig3.rows.filter((r) => r.used)).toHaveLength(1);
  });

  it("never falls back for a blocked page, from either engine", async () => {
    const chromium = fakeEngine("chromium", () => result(ARTICLE));
    const first = rig({ engines: [fakeEngine("moli", () => result(WALL)), chromium] });
    const out = await first.read();
    expect(out).toMatchObject({ outcome: "failed", quality: "blocked" });
    expect(chromium.calls).toHaveLength(0);
    expect(first.rows).toHaveLength(1);
    const second = rig({
      engines: [failing("crash"), fakeEngine("chromium", () => result(WALL))],
    });
    expect(await second.read()).toMatchObject({ outcome: "failed", quality: "blocked" });
  });

  it("hands back a navigation that leaves the allowed hosts, without falling back", async () => {
    const moli = fakeEngine("moli", (request) => {
      const refusal = request.checkNavigation("https://other.test/landing");
      throw new RenderFailure("navigation_stopped", refusal ?? "");
    });
    const chromium = fakeEngine("chromium", () => result(ARTICLE));
    const { read, rows } = rig({ engines: [moli, chromium] });
    expect(await read()).toEqual({ outcome: "redirect", location: "https://other.test/landing", hops: 1 });
    expect(chromium.calls).toHaveLength(0);
    expect(rows[0]!.outcome).toBe("navigation_stopped");
  });

  it("allows a navigation inside the allowed hosts and refuses unusable ones", async () => {
    let allowed: string | undefined = "x";
    let junk: string | undefined;
    const moli = fakeEngine("moli", (request) => {
      allowed = request.checkNavigation("https://a.test/next");
      junk = request.checkNavigation("file:///etc/passwd");
      return result(ARTICLE);
    });
    await rig({ engines: [moli] }).read();
    expect(allowed).toBeUndefined();
    expect(junk).toMatch(/cannot be fetched/);
  });

  it("hands back a navigation stopped in the fallback", async () => {
    const chromium = fakeEngine("chromium", (request) => {
      throw new RenderFailure("navigation_stopped", request.checkNavigation("https://other.test/") ?? "");
    });
    const { read } = rig({ engines: [failing("crash"), chromium] });
    expect(await read()).toEqual({ outcome: "redirect", location: "https://other.test/", hops: 1 });
  });

  it("fails with the render's message when both engines fail and there is no page to fall back on", async () => {
    const { read, rows } = rig({
      engines: [
        failing("crash"),
        fakeEngine("chromium", () => {
          throw new RenderFailure("deadline", "The page did not finish rendering in time.");
        }),
      ],
    });
    const out = await read();
    expect(out).toMatchObject({ outcome: "failed", message: "The page did not finish rendering in time." });
    expect(rows.every((r) => !r.used)).toBe(true);
  });

  it("keeps the fetched page when every render fails and the page had something to read", async () => {
    const { read } = rig({ fetched: THIN, engines: [failing("crash"), failing("crash")] });
    const out = await read();
    expect(out).toMatchObject({ outcome: "page", method: "http", extractor: "meta" });
    if (out.outcome === "page") expect(out.details.render).toMatchObject({ failed: true, reason: "low_quality" });
  });

  it("with one engine, a failure keeps the fetched page and an empty result is an error", async () => {
    const one = rig({ fetched: THIN, engines: [failing("crash")] });
    expect(await one.read()).toMatchObject({ outcome: "page", method: "http" });
    const empty = rig({ engines: [fakeEngine("moli", () => result(SHELL))] });
    expect(await empty.read()).toMatchObject({
      outcome: "failed",
      quality: "requires_js",
      message: "The page still had no readable text after it was rendered in the browser.",
    });
    const gone = rig({ engines: [failing("crash")] });
    expect(await gone.read()).toMatchObject({
      outcome: "failed",
      message: "The page could not be rendered in the browser.",
    });
  });

  it("does not fall back when the read is cancelled", async () => {
    const controller = new AbortController();
    const moli = fakeEngine("moli", () => {
      controller.abort();
      throw new RenderFailure("cancelled", "The read was cancelled.");
    });
    const chromium = fakeEngine("chromium", () => result(ARTICLE));
    const { read } = rig({ engines: [moli, chromium] });
    expect(await read({}, controller.signal)).toMatchObject({ outcome: "failed", message: "The read was cancelled." });
    expect(chromium.calls).toHaveLength(0);
  });

  it("stops between engines when the read was cancelled meanwhile", async () => {
    const controller = new AbortController();
    const moli = fakeEngine("moli", () => {
      controller.abort();
      throw new RenderFailure("crash", "The page could not be rendered in the browser.");
    });
    const chromium = fakeEngine("chromium", () => result(ARTICLE));
    const { read } = rig({ engines: [moli, chromium] });
    expect(await read({}, controller.signal)).toMatchObject({ outcome: "failed", message: "The read was cancelled." });
    expect(chromium.calls).toHaveLength(0);
  });

  it("answers busy without falling back, and uses the fetched page when there is one", async () => {
    const slots = new Slots({ slots: 1, waitMs: 20 });
    const hold = slots.tryAcquire("someone")!;
    const chromium = fakeEngine("chromium", () => result(ARTICLE));
    const busy = rig({ engines: [fakeEngine("moli", () => result(ARTICLE)), chromium], slots: [slots, new Slots()] });
    const out = await busy.read();
    expect(out).toMatchObject({ outcome: "failed", message: expect.stringContaining("busy") });
    expect(busy.rows[0]).toMatchObject({ outcome: "busy", used: false });
    expect(chromium.calls).toHaveLength(0);
    const withPage = rig({ fetched: THIN, engines: [fakeEngine("moli", () => result(ARTICLE))], slots: [slots] });
    expect(await withPage.read()).toMatchObject({ outcome: "page", method: "http" });
    hold.release();
  });

  it("treats an unexpected throw from an engine as a crash", async () => {
    const { read, rows } = rig({
      engines: [
        fakeEngine("moli", () => {
          throw new Error("boom");
        }),
        fakeEngine("chromium", () => result(ARTICLE)),
      ],
    });
    expect(await read()).toMatchObject({ outcome: "page" });
    expect(rows[0]).toMatchObject({ outcome: "crash", errorDetail: "boom" });
  });
});

describe("shadow comparisons", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  it("renders a sample of Moli successes in Chromium after the answer, and never returns it", async () => {
    const chromium = fakeEngine("chromium", () => result(ARTICLE), "146");
    const { read, rows, deferred, logs } = rig({
      engines: [fakeEngine("moli", () => result(ARTICLE)), chromium],
      shadowRate: 1,
    });
    const out = await read();
    expect(out).toMatchObject({ outcome: "page", details: { render: { engine: "moli" } } });
    expect(chromium.calls).toHaveLength(0);
    expect(deferred).toHaveLength(1);
    await deferred[0]!();
    await tick();
    expect(chromium.calls).toHaveLength(1);
    expect(rows.map((r) => [r.attempt, r.engine, r.role, r.used])).toEqual([
      [1, "moli", "primary", true],
      [2, "chromium", "shadow", false],
    ]);
    expect(logs.some((l) => l.event === "read.shadow")).toBe(true);
  });

  it("is skipped at rate 0, when the dice say no, when Chromium is busy, or when Chromium is the only engine", async () => {
    const moli = () => fakeEngine("moli", () => result(ARTICLE));
    const chromium = () => fakeEngine("chromium", () => result(ARTICLE));
    expect(
      await (async () => {
        const r = rig({ engines: [moli(), chromium()], shadowRate: 0 });
        await r.read();
        return r.deferred;
      })(),
    ).toHaveLength(0);
    const busy = new Slots({ slots: 1 });
    const hold = busy.tryAcquire("x")!;
    const r2 = rig({ engines: [moli(), chromium()], shadowRate: 1, slots: [new Slots(), busy] });
    await r2.read();
    expect(r2.deferred).toHaveLength(0);
    hold.release();
    const only = rig({ engines: [chromium()], shadowRate: 1 });
    await only.read();
    expect(only.deferred).toHaveLength(0);
  });

  it("is skipped when the dice say no", async () => {
    const r = rig({
      engines: [fakeEngine("moli", () => result(ARTICLE)), fakeEngine("chromium", () => result(ARTICLE))],
      shadowRate: 0.1,
    });
    // random() is fixed at 0 in the rig, so 0 < 0.1 samples; a rate of exactly 0 never does.
    await r.read();
    expect(r.deferred).toHaveLength(1);
    await r.deferred[0]!();
  });

  it("is not made when a fallback already ran", async () => {
    const r = rig({
      engines: [
        fakeEngine("moli", () => {
          throw new RenderFailure("crash", "x");
        }),
        fakeEngine("chromium", () => result(ARTICLE)),
      ],
      shadowRate: 1,
    });
    await r.read();
    expect(r.deferred).toHaveLength(0);
  });
});

describe("Slots", () => {
  it("shares slots first come first served and reports busy after the wait", async () => {
    const slots = new Slots({ slots: 1, waitMs: 20 });
    const a = await slots.acquire("a");
    const waiting = slots.acquire("b");
    const waited = expect(waiting).rejects.toMatchObject({ outcome: "busy" });
    await expect(slots.acquire("c")).rejects.toMatchObject({ outcome: "busy" });
    await waited;
    a.release();
    a.release(); // twice does nothing
    const b = await slots.acquire("d");
    expect(slots.stats).toEqual({ running: 1, waiting: 0 });
    b.release();
    expect(slots.stats).toEqual({ running: 0, waiting: 0 });
  });

  it("lets a caller that holds a slot have another only while nobody else waits", async () => {
    const slots = new Slots({ slots: 2, waitMs: 1_000 });
    const a1 = await slots.acquire("a");
    const a2 = await slots.acquire("a");
    const order: string[] = [];
    const a3 = slots.acquire("a").then((l) => {
      order.push("a3");
      return l;
    });
    const b1 = slots.acquire("b").then((l) => {
      order.push("b1");
      return l;
    });
    a1.release();
    const b = await b1;
    expect(order).toEqual(["b1"]);
    b.release();
    a2.release();
    (await a3).release();
    expect(order).toEqual(["b1", "a3"]);
  });

  it("leaves the queue when aborted and refuses an already aborted request", async () => {
    const slots = new Slots({ slots: 1, waitMs: 1_000 });
    const held = await slots.acquire("a");
    const controller = new AbortController();
    const pending = slots.acquire("b", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ outcome: "cancelled" });
    await expect(slots.acquire("c", controller.signal)).rejects.toMatchObject({ outcome: "cancelled" });
    expect(slots.stats.waiting).toBe(0);
    held.release();
  });

  it("tryAcquire gives a slot only when one is free and nobody waits", async () => {
    const slots = new Slots({ slots: 1, waitMs: 1_000 });
    const lease = slots.tryAcquire("a");
    expect(lease).toBeDefined();
    expect(slots.tryAcquire("a")).toBeUndefined();
    lease!.release();
    expect(slots.tryAcquire("a")).toBeDefined();
  });
});
