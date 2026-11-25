import type { Agent } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { triggerHref } from "../lib/route.ts";
import { skillSummary, trigger, triggerRun } from "../test/fixtures.ts";
import { TriggersPage } from "./TriggersPage.tsx";

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

function setup(api: Record<string, unknown>, id: string | null = null, rev = 0, people: Agent[] = agents) {
  const onClosed = vi.fn();
  const el = (r: number) => (
    <TriggersPage api={api as unknown as Api} agents={people} id={id} rev={r} onClosed={onClosed} />
  );
  const view = render(el(rev));
  return { view, onClosed, rerender: (r: number) => view.rerender(el(r)) };
}

const detail = (over = {}, runs = [triggerRun()], next: string | null = null) =>
  vi.fn().mockResolvedValue({ trigger: trigger(over), runs, next });

describe("TriggersPage: the list", () => {
  it("shows each trigger's name, schedule, next run, status chip and last run", async () => {
    const getTriggers = vi.fn().mockResolvedValue({
      triggers: [
        trigger(),
        trigger({
          id: "t2",
          name: "Rent",
          status: "paused",
          pausedReason: "failures",
          nextRunAt: null,
          lastRun: triggerRun({ status: "failed", reason: "model_error" }),
        }),
        trigger({ id: "t3", name: "Flight", status: "done", nextRunAt: null }),
      ],
    });
    setup({ getTriggers });
    const list = await screen.findByRole("list", { name: "Triggers" });
    const rows = within(list).getAllByRole("link");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.getAttribute("href")).toBe("/settings/triggers/trg1");
    expect(rows[0]!.textContent).toContain("Morning check");
    expect(rows[0]!.textContent).toContain("Every day at 09:00 (Asia/Macau)");
    expect(rows[0]!.textContent).toMatch(/Next: /);
    expect(within(rows[0]!).getByText("Active").getAttribute("data-variant")).toBe("success");
    expect(rows[0]!.textContent).toContain("Hasn't run yet");
    expect(within(rows[1]!).getByText("Paused after failures").getAttribute("data-variant")).toBe("attention");
    expect(rows[1]!.textContent).toContain("Last: Failed: model_error");
    expect(rows[1]!.textContent).not.toMatch(/Next: /);
    expect(rows[2]!.textContent).toContain("Done");
  });

  it("lists the event sources, read-only, and the last event of an event trigger", async () => {
    const getEventSources = vi.fn().mockResolvedValue({
      sources: [
        {
          id: "feed",
          name: "Feed",
          status: "active",
          lastEventAt: Date.now() - 60_000,
          types: ["items.changed", "items.new"],
        },
        { id: "quiet", name: "quiet", status: "disabled", lastEventAt: null, types: [] },
      ],
    });
    const getTriggers = vi.fn().mockResolvedValue({
      triggers: [
        trigger({
          start: { kind: "event", source: "feed", types: ["items.new"] },
          startText: "When items.new arrives from source feed",
          nextRunAt: null,
          lastEventAt: Date.now() - 120_000,
        }),
        trigger({ id: "t2", start: { kind: "event", source: "quiet", types: ["*"] }, nextRunAt: null }),
      ],
    });
    setup({ getTriggers, getEventSources });
    const sources = await screen.findByRole("list", { name: "Event sources" });
    const rows = within(sources).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("Feed (feed)");
    expect(within(rows[0]!).getByText("Active").getAttribute("data-variant")).toBe("success");
    expect(rows[0]!.textContent).toMatch(/Last event: /);
    expect(rows[0]!.textContent).toContain("Types: items.changed, items.new");
    expect(within(rows[1]!).getByText("Disabled").getAttribute("data-variant")).toBe("secondary");
    expect(rows[1]!.textContent).toContain("No events yet");
    expect(within(sources).queryByRole("button")).toBeNull();
    const list = await screen.findByRole("list", { name: "Triggers" });
    const triggerRows = within(list).getAllByRole("link");
    expect(triggerRows[0]!.textContent).toContain("When items.new arrives from source feed");
    expect(triggerRows[0]!.textContent).toMatch(/Last event: /);
    expect(triggerRows[0]!.textContent).not.toMatch(/Next: /);
    expect(triggerRows[1]!.textContent).toContain("No events yet");
  });

  it("shows no sources section when there are none or they cannot be read", async () => {
    setup({
      getTriggers: vi.fn().mockResolvedValue({ triggers: [trigger()] }),
      getEventSources: vi.fn().mockRejectedValue(new Error("nope")),
    });
    await screen.findByRole("list", { name: "Triggers" });
    expect(screen.queryByRole("list", { name: "Event sources" })).toBeNull();
  });

  it("names the agent only when there is more than one", async () => {
    const two: Agent[] = [...agents, { ...agents[0]!, id: "a2", name: "Rex" }];
    setup({ getTriggers: vi.fn().mockResolvedValue({ triggers: [trigger({ agentId: "a2" })] }) }, null, 0, two);
    expect((await screen.findByRole("link", { name: /Morning check/ })).textContent).toContain("Rex");
  });

  it("offers to create a trigger when there are none", async () => {
    setup({ getTriggers: vi.fn().mockResolvedValue({ triggers: [] }) });
    expect(await screen.findByText("No triggers yet.")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "New trigger" }).disabled).toBe(false);
  });

  it("shows an error with Try again, and refetches when the stream says something changed", async () => {
    const getTriggers = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(0, "network_error", ""))
      .mockResolvedValue({ triggers: [trigger()] });
    const { rerender } = setup({ getTriggers });
    expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the server");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("link", { name: /Morning check/ });
    rerender(1);
    await waitFor(() => expect(getTriggers).toHaveBeenCalledTimes(3));
  });
});

