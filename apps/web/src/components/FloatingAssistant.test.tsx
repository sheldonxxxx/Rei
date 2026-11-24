import type { Agent, Message } from "@rei/protocol";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approval, message, session, sessionBrowser, takeover } from "../test/fixtures.ts";
import { FloatingAssistant } from "./FloatingAssistant.tsx";

const agent: Agent = {
  id: "a1",
  name: "Dot",
  avatar: "bot:cat",
  model: null,
  thinkingLevel: "off",
  networkMode: "block",
  defaultProfile: "standard",
  homeSessionId: "h1",
};
const reply = (over: Partial<Message> = {}) =>
  message({ id: "a1", status: "complete", text: "I found three flights.", ...over });
const approvalMsg = (id = "ap1") =>
  message({ id: `m-${id}`, role: "approval", status: "complete", approval: approval({ id }) });
const takeoverMsg = (id = "t1") =>
  message({ id: `m-${id}`, role: "takeover", status: "complete", takeover: takeover({ id }) });

type Props = Partial<React.ComponentProps<typeof FloatingAssistant>>;
const handlers = () => ({
  onSend: vi.fn(),
  onStop: vi.fn(),
  onDecide: vi.fn().mockResolvedValue(approval({ status: "approved" })),
  onEndTakeover: vi.fn().mockResolvedValue(takeover({ status: "cancelled" })),
  onTakeOver: vi.fn(),
  onChangeLook: vi.fn(),
});

