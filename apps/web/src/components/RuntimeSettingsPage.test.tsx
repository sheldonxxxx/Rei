import type {
  BehaviorSettings,
  BehaviorSettingsResponse,
  ContextSettings,
  UpdateModelSettingsRequest,
} from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnsavedChangesProvider, useAnyUnsaved } from "../lib/unsaved.tsx";
import { RuntimeSettingsPage } from "./RuntimeSettingsPage.tsx";

const compaction = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 };
const home = { idleGapMinutes: 60, recentMessages: 10, maxTokens: 16000 };
const context: ContextSettings = { compaction, modelOverrides: {}, home, defaults: { compaction, home } };

const settings: BehaviorSettings = {
  runLimits: { maxModelCalls: 50, maxRunMinutes: 30 },
  retry: { maxRetries: 2, baseDelaySeconds: 2 },
  memory: { injectProfile: true, injectRecent: true, historyHits: 8 },
  generation: { maxOutputTokens: null },
  discovery: { maxConnectorTools: 5, maxSkills: 3 },
  search: { useOpenAiNativeSearch: false },
  codeMode: { enabled: false },
  chat: { whenBusy: "steer" },
};
const behavior: BehaviorSettingsResponse = {
  settings,
  defaults: settings,
  ceilings: { maxModelCalls: 500, maxRunMinutes: 1440, maxRetries: 10 },
};

const standard = { model: "local/chat", firstEventMs: 25_000, idleMs: 45_000, totalMs: 800_000 };

function apiMock() {
  return {
    getModelSettings: vi.fn().mockResolvedValue({ standard }),
    updateModelSettings: vi.fn().mockImplementation(async (patch: UpdateModelSettingsRequest) => ({
      standard: { ...standard, ...patch.standard },
    })),
    getContextSettings: vi.fn().mockResolvedValue(context),
    updateContextSettings: vi.fn().mockResolvedValue(context),
    getBehaviorSettings: vi.fn().mockResolvedValue(behavior),
    updateBehaviorSettings: vi.fn().mockResolvedValue(behavior),
  };
}

function setup() {
  const api = apiMock();
  render(<RuntimeSettingsPage api={api as never} />);
  return api;
}

function Watcher() {
  return <output data-testid="any">{String(useAnyUnsaved())}</output>;
}

const roomForAnswer = () => screen.findByLabelText(/Room kept for the answer/);
const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false });
const save = () => screen.getByRole("button", { name: "Save settings" });

