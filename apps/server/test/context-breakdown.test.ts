import { describe, expect, it, vi } from "vitest";
import { MemoryBlobStore } from "../src/blobs/blob-store.ts";
import { contextBreakdown, loadedNames, readContextBreakdown } from "../src/usage/context-breakdown.ts";

const call = (id: string, name: string, args: unknown) => ({
  type: "function_call",
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});
const result = (id: string, text: string) => ({ type: "function_call_output", call_id: id, output: text });

describe("context source attribution", () => {
  it("counts a selected skill's instructions as Skills, not Conversation, and keeps the user's own text as Conversation", () => {
    const block =
      '<selected-skill name="acme/review" version="2" id="s1">\nFollow the review steps carefully.\n</selected-skill>';
    const report = contextBreakdown({
      instructions: "Base rules",
      input: [{ role: "user", content: [{ type: "input_text", text: `${block}\n\nPlease review this` }] }],
    })!;
    const category = (id: string) => report.categories.find((c) => c.id === id)!;
    expect(category("skills").details.map((d) => d.label)).toEqual(["Selected skill: acme/review"]);
    expect(category("conversation").details.map((d) => d.label)).toEqual(["User messages"]);
    expect(category("conversation").estimatedTokens).toBeLessThan(category("skills").estimatedTokens);
    expect(report.estimatedTokens).toBe(report.categories.reduce((n, c) => n + c.estimatedTokens, 0));
  });

  it("separates prompt, the Capabilities index, skill instructions, tool schemas, arguments and results without double counting", () => {
    const report = contextBreakdown({
      instructions:
        "Base rules\n<capabilities>\nConnectors: Calendar\n</capabilities>\n<skill_saving>\nOffer to save\n</skill_saving>\n<policy>\nApproval rules\n</policy>",
      tools: [{ type: "function", name: "exec", parameters: { type: "object" } }],
      input: [
        { role: "user", content: [{ type: "input_text", text: "Research this" }] },
        { type: "tool_search_output", tools: [{ type: "function", name: "calendar__events", parameters: {} }] },
        call("s", "use_skill", { name: "research" }),
        result("s", "Skill instructions"),
        call("sf", "read_skill_file", { name: "research", path: "references/a.md" }),
        result("sf", "More skill instructions"),
        call("m", "calendar__events", {}),
        result("m", "MCP event data"),
        call("e", "exec", { cmd: "pwd" }),
        result("e", "Shell output"),
        { role: "assistant", content: [{ type: "output_text", text: "Finished" }] },
      ],
      // Generation parameters and request metadata are not prompt context.
      metadata: { ignored: "x".repeat(10000) },
      max_output_tokens: 200000,
    })!;
    const category = (id: string) => report.categories.find((c) => c.id === id)!;
    expect(report.method).toBe("o200k_base");
    expect(category("skills").details.map((d) => d.label)).toEqual(
      expect.arrayContaining(["skill saving", "use_skill: research", "read_skill_file: research / references/a.md"]),
    );
    expect(category("capabilities").details.map((d) => d.label)).toEqual(["capabilities"]);
    expect(category("loaded_tools").details.map((d) => d.label)).toEqual(["calendar__events"]);
    expect(category("mcp_calls").details.map((d) => d.label)).toContain("calendar__events");
    expect(category("mcp_results").details.map((d) => d.label)).toEqual(["calendar__events"]);
    expect(category("tool_results").details.map((d) => d.label)).toEqual(["exec"]);
    expect(category("tools").details.map((d) => d.label)).toEqual(["exec"]);
    expect(category("prompt").details.map((d) => d.label)).toEqual(
      expect.arrayContaining(["Base instructions", "policy"]),
    );
    expect(report.estimatedTokens).toBe(report.categories.reduce((n, c) => n + c.estimatedTokens, 0));
    expect(report.estimatedTokens).toBeLessThan(1000);
  });

  it("counts a code mode script as one tool call and one tool result: its nested calls never reach the model", () => {
    // The request holds what the model sees: the script, and the one result Pi wrote for it. The nested calls'
    // outputs are in the Trace only (Pi stores them in the script's own journal, outside the transcript).
    const report = contextBreakdown({
      input: [
        { role: "user", content: [{ type: "input_text", text: "Check my sessions" }] },
        call("c1", "codemode", { code: "const a = await tools.list_sessions({});\nconsole.log(a.length);" }),
        result("c1", "42"),
      ],
    })!;
    const category = (id: string) => report.categories.find((c) => c.id === id)!;
    expect(category("tool_calls").details.map((d) => d.label)).toEqual(["codemode"]);
    expect(category("tool_results").details.map((d) => d.label)).toEqual(["codemode"]);
  });

  it("excludes encoded images, private metadata and encrypted reasoning, preserving visible text estimates", () => {
    const report = contextBreakdown({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "abcd" },
            { type: "input_image", image_url: "data:image/png;base64," + "a".repeat(10000) },
          ],
        },
        { type: "reasoning", encrypted_content: "a".repeat(10000), summary: [{ type: "summary_text", text: "efgh" }] },
      ],
    })!;
    expect(report.hasOpaqueContent).toBe(true);
    expect(report.estimatedTokens).toBeLessThan(10);
    expect(contextBreakdown({ input: "<|endoftext|> 中文程式碼" })!.estimatedTokens).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("base64");
    expect(contextBreakdown({ messages: [] })).toBeNull();
    expect(contextBreakdown({ input: [] })?.estimatedTokens).toBe(0);
  });

  it("handles mid-conversation prompts, unknown call results and malformed arguments", () => {
    const report = contextBreakdown({
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: "<skill_saving>\nOffer to save\n</skill_saving>" }],
        },
        { type: "function_call", call_id: "x", name: "exec", arguments: "{" },
        result("x", "error"),
        result("missing", "unmatched"),
      ],
    })!;
    expect(report.categories.find((c) => c.id === "skills")!.estimatedTokens).toBeGreaterThan(0);
    expect(report.categories.find((c) => c.id === "tool_results")!.details.map((d) => d.label)).toContain(
      "Unknown tool",
    );
  });
  it("coalesces repeated immutable snapshots and retries unavailable/corrupt evidence", async () => {
    const blobs = new MemoryBlobStore();
    const ref = await blobs.put(new TextEncoder().encode(JSON.stringify({ input: "中文程式碼" })));
    const get = vi.spyOn(blobs, "get");
    const [a, b] = await Promise.all([readContextBreakdown(blobs, ref), readContextBreakdown(blobs, ref)]);
    expect(a).toEqual(b);
    expect(a!.estimatedTokens).toBeGreaterThan(0);
    expect(get).toHaveBeenCalledTimes(1);
    const bad = await blobs.put(new TextEncoder().encode("invalid json"));
    expect(await Promise.all([readContextBreakdown(blobs, bad), readContextBreakdown(blobs, bad)])).toEqual([
      null,
      null,
    ]);
    await readContextBreakdown(blobs, bad);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("counts the tools a call recorded as loaded under loaded, when the provider sends every tool in the request", async () => {
    // A provider without native tool search: Pi appends the loaded tools to the request's own tools.
    const payload = {
      input: [{ role: "user", content: "Open example.com" }],
      tools: [
        { type: "function", name: "read", parameters: {} },
        { type: "function", name: "browser_open", parameters: {} },
        { type: "function", name: "notes__search_notes", parameters: {} },
      ],
    };
    const loaded = loadedNames({ loaded_tools: JSON.stringify(["browser_open", "notes__search_notes"]) });
    const report = contextBreakdown(payload, new Set(loaded))!;
    expect(report.categories.find((c) => c.id === "tools")!.details.map((d) => d.label)).toEqual(["read"]);
    expect(
      report.categories
        .find((c) => c.id === "loaded_tools")!
        .details.map((d) => d.label)
        .sort(),
    ).toEqual(["browser_open", "notes__search_notes"]);
    // Read from the stored request: the loaded names are part of what is cached.
    const blobs = new MemoryBlobStore();
    const ref = await blobs.put(new TextEncoder().encode(JSON.stringify(payload)));
    const core = (await readContextBreakdown(blobs, ref))!;
    expect(core.categories.find((c) => c.id === "loaded_tools")!.estimatedTokens).toBe(0);
    const split = (await readContextBreakdown(blobs, ref, loaded))!;
    expect(split.categories.find((c) => c.id === "loaded_tools")!.details).toHaveLength(2);
  });

  it("reads no loaded names from a missing or unreadable record", () => {
    expect(loadedNames({ loaded_tools: null })).toEqual([]);
    expect(loadedNames({ loaded_tools: "not json" })).toEqual([]);
    expect(loadedNames({ loaded_tools: '{"a":1}' })).toEqual([]);
  });

  it("counts the first additional_tools item as core, later declarations as loaded, and custom tool transcripts", () => {
    const report = contextBreakdown({
      input: [
        { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "exec", parameters: {} }] },
        {
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "function", name: "create_trigger", parameters: {} }],
        },
        { type: "tool_search_call", arguments: { query: "calendar" } },
        { type: "tool_search_output", tools: [{ type: "function", name: "calendar__events", parameters: {} }] },
        { type: "custom_tool_call", call_id: "custom", name: "apply_patch", input: "*** Begin Patch" },
        { type: "custom_tool_call_output", call_id: "custom", output: "Success" },
      ],
    })!;
    expect(report.categories.find((c) => c.id === "tools")!.details.map((d) => d.label)).toEqual(["exec"]);
    expect(report.categories.find((c) => c.id === "loaded_tools")!.details.map((d) => d.label)).toEqual([
      "calendar__events",
      "create_trigger",
    ]);
    expect(report.categories.find((c) => c.id === "tool_calls")!.details.map((d) => d.label)).toEqual(["apply_patch"]);
    expect(report.categories.find((c) => c.id === "tool_results")!.details.map((d) => d.label)).toEqual([
      "apply_patch",
    ]);
  });
});
