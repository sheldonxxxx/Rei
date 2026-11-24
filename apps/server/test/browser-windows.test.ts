import { afterEach, describe, expect, it } from "vitest";
import { askApproval, tool } from "./helpers/approvals.ts";
import { type BrowserServer, el, type FakeBrowser, startBrowserServer } from "./helpers/browser.ts";
import { until } from "./helpers/client.ts";
import { startSignedIn } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

let server: BrowserServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async (
  config: { maxWindows?: number; busyWaitMs?: number } = {},
  fake?: FakeBrowser,
): Promise<BrowserServer> =>
  (server = await startBrowserServer({
    config: { browser: { mode: "cdp", cdpUrl: "http://fake:9223", ...config } },
    ...(fake ? { fake } : {}),
  }));
const open = (s: BrowserServer, id: string, url = "https://a.example/") => callTool(s, id, "browser_open", { url });
const service = (s: BrowserServer) => s.host.plane.browser!.service;
const shownPage = async (s: BrowserServer, id: string) => (await detail(s, id)).session.browser;

describe("windows", () => {
  it("gives each session its own window, and a session that comes back finds it where it was", async () => {
    const s = await start();
    const [a, b] = [await chat(s), await chat(s)];
    await open(s, a, "https://a.example/");
    await open(s, b, "https://b.example/");
    expect([...s.fake.wins.keys()].sort()).toEqual([a, b].sort());
    expect(s.fake.wins.get(a)!.url).toBe("https://a.example/");
    expect(s.fake.count("openWindow")).toBe(2);
    expect((await callTool(s, a, "browser_snapshot", {})).last!.text).toContain("https://a.example/");
    expect(s.fake.count("openWindow")).toBe(2);
  });

  it("closes the least recently used idle window to make room, and tells that session its page is gone", async () => {
    const s = await start({ maxWindows: 2 });
    const [a, b, c] = [await chat(s), await chat(s), await chat(s)];
    await open(s, a);
    await open(s, b);
    await callTool(s, a, "browser_snapshot", {}); // a is now the more recently used
    await open(s, c);
    expect(s.fake.hasWindow(b)).toBe(false);
    expect(s.fake.hasWindow(a) && s.fake.hasWindow(c)).toBe(true);
    expect(await shownPage(s, b)).toBeNull();
    const r = await callTool(s, b, "browser_snapshot", {});
    expect(r.last).toEqual({
      isError: true,
      text: "The browser window was given to another session, so the page is gone. Open it again with browser_open.",
    });
  });

  it("never closes a window whose session has a call in flight, and waits, then fails as busy", async () => {
    const s = await start({ maxWindows: 1, busyWaitMs: 400 });
    const [a, b] = [await chat(s), await chat(s)];
    await open(s, a);
    let release!: () => void;
    const held = service(s).run(a, undefined, () => new Promise<void>((r) => (release = r)));
    const r = await open(s, b);
    expect(r.last!.isError).toBe(true);
    expect(r.last!.text).toBe("The browser is busy (1 chats are using it); try again later.");
    expect(s.fake.hasWindow(a)).toBe(true);
    expect(s.fake.hasWindow(b)).toBe(false);
    release();
    await held;
    expect((await open(s, b)).last!.isError).toBe(false);
    expect(s.fake.hasWindow(a)).toBe(false);
  });

  it("waits for a window to free up", async () => {
    const s = await start({ maxWindows: 1, busyWaitMs: 8_000 });
    const [a, b] = [await chat(s), await chat(s)];
    await open(s, a);
    let release!: () => void;
    const held = service(s).run(a, undefined, () => new Promise<void>((r) => (release = r)));
    const second = open(s, b);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.fake.hasWindow(b)).toBe(false);
    release();
    await held;
    expect((await second).last!.isError).toBe(false);
    expect(s.fake.hasWindow(b)).toBe(true);
  });

  it("opens windows one at a time", async () => {
    const s = await start({ maxWindows: 3 });
    const ids = [await chat(s), await chat(s), await chat(s)];
    let running = 0;
    let most = 0;
    const orig = s.fake.openWindow.bind(s.fake);
    s.fake.openWindow = async (key, url) => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 30));
      try {
        return await orig(key, url);
      } finally {
        running--;
      }
    };
    await Promise.all(ids.map((id) => service(s).acquire(id)));
    expect(most).toBe(1);
    expect(s.fake.wins.size).toBe(3);
  });

  it("says the window was closed when it crashes, and opens a new one on the next browser_open", async () => {
    const s = await start();
    const a = await chat(s);
    await open(s, a);
    s.fake.drop(a, "crashed");
    expect(await shownPage(s, a)).toBeNull();
    const r = await callTool(s, a, "browser_snapshot", {});
    expect(r.last).toEqual({
      isError: true,
      text: "The browser window was closed. Open the page again with browser_open.",
    });
    expect((await open(s, a, "https://again.example/")).last!.isError).toBe(false);
    expect(s.fake.count("openWindow")).toBe(2);
  });

  it("tells every session the browser restarted", async () => {
    const s = await start();
    const [a, b] = [await chat(s), await chat(s)];
    await open(s, a);
    await open(s, b);
    s.fake.restart();
    for (const id of [a, b]) {
      expect((await callTool(s, id, "browser_snapshot", {})).last).toEqual({
        isError: true,
        text: "The browser restarted, so the page is gone. Open it again with browser_open.",
      });
    }
    expect((await open(s, a)).last!.isError).toBe(false);
  });

  it("closes the window of a deleted session, and a fork starts without one", async () => {
    const s = await start();
    const a = await chat(s);
    await say(s, a, "hello");
    const d = await settled(s, a, 1);
    await open(s, a);
    const reply = d.messages.find((m) => m.role === "assistant")!;
    const forked = (await s.client.post(`/api/sessions/${a}/fork`, { messageId: reply.id })).body.session;
    expect(s.fake.hasWindow(forked.id)).toBe(false);
    expect(forked.browser ?? null).toBeNull();
    expect((await callTool(s, forked.id, "browser_snapshot", {})).last!.isError).toBe(true);
    expect((await s.client.call("DELETE", `/api/sessions/${a}`)).status).toBe(200);
    await until(() => !s.fake.hasWindow(a) || undefined, 5_000, "the window of the deleted session to close");
    expect(s.fake.calls).toContain(`closeWindow ${a}`);
  });

  it("keeps the page it shows on the session in step with the browser", async () => {
    const s = await start();
    s.fake.page("https://a.example/", {
      title: "A",
      links: { e2: "https://a.example/2" },
      elements: { e2: el("link", "Two") },
    });
    const a = await chat(s);
    await open(s, a);
    expect(await shownPage(s, a)).toMatchObject({ url: "https://a.example/", title: "A" });
    await callTool(s, a, "browser_click", { ref: "p1e2", element: "Two link" });
    expect(await shownPage(s, a)).toMatchObject({ url: "https://a.example/2" });
  });
});

