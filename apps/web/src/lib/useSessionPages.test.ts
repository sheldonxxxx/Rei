import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { session } from "../test/fixtures.ts";
import { useSessionPages } from "./useSessionPages.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("session pages", () => {
  it("loads one page at a time, follows cursors, and stops at the end", async () => {
    const second = deferred<{ sessions: ReturnType<typeof session>[]; nextCursor: null }>();
    const getSessions = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [session()], nextCursor: "older" })
      .mockReturnValueOnce(second.promise);
    const hydrate = vi.fn();
    const api = { getSessions } as unknown as Api;
    const { result } = renderHook(() => useSessionPages(api, "a1", 1, hydrate));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getSessions).toHaveBeenCalledWith({ agent: "a1" });
    act(() => {
      void result.current.load();
      void result.current.load();
    });
    expect(getSessions).toHaveBeenCalledTimes(2);
    expect(getSessions).toHaveBeenLastCalledWith({ agent: "a1", before: "older" });
    await act(async () => second.resolve({ sessions: [], nextCursor: null }));
    expect(result.current.more).toBe(false);
    act(() => {
      void result.current.load();
    });
    expect(getSessions).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("ignores an old agent's response and restarts after a stream snapshot", async () => {
    const old = deferred<{ sessions: ReturnType<typeof session>[]; nextCursor: null }>();
    const getSessions = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ sessions: [], nextCursor: null });
    const hydrate = vi.fn();
    const api = { getSessions } as unknown as Api;
    const { rerender } = renderHook(({ agent, version }) => useSessionPages(api, agent, version, hydrate), {
      initialProps: { agent: "a1", version: 1 },
    });
    rerender({ agent: "a2", version: 1 });
    await waitFor(() => expect(hydrate).toHaveBeenCalledWith([], 1));
    await act(async () => old.resolve({ sessions: [session({ id: "old" })], nextCursor: null }));
    expect(hydrate).not.toHaveBeenCalledWith([expect.objectContaining({ id: "old" })], 1);
    rerender({ agent: "a2", version: 2 });
    await waitFor(() => expect(hydrate).toHaveBeenCalledWith([], 2));
  });
  it("asks for trigger runs too, and starts the history again when the filter changes", async () => {
    const getSessions = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
    const hydrate = vi.fn();
    const api = { getSessions } as unknown as Api;
    const { rerender } = renderHook(({ triggers }) => useSessionPages(api, "a1", 1, hydrate, triggers), {
      initialProps: { triggers: false },
    });
    await waitFor(() => expect(getSessions).toHaveBeenCalledWith({ agent: "a1" }));
    rerender({ triggers: true });
    await waitFor(() => expect(getSessions).toHaveBeenLastCalledWith({ agent: "a1", triggers: "1" }));
    expect(getSessions).toHaveBeenCalledTimes(2);
  });
});
