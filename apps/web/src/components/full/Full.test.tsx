import type { Agent, StepDetailResponse } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../api/client.ts";
import { ApiError } from "../../api/client.ts";
import type { TraceState } from "../../lib/useTrace.ts";
import { message, run, runTrace, session, step, toolStep } from "../../test/fixtures.ts";
import { ToolActivity } from "../ToolActivity.tsx";
import { AgentSettingsDialog } from "./AgentSettingsDialog.tsx";
import { ForkDialog } from "./ForkDialog.tsx";
import { Inspector } from "./Inspector.tsx";

const asApi = (a: Partial<Record<keyof Api, unknown>>) => a as unknown as Api;

describe("ToolActivity", () => {
  const sum = () => screen.getByRole("button", { name: /^(Worked|Working|Stopped|Failed|Interrupted)/ });

  it("is one quiet summary line until opened, then lists the steps as buttons that open the inspector at that step", () => {
    const onOpen = vi.fn();
    render(
      <ul>
        <ToolActivity
          trace={runTrace({
            steps: [
              step(),
              toolStep({
                id: "st9",
                sideEffect: true,
                toolName: "send_email",
                summary: "Send mail to ana@example.com",
              }),
            ],
          })}
          onOpen={onOpen}
        />
      </ul>,
    );
    expect(sum().textContent).toBe("Worked for 4.0 s");
    expect(screen.queryByText("2 steps · 1 acted outside")).toBeNull();
    expect(sum().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Inspect step:/ })).toBeNull();
    fireEvent.click(sum());
    expect(sum().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("2 steps · 1 acted outside")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: /^Inspect step:/ });
    expect(buttons).toHaveLength(2);
    expect(screen.getAllByText("acted outside")).toHaveLength(1);
    fireEvent.click(buttons[1]!);
    expect(onOpen).toHaveBeenCalledWith("r1", "st9");
    fireEvent.click(sum());
    expect(screen.queryByRole("button", { name: /^Inspect step:/ })).toBeNull();
  });

  it("counts steps and says when a run is going, is waiting for you, or failed", () => {
    const view = (t: ReturnType<typeof runTrace>) => (
      <ul>
        <ToolActivity trace={t} onOpen={() => {}} />
      </ul>
    );
    const steps = Array.from({ length: 7 }, (_, i) => toolStep({ id: `t${i}` }));
    const { rerender } = render(
      view(runTrace({ steps, totals: { modelCalls: 0, toolCalls: 7, tokens: 0, durationMs: 41_000 } })),
    );
    expect(sum().textContent).toBe("Worked for 41 s");
    expect(screen.queryByText("7 steps")).toBeNull();
    rerender(
      view(runTrace({ steps: [steps[0]!], totals: { modelCalls: 0, toolCalls: 1, tokens: 0, durationMs: null } })),
    );
    expect(sum().textContent).toBe("Worked");
    expect(screen.queryByText("1 step")).toBeNull();
    rerender(
      view(
        runTrace({
          run: run({ status: "running" }),
          steps: steps.slice(0, 3),
          totals: { modelCalls: 0, toolCalls: 3, tokens: 0, durationMs: null },
        }),
      ),
    );
    expect(sum().textContent).toBe("Working…");
    expect(screen.getByText("3 steps")).toBeTruthy();
    expect(sum().getAttribute("aria-expanded")).toBe("true");
    rerender(view(runTrace({ steps: [toolStep({ status: "blocked", decision: "ask" })] })));
    expect(sum().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(sum());
    expect(screen.getByText("Needs approval")).toBeTruthy();
    rerender(view(runTrace({ steps: [toolStep({ status: "error" })] })));
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("keeps each run's open state on its own", () => {
    render(
      <ul>
        <ToolActivity trace={runTrace({ run: run({ id: "r1", status: "completed" }) })} onOpen={() => {}} />
        <ToolActivity trace={runTrace({ run: run({ id: "r2", status: "completed" }) })} onOpen={() => {}} />
      </ul>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /^Worked/ })[0]!);
    expect(screen.getAllByRole("button", { name: /^Inspect step:/ })).toHaveLength(2);
  });

  it("draws nothing for a run with no steps", () => {
    const { container } = render(
      <ul>
        <ToolActivity trace={runTrace({ steps: [] })} onOpen={() => {}} />
      </ul>,
    );
    expect(container.querySelector("li")).toBeNull();
  });
});

const traceState = (over: Partial<TraceState> = {}): TraceState => ({
  runs: [runTrace()],
  loaded: true,
  error: null,
  hasOlder: false,
  loadingOlder: false,
  loadOlder: () => {},
  reload: () => {},
  ...over,
});