describe("TriggersPage: creation", () => {
  it("creates a scheduled trigger and opens its detail", async () => {
    const createTrigger = vi.fn().mockResolvedValue({ trigger: trigger() });
    const previousPath = window.location.href;
    setup({ getTriggers: vi.fn().mockResolvedValue({ triggers: [] }), createTrigger });
    try {
      fireEvent.click(screen.getByRole("button", { name: "New trigger" }));
      const form = within(screen.getByRole("form", { name: "New trigger" }));
      const submit = form.getByRole<HTMLButtonElement>("button", { name: "Create trigger" });
      expect(submit.disabled).toBe(true);
      expect(document.activeElement).toBe(form.getByLabelText("Name"));
      fireEvent.change(form.getByLabelText("Name"), { target: { value: "Morning check" } });
      fireEvent.change(form.getByLabelText("Prompt"), { target: { value: "Check the weather." } });
      fireEvent.change(form.getByLabelText("Time zone"), { target: { value: "Asia/Macau" } });
      fireEvent.click(submit);
      await waitFor(() => expect(window.location.pathname).toBe(triggerHref("trg1")));
      expect(createTrigger).toHaveBeenCalledWith({
        agentId: "a1",
        name: "Morning check",
        start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "Asia/Macau" } },
        action: { kind: "prompt", prompt: "Check the weather." },
        landing: "new",
        report: "never",
        hideInList: false,
        catchUp: "once",
        overlap: "skip",
        profile: "standard",
      });
    } finally {
      window.history.replaceState(null, "", previousPath);
    }
  });

  it("keeps an event trigger draft when creation fails and cancels without another request", async () => {
    const createTrigger = vi.fn().mockRejectedValue(new ApiError(400, "bad_request", "The event source changed."));
    setup(
      {
        getTriggers: vi.fn().mockResolvedValue({ triggers: [] }),
        getEventSources: vi.fn().mockResolvedValue({
          sources: [{ id: "feed", name: "Feed", status: "active", lastEventAt: null, types: [] }],
        }),
        createTrigger,
      },
      null,
      0,
      [...agents, { ...agents[0]!, id: "a2", name: "Rei", defaultProfile: "strict" }],
    );
    await screen.findByRole("list", { name: "Event sources" });
    fireEvent.click(screen.getByRole("button", { name: "New trigger" }));
    const form = within(screen.getByRole("form", { name: "New trigger" }));
    fireEvent.change(form.getByLabelText("Agent"), { target: { value: "a2" } });
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "Feed update" } });
    fireEvent.change(form.getByLabelText("Starts"), { target: { value: "event" } });
    fireEvent.change(form.getByLabelText("Event source"), { target: { value: "feed" } });
    fireEvent.change(form.getByLabelText("Event types"), { target: { value: "items.new" } });
    fireEvent.change(form.getByLabelText("Action"), { target: { value: "notify" } });
    fireEvent.change(form.getByLabelText("Message"), { target: { value: "The feed changed." } });
    fireEvent.click(form.getByRole("button", { name: "Create trigger" }));
    expect((await form.findByRole("alert")).textContent).toBe("The event source changed.");
    expect(createTrigger).toHaveBeenCalledWith({
      agentId: "a2",
      name: "Feed update",
      start: { kind: "event", source: "feed", types: ["items.new"] },
      action: { kind: "notify", message: "The feed changed." },
      landing: "new",
      report: "never",
      hideInList: false,
      profile: "strict",
    });
    expect(form.getByLabelText<HTMLInputElement>("Name").value).toBe("Feed update");
    fireEvent.click(form.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Triggers" })).toBeTruthy();
    expect(createTrigger).toHaveBeenCalledTimes(1);
  });

  it("couples Chat list visibility to Report by default and preserves manual overrides", async () => {
    const createTrigger = vi.fn().mockResolvedValue({ trigger: trigger({ report: "on_change", hideInList: false }) });
    const previousPath = window.location.href;
    setup({ getTriggers: vi.fn().mockResolvedValue({ triggers: [] }), createTrigger });
    try {
      fireEvent.click(screen.getByRole("button", { name: "New trigger" }));
      const form = within(screen.getByRole("form", { name: "New trigger" }));
      const reportSelect = form.getByLabelText<HTMLSelectElement>("Report to your chat");
      const listSelect = form.getByLabelText<HTMLSelectElement>("Chat list");
      expect(reportSelect.value).toBe("never");
      expect(listSelect.value).toBe("show");
      // Switching to a reporting trigger defaults to hiding from the chat list.
      fireEvent.change(reportSelect, { target: { value: "on_change" } });
      expect(listSelect.value).toBe("hide");
      // Switching back to never returns to showing in the chat list.
      fireEvent.change(reportSelect, { target: { value: "never" } });
      expect(listSelect.value).toBe("show");
      // Switching to always hides again, and a manual override to show is preserved.
      fireEvent.change(reportSelect, { target: { value: "always" } });
      expect(listSelect.value).toBe("hide");
      fireEvent.change(listSelect, { target: { value: "show" } });
      fireEvent.change(reportSelect, { target: { value: "on_change" } });
      expect(listSelect.value).toBe("show");
      fireEvent.change(form.getByLabelText("Name"), { target: { value: "Visible watcher" } });
      fireEvent.change(form.getByLabelText("Prompt"), { target: { value: "Check prices." } });
      fireEvent.change(form.getByLabelText("Time zone"), { target: { value: "Asia/Macau" } });
      fireEvent.click(form.getByRole("button", { name: "Create trigger" }));
      await waitFor(() => expect(createTrigger).toHaveBeenCalledOnce());
      expect(createTrigger).toHaveBeenCalledWith(expect.objectContaining({ report: "on_change", hideInList: false }));
    } finally {
      window.history.replaceState(null, "", previousPath);
    }
  });
});