describe("RuntimeSettingsPage", () => {
  it("shows the Runtime tabs with one save action", async () => {
    setup();
    await roomForAnswer();
    expect(screen.getByRole("heading", { name: "Runtime" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Save settings" })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Context", selected: true })).toBeTruthy();
    expect(screen.getByLabelText("Idle time before summarizing (minutes)")).toBeTruthy();
    expect(screen.queryByLabelText(/Recent messages kept/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Run limits" })).toBeNull();
  });

  it("shows current values for both the context window and the limits", async () => {
    setup();
    expect(((await roomForAnswer()) as HTMLInputElement).value).toBe("16384");
    openTab("Runs");
    expect((screen.getByLabelText("Total call (seconds)") as HTMLInputElement).value).toBe("800");
    expect((screen.getByLabelText("Model calls per run") as HTMLInputElement).value).toBe("50");
  });

  it("keeps edits across tabs and saves the changed timeout in milliseconds", async () => {
    const api = setup();
    fireEvent.change(await roomForAnswer(), { target: { value: "8000" } });
    fireEvent.click(screen.getByRole("switch", { name: "Put recent chats in context" }));
    openTab("Runs");
    fireEvent.change(screen.getByLabelText("Model calls per run"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Total call (seconds)"), { target: { value: "90" } });
    openTab("Context");
    expect(((await roomForAnswer()) as HTMLInputElement).value).toBe("8000");
    fireEvent.click(save());
    await waitFor(() => expect(api.updateBehaviorSettings).toHaveBeenCalled());
    expect(api.updateContextSettings.mock.calls[0]![0]).toMatchObject({
      compaction: { enabled: true, reserveTokens: 8000, keepRecentTokens: 20000, backgroundTokens: 32768 },
      home: { idleGapMinutes: home.idleGapMinutes, maxTokens: home.maxTokens },
    });
    expect(api.updateBehaviorSettings.mock.calls[0]![0]).toMatchObject({
      runLimits: { maxModelCalls: 20, maxRunMinutes: 30 },
      generation: { maxOutputTokens: null },
      memory: { injectProfile: true, injectRecent: false, historyHits: 8 },
      search: { useOpenAiNativeSearch: false },
    });
    expect(api.updateModelSettings).toHaveBeenCalledWith({ standard: { totalMs: 90_000 } });
    expect(await screen.findByText("Saved. Applies from the next model call.")).toBeTruthy();
  });

  it("saves an empty output cap as null and the web search switch", async () => {
    const api = setup();
    await roomForAnswer();
    openTab("Tools");
    fireEvent.click(screen.getByRole("switch", { name: "Use OpenAI's built-in search with OpenAI models" }));
    fireEvent.click(save());
    await waitFor(() => expect(api.updateBehaviorSettings).toHaveBeenCalled());
    expect(api.updateBehaviorSettings.mock.calls[0]![0]).toMatchObject({
      generation: { maxOutputTokens: null },
      search: { useOpenAiNativeSearch: true },
    });
    expect(api.updateModelSettings).not.toHaveBeenCalled();
  });

  it("shows the Code mode switch off and saves it on", async () => {
    const api = setup();
    await roomForAnswer();
    openTab("Tools");
    const toggle = screen.getByRole("switch", { name: "Let agents run scripts" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    fireEvent.click(save());
    await waitFor(() => expect(api.updateBehaviorSettings).toHaveBeenCalled());
    expect(api.updateBehaviorSettings.mock.calls[0]![0]).toMatchObject({ codeMode: { enabled: true } });
  });

  it("shows steering on by default and saves queue when it is turned off", async () => {
    const api = setup();
    await roomForAnswer();
    openTab("Runs");
    const toggle = screen.getByRole("switch", { name: "Steer the running reply" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    fireEvent.click(save());
    await waitFor(() => expect(api.updateBehaviorSettings).toHaveBeenCalled());
    expect(api.updateBehaviorSettings.mock.calls[0]![0]).toMatchObject({ chat: { whenBusy: "queue" } });
  });

  it("does not offer a rendering switch", async () => {
    setup();
    await roomForAnswer();
    expect(screen.queryByRole("switch", { name: "Render pages that need JavaScript" })).toBeNull();
  });

  it("opens the tab with an invalid number and resets runtime defaults", async () => {
    const api = setup();
    fireEvent.change(await roomForAnswer(), { target: { value: "abc" } });
    fireEvent.click(save());
    expect((await screen.findByRole("alert")).textContent).toMatch(/whole number/);
    expect(api.updateContextSettings).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Room kept for the answer (tokens)"), { target: { value: "16384" } });
    openTab("Runs");
    fireEvent.change(screen.getByLabelText("First response (seconds)"), { target: { value: "0" } });
    openTab("Tools");
    fireEvent.click(save());
    expect((await screen.findByRole("alert")).textContent).toMatch(/1 to 7,200/);
    expect(screen.getByRole("tab", { name: "Runs", selected: true })).toBeTruthy();
    expect(api.updateBehaviorSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset all to defaults" }));
    await waitFor(() => expect(api.updateContextSettings).toHaveBeenCalledWith({ compaction: null, home: null }));
    expect(api.updateBehaviorSettings).toHaveBeenCalledWith(null);
    expect(api.updateModelSettings).toHaveBeenCalledWith({
      standard: { firstEventMs: 120_000, idleMs: 500_000, totalMs: 600_000 },
    });
  });

  it("shows Unsaved changes while the form differs from the server, and Saved after a save", async () => {
    setup();
    const room = await roomForAnswer();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    fireEvent.change(room, { target: { value: "8000" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.change(room, { target: { value: "16384" } });
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    fireEvent.change(room, { target: { value: "8000" } });
    fireEvent.click(save());
    expect(await screen.findByText("Saved. Applies from the next model call.")).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("reports its unsaved edits to the surrounding window", async () => {
    const api = apiMock();
    render(
      <UnsavedChangesProvider>
        <RuntimeSettingsPage api={api as never} />
        <Watcher />
      </UnsavedChangesProvider>,
    );
    const room = await roomForAnswer();
    expect(screen.getByTestId("any").textContent).toBe("false");
    fireEvent.change(room, { target: { value: "8000" } });
    expect(screen.getByTestId("any").textContent).toBe("true");
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByTestId("any").textContent).toBe("false"));
  });
});
