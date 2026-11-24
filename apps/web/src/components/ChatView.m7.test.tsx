import type { Agent, Session } from "@rei/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { FullModeContext } from "../lib/fullMode.tsx";
import { approval, message, run, runTrace, session, step, surfacePart, toolStep } from "../test/fixtures.ts";
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
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Extra = Partial<React.ComponentProps<typeof ChatView>>;

function setup(api: Partial<Record<keyof Api, unknown>> = {}, extra: Extra = {}, full = false, setFull = vi.fn()) {
  render(
    <FullModeContext.Provider value={{ full, setFull }}>
      <ChatView
        api={api as unknown as Api}
        agents={[agent]}
        missing={false}
        onBack={() => {}}
        onUnauthorized={() => {}}
        sessionId="s1"
        {...extra}
      />
    </FullModeContext.Provider>,
  );
  return { es: FakeEventSource.last!, setFull };
}

const open = (
  es: FakeEventSource,
  s: Session,
  messages: ReturnType<typeof message>[],
  runs = [run({ status: "completed", endedAt: 5 })],
) =>
  act(() => {
    es.emit({ type: "snapshot", cursor: "1", session: s, messages, runs }, "1");
  });

const userMsg = (over = {}) =>
  message({ id: "u1", role: "user", status: "complete", text: "Find a hotel", runId: "r1", editable: true, ...over });
const card = surfacePart(
  [
    { id: "root", component: "Column", children: ["name", "book"] },
    { id: "name", component: "Text", text: "## Hotel Okura" },
    {
      id: "book",
      component: "Button",
      child: "bookLabel",
      action: { event: { name: "book", context: { hotel: { "@path": "/hotel" } } } },
    },
    { id: "bookLabel", component: "Text", text: "Book" },
  ],
  { surfaceId: "srf_card", title: "Hotels", data: { hotel: "Okura" } },
);
const form = surfacePart(
  [
    {
      id: "root",
      component: "Steps",
      variant: "form",
      title: "Trip",
      steps: [{ title: "When", child: "dates" }],
      submitLabel: "Send",
      action: { event: { name: "trip", context: { dates: { "@path": "/dates" } } } },
    },
    {
      id: "dates",
      component: "TextField",
      label: "Dates",
      value: { "@path": "/dates" },
      "@checks": [
        { condition: { "@call": "required", args: { value: { "@path": "/dates" } } }, message: "Dates are required." },
      ],
    },
  ],
  { surfaceId: "srf_form", title: "Trip", data: { dates: "" } },
);
const replyMsg = (over = {}) =>
  message({
    id: "a1",
    role: "assistant",
    status: "complete",
    text: "Options",
    runId: "r1",
    forkable: true,
    parts: [card, form, { type: "text", text: "Options" }],
    ...over,
  });

