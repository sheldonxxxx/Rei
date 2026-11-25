import type { SkillPreview } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import { ConnectorNamesContext } from "../lib/connectors.tsx";
import { approval, message, SKILL_MD, triggerPreview } from "../test/fixtures.ts";
import { MessageItem } from "./MessageItem.tsx";

const card = (a = approval(), onDecide?: ReturnType<typeof vi.fn>, extra = {}) =>
  render(
    <ul>
      <MessageItem
        message={message({ id: "m-ap", role: "approval", status: "complete", runId: null, approval: a, ...extra })}
        approvalAgentName="Rei"
        onDecide={onDecide as never}
      />
    </ul>,
  );

describe("approval card: pending", () => {
  it("shows what is being asked, the class, the connector, the destination and when it expires", () => {
    const { container } = card(approval({ expiresAt: Date.now() + 3 * 3_600_000 + 60_000 }));
    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("#3")).toBeTruthy();
    expect(screen.getByText("Requested by")).toBeTruthy();
    expect(screen.getByText("Rei")).toBeTruthy();
    expect(container.querySelector(".class-chip")?.textContent).toBe("Send");
    expect(screen.getByText('Send "Lunch?" to ana@example.com', { selector: ".approval-summary" })).toBeTruthy();
    expect(container.querySelector(".approval-facts")?.textContent).toContain("demo · send_email");
    expect(container.querySelector(".approval-facts")?.textContent).toContain("ana@example.com");
    expect(container.querySelector(".approval-expiry")?.textContent).toBe("Expires in 3 hours");
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("omits the destination when there is none, and the length choice when only 'once' is offered", () => {
    const { container } = card(approval({ destination: null, lengths: ["once"], actionClass: "credentials" }));
    expect(container.querySelector(".approval-facts")?.textContent).not.toContain("Destination");
    expect(container.querySelector(".class-chip")?.textContent).toBe("Login");
    expect(screen.queryByRole("group", { name: "Allow" })).toBeNull();
  });

  it("approves just once by default", async () => {
    const onDecide = vi.fn().mockResolvedValue(approval({ status: "approved", grantLength: "once", decidedAt: 9 }));
    card(approval(), onDecide);
    expect((screen.getByRole("radio", { name: "Just this once" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap1", { decision: "approve", length: "once" }));
    // the card shows the outcome at once, before the stream catches up
    expect(await screen.findByText("Approved once")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it.each([
    ["For this chat", "session"],
    ["For this agent", "agent"],
    ["Always", "always"],
  ])("sends the chosen length: %s", async (label, length) => {
    const onDecide = vi
      .fn()
      .mockResolvedValue(approval({ status: "approved", grantLength: length as "session", decidedAt: 9 }));
    card(approval(), onDecide);
    expect(screen.getByRole("group", { name: "Allow" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: label }));
    expect(screen.getByText("Matching actions can run without asking while this grant is active.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap1", { decision: "approve", length }));
  });

  it("offers a destination and all web for a research approval", async () => {
    const onDecide = vi.fn().mockResolvedValue(approval({ status: "approved", grantLength: "web_session" }));
    card(
      approval({
        connector: "web",
        operation: "fetch",
        destination: "example.test",
        lengths: ["once", "session", "web_session"],
      }),
      onDecide,
    );
    expect(screen.getByRole("radio", { name: "This destination for this chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "All web for this chat" }));
    expect(screen.getByText("Search queries and page URLs may contain information from this chat.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap1", { decision: "approve", length: "web_session" }));
  });

  it("asks for hours only when that option is chosen, validates 1 to 168, and sends them", async () => {
    const onDecide = vi
      .fn()
      .mockResolvedValue(
        approval({ status: "approved", grantLength: "hours", decidedAt: 9, grantExpiresAt: 9 + 6 * 3_600_000 }),
      );
    card(approval(), onDecide);
    expect(screen.queryByLabelText("Hours")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "For a number of hours" }));
    const hours = screen.getByLabelText("Hours") as HTMLInputElement;
    expect(hours.value).toBe("1");
    fireEvent.change(hours, { target: { value: "0" } });
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Enter 1 to 168 hours.")).toBeTruthy();
    fireEvent.change(hours, { target: { value: "169" } });
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(hours, { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith("ap1", { decision: "approve", length: "hours", hours: 6 }),
    );
    expect(await screen.findByText("Approved for 6 hours")).toBeTruthy();
  });

  it("names the hours of a decided hours grant from the approval alone (after a reload)", () => {
    card(
      approval({ status: "approved", grantLength: "hours", decidedAt: 1_000, grantExpiresAt: 1_000 + 4 * 3_600_000 }),
    );
    expect(screen.getByText("Approved for 4 hours")).toBeTruthy();
  });

  it("denies", async () => {
    const onDecide = vi.fn().mockResolvedValue(approval({ status: "denied", decidedAt: 9 }));
    card(approval(), onDecide);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap1", { decision: "deny" }));
    expect(await screen.findByText("Denied")).toBeTruthy();
  });

  it("disables both buttons while the request is in flight", async () => {
    let finish!: (a: ReturnType<typeof approval>) => void;
    const onDecide = vi.fn(() => new Promise((r) => (finish = r as typeof finish)));
    card(approval(), onDecide);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    finish(approval({ status: "approved", grantLength: "once", decidedAt: 1 }));
    expect(await screen.findByText("Approved once")).toBeTruthy();
  });

  it("shows a failure inline and lets you try again", async () => {
    const onDecide = vi.fn().mockRejectedValue(new ApiError(502, "http_502", "Request failed (502)."));
    card(approval(), onDecide);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Request failed");
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says 'Already decided.' for not_pending", async () => {
    const onDecide = vi.fn().mockRejectedValue(new ApiError(409, "not_pending", ""));
    card(approval(), onDecide);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Already decided.");
  });

  it("links to the session it is from when shown in another chat (the parent-chat mirror)", () => {
    const { container } = card(approval({ sessionId: "child 1", sessionTitle: "Book flights" }), undefined, {
      sessionId: "parent",
    });
    const link = within(container.querySelector(".approval-facts") as HTMLElement).getByRole("link", {
      name: "Book flights",
    });
    expect(link.getAttribute("href")).toBe("/s/child%201");
    expect(container.querySelector(".approval-facts")?.textContent).toContain("In Book flights");
  });

  it("does not show the link in the session's own chat", () => {
    const { container } = card(approval(), undefined, { sessionId: "s1" });
    expect(container.querySelector(".approval-facts a")).toBeNull();
  });

  it("warns that an irreversible action can't be undone", () => {
    card(approval({ actionClass: "irreversible" }));
    expect(screen.getByText("This can't be undone.")).toBeTruthy();
    expect(document.querySelector(".class-chip")?.textContent).toBe("Irreversible");
  });

  it("flags a chat that read outside content with one sentence, and no taint chips", () => {
    card(approval({ taint: ["external", "private"] }));
    expect(screen.queryByText("Read outside content")).toBeNull();
    expect(screen.queryByText("Read private data")).toBeNull();
    expect(
      screen.getByText(
        /This chat has read outside content and may hold private data\. Check the details before approving\./,
      ),
    ).toBeTruthy();
  });

  it("shows no taint warning for a clean chat", () => {
    card(approval());
    expect(screen.queryByText(/Check the details/)).toBeNull();
  });

  it("keeps the arguments behind a Details disclosure and renders them as text, never HTML", () => {
    const evil = '{\n  "body": "<img src=x onerror=alert(1)><b>hi</b>"\n}';
    const { container } = card(approval({ argsPreview: evil }));
    expect(container.querySelector("pre")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe(evil);
  });

  it("renders a summary containing markup as plain text", () => {
    const { container } = card(approval({ summary: "<script>alert(1)</script> **x**" }));
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".approval-summary")?.textContent).toBe("<script>alert(1)</script> **x**");
  });
});

describe("approval card: decided", () => {
  const line = (a: Parameters<typeof approval>[0]) => {
    const { container } = card(approval({ decidedAt: Date.now(), ...a }));
    return container.querySelector(".approval-done-text")?.textContent ?? "";
  };

  it.each([
    [{ status: "approved", grantLength: "once" }, "Approved once"],
    [{ status: "approved", grantLength: "session" }, "Approved for this chat"],
    [{ status: "approved", grantLength: "agent" }, "Approved for this agent"],
    [{ status: "approved", grantLength: "hours" }, "Approved for a set time"],
    [{ status: "approved", grantLength: "always" }, "Always allowed"],
    [{ status: "denied" }, "Denied"],
    [{ status: "expired", decidedAt: null }, "Expired"],
    [{ status: "cancelled", decidedAt: null }, "Cancelled"],
  ] as const)("collapses %o to one line", (over, text) => {
    const t = line(over as never);
    expect(t).toContain(text);
    expect(t).toContain('Send "Lunch?" to ana@example.com');
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("expands to the details and arguments", () => {
    const { container } = card(approval({ status: "approved", grantLength: "once", decidedAt: Date.now() }));
    expect(container.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(container.querySelector("pre code")?.textContent).toContain("ana@example.com");
  });
});

describe("approval card: asked by a script", () => {
  it("says a script asked, on a pending card and in its details", () => {
    const { container } = card(approval({ parentCallId: "call-1" }));
    expect(container.querySelector(".approval-script")?.textContent).toBe("Asked by a script");
    expect(container.querySelector(".approval-facts")?.textContent).toContain("Asked byA script");
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("says nothing about a script on a card a direct call asked for", () => {
    const { container } = card(approval());
    expect(container.querySelector(".approval-script")).toBeNull();
    expect(container.querySelector(".approval-facts")?.textContent).not.toContain("Asked by");
  });

  it("says why a card was withdrawn when the script that asked for it ended", () => {
    const { container } = card(
      approval({ parentCallId: "call-1", status: "cancelled", cancelReason: "script_ended", decidedAt: Date.now() }),
    );
    const line = container.querySelector(".approval-done-text")?.textContent ?? "";
    expect(line).toContain("Cancelled");
    expect(line).toContain("The script that asked for this ended");
    expect(line).toContain("Asked by a script");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("leaves a card the user cancelled without the script's reason", () => {
    const { container } = card(approval({ parentCallId: "call-1", status: "cancelled", decidedAt: Date.now() }));
    expect(container.querySelector(".approval-done-text")?.textContent).not.toContain("script that asked");
  });
});

describe("notice message", () => {
  it("is a quiet centred line, not a bubble", () => {
    const { container } = render(
      <ul>
        <MessageItem
          message={message({
            id: "n1",
            role: "notice",
            status: "complete",
            runId: null,
            text: "Permissions changed to Standard.",
          })}
        />
      </ul>,
    );
    expect(container.querySelector(".msg-notice")?.textContent).toBe("Permissions changed to Standard.");
    expect(container.querySelector(".bubble")).toBeNull();
    expect(container.querySelector(".avatar")).toBeNull();
  });
});

describe("approval card: memory write", () => {
  it("is labelled Memory write and says what saving does; a tainted chat gets the specific warning", () => {
    const { container } = card(
      approval({
        actionClass: "memory_write",
        connector: "memory",
        operation: "write",
        destination: "profile",
        summary: 'Save to your profile: "Lives in Hong Kong."',
        taint: ["external"],
      }),
    );
    expect(container.querySelector(".class-chip")?.textContent).toBe("Memory write");
    expect(container.querySelector(".approval-warn")?.textContent).toBe(
      "This chat read outside content, so this memory change needs approval. Check what would be saved.",
    );
    expect(container.querySelector(".approval-note")?.textContent).toMatch(/shared with every assistant/);
    expect(container.querySelector(".approval-facts")?.textContent).toContain("memory · write");
  });

  it("identifies agent notes as belonging to the requesting assistant", () => {
    card(
      approval({
        actionClass: "memory_write",
        connector: "memory",
        operation: "write",
        destination: "agent:agt_test",
        taint: ["external"],
      }),
    );
    expect(screen.getByText("This memory belongs to the requesting assistant.")).toBeTruthy();
  });

  it("other classes have no memory note", () => {
    const { container } = card(approval());
    expect(container.querySelector(".approval-note")).toBeNull();
  });
});

describe("approval card: set up", () => {
  it("labels the configure class and the trigger grant length", () => {
    const { container } = card(
      approval({ actionClass: "configure", lengths: ["once", "trigger"], preview: triggerPreview() }),
    );
    expect(container.querySelector(".class-chip")?.textContent).toBe("Set up");
    expect(screen.getByRole("radio", { name: "For this trigger" })).toBeTruthy();
    expect(screen.getByText("Change it later on the Triggers page.")).toBeTruthy();
    expect(screen.queryByText(/Nothing is set up/)).toBeNull();
  });

  it("an event trigger's card shows what starts it and leaves out the schedule-only rows", () => {
    card(
      approval({
        actionClass: "configure",
        lengths: ["once"],
        preview: triggerPreview({
          startKind: "event",
          startText: "When items.new arrives from source feed",
          nextRuns: [],
        }),
      }),
    );
    expect(screen.getByText("When items.new arrives from source feed")).toBeTruthy();
    expect(screen.queryByText("Skipped if late by")).toBeNull();
    expect(screen.queryByText("If a run is missed")).toBeNull();
    expect(screen.queryByText("If the last run is still going")).toBeNull();
  });

  it("names the page to change it on, by what is being set up", () => {
    const { unmount } = card(approval({ actionClass: "configure", lengths: ["once"], preview: triggerPreview() }));
    expect(screen.getByText(/later on the Triggers page\./)).toBeTruthy();
    unmount();
    const skill: SkillPreview = {
      kind: "skill",
      op: "create",
      name: "x",
      description: "d",
      skillMd: SKILL_MD,
      files: [],
    };
    const second = card(approval({ actionClass: "configure", lengths: ["once"], preview: skill }));
    expect(screen.getByText(/later on the Skills page\./)).toBeTruthy();
    second.unmount();
    card(approval({ actionClass: "configure", lengths: ["once"] }));
    expect(screen.getByText(/later on the Triggers or Skills page\./)).toBeTruthy();
  });

  it("lists 'For this trigger' right after 'Just this once', and leaves other orders alone", () => {
    const { unmount } = card(approval({ actionClass: "send", lengths: ["once", "session", "agent", "trigger"] }));
    expect(screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual([
      "once",
      "trigger",
      "session",
      "agent",
    ]);
    unmount();
    card(approval({ lengths: ["once", "session", "agent"] }));
    expect(screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual([
      "once",
      "session",
      "agent",
    ]);
  });

  it("says 'Approved for this trigger' once decided with that length", () => {
    card(approval({ status: "approved", grantLength: "trigger", decidedAt: 5 }));
    expect(screen.getByText("Approved for this trigger")).toBeTruthy();
  });

  it("shows a trigger card: schedule, next three runs, agent, action, landing, report, profile and the allow list", () => {
    const preview = triggerPreview({
      allow: [{ tool: "send_email", destination: "ana@example.com", actionClass: "send", label: "Send an email" }],
      skillNeeds: ["Bash(git:*)"],
    });
    const { container } = card(approval({ actionClass: "configure", lengths: ["once"], preview }));
    const facts = container.querySelector('dl[aria-label="Trigger"]')!;
    const text = facts.textContent!;
    expect(text).toContain("Every day at 09:00 (Asia/Macau)");
    expect(facts.querySelectorAll(".preview-runs li")).toHaveLength(3);
    expect(text).toContain("Dot");
    expect(text).toContain("Run this prompt: Check the weather.");
    expect(text).toContain("A new chat each run");
    expect(text).toContain("Only when something changed");
    expect(text).toContain("Hide in chat list");
    expect(text).toContain("Standard");
    expect(text).toContain("120 min");
    expect(text).toContain("Send an email · ana@example.com");
    expect(facts.querySelector(".preview-allow .class-chip")?.textContent).toBe("Send");
    expect(text).toContain("The skill needs");
    expect(text).toContain("Bash(git:*)");
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("says plainly when a change raises a trigger to YOLO, with the level it had before", () => {
    const preview = triggerPreview({
      op: "update",
      profile: "yolo",
      before: { ...triggerPreview(), profile: "standard" },
    });
    const { container } = card(approval({ actionClass: "configure", lengths: ["once"], preview }));
    const facts = container.querySelector('dl[aria-label="Trigger"]')!;
    expect(facts.textContent).toContain("YOLO: built-in actions run without asking");
    expect(facts.querySelector(".preview-before")?.textContent).toBe("Standard");
  });

  it("shows what happens to a missed run and to a firing while the last run is going, and what changed", () => {
    const preview = triggerPreview({
      catchUp: "skip",
      overlap: "queue",
      before: { ...triggerPreview(), name: "Morning check" },
    });
    const { container } = card(approval({ actionClass: "configure", lengths: ["once"], preview }));
    const facts = container.querySelector('dl[aria-label="Trigger"]')!;
    expect(facts.textContent).toContain("If a run is missed");
    expect(facts.textContent).toContain("Skip it");
    expect(facts.textContent).toContain("Run it once when back");
    expect(facts.textContent).toContain("If the last run is still going");
    expect(facts.textContent).toContain("Run it after");
  });

  it("leaves the Reports row out for a notify action, and the label's trailing period out of the allow row", () => {
    const preview = triggerPreview({
      action: { kind: "notify", message: "Pay rent" },
      allow: [
        {
          tool: "send_email",
          destination: "ana@example.com",
          actionClass: "send",
          label: "Send a message to someone.",
        },
      ],
    });
    const { container } = card(approval({ actionClass: "configure", lengths: ["once"], preview }));
    const facts = container.querySelector('dl[aria-label="Trigger"]')!;
    expect(facts.textContent).not.toContain("Reports");
    expect(facts.textContent).not.toContain("Chat list");
    expect(facts.querySelector(".preview-allow li span")?.textContent).toBe(
      "Send a message to someone · ana@example.com",
    );
  });

  it("shows what an update changes, striking out the old value", () => {
    const { before: _b, ...rest } = triggerPreview();
    const preview = triggerPreview({
      op: "update",
      name: "Evening check",
      startText: "Every day at 18:00 (Asia/Macau)",
      before: { ...rest, name: "Morning check", startText: "Every day at 09:00 (Asia/Macau)" },
    });
    const { container } = card(approval({ actionClass: "configure", lengths: ["once"], preview }));
    const dels = [...container.querySelectorAll(".preview-before")].map((d) => d.textContent);
    expect(dels).toEqual(["Morning check", "Every day at 09:00 (Asia/Macau)"]);
  });

  it("shows a delete card briefly", () => {
    const { container } = card(
      approval({
        actionClass: "configure",
        lengths: ["once"],
        preview: triggerPreview({ op: "delete", nextRuns: [] }),
      }),
    );
    expect(container.querySelector('dl[aria-label="Trigger to delete"]')?.textContent).toContain("Morning check");
    expect(container.querySelector(".preview-runs")).toBeNull();
  });

  it("shows a skill card with SKILL.md rendered, and a diff behind a toggle when there is one", () => {
    const preview: SkillPreview = {
      kind: "skill",
      op: "update",
      name: "weekly-review",
      description: "Summarise the week.",
      skillMd: SKILL_MD,
      files: ["scripts/run.py"],
      fromVersion: 2,
      diff: "--- v2\n+++ new\n@@ -1,2 +1,2 @@\n-old line\n+new line\n same",
    };
    const { container } = card(approval({ actionClass: "configure", lengths: ["once"], preview }));
    const facts = container.querySelector('dl[aria-label="Skill"]')!.textContent!;
    expect(facts).toContain("weekly-review");
    expect(facts).toContain("A new version (changes version 2)");
    expect(facts).toContain("scripts/run.py");
    expect(screen.getByRole("heading", { name: "Weekly review" })).toBeTruthy();
    expect(container.querySelector(".skill-front")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show diff" }));
    const lines = [...container.querySelectorAll(".diff-line")].map((l) => [
      l.getAttribute("data-kind"),
      l.textContent?.trim(),
    ]);
    expect(lines).toContainEqual(["add", "+new line"]);
    expect(lines).toContainEqual(["del", "-old line"]);
    expect(screen.queryByRole("heading", { name: "Weekly review" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show SKILL.md" }));
    expect(screen.getByRole("heading", { name: "Weekly review" })).toBeTruthy();
  });

  it("labels the SKILL.md box and keeps the toggle in its header", () => {
    const { container } = card(
      approval({
        actionClass: "configure",
        lengths: ["once"],
        preview: { kind: "skill", op: "update", name: "x", description: "d", skillMd: SKILL_MD, files: [], diff: "+a" },
      }),
    );
    const head = container.querySelector(".preview-skill-head")!;
    expect(head.textContent).toContain("SKILL.md");
    fireEvent.click(within(head as HTMLElement).getByRole("button", { name: "Show diff" }));
    expect(container.querySelector(".preview-skill-head")!.textContent).toContain("Changes");
  });

  it("hides raw arguments behind a toggle on a decided card that has a preview", () => {
    const preview: SkillPreview = {
      kind: "skill",
      op: "create",
      name: "x",
      description: "d",
      skillMd: SKILL_MD,
      files: [],
    };
    card(approval({ status: "approved", grantLength: "once", decidedAt: 1, preview }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.queryByRole("group", { name: "Exact arguments" })).toBeNull();
    const raw = screen.getByRole("button", { name: "Raw arguments" });
    expect(raw.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(raw);
    expect(raw.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "Exact arguments" })).toBeTruthy();
  });

  it("shows the arguments at once on a decided card with no preview", () => {
    card(approval({ status: "approved", grantLength: "once", decidedAt: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.queryByRole("button", { name: "Raw arguments" })).toBeNull();
    expect(screen.getByRole("group", { name: "Exact arguments" })).toBeTruthy();
  });

  it("offers no diff toggle for a new skill", () => {
    card(
      approval({
        actionClass: "configure",
        lengths: ["once"],
        preview: { kind: "skill", op: "create", name: "x", description: "d", skillMd: SKILL_MD, files: [] },
      }),
    );
    expect(screen.queryByRole("button", { name: "Show diff" })).toBeNull();
    expect(screen.getByText("A new skill")).toBeTruthy();
  });
});

describe("approval card: a connector tool", () => {
  it("shows the MCP profile and permits only this exact call", async () => {
    const a = approval({
      connector: "mcp",
      operation: "call",
      destination: "con_n1.search",
      actionClass: "read_external",
      lengths: ["once"],
      argsPreview: JSON.stringify({ arguments: { query: "test receipt" } }),
      preview: {
        kind: "mcp-provider",
        connectorId: "con_n1",
        connectorName: "Notes",
        url: "https://notes.example/mcp",
        tool: "search",
        claimedReadOnly: true,
        mcpProfile: "always_ask",
      },
    });
    const onDecide = vi.fn().mockResolvedValue({ ...a, status: "approved", grantLength: "once", decidedAt: 9 });
    const { container } = card(a, onDecide);
    expect(container.querySelector(".class-chip")?.textContent).toBe("Read outside content");
    expect(screen.getByText("Notes · Search")).toBeTruthy();
    expect(screen.getByText("query “test receipt”")).toBeTruthy();
    expect(screen.queryByText("https://notes.example/mcp")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("https://notes.example/mcp")).toBeTruthy();
    expect(screen.getByText(/Read-only \(provider claim/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review connector permissions" }).getAttribute("href")).toBe(
      "/settings/connectors/con_n1",
    );
    expect(container.querySelector(".approval-note")?.textContent).toBe(
      "Only this exact call. Review connector permissions.",
    );
    expect(screen.queryByRole("radio", { name: "Always" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("ap1", { decision: "approve", length: "once" }));
  });

  it("puts an alert icon on the receipt when an approved call failed", () => {
    const { container } = card(approval({ status: "approved", grantLength: "once", execution: "failed" }));
    expect(container.querySelector(".approval-icon")?.classList.contains("text-destructive")).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Failed");
  });

  const mcp = approval({ connector: "mcp", operation: "call", destination: "con_n1.notion-create-pages" });
  const show = (names: Map<string, string>) =>
    render(
      <ConnectorNamesContext.Provider value={names}>
        <ul>
          <MessageItem
            message={message({ id: "m-mcp", role: "approval", status: "complete", runId: null, approval: mcp })}
            onDecide={vi.fn() as never}
          />
        </ul>
      </ConnectorNamesContext.Provider>,
    );

  it("names the app and the tool instead of the connector id", () => {
    const { container } = show(new Map([["con_n1", "Notion"]]));
    const facts = container.querySelector(".approval-facts")!;
    expect(facts.textContent).toContain("AppNotion");
    expect(facts.textContent).toContain("Toolnotion-create-pages");
    expect(facts.textContent).not.toContain("con_n1");
    expect(facts.textContent).not.toContain("mcp · call");
  });

  it("says a connected app when the name isn't known", () => {
    const { container } = show(new Map());
    expect(container.querySelector(".approval-facts")!.textContent).toContain("A connected app");
  });
});
