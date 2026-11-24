import type { Agent, MemoryResponse } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { indexStatus, memoryChange, memoryLine } from "../test/fixtures.ts";
import { MemoryPage } from "./MemoryPage.tsx";

const agents: Agent[] = [
  {
    id: "a1",
    name: "Dot",
    avatar: "D",
    model: null,
    thinkingLevel: "off",
    networkMode: "block",
    defaultProfile: "standard",
    homeSessionId: "h",
  },
];
const DAY = 86_400_000;

const memory = (over: Partial<MemoryResponse> = {}): MemoryResponse => ({
  profile: [memoryLine()],
  agents: [{ agentId: "a1", lines: [], usedTokens: 45, tokenBudget: 1000 }],
  userUsedTokens: 120,
  userTokenBudget: 3000,
  usedTokens: 120,
  ...over,
});

function setup(api: Record<string, unknown> = {}, rev = { lines: 0, index: 0 }, people: Agent[] = agents) {
  const full = {
    getMemory: vi.fn().mockResolvedValue(memory()),
    getIndexStatus: vi.fn().mockResolvedValue({ index: indexStatus() }),
    getMemoryExtraction: vi.fn().mockResolvedValue({ enabled: false }),
    updateMemoryExtraction: vi.fn(),
    ...api,
  };
  const view = render(<MemoryPage api={full as unknown as Api} agents={people} rev={rev} />);
  return {
    api: full,
    view,
    rerender: (r: typeof rev) => view.rerender(<MemoryPage api={full as unknown as Api} agents={people} rev={r} />),
  };
}

describe("MemoryPage: the docs", () => {
  it("shows About you and one section per agent, with the line's date and who added it", async () => {
    setup({
      getMemory: vi.fn().mockResolvedValue(
        memory({
          agents: [
            {
              agentId: "a1",
              usedTokens: 45,
              tokenBudget: 1000,
              lines: [memoryLine({ id: "m2", doc: "agent", agentId: "a1", text: "Keep answers short." })],
            },
          ],
        }),
      ),
    });
    const about = await screen.findByRole("region", { name: "About you" });
    expect(within(about).getByText("Lives in Hong Kong.")).toBeTruthy();
    expect(within(about).getByText("Confirmed 3 days ago")).toBeTruthy();
    expect(within(about).getByText("Added by you")).toBeTruthy();
    const dot = screen.getByRole("region", { name: "Dot's notes" });
    expect(within(dot).getByText("Keep answers short.")).toBeTruthy();
  });

  it("links a line's source to the exact message, and says when the chat was deleted", async () => {
    setup({
      getMemory: vi.fn().mockResolvedValue(
        memory({
          profile: [
            memoryLine({ id: "m1", source: { sessionId: "s 1", messageId: "m9", sessionTitle: "Tokyo trip" } }),
            memoryLine({ id: "m2", text: "Likes tea.", sourceDeleted: true }),
          ],
        }),
      ),
    });
    const link = await screen.findByRole("link", { name: "From Tokyo trip" });
    expect(link.getAttribute("href")).toBe("/s/s%201?m=m9");
    expect(screen.getByText("Chat deleted")).toBeTruthy();
  });

  it("flags a line past the stale limit and lets you say it's still true", async () => {
    const updateMemoryLine = vi.fn().mockResolvedValue({ line: memoryLine(), change: memoryChange({ op: "replace" }) });
    const getMemory = vi.fn().mockResolvedValue(
      memory({
        profile: [
          memoryLine({ confirmedAt: Date.now() - 250 * DAY }),
          memoryLine({ id: "m2", text: "Fresh.", confirmedAt: Date.now() - DAY }),
        ],
      }),
    );
    setup({ getMemory, updateMemoryLine });
    expect(await screen.findByText("Stale")).toBeTruthy();
    expect(screen.getAllByText("Stale")).toHaveLength(1);
    expect(screen.getByText("Confirmed 8 months ago")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Still true: Lives in Hong Kong." }));
    await waitFor(() => expect(updateMemoryLine).toHaveBeenCalledWith("m1", { text: "Lives in Hong Kong." }));
    await waitFor(() => expect(getMemory).toHaveBeenCalledTimes(2));
  });

  it("shows the budget meter and warns when nearly full", async () => {
    const { view } = setup({ getMemory: vi.fn().mockResolvedValue(memory({ userUsedTokens: 1240 })) });
    const meter = await screen.findByRole("meter", { name: /User Memory/ });
    expect(meter.getAttribute("aria-valuenow")).toBe("1240");
    expect(meter.getAttribute("aria-valuemax")).toBe("3000");
    expect(screen.getByText(/of 3,000 tokens used/)).toBeTruthy();
    expect(screen.queryByText(/Nearly full/)).toBeNull();
    const privateMeter = screen.getByRole("meter", { name: /Dot.s notes/ });
    expect(privateMeter.getAttribute("aria-valuemax")).toBe("1000");
    expect(privateMeter.getAttribute("aria-valuenow")).toBe("45");
    view.unmount();
    setup({ getMemory: vi.fn().mockResolvedValue(memory({ userUsedTokens: 2900 })) });
    expect(await screen.findByText(/Nearly full/)).toBeTruthy();
  });

  it("empty docs say so, and a load error offers Try again", async () => {
    const getMemory = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(0, "network_error", ""))
      .mockResolvedValue(memory({ profile: [] }));
    setup({ getMemory });
    expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the server");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Nothing yet.")).toBeTruthy();
  });

  it("refetches when the stream says lines changed", async () => {
    const getMemory = vi.fn().mockResolvedValue(memory());
    const getIndexStatus = vi.fn().mockResolvedValue({ index: indexStatus() });
    const { rerender } = setup({ getMemory, getIndexStatus });
    await screen.findByText("Lives in Hong Kong.");
    expect(getMemory).toHaveBeenCalledTimes(1);
    rerender({ lines: 1, index: 0 });
    await waitFor(() => expect(getMemory).toHaveBeenCalledTimes(2));
    expect(getIndexStatus).toHaveBeenCalledTimes(1);
    rerender({ lines: 1, index: 1 });
    await waitFor(() => expect(getIndexStatus).toHaveBeenCalledTimes(2));
    expect(getMemory).toHaveBeenCalledTimes(2);
  });
});

