import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { message } from "../test/fixtures.ts";
import { readTarget, useReadMarker } from "./readMarker.ts";

const done = (id: string, createdAt: number) =>
  message({ id, role: "assistant", status: "complete", text: id, createdAt });

describe("readTarget", () => {
  it("is the newest settled item, skipping internal, pending and streaming ones", () => {
    const items = [
      done("a1", 10),
      message({ id: "u2", role: "user", status: "complete", createdAt: 20 }),
      message({ id: "a2", role: "assistant", status: "streaming", createdAt: 30 }),
      message({ id: "a3", role: "assistant", status: "complete", internal: true, createdAt: 40 }),
    ];
    expect(readTarget(items)?.id).toBe("u2");
    expect(readTarget([])).toBeUndefined();
  });
});

describe("useReadMarker", () => {
  const api = () => ({ markRead: vi.fn().mockResolvedValue({ marker: { itemId: "a1", at: 10 }, unread: 0 }) });

  it("marks the newest item read once it is on screen and the session has unread entries", () => {
    const a = api();
    const { rerender } = renderHook(
      ({ onScreen, unread }) => useReadMarker(a, { id: "s1", unread }, [done("a1", 10)], onScreen),
      { initialProps: { onScreen: false, unread: 1 } },
    );
    expect(a.markRead).not.toHaveBeenCalled();
    rerender({ onScreen: true, unread: 1 });
    expect(a.markRead).toHaveBeenCalledWith("s1", { itemId: "a1", at: 10 });
    rerender({ onScreen: true, unread: 1 });
    expect(a.markRead).toHaveBeenCalledTimes(1);
  });

  it("does nothing while nothing is unread", () => {
    const a = api();
    renderHook(() => useReadMarker(a, { id: "s1", unread: 0 }, [done("a1", 10)], true));
    expect(a.markRead).not.toHaveBeenCalled();
  });
});
