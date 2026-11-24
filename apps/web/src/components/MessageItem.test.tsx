import type { SessionReport } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import { message, surfacePart } from "../test/fixtures.ts";
import { MessageItem, PendingItem } from "./MessageItem.tsx";

describe("MessageItem", () => {
  it("labels a waiting steer Steering and a waiting follow-up Queued", () => {
    render(
      <ul>
        <MessageItem message={message({ id: "u:1", role: "user", text: "use pnpm", status: "pending", steer: true })} />
        <MessageItem message={message({ id: "u:2", role: "user", text: "then test", status: "pending" })} />
      </ul>,
    );
    expect(screen.getByText("Steering")).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();
  });

  it("leaves short user messages fully visible without a toggle", () => {
    render(
      <ul>
        <MessageItem message={message({ role: "user", text: "Hello" })} />
      </ul>,
    );
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("also collapses long messages while they are sending", () => {
    const { container } = render(
      <ul>
        <PendingItem
          pending={{
            requestId: "p1",
            text: "long message ".repeat(60),
            createdAt: 1000,
            sending: true,
          }}
          onRetry={vi.fn()}
        />
      </ul>,
    );
    expect(container.querySelector(".user-text.clamped")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(container.querySelector(".user-text.clamped")).toBeNull();
  });

  it.each(["x".repeat(600), Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n")])(
    "expands and collapses long user text",
    (text) => {
      const { container } = render(
        <ul>
          <MessageItem message={message({ role: "user", text })} />
        </ul>,
      );
      const toggle = screen.getByRole("button", { name: "Show more" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector(".user-text.clamped")?.id).toBe(toggle.getAttribute("aria-controls"));
      fireEvent.click(toggle);
      expect(container.querySelector(".user-text.clamped")).toBeNull();
      expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect(container.querySelector(".user-text.clamped")?.textContent).toBe(text);
    },
  );

  it("renders text, never HTML, and links URLs", () => {
    const { container } = render(
      <ul>
        <MessageItem
          message={message({
            role: "assistant",
            status: "complete",
            text: "<img src=x onerror=alert(1)>\nsee https://example.com/x.",
          })}
        />
      </ul>,
    );
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/x");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it.each([false, true])("shows citations inline in assistant replies (message parts: %s)", (withParts) => {
    const text = "The finding.[^1]\n\n[^1]: [Source title](https://example.com/finding)";
    const { container } = render(
      <ul>
        <MessageItem
          message={message({ role: "assistant", text, ...(withParts ? { parts: [{ type: "text", text }] } : {}) })}
        />
      </ul>,
    );
    const source = screen.getByRole("button", { name: "example.com" });
    expect(source.closest("p")?.textContent).toBe("The finding.example.com");
    expect(container.querySelector(".md-footnotes")).toBeNull();
  });

  it("shows the error message inline for failed replies and a note for aborted ones", () => {
    const { rerender } = render(
      <ul>
        <MessageItem
          message={message({
            status: "error",
            text: "partial",
            error: { code: "model_error", message: "The model failed." },
          })}
        />
      </ul>,
    );
    expect(screen.getByText("The model failed.")).toBeTruthy();
    rerender(
      <ul>
        <MessageItem message={message({ status: "aborted", text: "partial" })} />
      </ul>,
    );
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  it("shows a message written by another session as a brief card with a link to that session", () => {
    const { container } = render(
      <ul>
        <MessageItem
          message={message({
            id: "b1",
            role: "user",
            status: "complete",
            text: "Find **three** options",
            from: { sessionId: "s 9", title: "Trip planning" },
          })}
        />
      </ul>,
    );
    expect(container.querySelector(".bubble")).toBeNull();
    const link = screen.getByRole("link", { name: "Trip planning" });
    expect(link.getAttribute("href")).toBe("/s/s%209");
    expect(container.querySelector(".brief")?.textContent).toContain("From Trip planning");
    expect(container.querySelector("strong")?.textContent).toBe("three");
  });

  it("never renders HTML from a brief, a sender title or a report", () => {
    const { container } = render(
      <ul>
        <MessageItem
          message={message({
            id: "b1",
            role: "user",
            status: "complete",
            text: "<img src=x onerror=alert(1)> <script>alert(1)</script>",
            from: { sessionId: "s2", title: "<b>bold</b>" },
          })}
        />
        <MessageItem
          message={message({
            id: "r1",
            role: "report",
            runId: null,
            status: "complete",
            report: {
              sessionId: "s2",
              title: "<i>t</i>",
              outcome: "completed",
              summary: "<img src=y onerror=alert(2)>",
            },
          })}
        />
      </ul>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("i")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("<i>t</i> finished");
  });

  it("shows the report as a slim line in both modes, with the result behind a toggle", () => {
    const item = message({
      id: "r2",
      role: "report",
      runId: "home-reaction",
      status: "complete",
      text: "x",
      report: { sessionId: "c1", title: "Zoo hours", outcome: "completed", summary: "Open 9:00 to 17:00." },
    });
    const { rerender } = render(
      <ul>
        <MessageItem message={item} />
      </ul>,
    );
    expect(screen.getByText("Zoo hours finished")).toBeTruthy();
    expect(screen.queryByText("Open 9:00 to 17:00.")).toBeNull();
    rerender(
      <ul>
        <MessageItem message={item} full={{ onInspect: vi.fn(), onFork: vi.fn() }} />
      </ul>,
    );
    expect(screen.queryByText("Open 9:00 to 17:00.")).toBeNull();
    expect(screen.getByRole("link", { name: "Open session" }).getAttribute("href")).toBe("/s/c1");
  });

  describe("report line", () => {
    const report = (over: Partial<SessionReport> = {}) =>
      render(
        <ul>
          <MessageItem
            message={message({
              id: "r1",
              role: "report",
              runId: null,
              status: "complete",
              text: "x",
              report: { sessionId: "c1", title: "Research", outcome: "completed", summary: "Found it.", ...over },
            })}
          />
        </ul>,
      );
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Show result" }));

    it.each([
      ["completed", "Research finished"],
      ["failed", "Research failed"],
      ["cancelled", "Research was cancelled"],
    ] as const)("says what happened when %s", (outcome, line) => {
      const { container } = report({ outcome });
      expect(screen.getByText(line)).toBeTruthy();
      expect(container.querySelector(`.report-${outcome}`)).not.toBeNull();
      expect(screen.queryByText("Found it.")).toBeNull();
    });

    it("links to the session", () => {
      report({ sessionId: "c 1" });
      expect(screen.getByRole("link", { name: "Open session" }).getAttribute("href")).toBe("/s/c%201");
    });

    it("expands and hides the result, rendered as Markdown", () => {
      const { container } = report({ summary: "- one\n- **two**" });
      const toggle = screen.getByRole("button", { name: "Show result" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector(".report-body")).toBeNull();
      fireEvent.click(toggle);
      expect(container.querySelectorAll("li li")).toHaveLength(2);
      expect(container.querySelector("strong")?.textContent).toBe("two");
      expect(screen.getByRole("button", { name: "Hide result" }).getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Hide result" }));
      expect(container.querySelector(".report-body")).toBeNull();
    });

    it("says when the result continues in the session", () => {
      report({ summary: "start", resultId: "a:run_1", resultChars: 9000 });
      open();
      expect(screen.getByText("Showing the start of the result. Open the session for the rest.")).toBeTruthy();
    });

    it("says nothing extra when the summary is the whole result", () => {
      report({ summary: "whole", resultId: "a:run_1", resultChars: 5 });
      open();
      expect(screen.queryByText(/Showing the start of the result/)).toBeNull();
    });

    it("has no toggle when there is no summary", () => {
      report({ outcome: "failed", summary: "" });
      expect(screen.queryByRole("button", { name: "Show result" })).toBeNull();
      expect(screen.getByRole("link", { name: "Open session" })).toBeTruthy();
    });
  });

  describe("Branch in new chat", () => {
    const reply = (over = {}) =>
      message({ id: "a1", role: "assistant", status: "complete", text: "An answer", forkable: true, ...over });

    it("shows only for a forkable reply, and calls onBranch with its id", async () => {
      const onBranch = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <ul>
          <MessageItem message={reply()} onBranch={onBranch} />
        </ul>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Branch in new chat" }));
      await waitFor(() => expect(onBranch).toHaveBeenCalledWith("a1"));
      rerender(
        <ul>
          <MessageItem message={reply({ forkable: false })} onBranch={onBranch} />
        </ul>,
      );
      expect(screen.queryByRole("button", { name: "Branch in new chat" })).toBeNull();
      rerender(
        <ul>
          <MessageItem message={reply()} />
        </ul>,
      );
      expect(screen.queryByRole("button", { name: "Branch in new chat" })).toBeNull();
    });

    it("shows an inline error when branching fails, and lets you try again", async () => {
      const onBranch = vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, "not_forkable", ""))
        .mockResolvedValue(undefined);
      render(
        <ul>
          <MessageItem message={reply()} onBranch={onBranch} />
        </ul>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Branch in new chat" }));
      expect((await screen.findByRole("alert")).textContent).toMatch(/can't be branched/);
      fireEvent.click(screen.getByRole("button", { name: "Branch in new chat" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(onBranch).toHaveBeenCalledTimes(2);
    });
  });
});

describe("MessageItem: surfaces, actions, edit and Full mode", () => {
  const reply = (over: Partial<ReturnType<typeof message>> = {}) =>
    message({
      id: "a1",
      role: "assistant",
      status: "complete",
      text: "Here are options",
      forkable: true,
      parts: [
        surfacePart([{ id: "root", component: "Table", columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] }], {
          fallback: "A\n1",
        }),
        { type: "text", text: "Here are options" },
      ],
      ...over,
    });

  it("draws a reply's parts, and copies each surface's fallback plus the text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <ul>
        <MessageItem message={reply()} />
      </ul>,
    );
    expect(screen.getByRole("table")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy reply" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("A\n1\n\nHere are options"));
  });

  it("a reply with no parts is still markdown", () => {
    const { container } = render(
      <ul>
        <MessageItem message={message({ role: "assistant", status: "complete", text: "plain **bold**" })} />
      </ul>,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("a surface this client cannot draw shows its fallback text", () => {
    const part = surfacePart([{ id: "root", component: "Text", text: "x" }], { fallback: "Plain version" });
    if (part.type === "surface" && part.surface.message)
      part.surface.message.createSurface.catalogId = "other/catalog/9";
    render(
      <ul>
        <MessageItem message={reply({ parts: [part] })} />
      </ul>,
    );
    expect(screen.getByText("Plain version")).toBeTruthy();
  });

  it("a removed surface shows its fallback text and says it was removed", () => {
    render(
      <ul>
        <MessageItem message={reply({ parts: [surfacePart([], { state: "removed", fallback: "Gone now" })] })} />
      </ul>,
    );
    expect(screen.getByText("Gone now")).toBeTruthy();
    expect(screen.getByText("Removed")).toBeTruthy();
  });

  it("an action's message says which surface sent it and cannot be edited", () => {
    render(
      <ul>
        <MessageItem
          message={message({
            id: "u2",
            role: "user",
            status: "complete",
            text: "Book",
            surfaceAction: { surfaceId: "srf_1", revision: 1, componentId: "b", name: "book" },
          })}
        />
      </ul>,
    );
    expect(screen.getByText("via a surface")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  describe("Edit", () => {
    const mine = message({ id: "u1", role: "user", status: "complete", text: "Find a hotel", editable: true });

    it("shows and preserves the original skills when resending from the editor", async () => {
      const withSkills = message({
        id: "u2",
        role: "user",
        status: "complete",
        text: "Review this",
        editable: true,
        selectedSkills: [{ id: "k1", version: 2, name: "acme/review" }],
      });
      const onEdit = vi.fn().mockResolvedValue(undefined);
      render(
        <ul>
          <MessageItem message={withSkills} onEdit={onEdit} />
        </ul>,
      );
      expect(screen.getByRole("list", { name: "Skills" }).textContent).toContain("acme/review");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.click(screen.getByRole("button", { name: "Save & send" }));
      await waitFor(() =>
        expect(onEdit).toHaveBeenCalledWith("u2", "Review this", undefined, [
          { id: "k1", version: 2, name: "acme/review" },
        ]),
      );
    });

    it("Edit can drop a skill; the ones left are sent", async () => {
      const withSkills = message({
        id: "u2",
        role: "user",
        status: "complete",
        text: "Review this",
        editable: true,
        selectedSkills: [
          { id: "k1", version: 2, name: "acme/review" },
          { id: "k2", version: 1, name: "plain" },
        ],
      });
      const onEdit = vi.fn().mockResolvedValue(undefined);
      render(
        <ul>
          <MessageItem message={withSkills} onEdit={onEdit} />
        </ul>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove skill acme/review" }));
      fireEvent.click(screen.getByRole("button", { name: "Save & send" }));
      await waitFor(() =>
        expect(onEdit).toHaveBeenCalledWith("u2", "Review this", undefined, [{ id: "k2", version: 1, name: "plain" }]),
      );
    });

    it("Edit opens a box that sends the changed text", async () => {
      const onEdit = vi.fn().mockResolvedValue(undefined);
      render(
        <ul>
          <MessageItem message={mine} onEdit={onEdit} />
        </ul>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const box = screen.getByLabelText("Edit your message") as HTMLTextAreaElement;
      expect(box.value).toBe("Find a hotel");
      fireEvent.change(box, { target: { value: "Find a cheap hotel" } });
      fireEvent.click(screen.getByRole("button", { name: "Save & send" }));
      await waitFor(() => expect(onEdit).toHaveBeenCalledWith("u1", "Find a cheap hotel"));
    });

    it("Cancel closes the box without sending, and an empty edit can't be sent", () => {
      const onEdit = vi.fn();
      render(
        <ul>
          <MessageItem message={mine} onEdit={onEdit} />
        </ul>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.change(screen.getByLabelText("Edit your message"), { target: { value: "  " } });
      expect((screen.getByRole("button", { name: "Save & send" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByLabelText("Edit your message")).toBeNull();
      expect(onEdit).not.toHaveBeenCalled();
    });

    it("shows the error and stays open when the edit is refused", async () => {
      const onEdit = vi.fn().mockRejectedValue(new ApiError(409, "not_editable", ""));
      render(
        <ul>
          <MessageItem message={mine} onEdit={onEdit} />
        </ul>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.click(screen.getByRole("button", { name: "Save & send" }));
      expect((await screen.findByRole("alert")).textContent).toMatch(/can't be edited/i);
      expect(screen.getByLabelText("Edit your message")).toBeTruthy();
    });

    it("shows Edit only when the message and chat support it", () => {
      const { rerender } = render(
        <ul>
          <MessageItem message={{ ...mine, editable: false }} onEdit={vi.fn()} />
        </ul>,
      );
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      rerender(
        <ul>
          <MessageItem message={mine} />
        </ul>,
      );
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    });
  });

  describe("Full mode", () => {
    it("adds Inspect to replies (not your messages), and Fork from here to replies", () => {
      const full = { onInspect: vi.fn(), onFork: vi.fn() };
      render(
        <ul>
          <MessageItem
            message={message({ id: "u1", role: "user", runId: "r1", status: "complete", text: "hi" })}
            full={full}
          />
          <MessageItem message={reply({ runId: "r1" })} full={full} />
        </ul>,
      );
      const inspect = screen.getAllByRole("button", { name: "Inspect" });
      expect(inspect).toHaveLength(1);
      fireEvent.click(inspect[0]!);
      expect(full.onInspect).toHaveBeenCalledWith("r1");
      fireEvent.click(screen.getByRole("button", { name: "Fork from here" }));
      expect(full.onFork).toHaveBeenCalledWith("a1");
      // The action is icon-only; the tooltip and accessible name carry the words.
      expect(screen.getByRole("button", { name: "Fork from here" }).textContent?.trim()).toBe("");
    });

    it("gives your messages a Copy message button, with or without Full mode", () => {
      const full = { onInspect: vi.fn(), onFork: vi.fn() };
      render(
        <ul>
          <MessageItem
            message={message({ id: "u1", role: "user", status: "complete", text: "hello there" })}
            full={full}
          />
        </ul>,
      );
      expect(screen.queryByRole("button", { name: "Inspect" })).toBeNull();
      expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    });

    it("has Fork from here instead of Branch in a new chat (both fork the same point; Fork is a plain confirm)", () => {
      const full = { onInspect: vi.fn(), onFork: vi.fn() };
      const view = (f?: typeof full) => (
        <ul>
          <MessageItem message={reply()} onBranch={vi.fn()} full={f} />
        </ul>
      );
      const { rerender } = render(view(full));
      expect(screen.getByRole("button", { name: "Fork from here" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Branch in new chat" })).toBeNull();
      rerender(view());
      expect(screen.getByRole("button", { name: "Branch in new chat" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Fork from here" })).toBeNull();
    });

    it("shows none of it in Simple mode", () => {
      render(
        <ul>
          <MessageItem message={reply()} />
        </ul>,
      );
      expect(screen.queryByRole("button", { name: "Inspect" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Fork from here" })).toBeNull();
    });
  });
});

describe("MessageItem: trigger lines", () => {
  const line = (kind: "notify" | "report" | "failed" | "paused", over = {}) =>
    render(
      <ul>
        <MessageItem
          message={message({
            role: "trigger",
            status: "complete",
            runId: null,
            trigger: {
              kind,
              triggerId: "trg 1",
              triggerName: "Morning check",
              triggerRunId: "trr1",
              sessionId: "s9",
              text: "No umbrella needed.",
              ...over,
            },
          })}
        />
      </ul>,
    );

  it("is one compact box: the trigger's name linking to it and the run link in the header, the text below", () => {
    const { container } = line("report");
    expect(container.querySelector(".trigger-box .trigger-head .trigger-name")).toBeTruthy();
    expect(container.querySelector(".trigger-box .trigger-head .trigger-open")?.textContent).toBe("Open run");
    expect(container.querySelector(".trigger-box > .trigger-text")?.textContent).toBe("No umbrella needed.");
    expect(screen.getByRole("link", { name: "Morning check" }).getAttribute("href")).toBe("/settings/triggers/trg%201");
    expect(screen.getByText("No umbrella needed.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open run" }).getAttribute("href")).toBe("/s/s9");
    expect(container.querySelector(".msg-trigger")?.getAttribute("data-kind")).toBe("report");
  });

  it("renders structured reports with headings, paragraphs and links", () => {
    const { container } = line("report", {
      text: "# Findings\n\nFirst paragraph.\n\nSecond paragraph with [source](https://example.com).",
    });
    expect(screen.getByRole("heading", { name: "Findings" })).toBeTruthy();
    expect(container.querySelectorAll(".trigger-text .md > p")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "source" }).getAttribute("href")).toBe("https://example.com");
  });

  it("hides raw background inputs in both modes and links to the source session in Full mode", () => {
    const input = message({
      role: "trigger",
      runId: "home-reaction",
      trigger: {
        kind: "report",
        triggerId: "trg1",
        triggerName: "Rain check",
        triggerRunId: "trr1",
        sessionId: "source",
        text: "Raw background result",
      },
    });
    const { rerender, container } = render(
      <ul>
        <MessageItem message={input} />
      </ul>,
    );
    expect(screen.queryByText("Raw background result")).toBeNull();
    rerender(
      <ul>
        <MessageItem message={input} full={{ onInspect: vi.fn(), onFork: vi.fn() }} />
      </ul>,
    );
    expect(container.querySelector("details")).toBeNull();
    expect(screen.getByText("Background result · Rain check")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open session" }).getAttribute("href")).toBe("/s/source");
    expect(screen.queryByText("Raw background result")).toBeNull();
  });

  it("has no run link when there is no session (a notify)", () => {
    const { container } = line("notify", { sessionId: null, text: "Pay rent" });
    expect(screen.queryByRole("link", { name: "Open run" })).toBeNull();
    expect(container.querySelector(".msg-trigger")?.getAttribute("data-kind")).toBe("notify");
    expect(container.querySelector(".trigger-line .trigger-name")).toBeTruthy();
    expect(container.querySelector(".trigger-box")).toBeNull();
  });

  it("marks a failure and a self-pause by kind, and shows text as text", () => {
    const { container, unmount } = line("failed", { text: "<b>Couldn't</b> run" });
    expect(container.querySelector(".msg-trigger")?.getAttribute("data-kind")).toBe("failed");
    expect(container.querySelector("b")).toBeNull();
    unmount();
    expect(line("paused").container.querySelector(".msg-trigger")?.getAttribute("data-kind")).toBe("paused");
  });
});

describe("MessageItem: calmer chat", () => {
  it("draws no line for the server's note of an approval (the card says it), but keeps other notices", () => {
    const { container } = render(
      <ul>
        <MessageItem
          message={message({
            id: "n1",
            role: "notice",
            status: "complete",
            text: "You approved #10: Create the trigger “Morning check”",
          })}
        />
      </ul>,
    );
    expect(container.querySelector("li")).toBeNull();
    render(
      <ul>
        <MessageItem
          message={message({ id: "n2", role: "notice", status: "complete", text: "You finished in the browser." })}
        />
      </ul>,
    );
    expect(screen.getByText("You finished in the browser.")).toBeTruthy();
  });

  it("marks the newest reply, whose actions stay visible where the others show on hover", () => {
    const { container } = render(
      <ul>
        <MessageItem message={message({ id: "a1", role: "assistant", status: "complete", text: "old" })} />
        <MessageItem message={message({ id: "a2", role: "assistant", status: "complete", text: "new" })} latest />
      </ul>,
    );
    const items = container.querySelectorAll("li.msg-assistant");
    expect(items[0]!.getAttribute("data-latest")).toBeNull();
    expect(items[1]!.getAttribute("data-latest")).toBe("true");
  });
});

it("preserves stable mention IDs when editing text before a mention", async () => {
  const mention = { kind: "chat" as const, id: "other", label: "Other", start: 5, end: 11 };
  const onEdit = vi.fn().mockResolvedValue(undefined);
  render(
    <ul>
      <MessageItem
        message={message({
          id: "u1",
          role: "user",
          status: "complete",
          editable: true,
          text: "Read @Other",
          mentions: [mention],
        })}
        onEdit={onEdit}
      />
    </ul>,
  );
  expect(screen.getByRole("link", { name: "@Other" }).getAttribute("href")).toBe("/s/other");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Edit your message"), { target: { value: "Please Read @Other" } });
  fireEvent.click(screen.getByRole("button", { name: "Save & send" }));
  await waitFor(() =>
    expect(onEdit).toHaveBeenCalledWith("u1", "Please Read @Other", [{ ...mention, start: 12, end: 18 }]),
  );
});

it("never renders an internal assistant reply, including dismissed final text", () => {
  const { rerender } = render(
    <ul>
      <MessageItem
        message={message({ role: "assistant", internal: true, text: "Hidden event output", status: "streaming" })}
      />
    </ul>,
  );
  expect(screen.queryByText("Hidden event output")).toBeNull();
  rerender(
    <ul>
      <MessageItem
        message={message({ role: "assistant", internal: true, text: "Hidden event output", status: "complete" })}
        full={{ onInspect: vi.fn(), onFork: vi.fn() }}
      />
    </ul>,
  );
  expect(screen.queryByText("Hidden event output")).toBeNull();
});

describe("imported messages", () => {
  it("shows an imported reply's thinking only in detail mode, folded", () => {
    const item = message({ role: "assistant", text: "The answer", thinking: ["**Step one**\n\nWeighing it up"] });
    const { rerender, container } = render(
      <ul>
        <MessageItem message={item} />
      </ul>,
    );
    expect(screen.queryByText("Thinking")).toBeNull();
    rerender(
      <ul>
        <MessageItem message={item} full={{ onInspect: vi.fn(), onFork: vi.fn() }} />
      </ul>,
    );
    const details = container.querySelector("details.imported-thinking");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText("Weighing it up")).toBeTruthy();
  });

  it("shows a file an import did not carry as a placeholder with nothing to open", () => {
    render(
      <ul>
        <MessageItem
          message={message({
            role: "user",
            text: "My photo",
            attachments: [
              { id: "f1", name: "photo.jpg", mediaType: "image/jpeg", size: 1000, unavailable: "Not in export" },
            ],
          })}
        />
      </ul>,
    );
    expect(screen.getByText("photo.jpg")).toBeTruthy();
    expect(screen.getByText("image/jpeg · Not in export")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview photo.jpg" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Download photo.jpg" })).toBeNull();
  });
  it("shows embedded Library images as captioned figures side by side and drops their repeated cards", async () => {
    const image = (n: number) => ({
      id: `a${n}`,
      fileId: `fl_${n}`,
      versionId: `fv_${n}`,
      name: `image-${n}.png`,
      mediaType: "image/png",
      size: 2048,
    });
    const { container } = render(
      <ul>
        <MessageItem
          message={message({
            role: "assistant",
            text: "Both are ready:\n\n![Night](file:fl_1)\n\n![Day](file:fl_2)\n\nSee also [the notes](file:fl_3).",
            attachments: [
              image(1),
              image(2),
              {
                id: "a3",
                fileId: "fl_3",
                versionId: "fv_3",
                name: "notes.pdf",
                mediaType: "application/pdf",
                size: 10,
              },
            ],
          })}
        />
      </ul>,
    );
    const gallery = container.querySelector(".md-gallery.md-gallery-many");
    expect(gallery?.querySelectorAll("figure")).toHaveLength(2);
    expect(screen.getByText("Night").tagName).toBe("FIGCAPTION");
    expect(screen.getByRole("img", { name: "Day" }).getAttribute("src")).toBe("/api/files/fl_2/versions/fv_2/content");
    expect(screen.getByRole("link", { name: "Download Night" }).getAttribute("download")).toBe("image-1.png");
    // The images are in the reply, so only the linked PDF keeps a card.
    const cards = screen.getByRole("list", { name: "Attachments" });
    expect(cards.querySelectorAll("li")).toHaveLength(1);
    expect(cards.textContent).toContain("notes.pdf");
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 404 }));
    fireEvent.click(screen.getByRole("button", { name: "Preview Night" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fetcher.mockRestore();
  });

  it("keeps an image's card when the reply only links to it or embeds a file it does not carry", () => {
    render(
      <ul>
        <MessageItem
          message={message({
            role: "assistant",
            text: "![Elsewhere](file:fl_9)",
            attachments: [
              { id: "a1", fileId: "fl_1", versionId: "fv_1", name: "kept.png", mediaType: "image/png", size: 1 },
            ],
          })}
        />
      </ul>,
    );
    expect(screen.queryByRole("figure")).toBeNull();
    expect(screen.getByRole("button", { name: "Preview kept.png" })).toBeTruthy();
  });
});