const llmDetail: StepDetailResponse = {
  step: step(),
  llm: {
    request: {
      model: "gpt-6.1-sol",
      messages: [
        { role: "system", content: "You are Dot.\n\n<memory>\nLikes tea.\n</memory>\n\n<rules>\nBe brief.\n</rules>" },
        { role: "user", content: "Find a hotel" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "x", type: "function", function: { name: "web_search", arguments: '{"q":"hotel"}' } }],
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "web_search", description: "Search the web", parameters: { type: "object" } },
        },
      ],
    },
    response: { choices: [{ message: { role: "assistant", content: "Here you go" } }] },
  },
  payloadBytes: 2048,
  truncated: false,
};

const toolDetail: StepDetailResponse = {
  step: toolStep(),
  tool: {
    input: { q: "hotel <b>x</b>" },
    output: [
      { type: "text", text: "Result <img src=x onerror=alert(1)>" },
      { type: "image", index: 0, mimeType: "image/png" },
    ],
    isError: false,
  },
  payloadBytes: 100,
  truncated: false,
};

function inspector(
  api: Partial<Record<keyof Api, unknown>>,
  over: Partial<React.ComponentProps<typeof Inspector>> = {},
) {
  const onClose = vi.fn();
  const utils = render(
    <Inspector
      id="insp"
      api={asApi(api)}
      session={session()}
      agent={undefined}
      sessions={[session()]}
      trace={traceState()}
      messages={[]}
      focus={{ nonce: 1, runId: "r1", stepId: null }}
      onClose={onClose}
      {...over}
    />,
  );
  return { ...utils, onClose };
}

