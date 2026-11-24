import type { Agent, Session } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { historyHit, indexStatus } from "../test/fixtures.ts";
import { HistorySearchDialog } from "./HistorySearch.tsx";

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

function setup(
  api: Record<string, unknown> = {},
  people: Agent[] = agents,
  sessions: Session[] = [],
  onClose = vi.fn(),
) {
  const view = render(
    <HistorySearchDialog api={api as unknown as Api} agents={people} sessions={sessions} onClose={onClose} />,
  );
  return { api, view, onClose };
}

const robin: Agent = {
  id: "a2",
  name: "Robin",
  avatar: "R",
  model: null,
  thinkingLevel: "off",
  networkMode: "block",
  defaultProfile: "standard",
  homeSessionId: "h2",
};

describe("HistorySearchDialog", () => {
  const openFilters = () => fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  const type = (q: string) =>
    fireEvent.change(screen.getByRole("searchbox", { name: "Search your history" }), { target: { value: q } });

  it("labels possible leads and explains when no strong match was found", async () => {
    setup({
      searchHistory: vi.fn().mockResolvedValue({ hits: [historyHit({ relevance: "related" })], index: indexStatus() }),
    });
    type("hotel");
    fireEvent.submit(screen.getByRole("search"));
    expect(await screen.findByText("Possible lead")).toBeTruthy();
    expect(screen.getByText("Possible matches")).toBeTruthy();
  });

  it("labels only uncertain rows in a mixed result list", async () => {
    setup({
      searchHistory: vi.fn().mockResolvedValue({
        hits: [historyHit({ relevance: "match" }), historyHit({ chunkId: "h2", relevance: "related" })],
        index: indexStatus(),
      }),
    });
    type("hotel");
    fireEvent.submit(screen.getByRole("search"));
    const list = await screen.findByRole("list", { name: "Search results" });
    expect(within(list).getAllByText("Possible lead")).toHaveLength(1);
    expect(screen.queryByText(/No strong matches\./)).toBeNull();
  });

  it("searches, marks the words, shows chat, role and date, and links to the message", async () => {
    const searchHistory = vi.fn().mockResolvedValue({
      hits: [
        historyHit(),
        historyHit({
          chunkId: "e2",
          messageId: "m10",
          kind: "tool",
          toolName: "web_fetch",
          keywordRank: null,
          vectorRank: 3,
          cosine: 0.52,
          snippet: "Hotel prices",
        }),
      ],
      index: indexStatus(),
    });
    setup({ searchHistory });
    type("hotel");
    fireEvent.submit(screen.getByRole("search"));
    const list = await screen.findByRole("list", { name: "Search results" });
    expect(searchHistory).toHaveBeenCalledWith({ q: "hotel", from: undefined, to: undefined });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector("mark")?.textContent).toBe("hotel");
    expect(within(rows[0]!).getByText("Tokyo trip")).toBeTruthy();
    expect(within(rows[0]!).getByText("You")).toBeTruthy();
    expect(within(rows[0]!).getByRole("link").getAttribute("href")).toBe("/s/s1?m=m9");
    expect(within(rows[0]!).getByText("keyword #2 · meaning #1, 0.71")).toBeTruthy();
    expect(within(rows[1]!).getByText("Tool: web_fetch")).toBeTruthy();
    expect(within(rows[1]!).getByText("meaning #3, 0.52")).toBeTruthy();
  });

  it("with one agent there is no picker and results don't name the agent", async () => {
    setup({ searchHistory: vi.fn().mockResolvedValue({ hits: [historyHit()], index: indexStatus() }) });
    openFilters();
    expect(screen.queryByRole("radiogroup", { name: "Search in" })).toBeNull();
    type("hotel");
    fireEvent.submit(screen.getByRole("search"));
    const list = await screen.findByRole("list", { name: "Search results" });
    expect(list.querySelector(".hit-agent")).toBeNull();
  });

  it("with several agents: All agents by default, then each one; picking one searches only its chats", async () => {
    const searchHistory = vi.fn().mockResolvedValue({ hits: [], index: indexStatus() });
    setup({ searchHistory }, [agents[0]!, robin]);
    openFilters();
    const group = screen.getByRole("radiogroup", { name: "Search in" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.querySelector("span:last-child")?.textContent)).toEqual(["All agents", "Dot", "Robin"]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    type("hotel");
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(searchHistory).toHaveBeenCalledTimes(1));
    expect(searchHistory.mock.calls[0]![0]).not.toHaveProperty("agent");
    fireEvent.click(within(group).getByRole("radio", { name: "Robin" }));
    expect(within(group).getByRole("radio", { name: "Robin" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(searchHistory).toHaveBeenCalledTimes(2));
    expect(searchHistory.mock.calls[1]![0]).toMatchObject({ q: "hotel", agent: "a2" });
    fireEvent.click(within(group).getByRole("radio", { name: "All agents" }));
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(searchHistory).toHaveBeenCalledTimes(3));
    expect(searchHistory.mock.calls[2]![0]).not.toHaveProperty("agent");
  });

  it("with several agents each result shows whose chat it is from", async () => {
    const searchHistory = vi.fn().mockResolvedValue({
      hits: [historyHit(), historyHit({ chunkId: "e2", agentId: "a2", sessionId: "s2", messageId: "m10" })],
      index: indexStatus(),
    });
    setup({ searchHistory }, [agents[0]!, robin]);
    type("hotel");
    fireEvent.submit(screen.getByRole("search"));
    const rows = within(await screen.findByRole("list", { name: "Search results" })).getAllByRole("listitem");
    expect(rows[0]?.querySelector(".hit-agent > span:last-child")?.textContent).toBe("Dot");
    expect(rows[1]?.querySelector(".hit-agent > span:last-child")?.textContent).toBe("Robin");
    expect(rows[1]?.querySelector(".hit-agent .avatar")).toBeTruthy();
  });

  it("explains an unknown agent", async () => {
    setup({ searchHistory: vi.fn().mockRejectedValue(new ApiError(400, "unknown_agent", "")) }, [agents[0]!, robin]);
    type("hotel");
    fireEvent.submit(screen.getByRole("search"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/agent/i);
  });

  it("passes the date range as the start and end of the days", async () => {
    const searchHistory = vi.fn().mockResolvedValue({ hits: [], index: indexStatus() });
    setup({ searchHistory });
    type("tokyo");
    openFilters();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-03-31" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() =>
      expect(searchHistory).toHaveBeenCalledWith({
        q: "tokyo",
        from: new Date(2026, 2, 1, 0, 0, 0, 0).getTime(),
        to: new Date(2026, 2, 31, 23, 59, 59, 999).getTime(),
      }),
    );
    expect(await screen.findByText("No sufficiently relevant matches in your history.")).toBeTruthy();
  });

  it("reports a failure", async () => {
    setup({ searchHistory: vi.fn().mockRejectedValue(new ApiError(400, "bad_query", "")) });
    type("x");
    fireEvent.submit(screen.getByRole("search"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/word or phrase/);
  });

  it("searches as you type, and says nothing is wrong with an empty box", async () => {
    vi.useFakeTimers();
    try {
      const searchHistory = vi.fn().mockResolvedValue({ hits: [], index: indexStatus() });
      setup({ searchHistory });
      type("tok");
      expect(searchHistory).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      expect(searchHistory).toHaveBeenCalledWith({ q: "tok", from: undefined, to: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists recent chats until you type, and closes with Escape or the X", () => {
    const sessions = [{ id: "s1", title: "Tokyo trip" }] as Session[];
    const { onClose } = setup({ searchHistory: vi.fn() }, agents, sessions);
    const list = within(screen.getByRole("region", { name: "Recent chats" }));
    expect(list.getByRole("link", { name: "Tokyo trip" }).getAttribute("href")).toBe("/s/s1");
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
