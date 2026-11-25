import type { SearchSetupSettings } from "@rei/protocol";
import { SEARCH_PROVIDER_IDS } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SearchProviderSettings } from "./SearchProviderSettings.tsx";

function setup(patch: Partial<SearchSetupSettings> = {}) {
  const value: SearchSetupSettings = {
    providers: ["codex-subscription"],
    searxngUrl: "",
    providerStatus: [
      { id: "codex-subscription", configured: true, limitedUntil: null },
      { id: "exa", configured: true, limitedUntil: null },
    ],
    ...patch,
  };
  const save = vi.fn().mockImplementation(async (input) => ({ ...input, providerStatus: value.providerStatus }));
  render(
    <SearchProviderSettings
      api={{ getSearchSetup: vi.fn().mockResolvedValue(value), saveSearchSetup: save } as never}
      onSaved={vi.fn()}
    />,
  );
  return save;
}
it("lists every provider, preserves enabled choices and keeps unconfigured rows configurable", async () => {
  setup();
  const list = await screen.findByRole("list", { name: "Search providers in priority order" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(6);
  expect(screen.getByRole("switch", { name: "Enable ChatGPT / Codex" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("switch", { name: "Enable Exa (keyless)" }).getAttribute("aria-checked")).toBe("false");
  expect(within(screen.getByRole("listitem", { name: "Brave" })).getByText("Needs setup")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Configure Brave" }));
  expect(screen.getByLabelText("Brave API key")).toBeTruthy();
});
it("saves fallback order, switches and write-only configuration together without enabling on configure", async () => {
  const save = setup();
  await screen.findByRole("list");
  fireEvent.click(screen.getByRole("button", { name: "Move Exa (keyless) up" }));
  fireEvent.click(screen.getByRole("switch", { name: "Enable Exa (keyless)" }));
  fireEvent.click(screen.getByRole("button", { name: "Configure Brave" }));
  fireEvent.change(screen.getByLabelText("Brave API key"), { target: { value: "test-brave-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["exa", "codex-subscription"],
        providerOrder: ["exa", "codex-subscription", "exa-api", "brave", "tavily", "searxng"],
        apiKeys: { brave: "test-brave-key" },
        codexModel: "gpt-6-luna",
      }),
    ),
  );
  await screen.findByText("Saved");
  expect((screen.getByLabelText("Brave API key") as HTMLInputElement).value).toBe("");
});
it("supports drag reordering and keyboard movement, including disabled rows", async () => {
  const save = setup({ providerOrder: [...SEARCH_PROVIDER_IDS] });
  await screen.findByRole("list");
  fireEvent.dragStart(screen.getByRole("button", { name: "Drag SearXNG to reorder" }), {
    dataTransfer: { effectAllowed: "", setData: vi.fn() },
  });
  fireEvent.drop(screen.getByRole("listitem", { name: "ChatGPT / Codex" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Drag SearXNG to reorder" }), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOrder: ["codex-subscription", "searxng", "exa", "exa-api", "brave", "tavily"],
        providers: ["codex-subscription"],
      }),
    ),
  );
});
it("keeps the subscription model editable and supports all providers off", async () => {
  const save = setup({ codexModel: "gpt-6-luna" });
  await screen.findByRole("list");
  fireEvent.click(screen.getByRole("button", { name: "Configure ChatGPT / Codex" }));
  fireEvent.change(screen.getByLabelText("Search model"), { target: { value: "gpt-6.1-sol" } });
  fireEvent.click(screen.getByRole("switch", { name: "Enable ChatGPT / Codex" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ providers: [], codexModel: "gpt-6.1-sol" })),
  );
});
it("shows save failures without discarding unsaved order", async () => {
  const save = setup();
  save.mockRejectedValue(new Error("Save failed"));
  await screen.findByRole("list");
  fireEvent.click(screen.getByRole("button", { name: "Move Exa (keyless) up" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  expect(within(screen.getByRole("list")).getAllByRole("listitem")[0]?.getAttribute("aria-label")).toBe(
    "Exa (keyless)",
  );
});

it("enables and reorders both Exa modes independently", async () => {
  const save = setup({ providers: ["exa"] });
  await screen.findByRole("list");
  expect(screen.queryByText("Brave Search API")).toBeNull();
  fireEvent.click(screen.getByRole("switch", { name: "Enable Exa (API key)" }));
  expect(screen.getByRole("switch", { name: "Enable Exa (keyless)" }).getAttribute("aria-checked")).toBe("true");
  expect(within(screen.getByRole("listitem", { name: "Exa (API key)" })).getByText("Needs setup")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Configure Exa (API key)" }));
  fireEvent.change(screen.getByLabelText("Exa API key"), { target: { value: "test-exa-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Move Exa (API key) up" }));
  fireEvent.click(screen.getByRole("button", { name: "Move Exa (API key) up" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["exa-api", "exa"], apiKeys: { exa: "test-exa-key" } }),
    ),
  );
});