describe("MemoryPage: editing", () => {
  it("edits a line in place and saves it", async () => {
    const updateMemoryLine = vi
      .fn()
      .mockResolvedValue({ line: memoryLine({ text: "Lives in Kowloon." }), change: memoryChange({ op: "replace" }) });
    const getMemory = vi
      .fn()
      .mockResolvedValueOnce(memory())
      .mockResolvedValue(memory({ profile: [memoryLine({ text: "Lives in Kowloon." })] }));
    setup({ getMemory, updateMemoryLine });
    fireEvent.click(await screen.findByRole("button", { name: "Edit: Lives in Hong Kong." }));
    const box = screen.getByRole("textbox", { name: "Edit line" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Lives in Hong Kong.");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true); // unchanged
    fireEvent.change(box, { target: { value: "Lives in Kowloon." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateMemoryLine).toHaveBeenCalledWith("m1", { text: "Lives in Kowloon." }));
    expect(await screen.findByText("Lives in Kowloon.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Edit line" })).toBeNull();
  });

  it("Escape cancels an edit; too-long text is refused with a count", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Edit: Lives in Hong Kong." }));
    const box = screen.getByRole("textbox", { name: "Edit line" });
    fireEvent.change(box, { target: { value: "x".repeat(501) } });
    expect(screen.getByText("501 / 500")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Edit line" })).toBeNull();
    expect(screen.getByText("Lives in Hong Kong.")).toBeTruthy();
  });

  it("shows the server's reason when saving fails, and keeps the editor", async () => {
    setup({ updateMemoryLine: vi.fn().mockRejectedValue(new ApiError(409, "over_budget", "")) });
    fireEvent.click(await screen.findByRole("button", { name: "Edit: Lives in Hong Kong." }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit line" }), { target: { value: "A longer line." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Memory is full/);
    expect(screen.getByRole("textbox", { name: "Edit line" })).toBeTruthy();
  });

  it("asks before deleting, then deletes", async () => {
    const deleteMemoryLine = vi.fn().mockResolvedValue({ change: memoryChange({ op: "remove" }) });
    const getMemory = vi
      .fn()
      .mockResolvedValueOnce(memory())
      .mockResolvedValue(memory({ profile: [] }));
    setup({ getMemory, deleteMemoryLine });
    fireEvent.click(await screen.findByRole("button", { name: "Delete: Lives in Hong Kong." }));
    expect(deleteMemoryLine).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete: Lives in Hong Kong." }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete: Lives in Hong Kong." }));
    await waitFor(() => expect(deleteMemoryLine).toHaveBeenCalledWith("m1"));
    await waitFor(() => expect(screen.queryByText("Lives in Hong Kong.")).toBeNull());
  });

  it("adds a line to the profile and to an agent's notes", async () => {
    const addMemoryLine = vi.fn().mockResolvedValue({ line: memoryLine(), change: memoryChange() });
    setup({ addMemoryLine });
    fireEvent.click(await screen.findByRole("button", { name: "Add a line to About you" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New line for About you" }), {
      target: { value: "  Likes tea.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(addMemoryLine).toHaveBeenCalledWith({ doc: "profile", text: "Likes tea." }));
    fireEvent.click(await screen.findByRole("button", { name: "Add a line to Dot's notes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New line for Dot's notes" }), {
      target: { value: "Be brief." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(addMemoryLine).toHaveBeenLastCalledWith({ doc: "agent", agentId: "a1", text: "Be brief." }),
    );
  });
});

describe("MemoryPage: versions", () => {
  const changes = [
    memoryChange({
      id: "c1",
      op: "add",
      before: null,
      after: "Lives in Tokyo.",
      by: "agent",
      at: 1000,
      undoable: false,
    }),
    memoryChange({
      id: "c2",
      op: "replace",
      before: "Lives in Tokyo.",
      after: "Lives in Hong Kong.",
      by: "user",
      at: 2000,
      undoable: true,
    }),
  ];

  it("lists the versions newest first, with Undo only where it is possible", async () => {
    const getMemoryChanges = vi.fn().mockResolvedValue({ changes });
    setup({ getMemoryChanges });
    fireEvent.click(await screen.findByRole("button", { name: "History: Lives in Hong Kong." }));
    const group = await screen.findByRole("group", { name: "Versions" });
    expect(getMemoryChanges).toHaveBeenCalledWith("m1");
    const items = within(group).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Edited by you");
    expect(items[0]?.querySelector("del")?.textContent).toBe("Lives in Tokyo.");
    expect(items[1]?.textContent).toContain("Added by the assistant");
    expect(within(items[0]!).getByRole("button", { name: /^Undo/ })).toBeTruthy();
    expect(within(items[1]!).queryByRole("button")).toBeNull();
  });

  it("undoes a change and reloads the line and its versions", async () => {
    const undoMemoryChange = vi.fn().mockResolvedValue({
      change: memoryChange({ id: "c2", undoneAt: 5, undoable: false }),
      line: memoryLine({ text: "Lives in Tokyo." }),
    });
    const getMemoryChanges = vi
      .fn()
      .mockResolvedValueOnce({ changes })
      .mockResolvedValue({ changes: [changes[0], { ...changes[1], undoneAt: 5, undoable: false }] });
    const getMemory = vi.fn().mockResolvedValue(memory());
    setup({ getMemoryChanges, undoMemoryChange, getMemory });
    fireEvent.click(await screen.findByRole("button", { name: "History: Lives in Hong Kong." }));
    fireEvent.click(await screen.findByRole("button", { name: /^Undo edited/ }));
    await waitFor(() => expect(undoMemoryChange).toHaveBeenCalledWith("c2"));
    expect(await screen.findByText("Undone")).toBeTruthy();
    expect(getMemory).toHaveBeenCalledTimes(2);
  });

  it("says why an undo failed", async () => {
    setup({
      getMemoryChanges: vi.fn().mockResolvedValue({ changes }),
      undoMemoryChange: vi.fn().mockRejectedValue(new ApiError(409, "not_undoable", "")),
    });
    fireEvent.click(await screen.findByRole("button", { name: "History: Lives in Hong Kong." }));
    fireEvent.click(await screen.findByRole("button", { name: /^Undo edited/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Can't undo/);
  });
});

describe("MemoryPage: the index", () => {
  it.each([
    [indexStatus(), "Ready · 1,234 entries · mlx-community/embeddinggemma-2-6bit affine-6bit-g64-bf16"],
    [indexStatus({ state: "indexing", embedded: 340 }), "Indexing 340 of 1,234"],
    [indexStatus({ state: "down", embedded: 0, lastError: null }), "Embedder down — keyword search only"],
    [indexStatus({ state: "off", model: null, embedded: 0 }), "Off — keyword search only"],
  ])("shows %#", async (index, text) => {
    setup({ getIndexStatus: vi.fn().mockResolvedValue({ index }) });
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("warns that a remote embedder gets the text; indexing shows a progress bar", async () => {
    setup({
      getIndexStatus: vi
        .fn()
        .mockResolvedValue({ index: indexStatus({ state: "indexing", embedded: 340, remote: true }) }),
    });
    expect(await screen.findByText(/receives the text of everything indexed/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("340");
  });

  it("Rebuild asks first, then starts it and shows the new state", async () => {
    const rebuildIndex = vi.fn().mockResolvedValue({
      index: indexStatus({
        state: "indexing",
        embedded: 0,
        building: { model: "mlx-community/embeddinggemma-2-6bit", embedded: 0, total: 1234 },
      }),
    });
    setup({ rebuildIndex });
    fireEvent.click(await screen.findByRole("button", { name: "Rebuild" }));
    expect(rebuildIndex).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog", { name: "Rebuild the search index?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(rebuildIndex).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("Rebuilding the index for mlx-community/embeddinggemma-2-6bit: 0 of 1,234"),
    ).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Rebuild is off when there is no embedder", async () => {
    setup({ getIndexStatus: vi.fn().mockResolvedValue({ index: indexStatus({ state: "off", model: null }) }) });
    await screen.findByText(/^Off/);
    expect((screen.getByRole("button", { name: "Rebuild" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
