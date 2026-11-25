import type { Agent, ReiConversationViewV2, Session } from "@rei/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { FullModeContext } from "../lib/fullMode.tsx";
import { FakeWebSocket, hello } from "../test/fakes.ts";
import {
  approval,
  memoryChange,
  memoryMessage,
  message,
  run,
  session,
  sessionBrowser,
  takeover,
  trigger,
} from "../test/fixtures.ts";
import { openMenu } from "../test/menu.ts";
import { type ViewChange, ViewFrames } from "../test/viewFrames.ts";
import { ChatView } from "./ChatView.tsx";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (ev: MessageEvent) => void>();
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener(t: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(t, l);
  }
  close() {}
  frames = new ViewFrames();
  emit(change: ViewChange, _id = "") {
    for (const event of this.frames.translate(change)) {
      const { type, ...rest } = event;
      this.listeners.get(type)?.({ data: JSON.stringify(rest), lastEventId: "" } as MessageEvent);
    }
  }
}

const agent: Agent = {
  id: "a1",
  name: "Dot",
  avatar: "D",
  model: null,
  thinkingLevel: "off",
  networkMode: "block",
  defaultProfile: "standard",
  homeSessionId: "s1",
};

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type Extra = Partial<React.ComponentProps<typeof ChatView>>;

function setup(api: Partial<Record<keyof Api, unknown>> = {}, extra: Extra = {}, full = false) {
  const props = { sessionId: "s1", ...extra };
  render(
    <FullModeContext.Provider value={{ full, setFull: () => {} }}>
      <ChatView
        api={api as unknown as Api}
        agents={[agent]}
        missing={false}
        onBack={() => {}}
        onUnauthorized={() => {}}
        {...props}
      />
    </FullModeContext.Provider>,
  );
  return FakeEventSource.last!;
}

const open = (
  es: FakeEventSource,
  s: Session,
  messages = [message({ id: "u1", role: "user", status: "complete", text: "hi" })],
) =>
  act(() => {
    es.emit({ type: "snapshot", cursor: "1", session: s, messages, runs: [] }, "1");
  });

const viewOf = (over: Partial<ReiConversationViewV2>): ReiConversationViewV2 => ({
  version: 2,
  session: session(),
  items: [],
  runs: [],
  before: null,
  live: { runId: null },
  overlays: [],
  ...over,
});