describe("private sessions", () => {
  it("keep to the sites they opened: other navigations are refused until the user allows them", async () => {
    const s = await start();
    const a = await chat(s);
    await open(s, a, "https://a.example/");
    const guard = () => s.fake.wins.get(a)!.guard!;
    // Without private data a page may go anywhere.
    expect(guard()(new URL("https://elsewhere.example/"))).toBe(true);
    s.host.plane.store.addTaint(a, ["external", "private"]);
    expect(guard()(new URL("https://a.example/page"))).toBe(true);
    expect(guard()(new URL("https://www.a.example/"))).toBe(true);
    expect(guard()(new URL("https://elsewhere.example/"))).toBe(false);
    expect(guard()(new URL("data:text/html,x"))).toBe(true); // not a network page
    // The agent opening another site is a send in a private session: it needs the user's approval first.
    await askApproval(s, a, tool("browser_open", { url: "https://elsewhere.example/" }));
    expect(s.fake.wins.get(a)!.url).toBe("https://a.example/");
  });

  it("a page's blocked navigation reaches the agent as a note", async () => {
    const s = await start();
    const a = await chat(s);
    await open(s, a);
    s.fake.emit({ type: "blocked", key: a, host: "tracker.example" });
    expect((await callTool(s, a, "browser_snapshot", {})).last!.text).toContain(
      "[Navigation to tracker.example was blocked: open it with browser_open to ask.]",
    );
  });
});

describe("the browser is off", () => {
  it("has no browser tools and no takeovers", async () => {
    const off = await startSignedIn();
    try {
      const id = await chat(off);
      const r = await callTool(off, id, "browser_open", { url: "https://a.example/" });
      expect(r.last?.isError ?? true).toBe(true);
      expect(off.host.plane.browser).toBeUndefined();
      const state = await off.client.get(`/api/sessions/${id}/browser`);
      expect(state.body).toEqual({ window: false, url: null, title: null, viewport: null, takeover: null });
      expect((await off.client.post(`/api/sessions/${id}/browser/takeover`, {})).status).toBe(409);
    } finally {
      await off.destroy();
    }
  });
});