describe("TriggersPage: a trigger", () => {
  it("shows its status, schedule, next run and run history with status, reason, time, duration, attempt, report and chat link", async () => {
    const runs = [
      triggerRun({
        id: "r1",
        status: "failed",
        reason: "model_error",
        attempt: 1,
        report: "Couldn't check: the model failed",
      }),
      triggerRun({ id: "r2", status: "skipped", reason: "late", startedAt: null, finishedAt: null, sessionId: null }),
      triggerRun({ id: "r3", status: "waiting", finishedAt: null, manual: true }),
    ];
    setup({ getTrigger: detail({}, runs) }, "trg1");
    expect(await screen.findByRole("heading", { name: "Morning check" })).toBeTruthy();
    expect(screen.getByText("Every day at 09:00 (Asia/Macau)", { selector: ".cfg-summary-line span" })).toBeTruthy();
    expect(screen.getByText(/Next run:/)).toBeTruthy();
    const items = within(screen.getByRole("list", { name: "Runs" })).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Failed: model_error");
    expect(items[0]!.textContent).toContain("Took 42 s");
    expect(items[0]!.textContent).toContain("Attempt 2");
    expect(items[0]!.textContent).toContain("Couldn't check: the model failed");
    expect(
      within(items[0]!)
        .getByRole("link", { name: /Open chat/ })
        .getAttribute("href"),
    ).toBe("/s/s9");
    expect(items[1]!.textContent).toContain("Skipped (late)");
    expect(within(items[1]!).queryByRole("link")).toBeNull();
    expect(items[2]!.textContent).toContain("Waiting for you");
    expect(items[2]!.textContent).toContain("Run now");
  });

  it("puts the run history above the settings form", async () => {
    setup({ getTrigger: detail({}, [triggerRun({ id: "r1" })]) }, "trg1");
    const runs = await screen.findByRole("list", { name: "Runs" });
    const settings = screen.getByRole("form", { name: "Settings" });
    expect(runs.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("loads older runs from the page cursor", async () => {
    const getTrigger = vi
      .fn()
      .mockResolvedValueOnce({ trigger: trigger(), runs: [triggerRun({ id: "r1" })], next: "r1" })
      .mockResolvedValueOnce({ trigger: trigger(), runs: [triggerRun({ id: "r0" })], next: null });
    setup({ getTrigger }, "trg1");
    fireEvent.click(await screen.findByRole("button", { name: "Show older runs" }));
    await waitFor(() =>
      expect(within(screen.getByRole("list", { name: "Runs" })).getAllByRole("listitem")).toHaveLength(2),
    );
    expect(getTrigger).toHaveBeenLastCalledWith("trg1", "r1");
    expect(screen.queryByRole("button", { name: "Show older runs" })).toBeNull();
  });

  it("shows the 5 most recent runs first, and reveals more without a new request", async () => {
    const runs = Array.from({ length: 7 }, (_, i) => triggerRun({ id: `r${i}` }));
    const getTrigger = vi.fn().mockResolvedValueOnce({ trigger: trigger(), runs, next: null });
    setup({ getTrigger }, "trg1");
    const list = await screen.findByRole("list", { name: "Runs" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show older runs" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: "Show older runs" })).toBeNull();
    expect(getTrigger).toHaveBeenCalledTimes(1);
  });

  it("says so when the trigger no longer exists", async () => {
    setup({ getTrigger: vi.fn().mockRejectedValue(new ApiError(404, "not_found", "")) }, "gone");
    expect(await screen.findByText("This trigger no longer exists.")).toBeTruthy();
  });

  it("runs it now and says when it was skipped for overlap", async () => {
    const getTrigger = detail();
    const runTrigger = vi
      .fn()
      .mockResolvedValueOnce({ run: triggerRun() })
      .mockResolvedValueOnce({ run: triggerRun({ status: "skipped", reason: "overlap" }) });
    setup({ getTrigger, runTrigger }, "trg1");
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
    expect((await screen.findByText("Started a run.")).getAttribute("role")).toBe("status");
    expect(runTrigger).toHaveBeenCalledWith("trg1");
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("Not started: the last run is still going.")).toBeTruthy();
  });

  it("says when a run now was queued behind the running one, and lists queued and missed runs", async () => {
    const runs = [
      triggerRun({ id: "q1", status: "queued", startedAt: null, finishedAt: null, sessionId: null }),
      triggerRun({ id: "m1", status: "skipped", reason: "missed", startedAt: null, finishedAt: null, sessionId: null }),
    ];
    const runTrigger = vi
      .fn()
      .mockResolvedValue({ run: triggerRun({ status: "queued", startedAt: null, finishedAt: null }) });
    setup({ getTrigger: detail({}, runs), runTrigger }, "trg1");
    const items = within(await screen.findByRole("list", { name: "Runs" })).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Queued");
    expect(items[1]!.textContent).toContain("Skipped (missed)");
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("Queued: it starts when the last run ends.")).toBeTruthy();
  });

  it("pauses an active trigger and resumes a paused one; a done one has neither", async () => {
    const updateTrigger = vi.fn().mockResolvedValue({ trigger: trigger({ status: "paused", pausedReason: "user" }) });
    const paused = { trigger: trigger({ status: "paused", pausedReason: "user" }), runs: [], next: null };
    const getTrigger = vi
      .fn()
      .mockResolvedValueOnce({ trigger: trigger(), runs: [], next: null })
      .mockResolvedValue(paused);
    const first = setup({ getTrigger, updateTrigger }, "trg1");
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(updateTrigger).toHaveBeenCalledWith("trg1", { paused: true }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    first.view.unmount();

    const resume = vi.fn().mockResolvedValue({ trigger: trigger() });
    const second = setup(
      { getTrigger: detail({ status: "paused", pausedReason: "failures", failures: 3 }), updateTrigger: resume },
      "trg1",
    );
    expect((await screen.findByText(/Paused after 3 failed runs in a row/)).textContent).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("trg1", { paused: false }));
    second.view.unmount();

    setup({ getTrigger: detail({ status: "done", nextRunAt: null }) }, "trg1");
    await screen.findByRole("heading", { name: "Morning check" });
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("refetches when the stream says it changed", async () => {
    const getTrigger = detail();
    const { rerender } = setup({ getTrigger }, "trg1");
    await screen.findByRole("heading", { name: "Morning check" });
    rerender(1);
    await waitFor(() => expect(getTrigger).toHaveBeenCalledTimes(2));
  });
});

describe("TriggersPage: settings", () => {
  const open = async (over = {}, extra: Record<string, unknown> = {}) => {
    const api = {
      getTrigger: detail(over),
      updateTrigger: vi.fn().mockImplementation(async (_id, req) => ({ trigger: trigger({ ...over, ...req }) })),
      ...extra,
    };
    setup(api, "trg1");
    await screen.findByRole("form", { name: "Settings" });
    return api;
  };
  const save = () => screen.getByRole("button", { name: "Save" });

  it("has Save off until something changes, then sends only what changed", async () => {
    const api = await open();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Evening check" } });
    fireEvent.change(screen.getByLabelText("Report to your chat"), { target: { value: "always" } });
    fireEvent.change(screen.getByLabelText("Skip if late by (minutes)"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Check the news." } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateTrigger).toHaveBeenCalledWith("trg1", {
        name: "Evening check",
        report: "always",
        latenessMinutes: 30,
        action: { kind: "prompt", prompt: "Check the news." },
      }),
    );
    expect((await screen.findByText("Saved.")).getAttribute("role")).toBe("status");
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it("edits the schedule: times, days and zone round-trip into the request", async () => {
    const api = await open();
    fireEvent.click(screen.getByRole("button", { name: "Add a time" }));
    fireEvent.change(screen.getByLabelText("Time 2"), { target: { value: "18:30" } });
    fireEvent.click(screen.getByLabelText("Mon"));
    fireEvent.click(screen.getByLabelText("Fri"));
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/London" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateTrigger).toHaveBeenCalledWith("trg1", {
        start: {
          kind: "schedule",
          schedule: { kind: "daily", times: ["09:00", "18:30"], days: ["mon", "fri"], timeZone: "Europe/London" },
        },
      }),
    );
  });

  it("switches kind: a one-time schedule needs a date, an interval checks its bounds", async () => {
    const api = await open();
    fireEvent.change(screen.getByLabelText("Repeats"), { target: { value: "once" } });
    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: "2031-02-03T04:05" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateTrigger).toHaveBeenCalledWith("trg1", {
        start: { kind: "schedule", schedule: { kind: "once", at: "2031-02-03T04:05", timeZone: "Asia/Macau" } },
      }),
    );

    fireEvent.change(screen.getByLabelText("Repeats"), { target: { value: "interval" } });
    fireEvent.change(screen.getByLabelText("Every (minutes)"), { target: { value: "5" } });
    expect(screen.getByText(/15 to 1440/)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Every (minutes)"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: "22:00" } });
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the events a run was started for, and how many were not kept", async () => {
    const run = triggerRun({
      events: [
        { id: "e1", type: "items.new", ref: "item_1", receivedAt: 1_700_000_000_000 },
        { id: "e2", type: "items.changed", ref: "item_2", receivedAt: 1_700_000_005_000 },
      ],
      droppedEvents: 3,
    });
    setup(
      {
        getTrigger: detail(
          {
            start: { kind: "event", source: "feed", types: ["*"] },
            startText: "When any event arrives from source feed",
            nextRunAt: null,
            lastEventAt: 1_700_000_005_000,
          },
          [run],
        ),
      },
      "trg1",
    );
    const events = await screen.findByRole("list", { name: "Events" });
    expect(
      within(events)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining("items.new: item_1"),
      expect.stringContaining("items.changed: item_2"),
      "3 earlier events not kept",
    ]);
    expect(screen.getByText(/Last event: /)).toBeTruthy();
  });

  it("edits an event trigger: source and types, with no lateness, catch-up or overlap", async () => {
    const api = await open({
      start: { kind: "event", source: "feed", types: ["items.new"] },
      startText: "When items.new arrives from source feed",
    });
    expect(screen.queryByLabelText(/Skip if late/)).toBeNull();
    expect(screen.queryByLabelText("If a run is missed")).toBeNull();
    expect(screen.queryByLabelText("If the last run is still going")).toBeNull();
    fireEvent.change(screen.getByLabelText("Event types"), { target: { value: "items.new, items.changed" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateTrigger).toHaveBeenCalledWith("trg1", {
        start: { kind: "event", source: "feed", types: ["items.new", "items.changed"] },
      }),
    );
  });

  it("offers a monthly day and its times", async () => {
    const api = await open({
      start: { kind: "schedule", schedule: { kind: "monthly", day: 1, times: ["09:00"], timeZone: "Asia/Macau" } },
    });
    expect((screen.getByLabelText("Day of the month") as HTMLSelectElement).value).toBe("1");
    fireEvent.change(screen.getByLabelText("Day of the month"), { target: { value: "last" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateTrigger).toHaveBeenCalledWith("trg1", {
        start: {
          kind: "schedule",
          schedule: { kind: "monthly", day: "last", times: ["09:00"], timeZone: "Asia/Macau" },
        },
      }),
    );
  });

  it("refuses an empty name or prompt with a sentence, and shows the server's sentence when it refuses", async () => {
    const api = await open(
      {},
      {
        updateTrigger: vi
          .fn()
          .mockRejectedValue(new ApiError(400, "bad_request", "The schedule's time zone is unknown.")),
      },
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " " } });
    expect(screen.getByText("Give the trigger a name.")).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Morning check" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "" } });
    expect(screen.getByText("Write the prompt to run.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Go" } });
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Mars/Base" } });
    fireEvent.click(save());
    expect((await screen.findByRole("alert")).textContent).toBe("The schedule's time zone is unknown.");
    expect(api.updateTrigger).toHaveBeenCalled();
  });

  it("edits a notify message and a skill's arguments, and hides what doesn't apply to a notify", async () => {
    const notify = await open({ action: { kind: "notify", message: "Pay rent" } });
    expect(screen.queryByLabelText("Permissions for its runs")).toBeNull();
    expect(screen.queryByLabelText("Where it runs")).toBeNull();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Pay rent today" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(notify.updateTrigger).toHaveBeenCalledWith("trg1", {
        action: { kind: "notify", message: "Pay rent today" },
      }),
    );
    cleanupAll();
    const skill = await open({ action: { kind: "skill", skill: "weekly-review", args: "last week" } });
    expect((screen.getByLabelText("Skill") as HTMLSelectElement).value).toBe("weekly-review");
    fireEvent.change(screen.getByLabelText("Arguments (optional)"), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(skill.updateTrigger).toHaveBeenCalledWith("trg1", { action: { kind: "skill", skill: "weekly-review" } }),
    );
  });

  it("picks what to do when a run is missed and when the last run is still going", async () => {
    const api = await open();
    expect((screen.getByLabelText("If a run is missed") as HTMLSelectElement).value).toBe("once");
    expect(
      [...(screen.getByLabelText("If a run is missed") as HTMLSelectElement).options].map((o) => o.textContent),
    ).toEqual(["Run it once when back", "Skip it"]);
    expect(
      [...(screen.getByLabelText("If the last run is still going") as HTMLSelectElement).options].map(
        (o) => o.textContent,
      ),
    ).toEqual(["Skip this run", "Run it after"]);
    fireEvent.change(screen.getByLabelText("If a run is missed"), { target: { value: "skip" } });
    fireEvent.change(screen.getByLabelText("If the last run is still going"), { target: { value: "queue" } });
    fireEvent.click(save());
    await waitFor(() => expect(api.updateTrigger).toHaveBeenCalledWith("trg1", { catchUp: "skip", overlap: "queue" }));
  });

  it("hides the overlap choice for a notify, which cannot overlap", async () => {
    await open({ action: { kind: "notify", message: "Pay rent" } });
    expect(screen.getByLabelText("If a run is missed")).toBeTruthy();
    expect(screen.queryByLabelText("If the last run is still going")).toBeNull();
  });

  it("switches the kind: notify and prompt share the text, a skill is picked from the agent's saved skills", async () => {
    const skills = [
      skillSummary({ id: "k1", name: "weekly-review" }),
      skillSummary({ id: "k2", name: "mine-only", agents: ["a1"] }),
      skillSummary({ id: "k3", name: "not-mine", agents: ["a2"] }),
    ];
    const getSkills = vi.fn().mockResolvedValue({ skills });
    const api = await open({}, { getSkills });
    expect(getSkills).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "notify" } });
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
      "Check the weather and tell me if I need an umbrella.",
    );
    expect(screen.queryByLabelText("Permissions for its runs")).toBeNull();
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateTrigger).toHaveBeenCalledWith("trg1", {
        action: { kind: "notify", message: "Check the weather and tell me if I need an umbrella." },
      }),
    );
    cleanupAll();

    const second = await open({}, { getSkills: vi.fn().mockResolvedValue({ skills }) });
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "skill" } });
    expect(screen.getByText("Choose the skill to run.")).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() =>
      expect([...(screen.getByLabelText("Skill") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
        "Choose a skill…",
        "weekly-review",
        "mine-only",
      ]),
    );
    fireEvent.change(screen.getByLabelText("Skill"), { target: { value: "mine-only" } });
    fireEvent.change(screen.getByLabelText("Arguments (optional)"), { target: { value: "last week" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(second.updateTrigger).toHaveBeenCalledWith("trg1", {
        action: { kind: "skill", skill: "mine-only", args: "last week" },
      }),
    );
  });

  it("shows a skill that no longer exists as missing, and refuses an empty prompt after switching back", async () => {
    await open(
      { action: { kind: "skill", skill: "gone" } },
      { getSkills: vi.fn().mockResolvedValue({ skills: [skillSummary({ name: "weekly-review" })] }) },
    );
    await waitFor(() =>
      expect([...(screen.getByLabelText("Skill") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
        "weekly-review",
        "gone (missing)",
      ]),
    );
    expect((screen.getByLabelText("Skill") as HTMLSelectElement).value).toBe("gone");
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "prompt" } });
    expect(screen.getByText("Write the prompt to run.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Do it" } });
    expect(screen.queryByText("Write the prompt to run.")).toBeNull();
  });

  it("changes where it runs, the permission level, and removes allow entries with their class label", async () => {
    const allow = [
      { tool: "send_email", destination: "ana@example.com", actionClass: "send" as const, label: "Send an email" },
      { tool: "write_file", actionClass: "write_external" as const, label: "Write a file" },
    ];
    const api = await open({ allow });
    const list = screen.getByRole("list", { name: "Allowed without asking" });
    expect(list.textContent).toContain("Send an email");
    expect(list.textContent).toContain("Send");
    expect(list.textContent).toContain("to ana@example.com");
    expect(list.textContent).toContain("to any destination");
    fireEvent.change(screen.getByLabelText("Where it runs"), { target: { value: "ongoing" } });
    fireEvent.change(screen.getByLabelText("Permissions for its runs"), { target: { value: "strict" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove Send an email to ana@example.com" }));
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateTrigger).toHaveBeenCalledWith("trg1", {
        landing: "ongoing",
        profile: "strict",
        allow: [{ tool: "write_file" }],
      }),
    );
  });

  it("offers the chat's three levels, warns on YOLO, and has no way to add an allow entry", async () => {
    const api = await open();
    const select = screen.getByLabelText("Permissions for its runs") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Strict", "Standard", "YOLO"]);
    expect(screen.queryByText(/could talk the agent into things/)).toBeNull();
    fireEvent.change(select, { target: { value: "yolo" } });
    expect(screen.getByText(/could talk the agent into things/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add .*allow/i })).toBeNull();
    fireEvent.click(save());
    await waitFor(() => expect(api.updateTrigger).toHaveBeenCalledWith("trg1", { profile: "yolo" }));
  });

  it("follows a refetch when you haven't edited, and keeps your edit when you have", async () => {
    const getTrigger = vi
      .fn()
      .mockResolvedValueOnce({ trigger: trigger(), runs: [], next: null })
      .mockResolvedValueOnce({ trigger: trigger({ name: "Renamed elsewhere", updatedAt: 2 }), runs: [], next: null })
      .mockResolvedValueOnce({ trigger: trigger({ name: "Renamed again", updatedAt: 3 }), runs: [], next: null });
    const { rerender } = setup({ getTrigger }, "trg1");
    await screen.findByRole("form", { name: "Settings" });
    rerender(1);
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Renamed elsewhere"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My edit" } });
    rerender(2);
    await waitFor(() => expect(getTrigger).toHaveBeenCalledTimes(3));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("My edit");
  });
});

describe("TriggersPage: delete", () => {
  it("confirms, with the safe choice focused and an option to delete its chats", async () => {
    const deleteTrigger = vi.fn().mockResolvedValue({ ok: true });
    const { onClosed } = setup({ getTrigger: detail(), deleteTrigger }, "trg1");
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete this trigger?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Also delete its chats" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteTrigger).toHaveBeenCalledWith("trg1", { withSessions: true }));
    expect(onClosed).toHaveBeenCalled();
  });

  it("keeps its chats by default, cancels without deleting, and shows an error", async () => {
    const deleteTrigger = vi.fn().mockRejectedValue(new ApiError(500, "http_500", ""));
    const { onClosed } = setup({ getTrigger: detail(), deleteTrigger }, "trg1");
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(deleteTrigger).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteTrigger).toHaveBeenCalledWith("trg1", { withSessions: false }));
    expect((await within(screen.getByRole("alertdialog")).findByRole("alert")).textContent).toContain(
      "Something went wrong",
    );
    expect(onClosed).not.toHaveBeenCalled();
  });
});

function cleanupAll() {
  document.body.innerHTML = "";
}
