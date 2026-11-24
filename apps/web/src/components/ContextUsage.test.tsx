import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ContextUsage } from "./ContextUsage.tsx";

const report = {
  model: "test-model",
  maxTokens: 10000,
  inputTokens: 7000,
  cachedTokens: 4000,
  outputTokens: 1000,
  updatedAt: 1,
};

describe("ContextUsage", () => {
  it("shows a snapshot without double counting cached input and opens a dismissible breakdown", async () => {
    const api = { getContextUsage: vi.fn().mockResolvedValue(report) } as unknown as Api;
    render(<ContextUsage api={api} sessionId="chat" running={false} />);
    const button = await screen.findByRole("button", { name: "Context usage: 8K / 10K · 80% used" });
    fireEvent.click(button);
    expect(await screen.findByLabelText("Context usage breakdown")).toBeTruthy();
    expect(screen.getByText("4K")).toBeTruthy();
    expect(screen.getByText("2K")).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("Context usage breakdown")).toBeNull());
  });

  it("refreshes after a run and clears stale counts when the request fails", async () => {
    const getContextUsage = vi.fn().mockResolvedValue(report);
    const api = { getContextUsage } as unknown as Api;
    const view = render(<ContextUsage api={api} sessionId="chat" revision="1" running={false} />);
    await screen.findByRole("button", { name: /8K/ });
    getContextUsage.mockRejectedValue(new Error("offline"));
    view.rerender(<ContextUsage api={api} sessionId="chat" revision="2" running={false} />);
    const button = await screen.findByRole("button", { name: "Context usage: Unavailable / Unavailable" });
    fireEvent.click(button);
    expect(await screen.findByText("Could not load context usage.")).toBeTruthy();
  });
  it("compacts million-token limits", async () => {
    const api = {
      getContextUsage: vi.fn().mockResolvedValue({ ...report, outputTokens: 1500, maxTokens: 2000000 }),
    } as unknown as Api;
    render(<ContextUsage api={api} sessionId="chat" running={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /8.5K \/ 2M/ }));
    expect(screen.getByText("Max context").parentElement?.textContent).toContain("2M");
    expect(screen.getByText("1.5K")).toBeTruthy();
  });

  it("shows source estimates and expands named skill and MCP entries separately from provider totals", async () => {
    const api = {
      getContextUsage: vi.fn().mockResolvedValue({
        ...report,
        breakdown: {
          method: "o200k_base",
          estimatedTokens: 120,
          hasOpaqueContent: true,
          categories: [
            {
              id: "skills",
              label: "Skills",
              estimatedTokens: 80,
              details: [{ label: "use_skill: research", estimatedTokens: 80 }],
            },
            {
              id: "mcp_calls",
              label: "MCP calls",
              estimatedTokens: 40,
              details: [{ label: "calendar.events", estimatedTokens: 40 }],
            },
          ],
        },
      }),
    } as unknown as Api;
    render(<ContextUsage api={api} sessionId="chat" running={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /8K/ }));
    expect(screen.getByText("Estimated input breakdown")).toBeTruthy();
    expect(screen.queryByText(/model’s counts and formatting may differ/)).toBeNull();
    expect(screen.queryByText(/Based on the latest completed model call/)).toBeNull();
    const bar = screen.getByRole("group", { name: /Estimated input distribution: Skills 66.7%, MCP calls 33.3%/ });
    expect(bar.querySelectorAll('[role="img"]')).toHaveLength(2);
    const segment = screen.getByRole("img", { name: "Skills: ~80 · 66.7%" });
    fireEvent.focus(segment);
    expect(
      (await screen.findAllByRole("tooltip")).some((tip) => tip.textContent?.includes("Skills: ~80 · 66.7%")),
    ).toBe(true);
    const skill = screen.getByText("Skills").closest("details")!;
    fireEvent.click(skill.querySelector("summary")!);
    expect(skill.textContent).toContain("use_skill: research");
    expect(screen.getByText("calendar.events")).toBeTruthy();
    expect(screen.getByText("~120")).toBeTruthy();
  });
});