describe("ChatView", () => {
  it.each([false, true])("opens instantly and follows later content respecting reduced motion: %s", (reduced) => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && reduced,
      addEventListener() {},
      removeEventListener() {},
    }));
    const calls: ScrollToOptions[] = [];
    const original = Element.prototype.scrollTo;
    // The transcript that is still arriving page by page must never glide down to its newest message.
    Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
      if (typeof options === "object") calls.push(options);
    } as typeof Element.prototype.scrollTo;
    try {
      const es = setup();
      open(es, session(), [
        message({ id: "u1", role: "user", status: "complete", text: "hi" }),
        message({ id: "a1", text: "hello", status: "complete" }),
      ]);
      expect(calls).toEqual([]); // instant: the follow ran without asking for an eased scroll

      const log = screen.getByRole("log");
      Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
      log.scrollTop = 0;

      act(() => {
        es.emit({ type: "message.upserted", message: message({ id: "a2", text: "later", status: "complete" }) });
      });
      if (reduced) {
        expect(calls).not.toContainEqual(expect.objectContaining({ behavior: "smooth" }));
        expect(log.scrollTop).toBe(1000);
      } else expect(calls).toContainEqual({ top: 1000, behavior: "smooth" });
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it("streams text live and switches the composer button between Send and Stop", async () => {
    const cancel = vi.fn().mockResolvedValue({ cancelledRunId: "r1" });
    const es = setup({ cancel });
    const composerButton = screen.getByRole("button", { name: "Send message" });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    act(() => {
      es.emit(
        {
          type: "snapshot",
          cursor: "1",
          session: session({ status: "running" }),
          messages: [
            message({ id: "u1", role: "user", status: "complete", text: "hi" }),
            message({ id: "a1", text: "Hel" }),
          ],
          runs: [run()],
        },
        "1",
      );
    });
    expect(screen.getByRole("button", { name: "Stop" })).toBe(composerButton);
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.getByRole("log").textContent).toContain("Hel");

    act(() => es.emit({ type: "message.delta", messageId: "a1", offset: 3, text: "lo" }));
    expect(screen.getByRole("log").textContent).toContain("Hello");
    act(() => es.emit({ type: "message.delta", messageId: "a1", offset: 99, text: "XX" }));
    expect(screen.getByRole("log").textContent).not.toContain("XX");

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("s1"));

    act(() => {
      es.emit({ type: "run.upserted", run: run({ status: "cancelled", endedAt: 5 }) }, "2");
      es.emit({ type: "message.upserted", message: message({ id: "a1", text: "Hello", status: "aborted" }) }, "3");
    });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBe(composerButton);
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  it("shows a sent message immediately, then reconciles with the server message", async () => {
    let resolveSend!: (v: { messageId: string; runId: string }) => void;
    const sendMessage = vi.fn(() => new Promise((r) => (resolveSend = r)));
    const es = setup({ sendMessage });
    act(() => {
      es.emit({ type: "snapshot", cursor: "1", session: session(), messages: [], runs: [] }, "1");
    });
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByText("hello")).toHaveLength(1);
    const [, requestId, text] = sendMessage.mock.calls[0] as unknown as [string, string, string];
    expect(requestId).toMatch(/[0-9a-f-]{36}/);
    expect(text).toBe("hello");

    await act(async () => resolveSend({ messageId: "u1", runId: "r1" }));
    act(() =>
      es.emit(
        { type: "message.upserted", message: message({ id: "u1", role: "user", status: "complete", text: "hello" }) },
        "2",
      ),
    );
    expect(screen.getAllByText("hello")).toHaveLength(1);
  });

  it("marks a failed send and retries with the same requestId", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("x"), { code: "network_error" }))
      .mockResolvedValue({ messageId: "u1", runId: "r1" });
    const es = setup({ sendMessage });
    act(() => es.emit({ type: "snapshot", cursor: "1", session: session(), messages: [], runs: [] }, "1"));
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[1]![1]).toBe(sendMessage.mock.calls[0]![1]);
  });

  describe("skills and /compact", () => {
    const skills = { skills: [{ id: "k1", name: "review", description: "Reviews.", version: 2, bodyChars: 300 }] };
    // Chats of the same id share state between tests, so each test writes its own text.
    const chooseSkill = async (body = "check this") => {
      const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "/" } });
      input.setSelectionRange(1, 1);
      fireEvent.click(await screen.findByRole("option", { name: /review/ }));
      fireEvent.change(input, { target: { value: body } });
      return input;
    };

    it("sends a skill chip with the message, waits for the server, then shows the message with its skill", async () => {
      const sendMessage = vi.fn().mockResolvedValue({ messageId: "u1", runId: "r1" });
      const es = setup({ sendMessage, getSessionSkills: vi.fn().mockResolvedValue(skills) });
      act(() => es.emit({ type: "snapshot", cursor: "1", session: session(), messages: [], runs: [] }, "1"));
      const input = await chooseSkill();
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      const [sessionId, requestId, text, context] = sendMessage.mock.calls[0] as unknown as [
        string,
        string,
        string,
        { selectedSkills: unknown },
      ];
      expect([sessionId, text]).toEqual(["s1", "check this"]);
      expect(requestId).toMatch(/[0-9a-f-]{36}/);
      expect(context.selectedSkills).toEqual([{ id: "k1", version: 2, name: "review" }]);
      await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(""));
      const log = screen.getByRole("log");
      expect(log.textContent).toContain("check this");
      expect(within(log).getByRole("list", { name: "Skills" }).textContent).toContain("review");
    });

    it("keeps the draft and chip, shows no message, and says why when the server refuses the skill", async () => {
      const sendMessage = vi
        .fn()
        .mockRejectedValue(new ApiError(409, "skill_unavailable", "The skill review is not available any more."));
      const es = setup({ sendMessage, getSessionSkills: vi.fn().mockResolvedValue(skills) });
      act(() => es.emit({ type: "snapshot", cursor: "1", session: session(), messages: [], runs: [] }, "1"));
      const input = await chooseSkill("check that");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByText(/not available any more/)).toBeTruthy();
      expect(input.value).toBe("check that");
      expect(screen.getByRole("list", { name: "Skills for this message" })).toBeTruthy();
      expect(within(screen.getByRole("log")).queryByText("check that")).toBeNull();
    });

    it("runs /compact through the compact endpoint, not as a message", async () => {
      const sendMessage = vi.fn();
      const compact = vi.fn().mockResolvedValue({ requestId: "x", status: "running", taskId: "7" });
      const es = setup({ sendMessage, compact, getSessionSkills: vi.fn().mockResolvedValue(skills) });
      act(() => es.emit({ type: "snapshot", cursor: "1", session: session(), messages: [], runs: [] }, "1"));
      const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "/compact keep the plan" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
      expect(compact.mock.calls[0]).toEqual([
        "s1",
        { requestId: expect.stringMatching(/[0-9a-f-]{36}/), instructions: "keep the plan" },
      ]);
      expect(sendMessage).not.toHaveBeenCalled();
      await waitFor(() => expect(input.value).toBe(""));
    });

    it("shows the compaction's progress from the session stream and turns Send off until it ends", async () => {
      const es = setup({});
      act(() => es.emit({ type: "snapshot", cursor: "1", session: session(), messages: [], runs: [] }, "1"));
      const input = screen.getByLabelText("Message");
      fireEvent.change(input, { target: { value: "hello" } });
      const sendBtn = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
      expect(sendBtn().disabled).toBe(false);
      act(() =>
        es.emit({
          type: "patch",
          epoch: "test-epoch",
          rev: 1,
          live: { runId: null, manualCompaction: { requestId: "c1", status: "running" } },
        } as never),
      );
      expect(screen.getByText("Compacting the conversation…")).toBeTruthy();
      expect(sendBtn().disabled).toBe(true);
      act(() => es.emit({ type: "patch", epoch: "test-epoch", rev: 2, live: { runId: null } } as never));
      expect(screen.queryByText("Compacting the conversation…")).toBeNull();
      expect(sendBtn().disabled).toBe(false);
    });
  });

  describe("branching", () => {
    const reply = (over = {}) =>
      message({ id: "a1", role: "assistant", status: "complete", text: "An answer", forkable: true, ...over });

    it("forks at the message and opens the new chat", async () => {
      const forkSession = vi.fn().mockResolvedValue({ session: session({ id: "f1", origin: "fork" }) });
      const onNavigate = vi.fn();
      const es = setup({ forkSession }, { onNavigate });
      open(es, session(), [message({ id: "u1", role: "user", status: "complete", text: "hi" }), reply()]);
      fireEvent.click(screen.getByRole("button", { name: "Branch in new chat" }));
      await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("f1"));
      expect(forkSession).toHaveBeenCalledWith("s1", "a1");
    });

    it("shows an inline error and stays when the fork fails", async () => {
      const forkSession = vi.fn().mockRejectedValue(new ApiError(409, "not_forkable", ""));
      const onNavigate = vi.fn();
      const es = setup({ forkSession }, { onNavigate });
      open(es, session(), [reply()]);
      fireEvent.click(screen.getByRole("button", { name: "Branch in new chat" }));
      expect((await screen.findByRole("alert")).textContent).toMatch(/can't be branched/);
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("has no branch button on a reply that is not forkable", () => {
      const es = setup();
      open(es, session(), [reply({ forkable: false })]);
      expect(screen.getByRole("button", { name: "Copy reply" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Branch in new chat" })).toBeNull();
    });
  });

  describe("context line", () => {
    const parent = session({ id: "p1", title: "Plan the trip" });

    it("links a spawned session to its parent", () => {
      const es = setup({}, { sessions: [parent] });
      open(es, session({ origin: "spawned", parentSessionId: "p1", depth: 1 }));
      const link = screen.getByRole("link", { name: "Plan the trip" });
      expect(link.getAttribute("href")).toBe("/s/p1");
      expect(link.closest(".chat-context")?.textContent).toBe("Started by Plan the trip");
    });

    it("says so when the parent was deleted", () => {
      const es = setup({}, { sessions: [] });
      open(es, session({ origin: "spawned", parentSessionId: null, depth: 1 }));
      expect(screen.getByText("Started by a deleted chat")).toBeTruthy();
    });

    it("names the trigger a run belongs to and links to it", async () => {
      const getTrigger = vi
        .fn()
        .mockResolvedValue({ trigger: trigger({ id: "trg 1", name: "Morning check" }), runs: [], next: null });
      const es = setup({ getTrigger }, { sessions: [] });
      open(es, session({ origin: "trigger", triggerId: "trg 1" }));
      const link = await screen.findByRole("link", { name: "Morning check" });
      expect(link.getAttribute("href")).toBe("/settings/triggers/trg%201");
      expect(link.closest(".chat-sub")?.textContent).toBe("Run of Morning check");
      expect(link.closest("header")).toBeTruthy();
      expect(document.querySelector(".chat-context")).toBeNull();
      expect(getTrigger).toHaveBeenCalledWith("trg 1");
    });

    it("says 'a trigger' until the name arrives or if it can't be fetched, and 'deleted' when the trigger is gone", () => {
      const es = setup({ getTrigger: vi.fn().mockRejectedValue(new ApiError(404, "not_found", "")) }, { sessions: [] });
      open(es, session({ origin: "trigger", triggerId: "trg1" }));
      expect(screen.getByRole("link", { name: "a trigger" }).closest(".chat-sub")?.textContent).toBe(
        "Run of a trigger",
      );
      open(es, session({ origin: "trigger", triggerId: null }));
      expect(screen.getByText("Run of a deleted trigger")).toBeTruthy();
    });

    it("links a branch to its source, or says the source is gone", () => {
      const es = setup({}, { sessions: [parent] });
      open(es, session({ origin: "fork", forkedFrom: { sessionId: "p1", messageId: "m1" } }));
      expect(screen.getByRole("link", { name: "Plan the trip" }).closest(".chat-context")?.textContent).toBe(
        "Branched from Plan the trip",
      );
    });

    it("handles a deleted source", () => {
      const es = setup({}, { sessions: [] });
      open(es, session({ origin: "fork", forkedFrom: { sessionId: "gone", messageId: "m1" } }));
      expect(screen.getByText("Branched from a deleted chat")).toBeTruthy();
    });

    it("is absent for a plain chat", () => {
      const es = setup({}, { sessions: [parent] });
      open(es, session());
      expect(document.querySelector(".chat-context")).toBeNull();
    });
  });

  describe("sessions panel", () => {
    const child = (over: Partial<Session> = {}) =>
      session({ id: "c1", origin: "spawned", parentSessionId: "s1", depth: 1, title: "Research A", ...over });

    it("uses a modal sheet on phones and restores focus after Escape", async () => {
      vi.stubGlobal("matchMedia", (media: string) => ({
        matches: false,
        media,
        addEventListener() {},
        removeEventListener() {},
      }));
      const es = setup({}, { sessions: [child()] });
      open(es, session());
      const opener = screen.getByRole("button", { name: "Sessions" });
      opener.focus();
      fireEvent.click(opener);
      const sheet = screen.getByRole("dialog", { name: "Sessions" });
      expect(sheet.getAttribute("aria-modal")).toBe("true");
      expect(within(sheet).getByRole("link", { name: /Research A/ })).toBeTruthy();
      expect(document.activeElement).toBe(sheet);
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
    });

    it("is hidden when the chat started nothing, and lists only its own children", () => {
      const es = setup({}, { sessions: [child({ id: "x", parentSessionId: "other" })] });
      open(es, session());
      expect(screen.queryByRole("button", { name: "Sessions" })).toBeNull();
    });

    it("shows a child with a pending approval as 'Waiting for you'", () => {
      const es = setup({}, { sessions: [child({ status: "running", pendingApprovals: 1 })] });
      open(es, session());
      fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
      expect(within(screen.getByRole("complementary")).getByText("Waiting for you")).toBeTruthy();
    });

    it("opens from the header, lists children with status and preview, and closes", () => {
      const es = setup(
        {},
        {
          sessions: [
            child({ id: "c1", title: "Research A", status: "running", preview: "Looking at flights" }),
            child({ id: "c2", title: "Research B", status: "completed", updatedAt: 5 }),
            child({ id: "c3", title: "Research C", status: "failed", updatedAt: 9 }),
            child({ id: "c4", title: "Research D", status: "cancelled", updatedAt: 7 }),
            child({ id: "n1", title: "Not mine", parentSessionId: "p9" }),
          ],
        },
      );
      open(es, session());
      const button = screen.getByRole("button", { name: "Sessions" });
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.textContent).toContain("1"); // one unfinished
      expect(screen.queryByRole("complementary")).toBeNull();

      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      const panel = screen.getByRole("complementary", { name: "Sessions" });
      const rows = within(panel).getAllByRole("link");
      expect(rows.map((r) => r.querySelector(".child-title")?.textContent)).toEqual([
        "Research A",
        "Research C",
        "Research D",
        "Research B",
      ]); // unfinished first, then newest
      expect(rows[0]?.getAttribute("href")).toBe("/s/c1");
      expect(within(panel).getByText("Running")).toBeTruthy();
      expect(within(panel).getByText("Completed")).toBeTruthy();
      expect(within(panel).getByText("Failed")).toBeTruthy();
      expect(within(panel).getByText("Cancelled")).toBeTruthy();
      expect(within(panel).getByText("Looking at flights")).toBeTruthy();
      expect(within(panel).queryByText("Not mine")).toBeNull();

      fireEvent.click(within(panel).getByRole("button", { name: "Close sessions" }));
      expect(screen.queryByRole("complementary")).toBeNull();
      expect(document.activeElement).toBe(button);
    });

    it("closes on Escape and follows the live list", () => {
      const first = [child({ status: "running" })];
      const props = { sessionId: "s1", agents: [agent], missing: false, onBack: () => {}, onUnauthorized: () => {} };
      const view = render(<ChatView api={{} as Api} {...props} sessions={first} />);
      const es = FakeEventSource.last!;
      open(es, session());
      fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
      expect(screen.getByText("Running")).toBeTruthy();
      view.rerender(<ChatView api={{} as Api} {...props} sessions={[child({ status: "completed" })]} />);
      expect(screen.queryByText("Running")).toBeNull();
      expect(screen.getByText("Completed")).toBeTruthy();
      fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
      expect(screen.queryByRole("complementary")).toBeNull();
    });
  });

  describe("delete chat", () => {
    // The dialog opens once the menu has closed and given focus back to its button, so wait for it.
    const openDialog = async () => {
      openMenu(screen.getByRole("button", { name: "Chat options" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat" }));
      return screen.findByRole("alertdialog");
    };

    it("offers to clear a Home chat instead of deleting it", () => {
      const es = setup({}, { sessions: [] });
      open(es, session({ origin: "home" }));
      openMenu(screen.getByRole("button", { name: "Chat options" }));
      expect(screen.queryByRole("menuitem", { name: "Delete chat" })).toBeNull();
      expect(screen.getByRole("menuitem", { name: "Clear Home chat" })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: /Permissions/ })).toBeNull();
    });

    it("asks first, explains it can't be undone, and does nothing on Cancel or Escape", async () => {
      const deleteSession = vi.fn();
      const es = setup({ deleteSession }, { sessions: [session()] });
      open(es, session({ title: "Budget" }));
      let dialog = await openDialog();
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(within(dialog).getByText(/can't be undone/)).toBeTruthy();
      expect(within(dialog).getByText(/Budget/)).toBeTruthy();
      expect(within(dialog).queryByRole("checkbox")).toBeNull();
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));

      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Chat options" })));

      dialog = await openDialog();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(deleteSession).not.toHaveBeenCalled();
    });

    it("keeps Tab inside the dialog", async () => {
      const es = setup({}, { sessions: [session()] });
      open(es, session());
      const dialog = await openDialog();
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      const del = within(dialog).getByRole("button", { name: "Delete" });
      del.focus();
      fireEvent.keyDown(del, { key: "Tab" });
      expect(document.activeElement).toBe(cancel);
      fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(del);
    });

    it("deletes and goes back to the list, announcing nothing for a chat you deleted yourself", async () => {
      const deleteSession = vi.fn().mockResolvedValue({ ok: true });
      const onNavigate = vi.fn();
      const onLocalDelete = vi.fn();
      const es = setup({ deleteSession }, { sessions: [session()], onNavigate, onLocalDelete });
      open(es, session());
      fireEvent.click(within(await openDialog()).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(null));
      expect(deleteSession).toHaveBeenCalledWith("s1", { withForks: false });
      expect(onLocalDelete).toHaveBeenCalledWith("s1", true);
    });

    it("offers 'Also delete its branches' for a chat with branches, and maps it to withForks", async () => {
      const deleteSession = vi.fn().mockResolvedValue({ ok: true });
      const onNavigate = vi.fn();
      const sessions = [
        session({ id: "s1" }),
        session({ id: "f1", origin: "fork", forkedFrom: { sessionId: "s1", messageId: "m" } }),
      ];
      const es = setup({ deleteSession }, { sessions, onNavigate });
      open(es, sessions[0]!);
      const dialog = await openDialog();
      const box = within(dialog).getByRole("checkbox", { name: "Also delete its branches" }) as HTMLInputElement;
      expect(box.checked).toBe(false);
      fireEvent.click(box);
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("s1", { withForks: true }));
    });

    it("does not offer it for a branch that has no branches of its own", async () => {
      const sessions = [
        session({ id: "s1", origin: "fork", forkedFrom: { sessionId: "src", messageId: "m" } }),
        session({ id: "src" }),
      ];
      const es = setup({}, { sessions });
      open(es, sessions[0]!);
      expect(within(await openDialog()).queryByRole("checkbox")).toBeNull();
    });

    it("shows the error, stays open and re-enables Delete when the server refuses", async () => {
      const deleteSession = vi.fn().mockRejectedValue(new ApiError(409, "home_chat", ""));
      const onNavigate = vi.fn();
      const onLocalDelete = vi.fn();
      const es = setup({ deleteSession }, { sessions: [session()], onNavigate, onLocalDelete });
      open(es, session());
      const dialog = await openDialog();
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      expect((await within(dialog).findByRole("alert")).textContent).toMatch(/home chat/);
      expect(onNavigate).not.toHaveBeenCalled();
      expect(onLocalDelete).toHaveBeenLastCalledWith("s1", false);
      expect((within(dialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("tells its parent when the server removes the open chat", () => {
    const onRemoved = vi.fn();
    const es = setup({}, { onRemoved });
    open(es, session());
    expect(onRemoved).not.toHaveBeenCalled();
    act(() => es.emit({ type: "session.removed", sessionId: "s1" }, "5"));
    expect(onRemoved).toHaveBeenCalledWith("s1");
  });

  it("announces background review without reading the raw completion input", () => {
    const es = setup();
    open(es, session(), [
      message({
        id: "r1",
        role: "report",
        status: "complete",
        text: "Research finished: done",
        report: { sessionId: "c1", title: "Research", outcome: "completed", summary: "done" },
      }),
    ]);
    expect(screen.getByText("Assistant is reviewing a background result")).toBeTruthy();
    expect(screen.queryByText("Research finished: done")).toBeNull();
  });
});

describe("ChatView: permissions and approvals", () => {
  it("opens model settings from the composer and saves the agent model without changing permissions", async () => {
    const updateAgent = vi.fn().mockResolvedValue({ agent });
    const es = setup({
      updateAgent,
      getModels: vi.fn().mockResolvedValue({ default: "gpt-6.1-sol", models: ["gpt-6.1-sol", "gpt-6-luna"] }),
    });
    open(es, session());
    const control = screen.getByRole("button", { name: "Model and thinking effort" });
    expect(control.closest(".composer-toolbar")).toBeTruthy();
    await within(control).findByText("gpt-6.1-sol");
    fireEvent.click(control);
    const dialog = screen.getByRole("dialog", { name: "Model settings" });
    await within(dialog).findByRole("option", { name: "gpt-6-luna" });
    expect(within(dialog).queryByLabelText("Name")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "gpt-6-luna" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("a1", { model: "gpt-6-luna" }));
  });

  it("always shows the current permission level in the composer toolbar", () => {
    const es = setup({}, { sessions: [] });
    open(es, session({ profile: "standard" }));
    expect(
      screen.getByRole("button", { name: "Permissions: Standard. Change" }).closest(".composer-toolbar"),
    ).toBeTruthy();
    act(() => es.emit({ type: "session.upserted", session: session({ profile: "strict" }) }, "2"));
    expect(screen.getByRole("button", { name: "Permissions: Strict. Change" })).toBeTruthy();
    openMenu(screen.getByRole("button", { name: "Chat options" }));
    expect(screen.queryByRole("menuitem", { name: /Permissions/ })).toBeNull();
  });

  it("shows the profile chip for Standard and a YOLO chip in warning style, and no taint labels", () => {
    const es = setup({}, { sessions: [] });
    open(es, session({ profile: "standard", taint: ["external", "private"] }));
    expect(screen.getByRole("button", { name: "Permissions: Standard. Change" }).textContent).toBe("Standard");
    expect(screen.queryByText("Read outside content")).toBeNull();
    expect(screen.queryByText("Read private data")).toBeNull();
    act(() => es.emit({ type: "session.upserted", session: session({ profile: "yolo" }) }, "2"));
    const chip = screen.getByRole("button", { name: "Permissions: YOLO. Change" });
    expect(chip.className).toContain("yolo");
    expect(chip.textContent).toBe("YOLO");
  });

  it("opens Permissions from the composer with the current profile selected, warns on YOLO, and saves with PATCH", async () => {
    const updateSession = vi.fn().mockResolvedValue({ session: session({ profile: "yolo" }) });
    const es = setup({ updateSession }, { sessions: [] });
    open(es, session({ origin: "spawned", parentSessionId: "p", depth: 1, profile: "strict" }));
    fireEvent.click(screen.getByRole("button", { name: /Permissions: Strict/ }));
    const dialog = await screen.findByRole("dialog", { name: "Permissions" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText("This chat runs without you.")).toBeTruthy();
    expect((within(dialog).getByRole("radio", { name: /Strict/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getAllByRole("radio")).toHaveLength(3);
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(dialog).queryByText(/YOLO skips most approvals/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: /YOLO/ }));
    expect(within(dialog).getByText(/YOLO skips most approvals/)).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("s1", { profile: "yolo" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("returns focus to the toolbar permission control after saving Standard", async () => {
    let finishSave!: () => void;
    const updateSession = vi.fn(
      () =>
        new Promise<{ session: ReturnType<typeof session> }>((resolve) => {
          finishSave = () => resolve({ session: session({ profile: "standard" }) });
        }),
    );
    const es = setup({ updateSession }, { sessions: [] });
    open(es, session({ profile: "strict" }));
    const chip = screen.getByRole("button", { name: /Permissions: Strict/ });
    chip.focus();
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Permissions" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Standard/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    // The live session event can remove the opener before the save response closes the dialog.
    act(() => es.emit({ type: "session.upserted", session: session({ profile: "standard" }) }, "2"));
    await act(async () => finishSave());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Permissions: Standard. Change" })),
    );
    expect(updateSession).toHaveBeenCalledWith("s1", { profile: "standard" });
  });

  it("shows an error in the dialog when saving fails, and the chip also opens it", async () => {
    const updateSession = vi.fn().mockRejectedValue(new ApiError(400, "bad_profile", ""));
    const es = setup({ updateSession }, { sessions: [] });
    open(es, session({ origin: "home", profile: "standard" }));
    fireEvent.click(screen.getByRole("button", { name: /Permissions: Standard/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /Strict/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/doesn't exist/);
  });

  it('shows only the collapsed card after a decision, not the server\'s "You approved" line', () => {
    const es = setup({}, {}, true);
    open(es, session(), [
      message({
        id: "ap-m",
        role: "approval",
        status: "complete",
        runId: null,
        approval: approval({ status: "approved", grantLength: "once", decidedAt: 5 }),
      }),
      message({
        id: "n1",
        role: "notice",
        status: "complete",
        runId: "r2",
        text: 'You approved #3: Send "Lunch?" to ana@example.com',
      }),
    ]);
    expect(screen.getByText("Approved once")).toBeTruthy();
    expect(within(screen.getByRole("log")).queryByText(/You approved #3/)).toBeNull(); // still announced in the live region for screen readers
  });

  it("Simple mode leaves out an approved card; the step row says Approved instead", () => {
    const es = setup();
    open(es, session(), [
      message({
        id: "ap-m",
        role: "approval",
        status: "complete",
        runId: null,
        approval: approval({ status: "approved", grantLength: "once", decidedAt: 5 }),
      }),
    ]);
    expect(screen.queryByText("Approved once")).toBeNull();
    expect(document.querySelector(".msg-approval")).toBeNull();
  });

  it("Simple mode keeps a pending card and a denied one", () => {
    const es = setup();
    open(es, session({ status: "waiting_for_user", pendingApprovals: 1 }), [
      message({ id: "ap-p", role: "approval", status: "complete", runId: null, approval: approval({ id: "p" }) }),
      message({
        id: "ap-d",
        role: "approval",
        status: "complete",
        runId: null,
        approval: approval({ id: "d", status: "denied", decidedAt: 5 }),
      }),
    ]);
    expect(document.querySelectorAll(".msg-approval")).toHaveLength(2);
  });

  it("reviews a tool round in a single card and shows decisions separately from execution", async () => {
    const first = approval({
      id: "ap1",
      number: 1,
      groupId: "group",
      connector: "mcp",
      tool: "search_pages",
      argsPreview: JSON.stringify({ arguments: { query: "first query" } }),
      preview: {
        kind: "mcp-provider",
        connectorId: "notes",
        connectorName: "Notes",
        url: "https://notes.example/mcp",
        tool: "search_pages",
        claimedReadOnly: true,
      },
    });
    const second = {
      ...first,
      id: "ap2",
      number: 2,
      argsPreview: JSON.stringify({ arguments: { query: "second query" } }),
    };
    const requests = [first, second];
    const decideApprovalGroup = vi.fn().mockResolvedValue({
      approvals: [
        { ...first, status: "approved", execution: "ran" },
        { ...second, status: "denied" },
      ],
    });
    const es = setup({ decideApprovalGroup });
    open(
      es,
      session({ pendingApprovals: 2 }),
      requests.map((request) => message({ id: request.id, role: "approval", approval: request })),
    );
    const card = within(screen.getByRole("article", { name: "Review 2 connector reads" }));
    const apply = card.getByRole("button", { name: "Apply decisions" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(card.getByRole("combobox", { name: /first query/ }), { target: { value: "approve" } });
    fireEvent.change(card.getByRole("combobox", { name: /second query/ }), { target: { value: "deny" } });
    fireEvent.click(apply);
    await waitFor(() =>
      expect(decideApprovalGroup).toHaveBeenCalledExactlyOnceWith("group", {
        decisions: [
          { id: "ap1", decision: "approve" },
          { id: "ap2", decision: "deny" },
        ],
      }),
    );
    expect(await card.findByText("Approved · Ran")).toBeTruthy();
    expect(card.getByText("Denied")).toBeTruthy();
  });

  it("recovers a withdrawn message as a draft after protecting an existing draft", async () => {
    const es = setup();
    open(es, session(), [message({ id: "u1", role: "user", status: "aborted", text: "withdrawn follow-up" })]);
    expect(screen.getByText("Cancelled before running")).toBeTruthy();
    const restore = screen.getByRole("button", { name: "Use as draft" });
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "another draft" } });
    fireEvent.click(restore);
    expect(input.value).toBe("another draft");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(restore);
    await waitFor(() => expect(input.value).toBe("withdrawn follow-up"));
  });

  it("announces a new approval in the open chat and decides it through the API", async () => {
    const decideApproval = vi
      .fn()
      .mockResolvedValue({ approval: approval({ status: "approved", grantLength: "once", decidedAt: 5 }) });
    const es = setup({ decideApproval });
    open(es, session({ status: "waiting_for_user", pendingApprovals: 1 }));
    act(() =>
      es.emit(
        {
          type: "message.upserted",
          message: message({ id: "ap-m", role: "approval", status: "complete", runId: null, approval: approval() }),
        },
        "2",
      ),
    );
    expect(document.querySelector('[aria-live="polite"].sr-only')?.textContent).toContain("Approval needed: Send");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("ap1", { decision: "approve", length: "once" }));
    await waitFor(() => expect(screen.getByText("Approved once")).toBeTruthy());
  });
});

describe("ChatView: browser", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  const withBrowser = (t: ReturnType<typeof takeover> | null = null) =>
    session({ browser: sessionBrowser({ takeover: t }) });
  const takeoverMsg = (t = takeover()) =>
    message({ id: "tk1", role: "takeover", status: "complete", runId: null, takeover: t });

  it("has a Browser button only when the session has a browser window", () => {
    const es = setup();
    open(es, session());
    expect(screen.queryByRole("button", { name: /^Browser/ })).toBeNull();
    act(() => es.emit({ type: "session.upserted", session: withBrowser() }, "2"));
    expect(screen.getByRole("button", { name: "Browser" })).toBeTruthy();
    act(() => es.emit({ type: "session.upserted", session: session() }, "3"));
    expect(screen.queryByRole("button", { name: /^Browser/ })).toBeNull();
  });

  it("opens the panel and tells the app when the agent starts the browser, but not for a window that was already there", () => {
    const onBrowserStarted = vi.fn();
    const es = setup({}, { onBrowserStarted });
    open(es, session());
    expect(document.querySelector(".browser-panel")).toBeNull();
    act(() => es.emit({ type: "session.upserted", session: withBrowser() }, "2"));
    expect(document.querySelector(".browser-panel")).not.toBeNull();
    expect(onBrowserStarted).toHaveBeenCalledTimes(1);
  });

  it("leaves the layout alone when the chat opens with a browser window already there", () => {
    const onBrowserStarted = vi.fn();
    const es = setup({}, { onBrowserStarted });
    open(es, withBrowser());
    expect(document.querySelector(".browser-panel")).toBeNull();
    expect(onBrowserStarted).not.toHaveBeenCalled();
  });

  it("opens the live panel from the button and closes it, returning focus", async () => {
    const es = setup();
    open(es, withBrowser());
    const btn = screen.getByRole("button", { name: "Browser" });
    fireEvent.click(btn);
    const panel = screen.getByRole("complementary", { name: "Sign in" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(FakeWebSocket.last.url).toMatch(/\/api\/sessions\/s1\/browser\/live$/);
    fireEvent.click(within(panel).getByRole("button", { name: "Close browser" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(FakeWebSocket.all[0]!.closed).toBe(true);
  });

  it("marks the button when the assistant is waiting for you", () => {
    const es = setup();
    open(es, withBrowser(takeover()));
    expect(screen.getByRole("button", { name: "Browser, needs you" })).toBeTruthy();
  });

  it("replaces the sessions panel with the browser panel, not both", () => {
    const child = session({ id: "c1", origin: "spawned", parentSessionId: "s1", depth: 1, title: "Research A" });
    const es = setup({}, { sessions: [child] });
    open(es, withBrowser());
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
  });

  it("a pending takeover card announces itself and Take over opens the panel and starts the takeover", async () => {
    const startTakeover = vi.fn().mockResolvedValue({ takeover: takeover({ status: "active" }) });
    const es = setup({ startTakeover });
    open(es, withBrowser(takeover()), [takeoverMsg()]);
    expect(document.querySelector('[aria-live="polite"].sr-only')?.textContent).toBe(
      "The assistant needs you in the browser: Sign in to the bank",
    );
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(screen.getByRole("complementary")).toBeTruthy();
    await waitFor(() => expect(startTakeover).toHaveBeenCalledWith("s1"));
  });

  it("Not now on the card cancels through the API", async () => {
    const endTakeover = vi.fn().mockResolvedValue({ takeover: takeover({ status: "cancelled" }) });
    const es = setup({ endTakeover });
    open(es, withBrowser(takeover()), [takeoverMsg()]);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(endTakeover).toHaveBeenCalledWith("t1", { action: "cancel" }));
  });

  it("opening from the header only watches: no takeover is started", async () => {
    const startTakeover = vi.fn();
    const es = setup({ startTakeover });
    open(es, withBrowser(), [takeoverMsg(takeover({ status: "done", note: "Signed in" }))]);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    await act(async () => {});
    act(() => FakeWebSocket.last.serverSend(hello()));
    expect(startTakeover).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
  });

  it("an active takeover card reopens the panel after it was closed", () => {
    const es = setup();
    const active = takeover({ status: "active", requestedBy: "user", reason: null });
    open(es, withBrowser(active), [takeoverMsg(active)]);
    expect(screen.queryByRole("complementary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    expect(screen.getByRole("complementary")).toBeTruthy();
  });
});

describe("ChatView: expanded browser and the floating assistant", () => {
  const withBrowser = (t: ReturnType<typeof takeover> | null = null, over: Partial<Session> = {}) =>
    session({ browser: sessionBrowser({ takeover: t }), ...over });
  const chat = [
    message({ id: "u1", role: "user", status: "complete", text: "find flights" }),
    message({ id: "a1", status: "complete", text: "Here are the flights I found." }),
  ];
  const media = (wide: boolean) =>
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("min-width: 768px") ? wide : false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
  const column = () => document.querySelector<HTMLElement>(".chat-main")!;
  const panel = () => document.querySelector<HTMLElement>(".browser-panel")!;
  const floating = () => screen.queryByRole("complementary", { name: "Dot, the assistant" });

  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    media(true);
  });

  it("Expand hides the chat column and the header, fills the area with the browser and shows the assistant; Show chat undoes it", () => {
    const es = setup();
    open(es, withBrowser(), chat);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(panel().classList.contains("side")).toBe(true);
    expect(column().hidden).toBe(false);
    expect(floating()).toBeNull(); // the chat is beside it
    fireEvent.click(within(panel()).getByRole("button", { name: "Expand browser" }));
    expect(panel().classList.contains("focus")).toBe(true);
    expect(column().hidden).toBe(true);
    expect(screen.queryByRole("log")).toBeNull();
    expect(floating()).not.toBeNull();
    expect(within(floating()!).getByText("Here are the flights I found.")).toBeTruthy();
    expect(localStorage.getItem("rei:browser-expanded")).toBe("1");
    expect(FakeWebSocket.all).toHaveLength(1); // the same live connection, not a new one

    fireEvent.click(within(panel()).getByRole("button", { name: "Show chat" }));
    expect(panel().classList.contains("side")).toBe(true);
    expect(column().hidden).toBe(false);
    expect(screen.getByRole("log")).toBeTruthy();
    expect(floating()).toBeNull();
    expect(localStorage.getItem("rei:browser-expanded")).toBe("0");
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("starts expanded when this device chose that before, and Show chat on the browser leaves expanded mode", () => {
    localStorage.setItem("rei:browser-expanded", "1");
    const es = setup();
    open(es, withBrowser(), chat);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(panel().classList.contains("focus")).toBe(true);
    expect(within(floating()!).queryByRole("button", { name: "Show chat" })).toBeNull();
    fireEvent.click(within(panel()).getByRole("button", { name: "Show chat" }));
    expect(panel().classList.contains("side")).toBe(true);
    expect(column().hidden).toBe(false);
  });

  it("on a phone the sheet counts as expanded: the assistant is there and closing the sheet brings the chat back", () => {
    media(false);
    const es = setup();
    open(es, withBrowser(), chat);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(panel().classList.contains("sheet")).toBe(true);
    expect(within(panel()).queryByRole("button", { name: "Expand browser" })).toBeNull();
    expect(floating()).not.toBeNull();
    fireEvent.click(within(panel()).getByRole("button", { name: "Close browser" }));
    expect(document.querySelector(".browser-panel")).toBeNull();
    expect(floating()).toBeNull();
    expect(column().hidden).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Browser" }));
  });

  it("the assistant follows the latest reply as it streams, and says what the chat is doing", () => {
    localStorage.setItem("rei:browser-expanded", "1");
    const es = setup();
    act(() => {
      es.emit(
        {
          type: "snapshot",
          cursor: "1",
          session: withBrowser(null, { status: "running" }),
          messages: [chat[0]!, message({ id: "a1", text: "Look" })],
          runs: [run()],
        },
        "1",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(within(floating()!).getByText("Working…")).toBeTruthy();
    act(() => es.emit({ type: "message.delta", messageId: "a1", offset: 4, text: "ing now" }));
    expect(within(floating()!).getByText("Looking now")).toBeTruthy();
  });

  it("sends from the assistant with the same send path (a requestId), and Stop cancels", async () => {
    localStorage.setItem("rei:browser-expanded", "1");
    const sendMessage = vi.fn().mockResolvedValue({ messageId: "u2", runId: "r2" });
    const cancel = vi.fn().mockResolvedValue({ cancelledRunId: "r1" });
    const es = setup({ sendMessage, cancel });
    act(() => {
      es.emit(
        {
          type: "snapshot",
          cursor: "1",
          session: withBrowser(null, { status: "running" }),
          messages: chat,
          runs: [run()],
        },
        "1",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    const input = within(floating()!).getByLabelText("Message Dot");
    fireEvent.change(input, { target: { value: "pick the cheapest" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const [sid, requestId, text] = sendMessage.mock.calls[0] as unknown as [string, string, string];
    expect([sid, text]).toEqual(["s1", "pick the cheapest"]);
    expect(requestId).toMatch(/[0-9a-f-]{36}/);
    fireEvent.click(within(floating()!).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("s1"));
  });

  it("approves from the assistant without leaving expanded mode", async () => {
    localStorage.setItem("rei:browser-expanded", "1");
    const decideApproval = vi.fn().mockResolvedValue({ approval: approval({ status: "approved" }) });
    const es = setup({ decideApproval });
    open(es, withBrowser(), [
      ...chat,
      message({ id: "ap-m", role: "approval", status: "complete", runId: null, approval: approval() }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(within(floating()!).getByText("Needs you")).toBeTruthy();
    fireEvent.click(within(floating()!).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("ap1", { decision: "approve", length: "once" }));
    expect(panel().classList.contains("focus")).toBe(true);
  });

  it("keeps approvals in transcript order and shares earlier pages with the main chat", async () => {
    localStorage.setItem("rei:browser-expanded", "1");
    const getTranscript = vi.fn().mockResolvedValue({
      items: [message({ id: "older", role: "user", text: "Earlier question" })],
      before: null,
    });
    const es = setup({ getTranscript });
    act(() =>
      es.emit({
        type: "snapshot",
        epoch: "e",
        rev: 0,
        view: viewOf({
          session: withBrowser(),
          items: [
            ...chat,
            message({ id: "u2", role: "user", runId: "r2", text: "Upload the file" }),
            message({ id: "a2", runId: "r2", text: "I found the upload form." }),
            message({ id: "ap-m", role: "approval", runId: "r2", approval: approval() }),
          ],
          before: "older",
        }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    fireEvent.click(within(floating()!).getByRole("button", { name: "Expand conversation" }));
    const history = within(floating()!).getByRole("region", { name: "Conversation" });
    const order = ["Here are the flights I found.", "Upload the file", "Approval needed", "I found the upload form."];
    const text = history.textContent ?? "";
    for (const [index, item] of order.entries()) {
      expect(text).toContain(item);
      if (index > 0) expect(text.indexOf(item)).toBeGreaterThan(text.indexOf(order[index - 1]!));
    }
    expect(getTranscript).not.toHaveBeenCalled();
    fireEvent.click(within(history).getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(within(history).getByText("Earlier question")).toBeTruthy());
    expect(getTranscript).toHaveBeenCalledWith("s1", "older");
    fireEvent.click(within(panel()).getByRole("button", { name: "Show chat" }));
    expect(within(screen.getByRole("log")).getByText("Earlier question")).toBeTruthy();
  });

  it("Take over on the agent's request, from the assistant, starts the takeover", async () => {
    localStorage.setItem("rei:browser-expanded", "1");
    const startTakeover = vi.fn().mockResolvedValue({ takeover: takeover({ status: "active" }) });
    const es = setup({ startTakeover });
    open(es, withBrowser(takeover()), [
      ...chat,
      message({ id: "tk", role: "takeover", status: "complete", runId: null, takeover: takeover() }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Browser, needs you" }));
    fireEvent.click(within(floating()!).getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(startTakeover).toHaveBeenCalledWith("s1"));
  });

  it("keys typed in the assistant's field go to the field, never to the live page, during a takeover", async () => {
    localStorage.setItem("rei:browser-expanded", "1");
    const es = setup();
    const active = takeover({ status: "active", requestedBy: "user", reason: null });
    open(es, withBrowser(active), chat);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    await act(async () => {});
    act(() => FakeWebSocket.last.serverSend(hello({ control: true })));
    const page = screen.getByLabelText("Keyboard input for the page");
    fireEvent.keyDown(page, { key: "Enter", code: "Enter" });
    expect(FakeWebSocket.last.messages.some((m) => m.type === "key")).toBe(true); // the live field does own the keys

    const before = FakeWebSocket.last.sent.length;
    const input = within(floating()!).getByLabelText("Message Dot") as HTMLInputElement;
    input.focus();
    for (const key of ["h", "i", "Backspace", "Enter", "Escape"]) {
      fireEvent.keyDown(input, { key, code: key });
      fireEvent.keyUp(input, { key, code: key });
    }
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.input(input, { target: { value: "hi" } });
    fireEvent.paste(input, { clipboardData: { getData: () => "pasted" } });
    expect(input.value).toBe("hi");
    expect(FakeWebSocket.last.sent.slice(before).filter((s) => /"type":"(key|text)"/.test(s))).toEqual([]);
  });

  it("the agent's avatar in the header opens the look picker, and Save changes it through the api", async () => {
    const updateAgent = vi.fn().mockResolvedValue({ agent });
    const es = setup({ updateAgent });
    open(es, session());
    fireEvent.click(screen.getByRole("button", { name: "Change Dot's look" }));
    const dialog = screen.getByRole("dialog", { name: "Change Dot's look" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "River Stone" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("a1", { avatar: "bot:round" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("right-clicking the minimized assistant opens the same picker", async () => {
    localStorage.setItem("rei:browser-expanded", "1");
    localStorage.setItem("rei:assistant-minimized", "1");
    const es = setup();
    open(es, withBrowser(), chat);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    fireEvent.contextMenu(document.querySelector(".float-bot")!);
    expect(await screen.findByRole("dialog", { name: "Change Dot's look" })).toBeTruthy();
  });
});

describe("ChatView: memory", () => {
  const chat = [
    message({ id: "u1", role: "user", status: "complete", text: "I live in Hong Kong" }),
    message({ id: "a1", status: "complete", text: "Noted." }),
  ];

  it("shows 'Memory updated' under the reply, groups consecutive chips, and Undo goes through the API", async () => {
    const undoMemoryChange = vi
      .fn()
      .mockResolvedValue({ change: memoryChange({ id: "c1", undoneAt: 9, undoable: false }), line: null });
    const es = setup({ undoMemoryChange }, {}, true);
    open(es, session(), [
      ...chat,
      memoryMessage({ change: memoryChange({ id: "c1" }) }, { id: "mm1" }),
      memoryMessage({ change: memoryChange({ id: "c2", after: "Likes tea." }) }, { id: "mm2" }),
    ]);
    expect(document.querySelectorAll(".msg-memory")).toHaveLength(1);
    expect(screen.getAllByText("Memory updated")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Undo: Lives in Hong Kong." }));
    await waitFor(() => expect(undoMemoryChange).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText("Undone")).toBeTruthy();
    // the stream later upserts the same message; the chip stays right
    act(() =>
      es.emit(
        {
          type: "message.upserted",
          message: memoryMessage({ change: memoryChange({ id: "c1", undoneAt: 9, undoable: false }) }, { id: "mm1" }),
        },
        "2",
      ),
    );
    expect(screen.getByText("Undone")).toBeTruthy();
  });

  it("Simple mode shows no memory chips", () => {
    const es = setup();
    open(es, session(), [...chat, memoryMessage({ change: memoryChange({ id: "c1" }) }, { id: "mm1" })]);
    expect(document.querySelector(".msg-memory")).toBeNull();
    expect(screen.queryByText("Memory updated")).toBeNull();
    expect(screen.getByText("Noted.")).toBeTruthy();
  });

  it("says which doc a chip is in", () => {
    const es = setup({}, {}, true);
    open(es, session(), [
      ...chat,
      memoryMessage({ change: memoryChange({ id: "c1" }) }, { id: "mm1" }),
      memoryMessage(
        { change: memoryChange({ id: "c2", doc: "agent", agentId: "a1", after: "Be brief." }) },
        { id: "mm2" },
      ),
    ]);
    expect(screen.getByText(/· your profile/)).toBeTruthy();
    expect(screen.getByText(/· Dot's notes/)).toBeTruthy();
  });
});

describe("ChatView: opened at a message", () => {
  const msgs = [
    message({ id: "u1", role: "user", status: "complete", text: "first" }),
    message({ id: "a1", status: "complete", text: "second" }),
    memoryMessage({ change: memoryChange() }, { id: "mm1" }),
    message({ id: "u2", role: "user", status: "complete", text: "third", runId: "r2" }),
  ];
  const flashed = () => [...document.querySelectorAll("[data-flash]")].map((el) => el.textContent ?? "");

  it("scrolls to the message once loaded and highlights it, then lets go", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      const es = setup({}, { focusMessageId: "u2" });
      expect(flashed()).toEqual([]); // nothing loaded yet
      open(es, session(), msgs);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(flashed()).toHaveLength(1);
      expect(flashed()[0]).toContain("third");
      // a later message does not pull the view or flash again
      act(() => es.emit({ type: "message.upserted", message: message({ id: "a2", text: "more", runId: "r3" }) }, "2"));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      act(() => void vi.advanceTimersByTime(3000));
      expect(flashed()).toEqual([]);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      vi.useRealTimers();
    }
  });

  it("finds a message inside a row of memory chips", () => {
    const es = setup({}, { focusMessageId: "mm1" }, true);
    open(es, session(), msgs);
    expect(flashed()).toHaveLength(1);
    expect(flashed()[0]).toContain("Memory updated");
  });

  it("does nothing for a message that is not in the chat", () => {
    const es = setup({}, { focusMessageId: "nope" });
    open(es, session(), msgs);
    expect(flashed()).toEqual([]);
  });

  it("a chat opened without a message highlights nothing", () => {
    const es = setup();
    open(es, session(), msgs);
    expect(flashed()).toEqual([]);
  });
});

describe("ChatView: the Conversation View", () => {
  it("offers Continue after a failed run and starts one", async () => {
    const continueRun = vi.fn().mockResolvedValue({ runId: "r2" });
    const es = setup({ continueRun });
    act(() =>
      es.emit({
        type: "snapshot",
        epoch: "e",
        rev: 0,
        view: viewOf({
          items: [
            message({ id: "u:r1", role: "user", runId: "r1", status: "complete", text: "hi" }),
            message({
              id: "a:r1",
              runId: "r1",
              status: "error",
              text: "",
              error: { code: "model_error", message: "The model call failed." },
            }),
          ],
          runs: [run({ id: "r1", status: "failed" })],
          live: {
            runId: null,
            runFailure: {
              runId: "r1",
              reason: "model_error",
              error: { code: "model_error", message: "The model call failed." },
              canContinue: true,
            },
          },
        }),
      }),
    );
    expect(screen.getAllByText("The model call failed.")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(continueRun).toHaveBeenCalledWith("s1"));
    // Once a run is going the button goes.
    act(() =>
      es.emit({
        type: "patch",
        epoch: "e",
        rev: 1,
        live: { runId: "r2" },
        runs: [run({ id: "r1", status: "failed" }), run({ id: "r2" })],
      }),
    );
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("shows no Continue when the server does not allow one", () => {
    const es = setup();
    act(() =>
      es.emit({
        type: "snapshot",
        epoch: "e",
        rev: 0,
        view: viewOf({
          live: {
            runId: null,
            runFailure: {
              runId: "r1",
              reason: "aborted",
              error: { code: "aborted", message: "Stopped." },
              canContinue: false,
            },
          },
        }),
      }),
    );
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("recovers the visible history when reopening a running chat with an empty transcript window", async () => {
    const getTranscript = vi.fn().mockResolvedValue({
      items: [message({ id: "e:1", role: "user", status: "complete", text: "Start the report" })],
      before: null,
    });
    const es = setup({ getTranscript });
    act(() =>
      es.emit({
        type: "snapshot",
        epoch: "e",
        rev: 0,
        view: viewOf({ before: "e:2", live: { runId: "r1" } }),
      }),
    );

    expect(screen.queryByText("What's on your mind?")).toBeNull();
    expect(await screen.findByText("Start the report")).toBeTruthy();
    expect(getTranscript).toHaveBeenCalledExactlyOnceWith("s1", "e:2");
  });

  it("loads pre-compaction history when a compacted chat opens", async () => {
    const getTranscript = vi
      .fn()
      .mockResolvedValueOnce({
        items: [message({ id: "e:2", role: "user", text: "Before summarizing" })],
        before: "e:1",
      })
      .mockResolvedValueOnce({
        items: [message({ id: "e:1", role: "user", text: "Start of the chat" })],
        before: null,
      });
    const es = setup({ getTranscript });
    act(() =>
      es.emit({
        type: "snapshot",
        epoch: "e",
        rev: 0,
        view: viewOf({
          items: [
            message({ id: "e:3", role: "compaction", text: "Earlier messages were summarized." }),
            message({ id: "u:r9", role: "user", runId: "r9", text: "After summarizing" }),
          ],
          before: "e:2",
        }),
      }),
    );

    expect(await screen.findByText("Start of the chat")).toBeTruthy();
    expect(getTranscript.mock.calls).toEqual([
      ["s1", "e:2"],
      ["s1", "e:1"],
    ]);
    expect(screen.getByRole("log").textContent).toMatch(/Start of the chat.*Before summarizing.*After summarizing/);
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  });

  it("loads earlier messages above the window", async () => {
    const getTranscript = vi.fn().mockResolvedValue({
      items: [message({ id: "e:1", role: "notice", status: "complete", text: "the very start" })],
      before: null,
    });
    const es = setup({ getTranscript });
    act(() =>
      es.emit({
        type: "snapshot",
        epoch: "e",
        rev: 0,
        view: viewOf({
          items: [message({ id: "u:r9", role: "user", runId: "r9", status: "complete", text: "latest" })],
          before: "e:2",
        }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(screen.getByText("the very start")).toBeTruthy());
    expect(getTranscript).toHaveBeenCalledWith("s1", "e:2");
    const log = screen.getByRole("log").textContent ?? "";
    expect(log.indexOf("the very start")).toBeLessThan(log.indexOf("latest"));
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  });

  it("shows compaction and reset as dividers, and a summary in progress", () => {
    const es = setup();
    act(() =>
      es.emit({
        type: "snapshot",
        epoch: "e",
        rev: 0,
        view: viewOf({
          items: [
            message({ id: "e:3", role: "compaction", status: "complete", text: "Earlier messages were summarized." }),
            message({ id: "e:5", role: "reset", status: "complete", text: "A new context started here." }),
          ],
          live: { runId: "r1", compaction: { status: "running" } },
          runs: [run({ id: "r1" })],
        }),
      }),
    );
    expect(screen.getByText("Earlier messages were summarized.")).toBeTruthy();
    expect(screen.getByText("A new context started here.")).toBeTruthy();
    expect(screen.getByText("Summarizing earlier messages…")).toBeTruthy();
  });

  it("reconnects for a fresh snapshot when the stream skips a frame", () => {
    const first = setup();
    act(() => first.emit({ type: "snapshot", epoch: "e", rev: 0, view: viewOf({}) }));
    act(() => first.emit({ type: "patch", epoch: "e", rev: 5, live: { runId: null } }));
    expect(FakeEventSource.last).not.toBe(first);
  });
});
