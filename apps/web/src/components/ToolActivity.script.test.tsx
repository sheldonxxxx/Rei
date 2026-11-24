import type { LiveTool, Message } from "@rei/protocol";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { approval, message, run, runTrace, step, toolStep } from "../test/fixtures.ts";
import { type ScriptCards, ToolActivity } from "./ToolActivity.tsx";

const script = (over = {}) =>
  toolStep({
    id: "sc",
    toolName: "codemode",
    toolCallId: "call-1",
    status: "running",
    activity: "Check the invoices",
    summary: "const rows = await tools.list()",
    actionClass: "read_internal",
    ...over,
  });
const nested = (n: number, over = {}) =>
  toolStep({
    id: `n${n}`,
    toolName: "list_sessions",
    toolCallId: `call-1/c${n}`,
    parentStepId: "sc",
    summary: `List sessions ${n}`,
    ...over,
  });
const working = (steps: ReturnType<typeof step>[]) =>
  runTrace({ run: run({ status: "running", endedAt: null }), steps: [step(), ...steps] });

function cardList(messages: Message[]): ScriptCards {
  return {
    byScript: new Map([["call-1", messages]]),
    render: (m) => <li key={m.id}>{`card ${m.approval?.id}`}</li>,
  };
}

describe("ToolActivity: a script", () => {
  it("is one row in Simple mode: the calls are hidden and the label carries the count", () => {
    render(<ToolActivity trace={working([script(), nested(1), nested(2)])} />);
    expect(screen.getByLabelText("Check the invoices · 2 calls — Running")).toBeTruthy();
    expect(screen.queryByText("List sessions 1")).toBeNull();
    expect(screen.queryByRole("list", { name: "Calls made by the script" })).toBeNull();
    expect(screen.queryByRole("button", { name: /script's calls/ })).toBeNull();
  });

  it("falls back to 'Ran a script', not the first line of code, and says '1 call'", () => {
    render(
      <ToolActivity
        trace={runTrace({ steps: [step(), script({ activity: undefined, status: "ok" }), nested(1)] })}
        onOpen={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Worked/ }));
    expect(screen.getByRole("button", { name: "Inspect step: Ran a script · 1 call — Completed" })).toBeTruthy();
    expect(screen.queryByText(/const rows/)).toBeNull();
  });

  it("counts the script as one of the latest five rows in Simple mode", () => {
    const others = Array.from({ length: 6 }, (_, i) => toolStep({ id: `t${i}`, summary: `Other ${i}` }));
    const calls = Array.from({ length: 6 }, (_, i) => nested(i + 1));
    render(<ToolActivity trace={working([...others, script(), ...calls])} />);
    const rows = screen.getByRole("list", { name: "Tool activity" });
    expect(within(rows).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByLabelText("Check the invoices · 6 calls — Running")).toBeTruthy();
    expect(rows.textContent).not.toContain("Other 1");
    expect(rows.textContent).toContain("Other 2");
  });

  it("shows its calls indented under it in Full mode, in the order made, and folds them on request", () => {
    const onOpen = vi.fn();
    render(<ToolActivity trace={working([script(), nested(1), nested(2)])} onOpen={onOpen} />);
    const list = screen.getByRole("list", { name: "Calls made by the script" });
    expect(
      within(list)
        .getAllByRole("button", { name: /^Inspect step:/ })
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining("List sessions 1"), expect.stringContaining("List sessions 2")]);
    fireEvent.click(within(list).getByRole("button", { name: /List sessions 2/ }));
    expect(onOpen).toHaveBeenCalledWith("r1", "n2");
    fireEvent.click(screen.getByRole("button", { name: "Inspect step: Check the invoices · 2 calls — Running" }));
    expect(onOpen).toHaveBeenLastCalledWith("r1", "sc");
    const toggle = screen.getByRole("button", { name: "Hide the script's calls" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: "Calls made by the script" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show the script's calls" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps its calls open when it finishes, so nothing moves under the pointer", () => {
    const { rerender } = render(<ToolActivity trace={working([script(), nested(1)])} onOpen={vi.fn()} />);
    expect(screen.getByRole("list", { name: "Calls made by the script" })).toBeTruthy();
    rerender(
      <ToolActivity
        trace={working([script({ status: "ok" }), nested(1, { status: "ok" }), nested(2)])}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole("list", { name: "Calls made by the script" })).toBeTruthy();
  });

  it("starts folded for a script that was already done when the chat opened", () => {
    render(
      <ToolActivity trace={runTrace({ steps: [step(), script({ status: "ok" }), nested(1)] })} onOpen={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Worked/ }));
    expect(screen.queryByRole("list", { name: "Calls made by the script" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the script's calls" }));
    expect(screen.getByText("List sessions 1")).toBeTruthy();
  });

  describe("waiting", () => {
    it("reads 'Waiting' while another call of it is parked, and says so in the heading", () => {
      const trace = working([script(), nested(1), nested(2, { status: "running" })]);
      render(<ToolActivity trace={trace} parked={new Set(["call-1/c2"])} onOpen={vi.fn()} />);
      expect(
        screen.getByRole("button", { name: /^Inspect step: Check the invoices · 2 calls — Waiting$/ }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Inspect step: List sessions 2 — Waiting" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Waiting…" })).toBeTruthy();
    });

    it("reads 'Waiting for approval' while a call asked for one", () => {
      const ask = nested(1, { status: "running", decision: "ask", approvalId: "ap9" });
      render(
        <ToolActivity
          trace={working([script(), ask])}
          waitingForApproval
          parked={new Set(["call-1/c1"])}
          outcomes={new Map([["ap9", "pending"]])}
          onOpen={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: /Check the invoices · 1 call — Waiting for approval$/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Waiting for approval" })).toBeTruthy();
    });

    it("reads 'Waiting for approval' in Simple mode from a card that is waiting, before its call is recorded", () => {
      const pending = message({
        id: "m1",
        role: "approval",
        approval: approval({ id: "ap1", parentCallId: "call-1" }),
      });
      render(<ToolActivity trace={working([script()])} cards={cardList([pending])} />);
      expect(screen.getByLabelText("Check the invoices — Waiting for approval")).toBeTruthy();
    });
  });

  describe("live calls", () => {
    const live: LiveTool[] = [
      { callId: "call-1/c1", name: "list_sessions", status: "running", nested: true, parentCallId: "call-1" },
      { callId: "call-1/c2", name: "bash", status: "sleeping", nested: true, parentCallId: "call-1" },
    ];

    it("shows a call the trace has not recorded yet under its script, without a way to open it", () => {
      render(
        <ToolActivity trace={working([script()])} liveCalls={live} parked={new Set(["call-1/c2"])} onOpen={vi.fn()} />,
      );
      const list = screen.getByRole("list", { name: "Calls made by the script" });
      expect(within(list).getByLabelText("list sessions — Running")).toBeTruthy();
      expect((within(list).getByLabelText("bash — Waiting") as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole("button", { name: /Check the invoices · 2 calls — Waiting$/ })).toBeTruthy();
    });

    it("hands a live row over to its recorded step in place: same row, no flicker", () => {
      const { rerender } = render(<ToolActivity trace={working([script()])} liveCalls={live} onOpen={vi.fn()} />);
      const before = screen.getByLabelText("list sessions — Running");
      rerender(
        <ToolActivity
          trace={working([script(), nested(1, { status: "running" })])}
          liveCalls={live}
          onOpen={vi.fn()}
        />,
      );
      const after = screen.getByRole("button", { name: "Inspect step: List sessions 1 — Running" });
      // The same element, relabelled and now openable.
      expect(after).toBe(before);
      expect(screen.queryByLabelText("list sessions — Running")).toBeNull();
      expect(screen.getAllByRole("button", { name: /^Inspect step: List sessions 1/ })).toHaveLength(1);
    });

    it("draws no row for a live call whose script is not in the trace", () => {
      render(<ToolActivity trace={working([toolStep()])} liveCalls={live} onOpen={vi.fn()} />);
      expect(screen.queryByLabelText(/list sessions/)).toBeNull();
    });
  });

  describe("approval cards", () => {
    const pending = message({ id: "m1", role: "approval", approval: approval({ id: "ap1", parentCallId: "call-1" }) });

    it("sit under the script's row, in both modes, even when its calls are folded", () => {
      const { rerender } = render(
        <ToolActivity trace={working([script(), nested(1)])} cards={cardList([pending])} onOpen={vi.fn()} />,
      );
      const row = screen.getByText("card ap1").closest("li[data-enter]");
      expect(row?.textContent).toContain("Check the invoices");
      fireEvent.click(screen.getByRole("button", { name: "Hide the script's calls" }));
      expect(screen.getByText("card ap1")).toBeTruthy();
      rerender(<ToolActivity trace={working([script(), nested(1)])} cards={cardList([pending])} />);
      expect(screen.getByText("card ap1").closest("li[aria-label]")?.getAttribute("aria-label")).toContain(
        "Check the invoices",
      );
    });

    it("stay visible under the summary when the activity is folded", () => {
      render(
        <ToolActivity trace={runTrace({ steps: [step(), script({ status: "ok" })] })} cards={cardList([pending])} />,
      );
      expect(screen.getByRole("button", { name: /^Worked/ }).getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByRole("list", { name: "Asked by a script" }).textContent).toBe("card ap1");
    });
  });
});
