import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, hello } from "../test/fakes.ts";
import type { LiveStatus } from "./browserLive.ts";
import { liveUrl, openLive } from "./browserLive.ts";

const open = (url: string) => new FakeWebSocket(url) as never;

function setup() {
  const statuses: LiveStatus[] = [];
  const messages: unknown[] = [];
  const frames: Blob[] = [];
  const conn = openLive({
    url: "ws://x/live",
    openSocket: open,
    backoff: () => 1000,
    onStatus: (s) => statuses.push(s),
    onMessage: (m) => messages.push(m),
    onFrame: (b) => frames.push(b),
  });
  return { conn, statuses, messages, frames };
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("liveUrl", () => {
  it("uses ws on http and wss on https, and encodes the id", () => {
    expect(liveUrl("a b", { protocol: "http:", host: "h:1" })).toBe("ws://h:1/api/sessions/a%20b/browser/live");
    expect(liveUrl("s1", { protocol: "https:", host: "h" })).toBe("wss://h/api/sessions/s1/browser/live");
  });
});

describe("openLive", () => {
  it("is live after the hello, and passes JSON messages and binary frames on", async () => {
    const { statuses, messages, frames } = setup();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverSend(hello());
    FakeWebSocket.last.serverFrame();
    FakeWebSocket.last.onmessage?.({ data: "not json" } as MessageEvent); // skipped
    expect(statuses).toEqual(["connecting", "live"]);
    expect(messages).toHaveLength(1);
    expect(frames).toHaveLength(1);
  });

  it("reconnects with backoff after a drop, and reports it", async () => {
    const { statuses } = setup();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose();
    expect(statuses).toEqual(["connecting", "reconnecting"]);
    expect(FakeWebSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeWebSocket.all).toHaveLength(2);
    FakeWebSocket.last.serverSend(hello());
    expect(statuses.at(-1)).toBe("live");
  });

  it("does not reconnect when the server says the window is closed, or refuses the socket", async () => {
    const a = setup();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverSend({ type: "closed", reason: "The window closed" });
    FakeWebSocket.last.serverClose(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(a.statuses.at(-1)).toBe("closed");

    FakeWebSocket.reset();
    const b = setup();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose(4401);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(b.statuses.at(-1)).toBe("denied");
  });

  it("sends only on an open socket, and stops for good on close", async () => {
    const { conn } = setup();
    expect(conn.send({ type: "text", text: "x" })).toBe(false); // still connecting
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.send({ type: "text", text: "x" })).toBe(true);
    expect(FakeWebSocket.last.messages).toEqual([{ type: "text", text: "x" }]);
    const socket = FakeWebSocket.last;
    conn.close();
    expect(socket.closed).toBe(true);
    expect(conn.send({ type: "text", text: "y" })).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("cancels a pending reconnect on close", async () => {
    const { conn } = setup();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose();
    conn.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.all).toHaveLength(1);
  });
});
