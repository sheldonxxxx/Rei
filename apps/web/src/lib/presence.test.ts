import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPresence } from "./presence.ts";

let state: DocumentVisibilityState = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  state = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
});
afterEach(() => vi.useRealTimers());
const hide = (to: DocumentVisibilityState) => {
  state = to;
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("startPresence", () => {
  it("reports visible at once and every 30 seconds, hidden once on hiding, and stops", () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const stop = startPresence(post);
    expect(post.mock.calls).toEqual([[{ visible: true, idleMs: 0 }]]);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    expect(post).toHaveBeenCalledTimes(3);
    expect(post).toHaveBeenLastCalledWith({ visible: true, idleMs: 60_000 });
    hide("hidden");
    expect(post).toHaveBeenLastCalledWith({ visible: false });
    vi.advanceTimersByTime(300_000);
    expect(post).toHaveBeenCalledTimes(4);
    hide("visible");
    expect(post).toHaveBeenLastCalledWith({ visible: true, idleMs: 0 });
    vi.advanceTimersByTime(30_000);
    expect(post).toHaveBeenCalledTimes(6);
    stop();
    vi.advanceTimersByTime(300_000);
    hide("hidden");
    expect(post).toHaveBeenCalledTimes(6);
  });

  it("counts idle time from the last touch, and reports a return from a quiet spell at once", () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const stop = startPresence(post);
    vi.advanceTimersByTime(10_000);
    document.dispatchEvent(new Event("keydown"));
    expect(post).toHaveBeenCalledTimes(1); // a touch during use waits for the next beat
    vi.advanceTimersByTime(20_000);
    expect(post).toHaveBeenLastCalledWith({ visible: true, idleMs: 20_000 });
    vi.advanceTimersByTime(150_000);
    expect(post).toHaveBeenLastCalledWith({ visible: true, idleMs: 170_000 });
    const before = post.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    document.dispatchEvent(new Event("pointerdown"));
    expect(post).toHaveBeenCalledTimes(before + 1);
    expect(post).toHaveBeenLastCalledWith({ visible: true, idleMs: 0 });
    stop();
  });

  it("survives a failing post", () => {
    const post = vi.fn().mockRejectedValue(new Error("offline"));
    const stop = startPresence(post);
    vi.advanceTimersByTime(30_000);
    expect(post).toHaveBeenCalledTimes(2);
    stop();
  });
});
