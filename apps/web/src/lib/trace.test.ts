import { describe, expect, it } from "vitest";
import { step, toolStep } from "../test/fixtures.ts";
import {
  describeRequest,
  describeResponse,
  duration,
  sectionChanges,
  stepLine,
  stepTone,
  systemSections,
} from "./trace.ts";

describe("step lines", () => {
  it("describes a model call like the chat rows", () => {
    expect(stepLine(step())).toBe("Model · gpt-6.1-sol · 1,234 → 321 tokens · 2.3 s");
  });
  it("describes tool calls with class, decision and time", () => {
    expect(stepLine(toolStep())).toBe("web_search · read_external · allowed · 800 ms");
    expect(stepLine(toolStep({ decision: "deny", status: "blocked" }))).toContain("denied");
    expect(stepLine(toolStep({ decision: "ask", status: "blocked" }))).toContain("waiting for you");
    expect(stepLine(toolStep({ status: "running", latencyMs: null }))).toContain("running…");
  });
  it("tones denied and asked rows with the approval colours", () => {
    expect(stepTone(toolStep({ decision: "deny", status: "blocked" }))).toBe("deny");
    expect(stepTone(toolStep({ decision: "ask", status: "blocked" }))).toBe("ask");
    expect(stepTone(toolStep({ status: "error" }))).toBe("error");
    expect(stepTone(toolStep())).toBe("normal");
  });
  it("formats durations", () => {
    expect(duration(2300)).toBe("2.3 s");
    expect(duration(64_000)).toBe("1 min 4 s");
    expect(duration(null)).toBe("…");
  });
});

describe("describeRequest", () => {
  it("reads a chat-completions body", () => {
    const v = describeRequest({
      model: "m",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ function: { name: "web_search", arguments: '{"q":"x"}' } }],
        },
        { role: "tool", content: "result" },
      ],
      tools: [
        { type: "function", function: { name: "web_search", description: "Search", parameters: { type: "object" } } },
      ],
    });
    expect(v.system).toBe("Be brief.");
    expect(v.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(v.messages[1]!.calls[0]).toBe('web_search({"q":"x"})');
    expect(v.tools[0]).toMatchObject({ name: "web_search", description: "Search" });
  });
  it("reads a responses-style body with instructions and parts", () => {
    const v = describeRequest({
      instructions: "Sys",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "hello" },
            { type: "input_image", image_url: "x" },
          ],
        },
      ],
    });
    expect(v.system).toBe("Sys");
    expect(v.messages[0]).toMatchObject({ role: "user", text: "hello", other: 1 });
  });
  it("keeps a system message sent mid-conversation where it was sent, not in the prompt", () => {
    const v = describeRequest({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "system", content: 'Updated system prompt section "sessions":\n\n- ses_1 running' },
        { role: "user", content: "again" },
      ],
    });
    expect(v.system).toBe("Be brief.");
    expect(v.messages.map((m) => [m.role, !!m.update])).toEqual([
      ["user", false],
      ["assistant", false],
      ["system", true],
      ["user", false],
    ]);
  });
  it("says when it can't read the body", () => {
    expect(describeRequest("nope").recognised).toBe(false);
    expect(describeRequest({ foo: 1 }).recognised).toBe(false);
  });
});

describe("describeResponse", () => {
  it("reads chat-completions, messages-style and string (SSE) responses", () => {
    expect(describeResponse({ choices: [{ message: { role: "assistant", content: "Hello" } }] }).text).toBe("Hello");
    expect(
      describeResponse({
        content: [
          { type: "text", text: "Hi" },
          { type: "tool_use", name: "t", input: { a: 1 } },
        ],
      }),
    ).toMatchObject({ text: "Hi", calls: ['t({"a":1})'] });
    expect(describeResponse("data: {...}")).toMatchObject({ text: "data: {...}", recognised: true });
    expect(describeResponse({ weird: true }).recognised).toBe(false);
  });
  it("reads a Responses reasoning item apart from the answer, even when output_text is set", () => {
    const v = describeResponse({
      output_text: "Paris.",
      output: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Capital of France." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Paris." }] },
      ],
    });
    expect(v).toMatchObject({ text: "Paris.", reasoning: "Capital of France.", recognised: true });
    expect(v.text).not.toContain("Capital");
  });
  it("reads pi-style thinking parts from a message as reasoning", () => {
    const v = describeResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Check the date first." },
              { type: "text", text: "It is Tuesday." },
            ],
          },
        },
      ],
    });
    expect(v).toMatchObject({ text: "It is Tuesday.", reasoning: "Check the date first." });
  });
  it("says so for encrypted reasoning that cannot be read", () => {
    const v = describeResponse({
      output: [{ type: "reasoning", id: "rs_2", summary: [], encrypted_content: "abc" }],
    });
    expect(v.reasoning).toBe("Encrypted reasoning (not readable here).");
    expect(v.recognised).toBe(true);
  });
});

describe("describeRequest reasoning", () => {
  it("shows a Responses reasoning item in the history instead of dropping it", () => {
    const v = describeRequest({
      input: [
        { role: "user", content: "why?" },
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Think it through." }] },
        { role: "assistant", content: [{ type: "output_text", text: "Because." }] },
      ],
    });
    expect(v.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "why?"],
      ["reasoning", "Think it through."],
      ["assistant", "Because."],
    ]);
  });
  it("keeps a message's thinking parts as reasoning beside its text", () => {
    const v = describeRequest({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Earlier thought." },
            { type: "text", text: "Earlier answer." },
          ],
        },
      ],
    });
    expect(v.messages[0]).toMatchObject({ role: "assistant", text: "Earlier answer.", reasoning: "Earlier thought." });
  });
});

describe("systemSections", () => {
  it("splits tagged prompt sections", () => {
    const s = systemSections("You are Dot.\n<memory>\nLives in HK.\n</memory>\n<web>\nUse web_fetch.\n</web>");
    expect(s.map((x) => x.title)).toEqual([null, "memory", "web"]);
    expect(s[1]!.body).toBe("Lives in HK.");
  });
  it("splits at markdown headings, not inside code fences", () => {
    const s = systemSections("Intro\n# One\nbody\n```\n# not a heading\n```\n## Two\nmore");
    expect(s.map((x) => x.title)).toEqual([null, "One", "Two"]);
    expect(s[1]!.body).toContain("# not a heading");
  });
  it("returns one section for plain text", () => {
    expect(systemSections("just text")).toEqual([{ title: null, body: "just text" }]);
  });
});

describe("sectionChanges", () => {
  it("reads updated and removed sections out of one message", () => {
    const text =
      'Removed system prompt section "instructions".\n\nUpdated system prompt section "delegation":\n\nYou can run work.\n\nSecond line.\n\nUpdated system prompt section "sessions":\n\n- ses_1 running';
    expect(sectionChanges(text)).toEqual([
      { name: "instructions", change: "removed", body: "" },
      { name: "delegation", change: "updated", body: "You can run work.\n\nSecond line." },
      { name: "sessions", change: "updated", body: "- ses_1 running" },
    ]);
  });
  it("keeps other system text whole", () => {
    expect(sectionChanges("Remember to be kind.")).toEqual([
      { name: "", change: "updated", body: "Remember to be kind." },
    ]);
  });
});
