import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import { useOpenAiOAuth } from "./useOpenAiOAuth.ts";

type Status = { pending: boolean; authorizationUrl?: string; error?: string };
let popup: { closed: boolean; opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  popup = { closed: false, opener: {}, location: { href: "about:blank" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function makeApi(initial: Status = { pending: false }) {
  return {
    getOpenAiOAuthStatus: vi.fn<() => Promise<Status>>().mockResolvedValue(initial),
    startOpenAiOAuth: vi.fn().mockResolvedValue({ authorizationUrl: "https://auth.example/attempt-b" }),
    submitOpenAiOAuthCallback: vi.fn().mockResolvedValue({ ok: true }),
    cancelOpenAiOAuth: vi.fn().mockResolvedValue(undefined),
  };
}
async function flush() {
  await act(async () => {});
}
async function tick(ms = 1000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it("resumes gateway state, serializes slow polling, and uses the latest completion callback once", async () => {
  const api = makeApi({ pending: true, authorizationUrl: "https://auth.example/attempt-a" });
  const response = Promise.withResolvers<Status>();
  const oldSettled = vi.fn().mockResolvedValue(undefined);
  const newSettled = vi.fn().mockResolvedValue(undefined);
  const error = vi.fn();
  const { result, rerender, unmount } = renderHook(({ settled }) => useOpenAiOAuth(api, error, settled), {
    initialProps: { settled: oldSettled },
  });
  await flush();
  expect(result.current.pending).toBe(true);
  api.getOpenAiOAuthStatus.mockImplementationOnce(() => response.promise);
  await tick();
  await tick(5000);
  expect(api.getOpenAiOAuthStatus).toHaveBeenCalledTimes(2);
  rerender({ settled: newSettled });
  await act(async () => {
    response.resolve({ pending: false });
  });
  expect(result.current.pending).toBe(false);
  expect(newSettled).toHaveBeenCalledOnce();
  expect(oldSettled).not.toHaveBeenCalled();
  await tick(5000);
  expect(api.getOpenAiOAuthStatus).toHaveBeenCalledTimes(2);
  unmount();
  expect(api.cancelOpenAiOAuth).not.toHaveBeenCalled();
});

it.each([false, true])("ignores an obsolete poll after cancel and a replacement attempt (error=%s)", async (fail) => {
  const api = makeApi({ pending: true, authorizationUrl: "https://auth.example/attempt-a" });
  const response = Promise.withResolvers<Status>();
  const error = vi.fn();
  const settled = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() => useOpenAiOAuth(api, error, settled));
  await flush();
  api.getOpenAiOAuthStatus.mockImplementationOnce(() => response.promise);
  await tick();
  await act(async () => {
    expect(await result.current.cancel()).toBe(true);
  });
  await act(async () => {
    await result.current.start();
  });
  error.mockClear();
  await act(async () => {
    if (fail) response.reject(new Error("obsolete failure"));
    else response.resolve({ pending: false, error: "obsolete error" });
  });
  expect(result.current).toMatchObject({
    pending: true,
    busy: false,
    authorizationUrl: "https://auth.example/attempt-b",
  });
  expect(error).not.toHaveBeenCalled();
  expect(settled).not.toHaveBeenCalled();
});

it("leaving stops local observation and closes only an unfinished blank popup; returning resumes sign-in", async () => {
  const api = makeApi();
  const response = Promise.withResolvers<{ authorizationUrl: string }>();
  api.startOpenAiOAuth.mockImplementationOnce(() => response.promise);
  const error = vi.fn();
  const settled = vi.fn().mockResolvedValue(undefined);
  const first = renderHook(() => useOpenAiOAuth(api, error, settled));
  await flush();
  let starting: Promise<void>;
  act(() => {
    starting = first.result.current.start();
  });
  expect(window.open).toHaveBeenCalledOnce();
  expect(popup.opener).toBeNull();
  first.unmount();
  expect(popup.close).toHaveBeenCalledOnce();
  error.mockClear();
  await act(async () => {
    response.resolve({ authorizationUrl: "https://auth.example/resumed" });
    await starting;
  });
  expect(popup.location.href).toBe("about:blank");
  expect(error).not.toHaveBeenCalled();
  expect(settled).not.toHaveBeenCalled();
  expect(api.cancelOpenAiOAuth).not.toHaveBeenCalled();
  api.getOpenAiOAuthStatus.mockResolvedValue({ pending: true, authorizationUrl: "https://auth.example/resumed" });
  const next = renderHook(() => useOpenAiOAuth(api, error, settled));
  await flush();
  expect(next.result.current).toMatchObject({ pending: true, authorizationUrl: "https://auth.example/resumed" });
});

it("does not let initial state from an obsolete transport overwrite a replacement transport", async () => {
  const oldApi = makeApi();
  const newApi = makeApi({ pending: true, authorizationUrl: "https://auth.example/current" });
  const response = Promise.withResolvers<Status>();
  oldApi.getOpenAiOAuthStatus.mockImplementationOnce(() => response.promise);
  const error = vi.fn();
  const settled = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ api }) => useOpenAiOAuth(api, error, settled), {
    initialProps: { api: oldApi },
  });
  await flush();
  rerender({ api: newApi });
  await act(async () => {
    response.resolve({ pending: false, error: "old initial error" });
  });
  expect(result.current).toMatchObject({ pending: true, authorizationUrl: "https://auth.example/current" });
  expect(error).not.toHaveBeenCalled();
  expect(settled).not.toHaveBeenCalled();
});