describe("Inspector", () => {
  it("carries the activity label from the run row into the tool detail title, with technical facts still available", async () => {
    const tool = toolStep({ activity: "Compare hotel prices" });
    const getStep = vi.fn().mockResolvedValue({ ...toolDetail, step: tool });
    inspector({ getStep }, { trace: traceState({ runs: [runTrace({ steps: [tool] })] }) });
    const row = screen.getByRole("button", { name: "Inspect step: Compare hotel prices — Completed" });
    expect(row.textContent).toContain("web_search · read_external");
    fireEvent.click(row);
    await waitFor(() => expect(getStep).toHaveBeenCalledWith("st2"));
    expect(screen.getByText("Compare hotel prices", { selector: ".step-detail-title span" })).toBeTruthy();
    expect(screen.getByText("Tool").nextSibling?.textContent).toBe("web_search");
    expect(screen.getByText("Summary").nextSibling?.textContent).toBe("Search the web");
  });

  it("shows a mid-conversation system message as a prompt update in the order sent, not inside the system prompt", async () => {
    const detail: StepDetailResponse = {
      ...llmDetail,
      llm: {
        ...llmDetail.llm!,
        request: {
          messages: [
            { role: "system", content: "You are Dot.\n\n<memory>\nLikes tea.\n</memory>" },
            { role: "user", content: "Find a hotel" },
            { role: "assistant", content: "On it" },
            {
              role: "system",
              content:
                'Removed system prompt section "memory".\n\nUpdated system prompt section "sessions":\n\n- ses_1 "Say hi" running',
            },
            { role: "user", content: "And?" },
          ],
        },
      },
    };
    const getStep = vi.fn().mockResolvedValue(detail);
    inspector({ getStep });
    fireEvent.click(screen.getByRole("button", { name: /Inspect step: Model call/ }));
    expect(await screen.findByText(/System prompt · 2 sections/)).toBeTruthy();
    expect(screen.getByText(/Messages · 4 \(1 prompt update, in the order sent\)/)).toBeTruthy();
    expect(screen.getByText("prompt update")).toBeTruthy();
    expect(screen.getByText("removed memory · updated sessions")).toBeTruthy();
  });

  it("shows a failed model call's explanation when the step opens", async () => {
    const failed = step({ status: "error", errorCode: "provider_timeout" });
    const message = "The model provider did not answer in time.";
    const getStep = vi.fn().mockResolvedValue({
      ...llmDetail,
      step: failed,
      llm: {
        request: null,
        response: { errorMessage: "Raw provider text" },
        error: { code: "provider_timeout", message },
      },
    } satisfies StepDetailResponse);
    inspector({ getStep }, { trace: traceState({ runs: [runTrace({ steps: [failed] })] }) });
    fireEvent.click(screen.getByRole("button", { name: /Inspect step: Model call/ }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText(/Raw provider text/)).toBeNull();
  });

  it("shows the run, opens a model call with its context, response, raw and stats tabs", async () => {
    const getStep = vi.fn().mockResolvedValue(llmDetail);
    inspector({ getStep });
    fireEvent.click(screen.getByRole("button", { name: /Inspect step: Model call/ }));
    await waitFor(() => expect(getStep).toHaveBeenCalledWith("st1"));
    // context: system prompt sections, messages and tool definitions
    expect(await screen.findByText(/System prompt · 3 sections/)).toBeTruthy();
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("Messages · 2")).toBeTruthy();
    expect(screen.getAllByText("Find a hotel").length).toBeGreaterThan(0);
    expect(screen.getByText("Tools · 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Response" }));
    expect(screen.getByText("Here you go")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    expect(screen.getByText(/"tool_calls"/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Stats" }));
    expect(screen.getByText("Input tokens").nextSibling?.textContent).toBe("1,234");
    expect(screen.getByText("Provider").nextSibling?.textContent).toBe("Gateway");
    expect(screen.getByText("First byte")).toBeTruthy();
    expect(screen.getByText("Recorded size").nextSibling?.textContent).toContain("2,048 bytes");
  });

  it("opens straight at the requested step and shows a tool call's decision, input and output as text, images via the step endpoint", async () => {
    const getStep = vi.fn().mockResolvedValue(toolDetail);
    const { container } = inspector({ getStep }, { focus: { nonce: 2, runId: "r1", stepId: "st2" } });
    expect(await screen.findByText("Search the web", { selector: ".step-detail-title span" })).toBeTruthy();
    expect(screen.getByText("Decision").nextSibling?.textContent).toMatch(/allowed/i);
    expect(container.textContent).toContain("Result <img src=x onerror=alert(1)>");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/api/steps/st2/images/0");
    expect(container.querySelector("b")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to steps" }));
    expect(screen.getByRole("combobox", { name: /Run/ })).toBeTruthy();
  });

  describe("a script step", () => {
    const code =
      "const rows = await tools.list_sessions({});\nconst more = await tools.list_sessions({});\ntext(rows.length);";
    const scriptStep = toolStep({
      id: "sc",
      toolName: "codemode",
      toolCallId: "call-1",
      actionClass: "read_internal",
      activity: "Count the chats",
      summary: "const rows = await tools.list_sessions({});",
    });
    const nestedStep = (n: number, over = {}) =>
      toolStep({
        id: `n${n}`,
        toolName: "list_sessions",
        toolCallId: `call-1/c${n}`,
        parentStepId: "sc",
        summary: `List chats ${n}`,
        ...over,
      });
    const detail = (over: Partial<NonNullable<StepDetailResponse["tool"]>> = {}): StepDetailResponse => ({
      step: scriptStep,
      tool: {
        input: { code },
        output: [
          { type: "text", text: "Script completed\nWall time 0.4 seconds\nOutput:\n" },
          { type: "text", text: "<console_output>\n12\n</console_output>" },
        ],
        isError: false,
        script: {
          calls: [
            { id: 1, name: "list_sessions", args: "{}", status: "ok", durationMs: 120 },
            { id: 2, name: "list_sessions", args: '{"limit":5}', status: "error", durationMs: 30, error: "Denied" },
          ],
        },
        ...over,
      },
      payloadBytes: 100,
      truncated: false,
    });
    const runs = [runTrace({ steps: [step(), scriptStep, nestedStep(1), nestedStep(2)] })];
    const open = (d: StepDetailResponse) => {
      const getStep = vi.fn().mockResolvedValue(d);
      inspector({ getStep }, { focus: { nonce: 2, runId: "r1", stepId: "sc" }, trace: traceState({ runs }) });
      return getStep;
    };

    it("shows the code with line numbers, then the output, then the calls", async () => {
      open(detail());
      const container = document.body;
      const codeBlock = await waitFor(() => {
        const el = container.querySelector(".code-block");
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      expect(screen.getByRole("region", { name: "Code" })).toBeTruthy();
      expect(codeBlock.querySelector("code")?.textContent).toBe(code);
      expect(codeBlock.querySelector(".code-gutter")?.textContent).toBe("1\n2\n3");
      expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
      expect(screen.queryByText("Input")).toBeNull();
      const order = ["Code", "Output", "Calls"].map((n) => screen.getByRole("region", { name: n }));
      expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByRole("region", { name: "Output" }).textContent).toContain("12");
      expect(screen.getByRole("heading", { name: "Calls · 2" })).toBeTruthy();
    });

    it("lists each call with its arguments, status and time; one opens its own step", async () => {
      open(detail());
      const first = await screen.findByRole("button", { name: "Inspect call: list_sessions — Completed" });
      expect(first.textContent).toContain("120 ms");
      const failed = screen.getByRole("button", { name: "Inspect call: list_sessions — Failed" });
      expect(failed.textContent).toContain('{"limit":5}');
      expect(failed.textContent).toContain("Denied");
      fireEvent.click(failed);
      await waitFor(() =>
        expect(screen.getByText("List chats 2", { selector: ".step-detail-title span" })).toBeTruthy(),
      );
    });

    it("lists a call the trace has no step for as plain text", async () => {
      const getStep = vi.fn().mockResolvedValue(detail());
      inspector(
        { getStep },
        {
          focus: { nonce: 2, runId: "r1", stepId: "sc" },
          trace: traceState({ runs: [runTrace({ steps: [step(), scriptStep] })] }),
        },
      );
      expect(await screen.findByRole("heading", { name: "Calls · 2" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Inspect call:/ })).toBeNull();
    });

    it("says so when the output was cut, and where the full text was saved", async () => {
      open(
        detail({
          output: [
            { type: "text", text: "Script completed\nWall time 1.0 seconds\nOutput:\n" },
            {
              type: "text",
              text: "Warning: truncated output (original token count: 99999)\nTotal output lines: 9\n\nhead…5 tokens truncated…tail\n\n[Full output: /tmp/rei/output.txt (read with offset/limit)]",
            },
          ],
        }),
      );
      const note = await screen.findByRole("note");
      expect(note.textContent).toContain("shortened copy");
      expect(note.textContent).toContain("/tmp/rei/output.txt");
    });

    it("has no cut note for a whole output", async () => {
      open(detail());
      await screen.findByRole("region", { name: "Code" });
      expect(screen.queryByText(/shortened copy/)).toBeNull();
    });

    it("shows a script that was refused before it ran with its recorded input and no call list", async () => {
      const { script: _, ...refused } = detail({ input: { code: 42 }, isError: true }).tool!;
      open({ ...detail(), tool: refused });
      expect(await screen.findByText("Input")).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Code" })).toBeNull();
      expect(screen.queryByRole("region", { name: "Calls" })).toBeNull();
    });
  });

  it("links a decision that needed approval to the approval message in the chat", async () => {
    const approvalMsg = message({ id: "ap1", role: "approval", status: "complete", approval: { id: "apr1" } as never });
    const getStep = vi
      .fn()
      .mockResolvedValue({ ...toolDetail, step: toolStep({ approvalId: "apr1", decision: "granted" }) });
    inspector(
      { getStep },
      {
        focus: { nonce: 2, runId: "r1", stepId: "st2" },
        messages: [approvalMsg],
        trace: traceState({
          runs: [runTrace({ steps: [step(), toolStep({ approvalId: "apr1", decision: "granted" })] })],
        }),
      },
    );
    const link = await screen.findByRole("link", { name: "See the approval" });
    expect(link.getAttribute("href")).toContain("ap1");
  });

  it("reads a step whose approval was approved as Approved in Inspect too, as the chat does", async () => {
    const approvalMsg = message({
      id: "ap1",
      role: "approval",
      status: "complete",
      approval: { id: "apr1", status: "approved" } as never,
    });
    const blocked = toolStep({ status: "blocked", decision: "ask", approvalId: "apr1", activity: "Update the memory" });
    const getStep = vi.fn().mockResolvedValue({ ...toolDetail, step: blocked });
    inspector(
      { getStep },
      {
        focus: { nonce: 2, runId: "r1", stepId: null },
        messages: [approvalMsg],
        trace: traceState({ runs: [runTrace({ steps: [step(), blocked] })] }),
      },
    );
    expect(screen.queryByRole("button", { name: "Inspect step: Update the memory — Needs approval" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect step: Update the memory — Approved" }));
    await waitFor(() => expect(getStep).toHaveBeenCalledWith("st2"));
    expect(screen.getByText("Approved", { selector: "dd" })).toBeTruthy();
  });

  it("offers no fork from the inspector: only a finished reply can be forked", async () => {
    const getStep = vi.fn().mockResolvedValue(llmDetail);
    inspector({ getStep }, { focus: { nonce: 3, runId: "r1", stepId: "st1" } });
    await screen.findByText(/Model call/);
    expect(screen.queryByRole("button", { name: /Fork from here/ })).toBeNull();
  });

  it("shows what a search_capabilities step searched, ranked and loaded, and why", async () => {
    const search = toolStep({
      id: "st3",
      toolName: "search_capabilities",
      actionClass: "read_internal",
      summary: "Search",
    });
    const getStep = vi.fn().mockResolvedValue({
      step: search,
      tool: {
        input: { query: "schedule a weekly reminder" },
        output: [{ type: "text", text: "Loaded the triggers tools (4)" }],
        isError: false,
        discovery: {
          query: "schedule a weekly reminder",
          candidates: [
            { name: "create_trigger", kind: "tool", coverage: 1, score: 7.5 },
            { name: "weekly-review", kind: "skill", coverage: 0.5, score: 2.1 },
          ],
          loaded: [{ name: "create_trigger", reason: "group", group: "triggers" }],
          alreadyLoaded: [],
          alsoRelevant: ["notes__add_note"],
          skills: ["weekly-review"],
          notFound: [],
        },
      },
      payloadBytes: 10,
      truncated: false,
    } satisfies StepDetailResponse);
    inspector(
      { getStep },
      { trace: traceState({ runs: [runTrace({ steps: [search] })] }), focus: { nonce: 3, runId: "r1", stepId: "st3" } },
    );
    const section = await screen.findByRole("region", { name: "Discovery" });
    expect(section.textContent).toContain("“schedule a weekly reminder”");
    expect(section.textContent).toContain("create_trigger · its group matched (triggers)");
    expect(screen.getByText("Also relevant").nextSibling?.textContent).toBe("notes__add_note");
    expect(screen.getByText("Skills").nextSibling?.textContent).toBe("weekly-review");
    expect(screen.getByText("Ranked candidates · 2")).toBeTruthy();
    expect(section.textContent).toContain("50%");
  });

  it("shows how a web_fetch got its page, and opens the stored copy on request", async () => {
    const fetched = toolStep({
      id: "st4",
      toolName: "web_fetch",
      actionClass: "read_external",
      summary: "Fetch https://guide.example/kyoto",
      web: { title: "Kyoto guide", host: "guide.example" },
    });
    const getStep = vi.fn().mockResolvedValue({
      step: fetched,
      tool: {
        input: { url: "https://guide.example/kyoto", query: "maples" },
        output: [{ type: "text", text: "[section when-to-go: When to go] The maples turn red in mid November." }],
        isError: false,
        fetch: {
          method: "http",
          cache: "miss",
          mode: "query",
          host: "guide.example",
          title: "Kyoto guide",
          quality: "success",
          extractor: "readability",
          sections: ["when-to-go"],
          status: 200,
          bytes: 48_213,
          mediaType: "text/html",
          redirects: 1,
          tokensReturned: 412,
          pageTokens: 9_870,
          durationMs: 840,
        },
      },
      payloadBytes: 10,
      truncated: false,
    } satisfies StepDetailResponse);
    const getStepWebDocument = vi.fn().mockResolvedValue({
      title: "Kyoto guide",
      url: "https://guide.example/kyoto",
      text: "Full readable text of the Kyoto guide.",
      quality: "success",
      extractor: "readability",
      fetchedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 3_600_000,
    });
    inspector(
      { getStep, getStepWebDocument },
      {
        trace: traceState({ runs: [runTrace({ steps: [fetched] })] }),
        focus: { nonce: 6, runId: "r1", stepId: "st4" },
      },
    );
    const section = await screen.findByRole("region", { name: "Fetch" });
    const fact = (k: string) => screen.getByText(k).nextSibling?.textContent;
    expect(fact("Source")).toBe("Fetched (nothing stored)");
    expect(fact("Shown")).toBe("Passages matching the query");
    expect(fact("HTTP status")).toBe("200");
    expect(fact("Redirects")).toBe("1");
    expect(fact("Extractor")).toBe("readability");
    expect(fact("Quality")).toBe("success");
    expect(fact("Tokens returned")).toBe("412");
    expect(fact("Tokens on the page")).toBe((9_870).toLocaleString());
    expect(section.textContent).toContain("when-to-go");
    // The stored copy loads only when asked, and stays in the UI.
    expect(getStepWebDocument).not.toHaveBeenCalled();
    const open = screen.getByRole("button", { name: "Stored copy" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(open);
    expect(await screen.findByText("Full readable text of the Kyoto guide.")).toBeTruthy();
    expect(getStepWebDocument).toHaveBeenCalledWith("st4");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(open);
    expect(screen.queryByText("Full readable text of the Kyoto guide.")).toBeNull();
  });

  it("shows a failed web_fetch's status and class, says when the stored copy is gone", async () => {
    const failed = toolStep({ id: "st5", toolName: "web_fetch", status: "error" });
    const ok = toolStep({ id: "st6", toolName: "web_fetch", web: { title: "Old", host: "old.example" } });
    const details = (step: typeof failed, fetch: NonNullable<StepDetailResponse["tool"]>["fetch"]) =>
      ({
        step,
        tool: {
          input: { url: "https://x.example/" },
          output: [{ type: "text", text: "no" }],
          isError: !!fetch?.error,
          fetch,
        },
        payloadBytes: 10,
        truncated: false,
      }) satisfies StepDetailResponse;
    const getStep = vi.fn((id: string) =>
      Promise.resolve(
        id === "st5"
          ? details(failed, {
              method: "http",
              cache: "miss",
              host: "locked.example",
              status: 403,
              quality: "blocked",
              durationMs: 90,
              error: true,
            })
          : details(ok, { method: "http", cache: "hit", mode: "overview", host: "old.example", durationMs: 3 }),
      ),
    );
    const getStepWebDocument = vi
      .fn()
      .mockRejectedValue(new ApiError(404, "not_found", "That page is no longer stored."));
    const trace = traceState({ runs: [runTrace({ steps: [failed, ok] })] });
    const { unmount } = inspector(
      { getStep, getStepWebDocument },
      { trace, focus: { nonce: 7, runId: "r1", stepId: "st5" } },
    );
    await screen.findByRole("region", { name: "Fetch" });
    expect(screen.getByText("HTTP status").nextSibling?.textContent).toBe("403");
    expect(screen.getByText("Quality").nextSibling?.textContent).toBe("blocked");
    expect(screen.queryByRole("button", { name: "Stored copy" })).toBeNull();
    unmount();
    inspector({ getStep, getStepWebDocument }, { trace, focus: { nonce: 8, runId: "r1", stepId: "st6" } });
    await waitFor(() => expect(screen.getByText("Source").nextSibling?.textContent).toBe("Stored copy (no network)"));
    fireEvent.click(screen.getByRole("button", { name: "Stored copy" }));
    expect(await screen.findByText(/no longer stored/)).toBeTruthy();
  });

  it("shows how a web_fetch rendered its page, or why it did not", async () => {
    const rendered = toolStep({ id: "st7", toolName: "web_fetch", web: { title: "App", host: "app.example" } });
    const skipped = toolStep({ id: "st8", toolName: "web_fetch", status: "error" });
    const details = (step: typeof rendered, fetch: NonNullable<StepDetailResponse["tool"]>["fetch"]) =>
      ({
        step,
        tool: { input: { url: "https://app.example/" }, output: [{ type: "text", text: "x" }], isError: false, fetch },
        payloadBytes: 10,
        truncated: false,
      }) satisfies StepDetailResponse;
    const getStep = vi.fn((id: string) =>
      Promise.resolve(
        id === "st7"
          ? details(rendered, {
              method: "render",
              cache: "miss",
              mode: "whole",
              host: "app.example",
              render: {
                reason: "requires_js",
                queueMs: 1_200,
                renderMs: 2_400,
                ended: "stable",
                connections: 7,
                refused: 1,
                blockedMedia: 3,
              },
              durationMs: 3_900,
            })
          : details(skipped, {
              method: "http",
              cache: "miss",
              host: "app.example",
              quality: "requires_js",
              render: { reason: "requires_js", skipped: "off" },
              durationMs: 80,
              error: true,
            }),
      ),
    );
    const trace = traceState({ runs: [runTrace({ steps: [rendered, skipped] })] });
    const { unmount } = inspector(
      { getStep, getStepWebDocument: vi.fn() },
      { trace, focus: { nonce: 9, runId: "r1", stepId: "st7" } },
    );
    await screen.findByRole("region", { name: "Fetch" });
    const fact = (k: string) => screen.getByText(k).nextSibling?.textContent;
    expect(fact("Method")).toBe("Rendered in the browser");
    expect(fact("Rendering")).toBe("Page needs JavaScript, read once the text settled");
    expect(fact("Render connections")).toBe("7, 1 refused");
    expect(fact("Media not loaded")).toBe("3");
    expect(screen.getByText("Waited for the browser")).toBeTruthy();
    unmount();
    inspector({ getStep, getStepWebDocument: vi.fn() }, { trace, focus: { nonce: 10, runId: "r1", stepId: "st8" } });
    await waitFor(() =>
      expect(screen.getByText("Rendering").nextSibling?.textContent).toBe(
        "Not rendered: disabled by the reader request",
      ),
    );
    expect(screen.getByText("Method").nextSibling?.textContent).toBe("HTTP");
  });

  it("shows a model call's offered tools and what changed, each load linked to the search that caused it", async () => {
    const search = toolStep({ id: "st3", toolName: "search_capabilities", summary: "Search" });
    const call = step({ id: "st4" });
    const getStep = vi.fn((id: string) =>
      Promise.resolve(
        id === "st4"
          ? {
              ...llmDetail,
              step: call,
              llm: {
                ...llmDetail.llm!,
                tools: {
                  offered: ["web_search", "search_capabilities", "notes__add_note"],
                  previousStepId: "st1",
                  added: [{ name: "notes__add_note", loadedBy: "st3", reason: "load" }, { name: "calendar__list" }],
                  removed: ["mail__send"],
                },
              },
            }
          : { ...toolDetail, step: search },
      ),
    );
    inspector(
      { getStep },
      {
        trace: traceState({ runs: [runTrace({ steps: [step(), search, call] })] }),
        focus: { nonce: 4, runId: "r1", stepId: "st4" },
      },
    );
    const offered = await screen.findByRole("region", { name: "Offered tools" });
    expect(offered.textContent).toContain("Offered tools · 3");
    expect(offered.textContent).toContain("notes__add_noteloaded by a search (named in load)");
    expect(offered.textContent).toContain("calendar__listoffered again or added by a capability change");
    expect(offered.textContent).toContain("mail__sendno longer offered");
    fireEvent.click(screen.getByRole("button", { name: "a search" }));
    await waitFor(() => expect(getStep).toHaveBeenCalledWith("st3"));
  });

  it("says the first model call offers its core tools", async () => {
    const getStep = vi.fn().mockResolvedValue({
      ...llmDetail,
      llm: { ...llmDetail.llm!, tools: { offered: ["web_search"], added: [], removed: [] } },
    });
    inspector({ getStep }, { focus: { nonce: 5, runId: "r1", stepId: "st1" } });
    expect(await screen.findByText("The first model call of this chat: its core tools.")).toBeTruthy();
  });

  it("shows a capabilities-changed step with the connector tools that came, went or changed", async () => {
    const change = step({
      id: "st5",
      type: "capabilities.changed",
      summary: "Notes: tools 1 added, 1 removed",
      latencyMs: 0,
      model: undefined as never,
      tokens: undefined as never,
      provider: undefined as never,
    });
    const getStep = vi.fn().mockResolvedValue({
      step: change,
      change: { connectors: ["Notes"], added: ["notes__archive"], removed: ["notes__delete"], changed: [] },
      payloadBytes: 10,
      truncated: false,
    } satisfies StepDetailResponse);
    inspector(
      { getStep },
      { trace: traceState({ runs: [runTrace({ steps: [change] })] }), focus: { nonce: 6, runId: "r1", stepId: "st5" } },
    );
    expect(await screen.findByText("Capabilities changed", { selector: ".step-detail-title span" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Added").nextSibling?.textContent).toBe("notes__archive"));
    expect(screen.getByText("Removed").nextSibling?.textContent).toBe("notes__delete");
    expect(screen.getByText("Connectors").nextSibling?.textContent).toBe("Notes");
  });

  it("shows a load error from the step endpoint", async () => {
    const getStep = vi.fn().mockRejectedValue(new ApiError(404, "not_found", ""));
    inspector({ getStep }, { focus: { nonce: 2, runId: "r1", stepId: "st2" } });
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
  });

  it("offers older runs, shows empty and error states, and closes with the button and Escape", () => {
    const loadOlder = vi.fn();
    const { onClose } = inspector({}, { trace: traceState({ hasOlder: true, loadOlder }) });
    fireEvent.click(screen.getByRole("button", { name: /older/i }));
    expect(loadOlder).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("says when there are no runs yet", () => {
    inspector({}, { trace: traceState({ runs: [] }) });
    expect(screen.getByText("No runs recorded yet.")).toBeTruthy();
  });

  it("the Session tab lists what the chat is made of", () => {
    inspector(
      {},
      {
        session: session({ id: "s1", origin: "fork", forkedFrom: { sessionId: "s0", messageId: "m0" } }),
        sessions: [session({ id: "s0", title: "Original" }), session({ id: "s1" })],
      },
    );
    fireEvent.click(screen.getByRole("tab", { name: "Session" }));
    expect(screen.getByRole("tabpanel").textContent).toMatch(/fork|Fork|Branch/i);
  });
});

describe("ForkDialog", () => {
  it("confirms and forks at a reply", async () => {
    const forkSession = vi.fn().mockResolvedValue({ session: session({ id: "s2" }) });
    const onForked = vi.fn();
    render(
      <ForkDialog
        api={asApi({ forkSession })}
        sessionId="s1"
        at={{ messageId: "m1" }}
        onCancel={() => {}}
        onForked={onForked}
      />,
    );
    expect(screen.queryByText(/won't be undone/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Fork into a new chat" }));
    await waitFor(() => expect(onForked).toHaveBeenCalledWith("s2"));
    expect(forkSession).toHaveBeenCalledWith("s1", "m1");
  });

  it("shows a fork error and lets the user retry", async () => {
    const forkSession = vi.fn().mockRejectedValue(new ApiError(409, "not_forkable", ""));
    const onForked = vi.fn();
    render(
      <ForkDialog
        api={asApi({ forkSession })}
        sessionId="s1"
        at={{ messageId: "m1" }}
        onCancel={() => {}}
        onForked={onForked}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fork into a new chat" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't be branched/);
    expect(onForked).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Fork into a new chat" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("cancels with the Cancel button", () => {
    const onCancel = vi.fn();
    render(
      <ForkDialog api={asApi({})} sessionId="s1" at={{ messageId: "m1" }} onCancel={onCancel} onForked={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});

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

describe("AgentSettingsDialog", () => {
  it("shows an empty disabled picker when no provider supplies models", async () => {
    render(
      <AgentSettingsDialog
        mode="model"
        agent={{ ...agent, model: "retired" }}
        api={asApi({ getModels: vi.fn().mockResolvedValue({ default: "gpt-6.1-sol", models: [] }) })}
        onClose={() => {}}
        onChangeLook={() => {}}
      />,
    );
    await screen.findByRole("option", { name: "No models available" });
    const picker = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(picker.disabled).toBe(true);
    expect(Array.from(picker.options).filter((option) => !option.disabled)).toHaveLength(0);
  });

  it("saves thinking effort alone, offering the selected model's supported levels", async () => {
    const updateAgent = vi.fn().mockResolvedValue({ agent });
    const getModels = vi.fn().mockResolvedValue({
      default: "gpt-6.1-sol",
      models: ["gpt-6.1-sol"],
      thinkingLevels: { "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"] },
    });
    render(
      <AgentSettingsDialog
        mode="model"
        agent={agent}
        api={asApi({ updateAgent, getModels })}
        onClose={() => {}}
        onChangeLook={() => {}}
      />,
    );
    await screen.findByRole("option", { name: "Default (gpt-6.1-sol)" });
    const effort = screen.getByLabelText("Thinking effort") as HTMLSelectElement;
    expect(effort.value).toBe("off");
    expect(Array.from(effort.options).map((o) => o.value)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("a1", { thinkingLevel: "high" }));
  });

  it("keeps saved effort visible when switching models and lets it return to default", async () => {
    const updateAgent = vi.fn().mockResolvedValue({ agent });
    const getModels = vi.fn().mockResolvedValue({
      default: "gpt-6.1-sol",
      models: ["gpt-6.1-sol", "plain"],
      thinkingLevels: { plain: ["off"] },
    });
    render(
      <AgentSettingsDialog
        mode="model"
        agent={{ ...agent, thinkingLevel: "high" }}
        api={asApi({ updateAgent, getModels })}
        onClose={() => {}}
        onChangeLook={() => {}}
      />,
    );
    await screen.findByRole("option", { name: "plain" });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "plain" } });
    const effort = screen.getByLabelText("Thinking effort") as HTMLSelectElement;
    expect(effort.value).toBe("high");
    expect(Array.from(effort.options).map((o) => o.value)).toEqual(["off", "high"]);
    fireEvent.change(effort, { target: { value: "off" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("a1", { model: "plain", thinkingLevel: "off" }));
  });

  it("saves only what changed", async () => {
    const updateAgent = vi.fn().mockResolvedValue({ agent });
    const getModels = vi.fn().mockResolvedValue({ default: "gpt-6.1-sol", models: ["gpt-6.1-sol", "gpt-6-luna"] });
    const onClose = vi.fn();
    render(
      <AgentSettingsDialog
        mode="model"
        agent={agent}
        api={asApi({ updateAgent, getModels })}
        onClose={onClose}
        onChangeLook={() => {}}
      />,
    );
    await screen.findByRole("option", { name: "gpt-6-luna" });
    expect(screen.getByRole("option", { name: "Default (gpt-6.1-sol)" })).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.queryByLabelText("Name")).toBeNull();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-6-luna" } });
    expect(screen.queryByRole("radio", { name: /Relaxed/ })).toBeNull(); // permissions live on the Permissions page
    fireEvent.click(save);
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("a1", { model: "gpt-6-luna" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("marks an unavailable saved model disabled and allows returning to the default", async () => {
    const updateAgent = vi.fn().mockResolvedValue({ agent });
    const getModels = vi.fn().mockResolvedValue({ default: "gpt-6.1-sol", models: ["gpt-6.1-sol"] });
    const set: Agent = { ...agent, model: "my-model" };
    render(
      <AgentSettingsDialog
        mode="model"
        agent={set}
        api={asApi({ updateAgent, getModels })}
        onClose={() => {}}
        onChangeLook={() => {}}
      />,
    );
    await screen.findByRole("option", { name: "gpt-6.1-sol" });
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("my-model");
    expect((screen.getByRole("option", { name: "Current model unavailable" }) as HTMLOptionElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("a1", { model: null }));
  });

  it("refuses an empty name and shows a save error without closing", async () => {
    const updateAgent = vi.fn().mockRejectedValue(new ApiError(400, "bad_request", ""));
    const onClose = vi.fn();
    render(
      <AgentSettingsDialog agent={agent} api={asApi({ updateAgent })} onClose={onClose} onChangeLook={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dot2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Change look closes the dialog's work to the picker", async () => {
    const onChangeLook = vi.fn();
    render(<AgentSettingsDialog agent={agent} api={asApi({})} onClose={() => {}} onChangeLook={onChangeLook} />);
    fireEvent.click(screen.getByRole("button", { name: "Change look…" }));
    await waitFor(() => expect(onChangeLook).toHaveBeenCalled());
  });
});
