import { afterEach, describe, expect, it } from "vitest";
import { IDLE_CHECK_MS } from "../src/browser/service.ts";
import { type BrowserServer, startBrowserServer } from "./helpers/browser.ts";
import { TestClock } from "./helpers/server.ts";
import { chat, detail } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

const IDLE = 10 * 60_000;
let server: BrowserServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const clock = new TestClock();
const start = async (browser: { idleMs?: number; maxWindows?: number } = {}): Promise<BrowserServer> =>
  (server = await startBrowserServer({
    clock,
    config: { browser: { mode: "cdp", cdpUrl: "http://fake:9223", idleMs: IDLE, ...browser } },
  }));
const open = (s: BrowserServer, id: string) => callTool(s, id, "browser_open", { url: "https://a.example/" });
const service = (s: BrowserServer) => s.host.plane.browser!.service;
/** Moves time on and runs one cleanup check. */
const tick = async (s: BrowserServer, ms: number) => {
  clock.advance(ms);
  await service(s).sweep();
};

describe("idle windows", () => {
  it("closes a window after idleMs, and not a tick earlier", async () => {
    const s = await start();
    const id = await chat(s);
    await open(s, id);
    await tick(s, IDLE - IDLE_CHECK_MS);
    expect(s.fake.hasWindow(id)).toBe(true);
    await tick(s, IDLE_CHECK_MS);
    expect(s.fake.hasWindow(id)).toBe(false);
    expect((await detail(s, id)).session.browser).toBeNull();
  });

  it("tells the agent the page is gone, and browser_open works and clears it", async () => {
    const s = await start();
    const id = await chat(s);
    await open(s, id);
    await tick(s, IDLE);
    const r = await callTool(s, id, "browser_snapshot", {});
    expect(r.last).toEqual({
      isError: true,
      text: "The browser window was closed after 10 minutes without use, so the page is gone. Open it again with browser_open.",
    });
    expect((await open(s, id)).last!.isError).toBe(false);
    expect((await callTool(s, id, "browser_snapshot", {})).last!.isError).toBe(false);
  });

  it("names an hour in the message for the default", async () => {
    const s = await start({ idleMs: 60 * 60_000 });
    const id = await chat(s);
    await open(s, id);
    await tick(s, 60 * 60_000);
    expect((await callTool(s, id, "browser_snapshot", {})).last!.text).toContain("after an hour without use");
  });

  it("tells an evicted session its window was given to another", async () => {
    const s = await start({ maxWindows: 1 });
    const [a, b] = [await chat(s), await chat(s)];
    await open(s, a);
    await open(s, b);
    const r = await callTool(s, a, "browser_snapshot", {});
    expect(r.last!.text).toBe(
      "The browser window was given to another session, so the page is gone. Open it again with browser_open.",
    );
    // The window made room for was opened at once: the connection was not given up in between.
    expect(s.fake.count("release")).toBe(0);
  });

  it("keeps a window while a call is in flight, then gives it the full time again", async () => {
    const s = await start();
    const id = await chat(s);
    await open(s, id);
    let done!: () => void;
    const held = service(s).run(id, undefined, () => new Promise<void>((r) => (done = r)));
    await tick(s, IDLE * 3);
    expect(s.fake.hasWindow(id)).toBe(true);
    done();
    await held;
    await tick(s, IDLE - IDLE_CHECK_MS);
    expect(s.fake.hasWindow(id)).toBe(true);
    await tick(s, IDLE_CHECK_MS);
    expect(s.fake.hasWindow(id)).toBe(false);
  });

  it("keeps a window while someone watches it, and counts from when they left", async () => {
    const s = await start();
    const id = await chat(s);
    await open(s, id);
    let watching = true;
    service(s).watched = () => watching;
    await tick(s, IDLE * 2);
    expect(s.fake.hasWindow(id)).toBe(true);
    watching = false;
    await tick(s, IDLE - IDLE_CHECK_MS);
    expect(s.fake.hasWindow(id)).toBe(true);
    await tick(s, IDLE_CHECK_MS);
    expect(s.fake.hasWindow(id)).toBe(false);
  });

  it("keeps a window while a takeover is open", async () => {
    const s = await start();
    const id = await chat(s);
    await open(s, id);
    expect((await s.client.post(`/api/sessions/${id}/browser/takeover`, {})).status).toBeLessThan(300);
    await tick(s, IDLE * 2);
    expect(s.fake.hasWindow(id)).toBe(true);
  });

  it("is not kept open by events from the page itself", async () => {
    const s = await start();
    const id = await chat(s);
    await open(s, id);
    await tick(s, IDLE - IDLE_CHECK_MS);
    s.fake.emit({ type: "page", key: id, url: "https://a.example/next", title: "Next" });
    s.fake.emit({ type: "note", key: id, text: "something" });
    await tick(s, IDLE_CHECK_MS);
    expect(s.fake.hasWindow(id)).toBe(false);
  });

  it("lets go of the browser once, when the last window closes", async () => {
    const s = await start();
    const [a, b] = [await chat(s), await chat(s)];
    await open(s, a);
    await tick(s, IDLE / 2);
    await open(s, b);
    await tick(s, IDLE / 2); // a is due, b is not
    expect(s.fake.hasWindow(a)).toBe(false);
    expect(s.fake.count("release")).toBe(0);
    await tick(s, IDLE / 2);
    expect(s.fake.hasWindow(b)).toBe(false);
    expect(s.fake.count("release")).toBe(1);
    await open(s, a);
    expect(s.fake.count("release")).toBe(1);
  });

  it("lets go when the user closes the last window, and when a session is deleted", async () => {
    const s = await start();
    const [a, b] = [await chat(s), await chat(s)];
    await open(s, a);
    s.fake.drop(a);
    expect(s.fake.count("release")).toBe(1);
    await open(s, b);
    await service(s).closeSession(b);
    expect(s.fake.count("release")).toBe(2);
  });

  it("never closes a window when idleMs is 0", async () => {
    const s = await start({ idleMs: 0 });
    const id = await chat(s);
    await open(s, id);
    await tick(s, 1000 * 60 * 60 * 24);
    expect(s.fake.hasWindow(id)).toBe(true);
  });

  it("keeps a window opened while a check runs", async () => {
    const s = await start();
    const [a, b] = [await chat(s), await chat(s)];
    await open(s, a);
    clock.advance(IDLE);
    let gate!: () => void;
    s.fake.openGate = new Promise<void>((r) => (gate = r));
    const opening = open(s, b);
    while (s.fake.count("openWindow") < 2) await new Promise((r) => setTimeout(r, 5));
    const sweeping = service(s).sweep();
    gate();
    await Promise.all([opening, sweeping]);
    expect(s.fake.hasWindow(b)).toBe(true);
    expect(s.fake.hasWindow(a)).toBe(false);
    expect(s.fake.count("release")).toBe(0);
  });
});