function ui(props: Props = {}) {
  return (
    <FloatingAssistant
      agent={agent}
      session={session({ browser: sessionBrowser({ url: "https://example.com/a" }) })}
      messages={[reply()]}
      running={false}
      stopping={false}
      {...handlers()}
      {...props}
    />
  );
}
const setup = (props: Props = {}) => {
  const h = handlers();
  const view = render(ui({ ...h, ...props }));
  return { ...h, view, again: (next: Props = {}) => view.rerender(ui({ ...h, ...props, ...next })) };
};

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("FloatingAssistant: the card", () => {
  it("shows the agent, the latest reply and an idle status", () => {
    setup({
      messages: [
        reply({ id: "old", text: "Older answer" }),
        message({ id: "u2", role: "user", status: "complete", text: "more?" }),
        reply({ id: "new", text: "Newest answer" }),
      ],
    });
    const card = screen.getByRole("complementary", { name: "Dot, the assistant" });
    expect(within(card).getByText("Dot")).toBeTruthy();
    expect(within(card).getByText("Idle")).toBeTruthy();
    expect(within(card).getByText("Newest answer")).toBeTruthy();
    expect(within(card).queryByText("Older answer")).toBeNull();
    expect(card.querySelector("svg.bot")?.getAttribute("data-bot")).toBe("cat");
  });

  it("says Working… with the page it is on while a run goes, and the reply streams in", () => {
    const { again } = setup({ running: true, messages: [reply({ status: "streaming", text: "Looking" })] });
    expect(screen.getByText("Working…")).toBeTruthy();
    expect(screen.getByText("on example.com")).toBeTruthy();
    expect(document.querySelector(".md.streaming")).not.toBeNull();
    expect(document.querySelector("svg.bot")?.getAttribute("data-working")).toBe("true");
    again({ running: true, messages: [reply({ status: "streaming", text: "Looking at flights" })] });
    expect(screen.getByText("Looking at flights")).toBeTruthy();
  });

  it("says Needs you, and lets you approve and take over from the card", async () => {
    const h = handlers();
    render(ui({ ...h, messages: [reply(), approvalMsg(), takeoverMsg()] }));
    expect(screen.getByText("Needs you")).toBeTruthy();
    const card = screen.getByRole("complementary", { name: "Dot, the assistant" });
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await act(async () => {});
    expect(h.onDecide).toHaveBeenCalledWith("ap1", { decision: "approve", length: "once" });
    fireEvent.click(within(card).getByRole("button", { name: "Take over" }));
    expect(h.onTakeOver).toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Not now" }));
    await act(async () => {});
    expect(h.onEndTakeover).toHaveBeenCalledWith("t1", { action: "cancel" });
  });

  it("does not list an approval that was already decided", () => {
    setup({
      messages: [
        reply(),
        message({ id: "mx", role: "approval", status: "complete", approval: approval({ status: "approved" }) }),
      ],
    });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Idle")).toBeTruthy();
  });

  it("shows Stop only while running, and has no Show chat or options button", () => {
    const { onStop, again } = setup();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    again({ running: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Show chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assistant options" })).toBeNull();
  });

  it("expands to the whole conversation, scrollable, and collapses back to the latest reply", () => {
    setup({
      messages: [
        message({ id: "u1", role: "user", text: "first question" }),
        message({ id: "a1", role: "assistant", text: "first answer" }),
        message({ id: "u2", role: "user", text: "second question" }),
        message({ id: "a2", role: "assistant", text: "second answer" }),
      ],
    });
    expect(screen.queryByText("first question")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand conversation" }));
    const history = screen.getByRole("region", { name: "Conversation" });
    for (const t of ["first question", "first answer", "second question", "second answer"])
      expect(within(history).getByText(t)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse conversation" }));
    expect(screen.queryByText("first question")).toBeNull();
    expect(screen.getByRole("region", { name: "Latest reply" })).toBeTruthy();
  });

  it("styles your messages in the expanded conversation like the main chat bubble", () => {
    setup({
      messages: [message({ id: "u1", role: "user", text: "first question" }), reply()],
    });
    fireEvent.click(screen.getByRole("button", { name: "Expand conversation" }));
    const turn = screen.getByText("first question").closest(".float-turn");
    expect(turn?.getAttribute("data-role")).toBe("user");
    for (const style of ["rounded-2xl", "bg-secondary", "px-4", "py-2.5", "text-secondary-foreground"])
      expect(turn?.className).toContain(style);
    expect(turn?.className).not.toContain("rounded-br-sm");
  });

  it("sends what you type in its own field, trimmed, and clears it", () => {
    const { onSend } = setup();
    const input = screen.getByLabelText("Message Dot") as HTMLInputElement;
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  book the first one " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("book the first one");
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "and again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenLastCalledWith("and again");
  });

  it("ignores the Enter that confirms an IME composition", () => {
    const { onSend } = setup();
    const input = screen.getByLabelText("Message Dot");
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("offers Retry for a send that failed", () => {
    const onRetry = vi.fn();
    const failed = {
      requestId: "r",
      text: "hi",
      createdAt: 1,
      knownUserIds: [],
      sending: false,
      error: "Not sent. Can't reach the server.",
    };
    setup({ failed, onRetry });
    expect(screen.getByRole("alert").textContent).toContain("Not sent.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith(failed);
  });

  it("does not steal focus when it appears", () => {
    const outside = document.createElement("textarea");
    document.body.append(outside);
    outside.focus();
    setup();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe("FloatingAssistant: minimized", () => {
  const minimize = () => fireEvent.click(screen.getByRole("button", { name: "Minimize assistant" }));

  it("folds into a bot button and comes back on click, remembering the choice", () => {
    const { view } = setup({ running: true });
    minimize();
    expect(screen.queryByRole("complementary")).toBeNull();
    const bot = screen.getByRole("button", { name: /^Open Dot: Working… on example.com/ });
    expect(bot.closest(".float-mini")?.getAttribute("data-working")).toBe("true");
    expect(localStorage.getItem("rei:assistant-minimized")).toBe("1");
    // another visit starts minimized
    view.unmount();
    render(ui({ ...handlers() }));
    expect(screen.queryByRole("complementary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Open Dot/ }));
    expect(screen.getByRole("complementary", { name: "Dot, the assistant" })).toBeTruthy();
    expect(localStorage.getItem("rei:assistant-minimized")).toBe("0");
  });

  it("restores itself when a new approval arrives, with the card showing it", () => {
    const { again } = setup();
    minimize();
    again({ messages: [reply(), approvalMsg()] });
    const card = screen.getByRole("complementary", { name: "Dot, the assistant" });
    expect(within(card).getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("restores itself when the agent asks for a takeover", () => {
    const { again } = setup();
    minimize();
    again({ messages: [reply(), takeoverMsg()] });
    expect(screen.getByRole("complementary", { name: "Dot, the assistant" })).toBeTruthy();
  });

  it("shows a badge for what waits, and does not restore for something already waiting", () => {
    setup({ messages: [reply(), approvalMsg()] });
    minimize();
    const bot = screen.getByRole("button", { name: /Needs you/ });
    expect(bot.querySelector(".float-badge")?.textContent).toBe("1");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("a new message only peeks for about four seconds; the unread dot follows the server's count", () => {
    const browser = sessionBrowser({ url: "https://example.com/a" });
    const onOpenChange = vi.fn();
    const { again } = setup({ messages: [reply()], onOpenChange });
    minimize();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(document.querySelector(".float-unread")).toBeNull();
    again({ messages: [reply(), reply({ id: "a2", status: "streaming", text: "" })] });
    expect(screen.queryByRole("status")).toBeNull(); // nothing to peek at until text arrives
    again({ messages: [reply(), reply({ id: "a2", status: "streaming", text: "**Done.** Booked it.\nMore below" })] });
    expect(document.querySelector(".float-peek-line")?.textContent).toBe("Done. Booked it.");
    expect(screen.queryByRole("complementary")).toBeNull(); // peek, not restore
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(document.querySelector(".float-peek")).toBeNull();
    // The reply settles and the server counts it unread (the read marker every device shares).
    const done = [reply(), reply({ id: "a2", text: "**Done.** Booked it.\nMore below" })];
    again({ messages: done, session: session({ browser, unread: 1 }) });
    expect(document.querySelector(".float-unread")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /new message/ }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(document.querySelector(".float-unread")).toBeNull();
    expect(screen.getByText("More below", { exact: false })).toBeTruthy();
    // Read on another device: the count drops and so does the dot.
    minimize();
    again({ messages: done, session: session({ browser, unread: 0 }) });
    expect(document.querySelector(".float-unread")).toBeNull();
  });

  it("an open card shows no unread dot", () => {
    setup({ session: session({ unread: 2 }) });
    expect(document.querySelector(".float-unread")).toBeNull();
  });

  it("opens the look dialog from the bot's context menu", async () => {
    const { onChangeLook } = setup();
    minimize();
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Open Dot/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(onChangeLook).toHaveBeenCalled();
  });
});
