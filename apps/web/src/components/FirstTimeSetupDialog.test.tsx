import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { FirstTimeSetupDialog } from "./FirstTimeSetupDialog.tsx";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    getOpenAiOAuthStatus: vi.fn().mockResolvedValue({ pending: false }),
    getModelSettings: vi
      .fn()
      .mockResolvedValue({ fast: { model: "test" }, standard: { model: "test" }, capabilities: [] }),
    getModels: vi.fn().mockResolvedValue({ models: ["test"] }),
    getEmbeddingSetup: vi.fn().mockResolvedValue(null),
    getMemorySetup: vi.fn().mockResolvedValue({ enabled: false, available: false, model: null }),
    getSearchSetup: vi.fn().mockResolvedValue({ providers: [], searxngUrl: "" }),
    getProviders: vi.fn().mockResolvedValue({ connections: [] }),
    getIndexStatus: vi.fn().mockResolvedValue({ index: { state: "off", model: null } }),
    getWebSearchStatus: vi.fn().mockResolvedValue({ providers: [] }),
    getFirstTimeSetup: vi.fn().mockResolvedValue({ dismissed: false }),
    updateFirstTimeSetup: vi.fn().mockImplementation(async (req: { dismissed: boolean }) => req),
    ...overrides,
  };
}

const completeStatus = {
  getProviders: vi.fn().mockResolvedValue({ connections: [{ connected: true }] }),
  getIndexStatus: vi.fn().mockResolvedValue({ index: { state: "ready", model: "m" } }),
  getWebSearchStatus: vi.fn().mockResolvedValue({ providers: [{ id: "x", configured: true }] }),
};

it("guides through three steps, supports going back, and finishes", async () => {
  render(<FirstTimeSetupDialog api={fakeApi() as never} />);
  await screen.findByRole("dialog");
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  expect(screen.queryByRole("region", { name: "Memory embeddings" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("region", { name: "Memory embeddings" })).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("region", { name: "Model provider" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "3 Search" }));
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("stays hidden when the instance has dismissed it, even in a fresh browser", async () => {
  const api = fakeApi({ getFirstTimeSetup: vi.fn().mockResolvedValue({ dismissed: true }) });
  render(<FirstTimeSetupDialog api={api as never} />);
  await waitFor(() => expect(api.getFirstTimeSetup).toHaveBeenCalled());
  expect(api.getProviders).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("stays hidden once setup is complete, without any browser flag", async () => {
  const api = fakeApi(completeStatus);
  render(<FirstTimeSetupDialog api={api as never} />);
  await waitFor(() => expect(api.getWebSearchStatus).toHaveBeenCalled());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it('saves "Don\'t show again" on the instance when the dialog is closed', async () => {
  const api = fakeApi();
  render(<FirstTimeSetupDialog api={api as never} />);
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("checkbox", { name: "Don’t show again" }));
  fireEvent.click(screen.getByRole("button", { name: "3 Search" }));
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.updateFirstTimeSetup).toHaveBeenCalledWith({ dismissed: true });
});

it('closing without "Don\'t show again" does not save anything on the instance', async () => {
  const api = fakeApi();
  render(<FirstTimeSetupDialog api={api as never} />);
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "3 Search" }));
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.updateFirstTimeSetup).not.toHaveBeenCalled();
});
