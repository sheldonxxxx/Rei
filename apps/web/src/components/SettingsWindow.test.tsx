import type { ContextSettings } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentRoute } from "../lib/route.ts";
import { SettingsWindow } from "./SettingsWindow.tsx";

const compaction = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 };
const home = { idleGapMinutes: 60, recentMessages: 10, maxTokens: 16000 };
const initial: ContextSettings = { compaction, modelOverrides: {}, home, defaults: { compaction, home } };
const settings = {
  runLimits: { maxModelCalls: 50, maxRunMinutes: 30 },
  retry: { maxRetries: 2, baseDelaySeconds: 2 },
  memory: { injectProfile: true, injectRecent: true, historyHits: 8 },
  generation: { maxOutputTokens: null },
  discovery: { maxConnectorTools: 5, maxSkills: 3 },
  search: { useOpenAiNativeSearch: false },
  codeMode: { enabled: false },
};
const behavior = {
  settings,
  defaults: settings,
  ceilings: { maxModelCalls: 500, maxRunMinutes: 1440, maxRetries: 10 },
};

function setup(onClose = vi.fn()) {
  const api = {
    getModelSettings: vi.fn().mockResolvedValue({
      standard: { model: "local/chat", firstEventMs: 120_000, idleMs: 30_000, totalMs: 600_000 },
    }),
    getContextSettings: vi.fn().mockResolvedValue(initial),
    updateContextSettings: vi.fn().mockResolvedValue(initial),
    getBehaviorSettings: vi.fn().mockResolvedValue(behavior),
    updateBehaviorSettings: vi.fn().mockResolvedValue(behavior),
  };
  render(
    <SettingsWindow
      api={api as never}
      agents={[]}
      companion={null}
      sessions={[]}
      route={{ section: "runtime", id: null }}
      wide
      memoryRev={0 as never}
      pageRev={{} as never}
      onClose={onClose}
      onLogout={() => {}}
    />,
  );
  return { api, onClose };
}

const editReserve = async () => {
  const reserve = await screen.findByLabelText(/Room kept for the answer/);
  fireEvent.change(reserve, { target: { value: "8000" } });
};
const closeButton = () => screen.getByRole("button", { name: "Close settings" });

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("SettingsWindow leaving with unsaved changes", () => {
  it("closes at once when nothing is unsaved", async () => {
    const { onClose } = setup();
    await screen.findByLabelText(/Room kept for the answer/);
    fireEvent.click(closeButton());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });

  it("asks before closing, and keeps the window open on Keep editing", async () => {
    const { onClose } = setup();
    await editReserve();
    fireEvent.click(closeButton());
    expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes after Discard", async () => {
    const { onClose } = setup();
    await editReserve();
    fireEvent.click(closeButton());
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks before following a link to another section, and goes there after Discard", async () => {
    setup();
    await editReserve();
    const link = document.querySelector<HTMLAnchorElement>('a[href="/settings/memory"]');
    expect(link).toBeTruthy();
    fireEvent.click(link!);
    expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy();
    expect(currentRoute()).not.toBe("/settings/memory");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(currentRoute()).toBe("/settings/memory"));
  });

  it("follows a section link without asking when nothing is unsaved", async () => {
    setup();
    await screen.findByLabelText(/Room kept for the answer/);
    const link = document.querySelector<HTMLAnchorElement>('a[href="/settings/memory"]');
    fireEvent.click(link!);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });

  it("asks before the browser's Back leaves, and stays put on Keep editing", async () => {
    const { onClose } = setup();
    await editReserve();
    window.history.back();
    expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Room kept for the answer/)).toBeTruthy();
  });

  it("Back passes straight through when nothing is unsaved", async () => {
    setup();
    await screen.findByLabelText(/Room kept for the answer/);
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });

  it("renders the MCP settings section when route is mcp and opens New MCP token in-pane without a stacked dialog", async () => {
    const api = {
      listKnowledgeMcpTokens: vi.fn().mockResolvedValue({ endpointPath: "/api/mcp/knowledge", tokens: [] }),
      knowledgeTree: vi.fn().mockResolvedValue({ pages: [] }),
    };
    render(
      <SettingsWindow
        api={api as never}
        agents={[]}
        companion={null}
        sessions={[]}
        route={{ section: "mcp", id: null }}
        wide
        memoryRev={0 as never}
        pageRev={{} as never}
        onClose={vi.fn()}
        onLogout={() => {}}
      />,
    );
    expect(await screen.findByRole("heading", { name: "MCP" })).toBeTruthy();
    expect(await screen.findByText(/No MCP tokens yet/)).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "New token" }));
    expect(await screen.findByRole("heading", { name: "New MCP token" })).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    // Dirty check also warns before closing Settings when editing a new token.
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Unsaved token" } });
    fireEvent.click(closeButton());
    expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy();
  });
});
