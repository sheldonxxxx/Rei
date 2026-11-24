import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { run, runTrace, step, toolStep } from "../test/fixtures.ts";
import { ToolActivity } from "./ToolActivity.tsx";

describe("ToolActivity", () => {
  it("draws no row for a shown surface; a refused one stays as a quiet row that does not open the list", () => {
    const shown = toolStep({ id: "s1", toolName: "show_surface", activity: "Show surface" });
    const { rerender } = render(<ToolActivity trace={runTrace({ steps: [step(), shown] })} />);
    expect(screen.queryByRole("button", { name: /Worked/ })).toBeNull();
    const refused = toolStep({ id: "s0", toolName: "show_surface", status: "error" });
    rerender(<ToolActivity trace={runTrace({ steps: [step(), refused, shown] })} />);
    const summary = screen.getByRole("button", { name: "Worked for 4.0 s" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(screen.getByLabelText("A surface was refused and sent back to fix — Failed")).toBeTruthy();
    expect(screen.queryByLabelText(/Show surface/)).toBeNull();
  });

  it.each([false, true])("opens past runs collapsed with only the summary (detail mode: %s)", (detail) => {
    const trace = runTrace({
      steps: [
        toolStep({ id: "failed", status: "error", activity: "Read the settings" }),
        toolStep({ id: "blocked", status: "blocked", decision: "ask", activity: "Save the report" }),
        toolStep({ id: "skipped", status: "not_executed", activity: "Run the checks" }),
      ],
    });
    const { unmount, container } = render(<ToolActivity trace={trace} onOpen={detail ? vi.fn() : undefined} />);
    const summary = screen.getByRole("button", { name: "Worked for 4.0 s" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toBe("Worked for 4.0 s");
    expect(screen.queryByRole("list", { name: "Tool activity" })).toBeNull();
    fireEvent.click(summary);
    expect(screen.getByRole("list", { name: "Tool activity" })).toBeTruthy();
    unmount();
    render(<ToolActivity trace={trace} onOpen={detail ? vi.fn() : undefined} />);
    expect(screen.getByRole("button", { name: "Worked for 4.0 s" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("preserves the activity description and expanded state when switching between Simple and Full modes", () => {
    const trace = runTrace({ steps: [step(), toolStep({ activity: "Compare hotel prices" })] });
    const onOpen = vi.fn();
    const { rerender } = render(<ToolActivity trace={trace} />);
    fireEvent.click(screen.getByRole("button", { name: "Worked for 4.0 s" }));
    expect(screen.getByLabelText("Compare hotel prices — Completed")).toBeTruthy();
    rerender(<ToolActivity trace={trace} onOpen={onOpen} />);
    expect(screen.getByRole("button", { name: "Worked for 4.0 s" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Compare hotel prices")).toBeTruthy();
    expect(screen.getByText(/web_search · read_external/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Inspect step: Compare hotel prices — Completed" }));
    expect(onOpen).toHaveBeenCalledWith("r1", "st2");
    fireEvent.click(screen.getByRole("button", { name: "Worked for 4.0 s" }));
    rerender(<ToolActivity trace={trace} />);
    expect(screen.getByRole("button", { name: "Worked for 4.0 s" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Compare hotel prices")).toBeNull();
  });

  it("shows model labels while working and folds them when the run completes", () => {
    const steps = [step(), toolStep({ activity: "Compare hotel prices", status: "running" })];
    const { rerender } = render(<ToolActivity trace={runTrace({ run: run(), steps })} />);
    expect(screen.getByRole("button", { name: "Working…" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Compare hotel prices — Running")).toBeTruthy();
    expect(screen.queryByText(/tokens|gpt/)).toBeNull();
    rerender(<ToolActivity trace={runTrace({ steps: [step(), toolStep({ activity: "Compare hotel prices" })] })} />);
    const summary = screen.getByRole("button", { name: "Worked for 4.0 s" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Compare hotel prices")).toBeNull();
    fireEvent.click(summary);
    expect(screen.getByLabelText("Compare hotel prices — Completed")).toBeTruthy();
  });

  it("uses static fallbacks and keeps failed, blocked and stopped calls readable", () => {
    render(
      <ToolActivity
        trace={runTrace({
          steps: [
            toolStep({ id: "s1", status: "error", activity: "Read the settings" }),
            toolStep({ id: "s2", status: "blocked", decision: "ask", activity: "Save the report" }),
            toolStep({ id: "s3", status: "cancelled", summary: "Run the checks" }),
            toolStep({ id: "s4", summary: "", toolName: "search_capabilities" }),
          ],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Worked for 4.0 s" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Worked for 4.0 s" }));
    expect(screen.getByLabelText("Read the settings — Failed")).toBeTruthy();
    expect(screen.getByLabelText("Save the report — Needs approval")).toBeTruthy();
    expect(screen.getByLabelText("Run the checks — Stopped")).toBeTruthy();
    expect(screen.getByLabelText("search capabilities — Completed")).toBeTruthy();
  });

  it("shows the original call waiting for approval, then running after approval", () => {
    const trace = runTrace({
      run: run(),
      steps: [toolStep({ activity: "Read receipts", status: "running", approvalId: "ap1", decision: "ask" })],
    });
    const { rerender } = render(
      <ToolActivity trace={trace} waitingForApproval outcomes={new Map([["ap1", "pending"]])} />,
    );
    expect(screen.getByRole("button", { name: "Waiting for approval" })).toBeTruthy();
    expect(screen.getByLabelText("Read receipts — Waiting for approval")).toBeTruthy();
    rerender(<ToolActivity trace={trace} outcomes={new Map([["ap1", "approved"]])} />);
    expect(screen.getByLabelText("Read receipts — Running")).toBeTruthy();
  });

  it("shows a parked call as waiting, not running", () => {
    const parked = toolStep({ activity: "Read receipts", status: "running", toolCallId: "call-1" });
    const working = toolStep({ id: "s2", activity: "Sort receipts", status: "running", toolCallId: "call-2" });
    const trace = runTrace({ run: run(), steps: [parked, working] });
    const { rerender } = render(<ToolActivity trace={trace} parked={new Set(["call-1"])} />);
    expect(screen.getByLabelText("Read receipts — Waiting")).toBeTruthy();
    expect(screen.getByLabelText("Sort receipts — Running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Waiting…" })).toBeTruthy();
    rerender(
      <ToolActivity
        trace={runTrace({ run: run(), steps: [{ ...parked, decision: "ask" }] })}
        parked={new Set(["call-1"])}
      />,
    );
    expect(screen.getByLabelText("Read receipts — Waiting for approval")).toBeTruthy();
    rerender(<ToolActivity trace={trace} parked={new Set()} />);
    expect(screen.getByLabelText("Read receipts — Running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Working…" })).toBeTruthy();
  });

  it("shows approval wait separately from active work", () => {
    render(
      <ToolActivity
        trace={runTrace({
          steps: [toolStep()],
          totals: { modelCalls: 1, toolCalls: 1, tokens: 10, durationMs: 49_000, approvalWaitMs: 45_000 },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Worked for 4.0 s" })).toBeTruthy();
    expect(screen.getByText("Waited for approval 45 s")).toBeTruthy();
  });

  it("renders labels as plain text and hides runs with no tool calls", () => {
    const { rerender } = render(
      <ToolActivity
        trace={runTrace({
          steps: [toolStep({ activity: "<script>alert(1)</script>", status: "running" })],
          run: run(),
        })}
      />,
    );
    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    rerender(<ToolActivity trace={runTrace({ steps: [step()] })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("words a failed run as failing after a time, and a continued one as interrupted", () => {
    const failed = {
      run: run({ status: "failed", endedAt: 155_000 }),
      totals: { modelCalls: 0, toolCalls: 1, tokens: 0, durationMs: 154_000 },
    };
    const { rerender } = render(<ToolActivity trace={runTrace(failed)} />);
    expect(screen.getByRole("button", { name: "Failed after 2 min 34 s" })).toBeTruthy();
    rerender(<ToolActivity trace={runTrace({ ...failed, continued: true })} />);
    expect(screen.getByRole("button", { name: "Interrupted after 2 min 34 s" })).toBeTruthy();
    rerender(<ToolActivity trace={runTrace({ run: run({ status: "cancelled", endedAt: 5000 }) })} />);
    expect(screen.getByRole("button", { name: "Stopped after 4.0 s" })).toBeTruthy();
  });
});