describe("ChatView: surfaces", () => {
  it("draws a reply's surfaces before its text, and a button press posts an A2UI action", async () => {
    const surfaceAction = vi.fn().mockResolvedValue({ messageId: "u2", runId: "r2" });
    const { es } = setup({ surfaceAction });
    open(es, session(), [userMsg(), replyMsg()]);
    expect(screen.getByRole("heading", { name: "Hotel Okura" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Book" }));
    await waitFor(() => expect(surfaceAction).toHaveBeenCalled());
    const [sid, surfaceId, req] = surfaceAction.mock.calls[0]!;
    expect([sid, surfaceId]).toEqual(["s1", "srf_card"]);
    expect(req).toMatchObject({
      revision: 1,
      dataModel: { hotel: "Okura" },
      action: {
        version: "1.0",
        action: { name: "book", surfaceId: "srf_card", sourceComponentId: "book", context: { hotel: "Okura" } },
      },
    });
    expect(await screen.findByText("Sent")).toBeTruthy();
  });

  it("a form runs its checks before sending, then sends its values once", async () => {
    const surfaceAction = vi.fn().mockResolvedValue({ messageId: "u2", runId: "r2" });
    const { es } = setup({ surfaceAction });
    open(es, session(), [userMsg(), replyMsg()]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Dates are required.")).toBeTruthy();
    expect(surfaceAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Dates"), { target: { value: "3-5 Nov" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(surfaceAction).toHaveBeenCalledTimes(1));
    expect(surfaceAction.mock.calls[0]![2].action.action).toMatchObject({
      name: "trip",
      context: { dates: "3-5 Nov" },
    });
    expect(await screen.findByText("3-5 Nov")).toBeTruthy();
  });

  it("a stale surface says so instead of sending", async () => {
    const surfaceAction = vi.fn().mockRejectedValue(new ApiError(409, "stale_surface", "changed"));
    const { es } = setup({ surfaceAction });
    open(es, session(), [userMsg(), replyMsg()]);
    fireEvent.click(screen.getByRole("button", { name: "Book" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed since you saw it/);
  });

  it("a form already submitted in the chat shows Sent, and the action's message says which surface sent it", () => {
    const { es } = setup({});
    const sent = message({
      id: "u2",
      role: "user",
      status: "complete",
      text: 'Submitted "Trip": dates: 3-5 Nov',
      runId: "r2",
      surfaceAction: { surfaceId: "srf_form", revision: 1, componentId: "root", name: "trip" },
    });
    open(es, session(), [userMsg(), replyMsg(), sent]);
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.getByText("via Trip")).toBeTruthy();
  });

  it("a fork's copy is read-only and labelled", () => {
    const { es } = setup({ surfaceAction: vi.fn() });
    const frozen = surfacePart(
      [
        { id: "root", component: "Button", child: "l", action: { event: { name: "go" } } },
        { id: "l", component: "Text", text: "Go" },
      ],
      { state: "frozen", title: "Old" },
    );
    open(es, session(), [userMsg(), replyMsg({ parts: [frozen] })]);
    expect((screen.getByRole("button", { name: "Go" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Copy")).toBeTruthy();
  });

  it("the header shows Live while a worker is updating a surface", () => {
    const { es } = setup({});
    const live = surfacePart([{ id: "root", component: "Text", text: "Working" }], {
      surfaceId: "srf_live",
      state: "live",
      title: "Progress",
    });
    open(es, session(), [userMsg(), replyMsg({ parts: [live, card] })]);
    const chip = screen.getAllByRole("status").find((n) => n.closest(".chat-title"));
    expect(chip?.textContent).toBe("Live");
  });
});

describe("ChatView: Edit and message versions", () => {
  it("Edit resends unchanged text and shows the replacement stream view in place", async () => {
    const editMessage = vi.fn().mockResolvedValue({ session: session(), messageId: "n1", runId: "r9" });
    const onNavigate = vi.fn();
    const { es } = setup({ editMessage }, { onNavigate });
    open(es, session(), [userMsg(), replyMsg()]);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & send" }));
    await waitFor(() => expect(editMessage).toHaveBeenCalledWith("s1", { messageId: "u1", text: "Find a hotel" }));
    es.frames.epoch = "rewound";
    open(es, session(), [userMsg({ id: "n1", versions: { index: 2, count: 2 } })]);
    expect(await screen.findByText("2/2")).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("Edit sends the changed text in the same chat", async () => {
    const editMessage = vi.fn().mockResolvedValue({ session: session(), messageId: "n1", runId: "r9" });
    const onNavigate = vi.fn();
    const { es } = setup({ editMessage }, { onNavigate });
    open(es, session(), [userMsg(), replyMsg()]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit your message"), { target: { value: "Find a cheaper hotel" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & send" }));
    await waitFor(() =>
      expect(editMessage).toHaveBeenCalledWith("s1", { messageId: "u1", text: "Find a cheaper hotel" }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Edit your message")).toBeNull());
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("switches versions in the same chat and shows busy refusals on the message", async () => {
    const busy = "Wait for the reply to finish, or stop it.";
    const switchVersion = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "busy", busy))
      .mockResolvedValue({ ok: true });
    const onNavigate = vi.fn();
    const { es } = setup({ switchVersion }, { onNavigate });
    open(es, session(), [userMsg({ versions: { index: 2, count: 2 } })]);
    const previous = screen.getByRole<HTMLButtonElement>("button", { name: "Previous version" });
    expect(previous.disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next version" }).disabled).toBe(true);
    fireEvent.click(previous);
    expect((await screen.findByRole("alert")).textContent).toBe(busy);
    fireEvent.click(previous);
    await waitFor(() => expect(switchVersion).toHaveBeenCalledTimes(2));
    expect(switchVersion).toHaveBeenLastCalledWith("s1", { messageId: "u1", to: "prev" });
    es.frames.epoch = "selected";
    open(es, session(), [userMsg({ id: "older", text: "Original text", versions: { index: 1, count: 2 } })]);
    expect(await screen.findByText("Original text")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Previous version" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next version" }).disabled).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps the editor open and shows the error when the chat is busy", async () => {
    const busy = "Wait for the reply to finish, or stop it.";
    const editMessage = vi.fn().mockRejectedValue(new ApiError(409, "busy", busy));
    const { es } = setup({ editMessage });
    open(es, session(), [userMsg()]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & send" }));
    expect((await screen.findByRole("alert")).textContent).toBe(busy);
    expect(screen.getByLabelText("Edit your message")).toBeTruthy();
  });

  it("the new chat says whether it was retried or edited, and links back to the message", () => {
    const forked = session({
      id: "s1",
      origin: "fork",
      forkedFrom: { sessionId: "src", messageId: "u1", edited: true, retried: true },
    });
    const { es } = setup({}, { sessions: [forked, session({ id: "src", title: "Plan the trip" })] });
    open(es, forked, [userMsg({ editable: false })]);
    const line = screen.getByRole("link", { name: "Plan the trip" });
    expect(line.closest(".chat-context")?.textContent).toBe("Retried from Plan the trip");
    expect(line.getAttribute("href")).toBe("/s/src?m=u1");
  });

  it("an edit says Edited from", () => {
    const edited = session({
      id: "s1",
      origin: "fork",
      forkedFrom: { sessionId: "src", messageId: "u1", edited: true },
    });
    const { es } = setup({}, { sessions: [edited, session({ id: "src", title: "Plan" })] });
    open(es, edited, [userMsg({ editable: false })]);
    expect(screen.getByRole("link", { name: "Plan" }).closest(".chat-context")?.textContent).toBe("Edited from Plan");
  });

  it("a fork taken at a step says Forked from", () => {
    const forked = session({
      id: "s1",
      origin: "fork",
      forkedFrom: { sessionId: "src", messageId: "a1", stepId: "st1" },
    });
    const { es } = setup({}, { sessions: [forked, session({ id: "src", title: "Plan" })] });
    open(es, forked, [userMsg({ editable: false })]);
    expect(screen.getByRole("link", { name: "Plan" }).closest(".chat-context")?.textContent).toBe("Forked from Plan");
  });

  it("a fork with a hidden source message links to the chat and explains where the message is", () => {
    const forked = session({
      origin: "fork",
      forkedFrom: { sessionId: "src", messageId: "a1", onAnotherVersion: true },
    });
    const { es } = setup({}, { sessions: [forked, session({ id: "src", title: "Plan" })] });
    open(es, forked, [userMsg({ editable: false })]);
    const link = screen.getByRole("link", { name: "Plan" });
    expect(link.getAttribute("href")).toBe("/s/src");
    expect(link.closest(".chat-context")?.textContent).toBe("Branched from Plan (on another version of this chat)");
  });
});

describe("ChatView: Simple mode stays simple", () => {
  it("shows compact tool activity without step details, Inspect, Fork from here or Full badge", async () => {
    const getTrace = vi.fn().mockResolvedValue({ session: session(), runs: [runTrace()], next: null });
    const { es } = setup({ getTrace });
    open(es, session(), [userMsg(), replyMsg()]);
    const summary = await screen.findByRole("button", { name: "Worked for 4.0 s" });
    expect(getTrace).toHaveBeenCalledWith("s1");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(screen.getByRole("list", { name: "Tool activity" }).textContent).toBe("Search the web");
    expect(screen.queryByRole("button", { name: /\d+ steps?/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Inspect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fork from here" })).toBeNull();
    expect(screen.getByRole("button", { name: "Branch in new chat" })).toBeTruthy();
  });

  it("shows only the latest five steps while the run works, all of them once expanded by hand, and hides the trace when it completes", async () => {
    const steps = Array.from({ length: 7 }, (_, i) => toolStep({ id: `t${i + 1}`, summary: `Step ${i + 1}` }));
    const working = runTrace({ run: run({ status: "running", endedAt: null }), steps: [step(), ...steps] });
    const getTrace = vi.fn().mockResolvedValue({ session: session(), runs: [working], next: null });
    const { es } = setup({ getTrace });
    open(es, session(), [userMsg()], [run({ status: "running", endedAt: null })]);
    const summary = await screen.findByRole("button", { name: "Working…" });
    const rows = () => screen.getByRole("list", { name: "Tool activity" }).textContent;
    expect(rows()).toBe("Step 3Step 4Step 5Step 6Step 7");
    fireEvent.click(summary);
    expect(screen.queryByRole("list", { name: "Tool activity" })).toBeNull();
    fireEvent.click(summary);
    expect(rows()).toBe(steps.map((s) => s.summary).join(""));
    getTrace.mockResolvedValue({
      session: session(),
      runs: [{ ...working, run: run({ status: "completed", endedAt: 5000 }) }],
      next: null,
    });
    await screen.findByRole("button", { name: "Worked for 4.0 s" }, { timeout: 4_500 });
    expect(screen.queryByRole("list", { name: "Tool activity" })).toBeNull();
  }, 10_000);

  it("puts a run's approval card under its activity and above the reply", async () => {
    const getTrace = vi.fn().mockResolvedValue({ session: session(), runs: [runTrace()], next: null });
    const { es } = setup({ getTrace });
    open(es, session({ status: "waiting_for_user", pendingApprovals: 1 }), [
      userMsg(),
      replyMsg(),
      message({ id: "ap-m", role: "approval", status: "complete", runId: "r1", approval: approval() }),
    ]);
    const summary = await screen.findByRole("button", { name: "Worked for 4.0 s" });
    const list = screen.getByRole("log");
    const rows = [...list.querySelectorAll(".msg-list > li")];
    const at = (el: Element | null) => (el ? rows.indexOf(el.closest("li")!) : -1);
    const card = document.querySelector(".msg-approval");
    const reply = screen.getByText("Options").closest("li");
    expect(at(summary)).toBeGreaterThan(-1);
    expect(at(summary)).toBeLessThan(at(card));
    expect(at(card)).toBeLessThan(at(reply));
  });

  it("leaves out the follow-up about a memory save, and says Approved in green on the step that asked", async () => {
    const ask = toolStep({
      id: "st-ask",
      toolName: "memory_add",
      summary: "Remember the trip",
      status: "blocked",
      decision: "ask",
      approvalId: "apr1",
    });
    const first = runTrace({
      run: run({ id: "r1", status: "completed", endedAt: 5000 }),
      triggerMessageId: "u1",
      steps: [step(), ask],
    });
    const followUp = runTrace({
      run: run({ id: "r2", status: "completed", endedAt: 5000 }),
      triggerMessageId: "u:r2",
      steps: [step(), toolStep({ id: "st-save", toolName: "memory_add", summary: "Save it" })],
    });
    const getTrace = vi.fn().mockResolvedValue({ session: session(), runs: [followUp, first], next: null });
    const { es } = setup({ getTrace });
    open(es, session(), [
      userMsg(),
      replyMsg({ parts: [{ type: "text", text: "Started three tasks." }], text: "Started three tasks." }),
      message({
        id: "ap1",
        role: "approval",
        status: "complete",
        runId: null,
        approval: approval({ id: "apr1", status: "approved", grantLength: "once", decidedAt: 5 }),
      }),
      message({ id: "a2", role: "assistant", status: "complete", text: "Saved to memory.", runId: "r2" }),
    ]);
    await screen.findByRole("button", { name: "Worked for 4.0 s" });
    expect(screen.queryByText("Saved to memory.")).toBeNull();
    expect(screen.queryByText(/Approved once/)).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Worked/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Worked for 4.0 s" }));
    const row = screen.getByRole("list", { name: "Tool activity" }).querySelector("[data-status=blocked]");
    expect(row?.textContent).toContain("Approved");
    expect(row?.className).toContain("text-success");
  });
});

describe("ChatView: Full mode", () => {
  const findSummary = () => screen.findByRole("button", { name: /^(Worked|Working)/ });
  const trace = () => ({
    session: session(),
    runs: [runTrace({ steps: [step(), toolStep({ id: "st2", summary: "Search the web" })] })],
    next: null,
  });

  it("loads the trace and shows one collapsed summary between the user message and the reply, that opens to the step rows", async () => {
    const getTrace = vi.fn().mockResolvedValue(trace());
    const { es } = setup({ getTrace }, {}, true);
    open(es, session(), [userMsg(), replyMsg()]);
    const summary = await findSummary();
    expect(getTrace).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("list", { name: "Tool activity" })).toBeNull();
    expect(document.querySelector(".full-badge")).toBeNull();
    expect(summary.textContent).toBe("Worked for 4.0 s");
    expect(screen.queryByText("2 steps")).toBeNull();
    fireEvent.click(summary);
    expect(screen.getByText("2 steps")).toBeTruthy();
    const steps = screen.getByRole("list", { name: "Tool activity" });
    const log = screen.getByRole("log");
    const order = [...log.querySelectorAll(".msg")].map((e) =>
      e.classList.contains("msg-tool-activity") ? "steps" : e.textContent?.includes("Find a hotel") ? "user" : "reply",
    );
    expect(order.indexOf("user")).toBeLessThan(order.indexOf("steps"));
    expect(order.indexOf("steps")).toBeLessThan(order.indexOf("reply"));
    expect(within(steps).getAllByRole("button")).toHaveLength(2);
  });

  it("fetches the steps again every few seconds while the run is going, and stops when it ends", async () => {
    const going = {
      session: session(),
      runs: [runTrace({ run: run({ status: "running", endedAt: null }) })],
      next: null,
    };
    const getTrace = vi.fn().mockResolvedValue(going);
    const { es } = setup({ getTrace }, {}, true);
    open(es, session(), [userMsg()]);
    expect((await findSummary()).textContent).toBe("Working…");
    await waitFor(() => expect(getTrace.mock.calls.length).toBeGreaterThan(1), { timeout: 4_500 });
    getTrace.mockResolvedValue(trace());
    await waitFor(() => expect(getTrace.mock.calls.length).toBeGreaterThan(2), { timeout: 4_500 });
    const settled = getTrace.mock.calls.length;
    await new Promise((r) => setTimeout(r, 3_500));
    expect(getTrace.mock.calls.length).toBe(settled);
  }, 15_000);

  it("a step row opens the inspector at that step, Escape closes it and focus returns", async () => {
    const getTrace = vi.fn().mockResolvedValue(trace());
    const getStep = vi.fn().mockResolvedValue({
      step: toolStep(),
      tool: { input: { q: "x" }, output: [{ type: "text", text: "found" }], isError: false },
      payloadBytes: 10,
      truncated: false,
    });
    const { es } = setup({ getTrace, getStep }, {}, true);
    open(es, session(), [userMsg(), replyMsg()]);
    fireEvent.click(await findSummary());
    const row = await screen.findByRole("button", { name: /Inspect step: Search the web/ });
    row.focus();
    fireEvent.click(row);
    await waitFor(() => expect(getStep).toHaveBeenCalledWith("st2"));
    expect(await screen.findByText("found")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("complementary", { name: "Inspect" }), { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Inspect" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("Inspect on a message opens that message's run", async () => {
    const getTrace = vi.fn().mockResolvedValue(trace());
    const { es } = setup({ getTrace, getStep: vi.fn().mockResolvedValue({}) }, {}, true);
    open(es, session(), [userMsg(), replyMsg()]);
    await findSummary();
    fireEvent.click(screen.getAllByRole("button", { name: "Inspect" })[0]!);
    const panel = await screen.findByRole("complementary", { name: "Inspect" });
    expect(within(panel).getAllByText(/web_search/).length).toBeGreaterThan(0);
  });

  it("does not offer Fork from here in the inspector", async () => {
    const getTrace = vi.fn().mockResolvedValue(trace());
    const getStep = vi
      .fn()
      .mockResolvedValue({ step: step(), llm: { request: {}, response: {} }, payloadBytes: 1, truncated: false });
    const { es } = setup({ getTrace, getStep }, {}, true);
    open(es, session(), [userMsg(), replyMsg()]);
    fireEvent.click(await findSummary());
    fireEvent.click(await screen.findByRole("button", { name: /Inspect step: Model/ }));
    const panel = await screen.findByRole("complementary", { name: "Inspect" });
    await within(panel).findByRole("tab", { name: "Context" });
    expect(within(panel).queryByRole("button", { name: /Fork from here/ })).toBeNull();
  });

  it("Fork from here on a reply confirms and forks at that message", async () => {
    const getTrace = vi.fn().mockResolvedValue(trace());
    const forkPreview = vi.fn();
    const forkSession = vi.fn().mockResolvedValue({ session: session({ id: "f8", origin: "fork" }) });
    const { es } = setup({ getTrace, forkPreview, forkSession }, {}, true);
    open(es, session(), [userMsg(), replyMsg()]);
    fireEvent.click(screen.getByRole("button", { name: "Fork from here" }));
    await screen.findByText("The original stays as it is.");
    expect(forkPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fork into a new chat" }));
    await waitFor(() => expect(forkSession).toHaveBeenCalledWith("s1", "a1"));
  });

  it("a reply has Fork from here and Inspect, not the Branch button (Fork does the same, after warning about later effects)", () => {
    const { es } = setup({}, {}, true);
    open(es, session(), [userMsg(), replyMsg()]);
    expect(screen.getByRole("button", { name: "Fork from here" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Branch in new chat" })).toBeNull();
  });

  it("keeps the Detail mode switch out of Chat options", () => {
    const { es, setFull } = setup();
    open(es, session(), [userMsg(), replyMsg()]);
    openMenu(screen.getByRole("button", { name: "Chat options" }));
    expect(screen.queryByRole("menuitemcheckbox", { name: "Show details" })).toBeNull();
    expect(setFull).not.toHaveBeenCalled();
  });

  it("offers Inspect chat in Detail mode and describes the chat in its Session tab", async () => {
    const getTrace = vi.fn().mockResolvedValue(trace());
    const { es } = setup({ getTrace }, {}, true);
    open(es, session(), [userMsg(), replyMsg()]);
    openMenu(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Inspect chat/ }));
    const panel = await screen.findByRole("complementary", { name: "Inspect" });
    fireEvent.click(within(panel).getByRole("tab", { name: "Session" }));
    expect(within(panel).getByRole("tabpanel")).toBeTruthy();
  });

  it("shows only the collapsed approval card in Full mode too, and keeps the run it started under it", async () => {
    const getTrace = vi
      .fn()
      .mockResolvedValue({ session: session(), runs: [runTrace({ triggerMessageId: "n1" })], next: null });
    const { es } = setup({ getTrace }, {}, true);
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
        runId: "r1",
        text: 'You approved #3: Send "Lunch?" to ana@example.com',
      }),
    ]);
    expect(screen.getByText("Approved once")).toBeTruthy();
    expect(within(screen.getByRole("log")).queryByText(/You approved #3/)).toBeNull(); // still announced in the live region for screen readers
    expect(await findSummary()).toBeTruthy();
  });

  it("shows a trace load error in the inspector, not in the chat", async () => {
    const getTrace = vi.fn().mockRejectedValue(new ApiError(500, "internal", ""));
    const { es } = setup({ getTrace }, {}, true);
    open(es, session(), [userMsg(), replyMsg()]);
    fireEvent.click(screen.getAllByRole("button", { name: "Inspect" })[0]!);
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Inspect" }).querySelector("[role=alert]")).toBeTruthy(),
    );
  });
});

describe("ChatView: agent settings", () => {
  it("returns focus to Chat options after replacing settings with the look picker", async () => {
    const { es } = setup();
    open(es, session(), [userMsg()]);
    const options = screen.getByRole("button", { name: "Chat options" });
    openMenu(options);
    fireEvent.click(screen.getByRole("menuitem", { name: /Agent settings/ }));
    const settings = await screen.findByRole("dialog", { name: "Dot settings" });
    const changeLook = within(settings).getByRole("button", { name: "Change look…" });
    changeLook.focus();
    fireEvent.click(changeLook);
    const picker = await screen.findByRole("dialog", { name: "Change Dot's look" });
    expect(screen.queryByRole("dialog", { name: "Dot settings" })).toBeNull();
    expect(picker.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(options));
  });

  it("opens from the header and the menu, saves the changes and closes", async () => {
    const updateAgent = vi.fn().mockResolvedValue({ agent });
    const { es } = setup({ updateAgent });
    open(es, session(), [userMsg()]);
    fireEvent.click(screen.getByRole("button", { name: "Dot settings" }));
    const dialog = screen.getByRole("dialog", { name: "Dot settings" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Robin" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("a1", { name: "Robin" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Dot settings" })).toBeNull());

    openMenu(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Agent settings/ }));
    expect(await screen.findByRole("dialog", { name: "Dot settings" })).toBeTruthy();
  });

  it("has no Delete agent entry in the options menu", () => {
    const { es } = setup({});
    open(es, session(), [userMsg()]);
    openMenu(screen.getByRole("button", { name: "Chat options" }));
    expect(screen.getByRole("menuitem", { name: /Agent settings/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete agent" })).toBeNull();
  });

  it("offers Delete agent under Inspect chat on a home chat, in Full mode", () => {
    const { es } = setup({}, {}, true);
    open(es, session({ origin: "home" }), [userMsg()]);
    openMenu(screen.getByRole("button", { name: "Chat options" }));
    const items = screen.getAllByRole("menuitem").map((m) => m.textContent?.trim());
    expect(items).toEqual(["Agent settings", "Inspect chat", "Delete agent"]);
  });

  it("offers Delete agent on a home chat in Simple mode too, and never for the default agent", () => {
    const { es } = setup({}, { defaultAgentId: "a2" });
    open(es, session({ origin: "home" }), [userMsg()]);
    openMenu(screen.getByRole("button", { name: "Chat options" }));
    expect(screen.getByRole("menuitem", { name: "Delete agent" })).toBeTruthy();
  });

  it("hides Delete agent for the default agent's home chat", () => {
    const { es } = setup({}, { defaultAgentId: "a1" });
    open(es, session({ origin: "home" }), [userMsg()]);
    openMenu(screen.getByRole("button", { name: "Chat options" }));
    expect(screen.queryByRole("menuitem", { name: "Delete agent" })).toBeNull();
  });

  it("confirms, deletes the agent and leaves its home chat", async () => {
    const deleteAgent = vi.fn().mockResolvedValue({ ok: true });
    const onNavigate = vi.fn();
    const { es } = setup({ deleteAgent }, { onNavigate });
    open(es, session({ origin: "home" }), [userMsg()]);
    openMenu(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete agent" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Dot?" });
    expect(deleteAgent).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(null));
    expect(deleteAgent).toHaveBeenCalledWith("a1");
  });

  it("keeps the dialog open with the server's reason when deleting fails", async () => {
    const deleteAgent = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "default_agent", "The default agent can't be deleted."));
    const onNavigate = vi.fn();
    const { es } = setup({ deleteAgent }, { onNavigate });
    open(es, session({ origin: "home" }), [userMsg()]);
    openMenu(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete agent" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Dot?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByText("The default agent can't be deleted.")).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("ChatView: a script's row", () => {
  const code = toolStep({
    id: "sc",
    toolName: "codemode",
    toolCallId: "call-1",
    status: "running",
    activity: "Mail the invoices",
    actionClass: "read_internal",
  });
  const sent = toolStep({
    id: "n1",
    toolName: "demo_send",
    toolCallId: "call-1/c1",
    parentStepId: "sc",
    status: "running",
    decision: "ask",
    summary: "Send the invoices",
  });
  const going = (steps = [step(), code, sent]) => ({
    session: session(),
    runs: [runTrace({ run: run({ status: "running", endedAt: null }), steps })],
    next: null,
  });
  const ask = (over = {}) =>
    message({
      id: "ap-n",
      role: "approval",
      status: "complete",
      runId: "r1",
      approval: approval({ id: "apr9", parentCallId: "call-1", resumesTool: true, ...over }),
    });
  const live = (es: FakeEventSource) =>
    act(() => {
      es.emit({
        type: "patch",
        epoch: "test-epoch",
        rev: 1,
        live: {
          runId: "r1",
          tools: [
            { callId: "call-1", name: "codemode", status: "running" },
            { callId: "call-1/c1", name: "demo_send", status: "waiting", nested: true, parentCallId: "call-1" },
          ],
        },
      } as never);
    });
  const running = [run({ status: "running", endedAt: null })];

  it.each([true, false])(
    "puts a call's approval card under its script's row, not in the transcript (Full: %s)",
    async (full) => {
      const decideApproval = vi.fn().mockResolvedValue({
        approval: approval({ id: "apr9", status: "approved", grantLength: "once", decidedAt: 5 }),
      });
      const { es } = setup({ getTrace: vi.fn().mockResolvedValue(going()), decideApproval }, {}, full);
      open(es, session(), [userMsg(), ask()], running);
      live(es);
      // The card first shows where it landed, until the trace brings the script's row for it to move under.
      await screen.findByLabelText(/Mail the invoices/);
      const card = await screen.findByText("Asked by a script", { selector: ".approval-script" });
      await waitFor(() => expect(card.closest(".msg-tool-activity")).toBeTruthy());
      const row = card.closest("ul")?.parentElement;
      expect(row?.textContent).toContain("Mail the invoices");
      expect(row?.closest(".msg-tool-activity")).toBeTruthy();
      expect(within(screen.getByRole("log")).getAllByText("Approval needed")).toHaveLength(1);
      expect(screen.getByLabelText(/Mail the invoices.* — Waiting for approval/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("apr9", { decision: "approve", length: "once" }));
    },
  );

  it("shows the call under its script as soon as the live run has it, before the trace does", async () => {
    const { es } = setup({ getTrace: vi.fn().mockResolvedValue(going([step(), code])) }, {}, true);
    open(es, session(), [userMsg()], running);
    await screen.findByLabelText(/Mail the invoices/);
    live(es);
    expect(await screen.findByLabelText("demo send — Waiting")).toBeTruthy();
  });

  it("keeps a card whose script is not in this chat's trace where it was", async () => {
    const { es } = setup({ getTrace: vi.fn().mockResolvedValue(going([step(), toolStep()])) }, {}, true);
    open(es, session(), [userMsg(), ask()], running);
    expect(await screen.findByText("Approval needed")).toBeTruthy();
    expect(document.querySelector(".msg-tool-activity .msg-approval")).toBeNull();
    expect(document.querySelector(".msg-list > .msg-approval")).toBeTruthy();
  });
});
