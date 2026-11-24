import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import { memoryChange, memoryMessage, memorySuggestion } from "../test/fixtures.ts";
import { MemoryChipRow, MemorySuggestions } from "./MemoryCards.tsx";
import { MessageItem } from "./MessageItem.tsx";

const chips = (changes: ReturnType<typeof memoryChange>[], onUndo?: ReturnType<typeof vi.fn>) =>
  render(
    <ul>
      <MemoryChipRow
        messages={changes.map((c) => memoryMessage({ change: c }, { id: `mm-${c.id}` }))}
        onUndo={onUndo as never}
      />
    </ul>,
  );

describe("Memory updated chip", () => {
  it("says which doc it is in", () => {
    chips([memoryChange(), memoryChange({ id: "c2", doc: "agent", agentId: "a1" })]);
    expect(screen.getByText(/· your profile/)).toBeTruthy();
    expect(screen.getByText(/· the agent's notes/)).toBeTruthy();
  });

  it("says what was saved and offers Undo", () => {
    chips([memoryChange()], vi.fn());
    expect(screen.getByText("Memory updated")).toBeTruthy();
    expect(screen.getByText("Lives in Hong Kong.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo: Lives in Hong Kong." })).toBeTruthy();
  });

  it("a removal is struck through; a replacement shows old, then new", () => {
    const { container } = chips([
      memoryChange({ id: "c1", op: "remove", before: "Owns a cat.", after: null }),
      memoryChange({ id: "c2", op: "replace", before: "Lives in Tokyo.", after: "Lives in Osaka." }),
    ]);
    const rows = container.querySelectorAll(".memory-chip");
    expect(rows[0]?.querySelector("del")?.textContent).toBe("Owns a cat.");
    expect(rows[0]?.querySelector("ins")).toBeNull();
    expect(rows[1]?.querySelector("del")?.textContent).toBe("Lives in Tokyo.");
    expect(rows[1]?.querySelector("ins")?.textContent).toBe("Lives in Osaka.");
  });

  it("consecutive chips share one row", () => {
    const { container } = chips([memoryChange({ id: "c1" }), memoryChange({ id: "c2", after: "Likes tea." })]);
    expect(container.querySelectorAll(".msg-memory")).toHaveLength(1);
    expect(container.querySelectorAll(".memory-chip")).toHaveLength(2);
  });

  it("Undo calls back, then the chip reads Undone with no button", async () => {
    const onUndo = vi.fn().mockResolvedValue(memoryChange({ undoneAt: 5, undoable: false }));
    chips([memoryChange()], onUndo);
    fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
    await waitFor(() => expect(onUndo).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText("Undone")).toBeTruthy();
    expect(screen.queryByText("Memory updated")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("an undone change from the server reads Undone; one a later change touched has no Undo", () => {
    chips(
      [memoryChange({ id: "c1", undoneAt: 9, undoable: false }), memoryChange({ id: "c2", undoable: false })],
      vi.fn(),
    );
    expect(screen.getByText("Undone")).toBeTruthy();
    expect(screen.getByText("Memory updated")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("explains when Undo fails and keeps the button", async () => {
    chips([memoryChange()], vi.fn().mockRejectedValue(new ApiError(409, "not_undoable", "")));
    fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Can't undo/);
    expect(screen.getByRole("button", { name: /^Undo/ })).toBeTruthy();
  });

  it("renders the text as plain text", () => {
    const { container } = chips([memoryChange({ after: "<img src=x onerror=alert(1)>" })]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".memory-chip-text")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("a MessageItem for a change renders the chip, and for a silent confirmation nothing", () => {
    const { container } = render(
      <ul>
        <MessageItem message={memoryMessage({ change: memoryChange() })} memory={{ onUndo: vi.fn() }} />
        <MessageItem message={memoryMessage({ change: memoryChange({ op: "confirm" }) }, { id: "mm2" })} />
      </ul>,
    );
    expect(container.querySelectorAll(".memory-chip")).toHaveLength(1);
  });
});

describe("suggestions under a report", () => {
  const list = (items: ReturnType<typeof memorySuggestion>[]) =>
    render(<MemorySuggestions suggestions={items} agentName={(id) => (id === "a1" ? "Dot" : undefined)} />);

  it("says how many, and lists them behind an expander with no buttons to decide", () => {
    const { container } = list([
      memorySuggestion(),
      memorySuggestion({
        id: "sg2",
        doc: "agent",
        agentId: "a1",
        op: "replace",
        lineId: "m4",
        current: "Be formal.",
        text: "Be casual.",
      }),
    ]);
    expect(screen.getByText("Suggested 2 memory edits")).toBeTruthy();
    expect(screen.queryByText("Prefers metric units.")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("Prefers metric units.")).toBeTruthy();
    expect(screen.getByText("your profile")).toBeTruthy();
    expect(screen.getByText("Dot's notes")).toBeTruthy();
    expect(screen.getByText("Add")).toBeTruthy();
    expect(screen.getByText("Change")).toBeTruthy();
    expect(container.querySelector("del")?.textContent).toBe("Be formal.");
    expect(container.querySelector("ins")?.textContent).toBe("Be casual.");
    expect(screen.getAllByRole("button")).toHaveLength(1); // only the expander
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("Prefers metric units.")).toBeNull();
  });

  it("one edit reads in the singular; a removal is struck through; nothing renders for none", () => {
    const { container, unmount } = list([
      memorySuggestion({ op: "remove", lineId: "m1", current: "Owns a cat.", text: null }),
    ]);
    expect(screen.getByText("Suggested 1 memory edit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(container.querySelector("del")?.textContent).toBe("Owns a cat.");
    unmount();
    const empty = list([]);
    expect(empty.container.textContent).toBe("");
  });

  it("shows under a report card, not under other messages", () => {
    const report = memoryMessage({ change: memoryChange() });
    const { container } = render(
      <ul>
        <MessageItem
          message={{
            ...report,
            runId: null,
            role: "report",
            memory: undefined,
            report: {
              sessionId: "s2",
              title: "Hotel search",
              outcome: "completed",
              summary: "Found three.",
              memorySuggestions: [memorySuggestion()],
            },
          }}
        />
      </ul>,
    );
    expect(container.querySelector(".report .report-memory")).toBeTruthy();
    expect(screen.getByText("Suggested 1 memory edit")).toBeTruthy();
  });

  it("is rendered under a run-owned report card too", () => {
    const { container } = render(
      <ul>
        <MessageItem
          full={{ onInspect: vi.fn(), onFork: vi.fn() }}
          message={memoryMessage(
            { change: memoryChange() },
            {
              role: "report",
              memory: undefined,
              report: {
                sessionId: "s2",
                title: "Hotel search",
                outcome: "completed",
                summary: "Found three.",
                memorySuggestions: [memorySuggestion()],
              },
            },
          )}
        />
      </ul>,
    );
    expect(container.querySelector(".report-memory")).toBeTruthy();
    expect(container.querySelector(".msg-report .card-link")?.getAttribute("href")).toBe("/s/s2");
  });
});
