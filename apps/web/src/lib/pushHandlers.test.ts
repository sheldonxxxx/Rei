import { beforeAll, describe, expect, it, vi } from "vitest";
import "../../public/push-handlers.js";

interface Handlers {
  onPush(event: unknown, sw: unknown): void;
  onNotificationClick(event: unknown, sw: unknown): void;
  routeOf(payload: unknown): string;
}
const handlers = (): Handlers => (globalThis as unknown as { reiPush: Handlers }).reiPush;
beforeAll(() => expect(handlers()).toBeDefined());

const pushEvent = (payload: unknown, raw?: string) => {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    event: {
      data: { json: () => (raw !== undefined ? JSON.parse(raw) : payload), text: () => raw ?? JSON.stringify(payload) },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    },
  };
};
const worker = (windows: Array<Record<string, unknown>> = []) => ({
  location: { origin: "https://ai.example.com" },
  registration: { showNotification: vi.fn().mockResolvedValue(undefined) },
  clients: { matchAll: vi.fn().mockResolvedValue(windows), openWindow: vi.fn().mockResolvedValue(null) },
});
const clickEvent = (data: unknown) => {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    event: { notification: { close: vi.fn(), data }, waitUntil: (p: Promise<unknown>) => waits.push(p) },
  };
};

describe("push", () => {
  it("shows the title and body, tagged by session so a repeat replaces it, with the route built from the ids", async () => {
    const sw = worker();
    const { event, waits } = pushEvent({
      event: "trigger_report",
      sessionId: "ses_1",
      messageId: "a:run_1",
      title: "Morning brief",
      body: "Three meetings",
      path: "#/s/ses_1",
    });
    handlers().onPush(event, sw);
    await Promise.all(waits);
    expect(sw.registration.showNotification).toHaveBeenCalledWith(
      "Morning brief",
      expect.objectContaining({
        body: "Three meetings",
        tag: "session:ses_1",
        renotify: true,
        data: { path: "/s/ses_1?m=a%3Arun_1" },
      }),
    );
  });

  it("always shows something, and never takes a route from outside the app", async () => {
    const sw = worker();
    const bad = pushEvent(undefined, "not json {");
    handlers().onPush(bad.event, sw);
    await Promise.all(bad.waits);
    expect(sw.registration.showNotification).toHaveBeenLastCalledWith(
      "Rei",
      expect.objectContaining({ data: { path: "/" } }),
    );
    expect((sw.registration.showNotification.mock.calls[0]![1] as { tag?: string }).tag).toBeUndefined();
    const evil = pushEvent({ title: "t", path: "https://evil.example/" });
    handlers().onPush(evil.event, sw);
    expect(sw.registration.showNotification).toHaveBeenLastCalledWith(
      "t",
      expect.objectContaining({ data: { path: "/" } }),
    );
  });

  it("reads an older server's payload that has only a hash path", () => {
    expect(handlers().routeOf({ path: "#/s/ses_1" })).toBe("/s/ses_1");
    expect(handlers().routeOf({ sessionId: "ses 1" })).toBe("/s/ses%201");
    expect(handlers().routeOf({ path: "//evil.example" })).toBe("/");
  });
});

describe("notification click", () => {
  it("focuses an open window of the app and moves it to the route", async () => {
    const win = {
      url: "https://ai.example.com/s/other",
      focused: false,
      focus: vi.fn(),
      navigate: vi.fn().mockResolvedValue(null),
      postMessage: vi.fn(),
    };
    win.focus.mockResolvedValue(win);
    const foreign = { url: "https://elsewhere.example/", focus: vi.fn(), navigate: vi.fn() };
    const sw = worker([foreign, win]);
    const { event, waits } = clickEvent({ path: "/s/ses_1?m=a%3Ax" });
    handlers().onNotificationClick(event, sw);
    await Promise.all(waits);
    expect(event.notification.close).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.navigate).toHaveBeenCalledWith("https://ai.example.com/s/ses_1?m=a%3Ax");
    expect(foreign.focus).not.toHaveBeenCalled();
    expect(sw.clients.openWindow).not.toHaveBeenCalled();
  });

  it("asks the window to move itself when it can't be navigated", async () => {
    const win = {
      url: "https://ai.example.com/",
      focused: true,
      focus: vi.fn().mockResolvedValue(null),
      postMessage: vi.fn(),
    };
    const { event, waits } = clickEvent({ path: "/s/ses_1" });
    handlers().onNotificationClick(event, worker([win]));
    await Promise.all(waits);
    expect(win.postMessage).toHaveBeenCalledWith({ type: "navigate", path: "/s/ses_1" });
  });

  it("opens a new window when none is open, at the start without a route, and reads an older worker's hash route", async () => {
    const sw = worker();
    const a = clickEvent({ path: "/s/ses_1" });
    handlers().onNotificationClick(a.event, sw);
    await Promise.all(a.waits);
    expect(sw.clients.openWindow).toHaveBeenLastCalledWith("https://ai.example.com/s/ses_1");
    const b = clickEvent(undefined);
    handlers().onNotificationClick(b.event, sw);
    await Promise.all(b.waits);
    expect(sw.clients.openWindow).toHaveBeenLastCalledWith("https://ai.example.com/");
    const c = clickEvent({ path: "#/s/ses_2" });
    handlers().onNotificationClick(c.event, sw);
    await Promise.all(c.waits);
    expect(sw.clients.openWindow).toHaveBeenLastCalledWith("https://ai.example.com/s/ses_2");
    const d = clickEvent({ path: "//evil.example/" });
    handlers().onNotificationClick(d.event, sw);
    await Promise.all(d.waits);
    expect(sw.clients.openWindow).toHaveBeenLastCalledWith("https://ai.example.com/");
  });
});