it("retries polling errors and callback errors without losing the resumable attempt", async () => {
  const api = makeApi({ pending: true });
  const error = vi.fn();
  const settled = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() => useOpenAiOAuth(api, error, settled));
  await flush();
  api.getOpenAiOAuthStatus.mockRejectedValueOnce(new ApiError(400, "test_error", "poll failed"));
  await tick();
  expect(error).toHaveBeenLastCalledWith("poll failed");
  expect(result.current.pending).toBe(true);
  api.submitOpenAiOAuthCallback.mockRejectedValueOnce(new ApiError(400, "test_error", "callback failed"));
  await act(async () => {
    expect(await result.current.submit("http://127.0.0.1:1455/auth/callback?test")).toBe(false);
  });
  expect(error).toHaveBeenLastCalledWith("callback failed");
  api.getOpenAiOAuthStatus.mockResolvedValueOnce({ pending: false });
  await tick();
  expect(settled).toHaveBeenCalledOnce();
  expect(result.current.pending).toBe(false);
});

it("retains the attempt after a refused cancellation and can finish a pasted callback", async () => {
  const api = makeApi({ pending: true });
  const error = vi.fn();
  const settled = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() => useOpenAiOAuth(api, error, settled));
  await flush();
  api.cancelOpenAiOAuth.mockRejectedValueOnce(new ApiError(400, "test_error", "cancel failed"));
  await act(async () => {
    expect(await result.current.cancel()).toBe(false);
  });
  expect(result.current).toMatchObject({ pending: true, busy: false });
  expect(error).toHaveBeenLastCalledWith("cancel failed");
  await act(async () => {
    expect(await result.current.submit("http://127.0.0.1:1455/auth/callback?test")).toBe(true);
  });
  expect(api.submitOpenAiOAuthCallback).toHaveBeenCalledOnce();
  api.getOpenAiOAuthStatus.mockResolvedValueOnce({ pending: false });
  await tick();
  expect(settled).toHaveBeenCalledOnce();
});

it("keeps a popup-blocked attempt usable through its authorization link and cancels a pending start safely", async () => {
  vi.mocked(window.open).mockReturnValue(null);
  const api = makeApi();
  const response = Promise.withResolvers<{ authorizationUrl: string }>();
  const { result } = renderHook(() => useOpenAiOAuth(api, vi.fn(), vi.fn().mockResolvedValue(undefined)));
  await flush();
  await act(async () => {
    await result.current.start();
  });
  expect(result.current).toMatchObject({ pending: true, authorizationUrl: "https://auth.example/attempt-b" });
  await act(async () => {
    await result.current.cancel();
  });
  api.startOpenAiOAuth.mockImplementationOnce(() => response.promise);
  let starting: Promise<void>;
  act(() => {
    starting = result.current.start();
  });
  await act(async () => {
    await result.current.cancel();
  });
  await act(async () => {
    response.resolve({ authorizationUrl: "https://auth.example/obsolete" });
    await starting;
  });
  expect(result.current).toMatchObject({ pending: false, busy: false, authorizationUrl: "" });
});
