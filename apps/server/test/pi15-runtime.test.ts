// Pi 1.5 runtime seams: the pi-schema port (closed objects, open dispatch arguments, enums, the injected _activity
// label), the copy of every run failure reason, which tool results the Trace counts as not executed, and the request
// filter that keeps thinking "Default" meaning the provider's default.
import { StringEnum, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { arr, int, obj, opt, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { runFailureError } from "../src/pi/errors.ts";
import { providerDefaultEffort } from "../src/pi/instrument.ts";
import { harnessCode } from "../src/pi/policy-ext.ts";

const call = (name: string, args: Record<string, unknown>) =>
  ({
    type: "toolCall" as const,
    id: "c1",
    name,
    arguments: args,
  }) as unknown as ToolCall;
const tool = (parameters: unknown) =>
  ({ name: "t", description: "t", parameters }) as Parameters<typeof validateToolArguments>[0];

describe("pi-schema tool parameters", () => {
  const params = obj({
    text: str(),
    count: opt(int()),
    kind: opt(StringEnum(["once", "daily"])),
    tags: opt(arr(str())),
  });

  it("accepts valid arguments and leaves optional fields out", () => {
    expect(validateToolArguments(tool(params), call("t", { text: "a" }))).toEqual({ text: "a" });
    expect(validateToolArguments(tool(params), call("t", { text: "a", count: 2, kind: "daily", tags: ["x"] }))).toEqual(
      {
        text: "a",
        count: 2,
        kind: "daily",
        tags: ["x"],
      },
    );
  });

  it("rejects a missing field, a value outside the enum and, since objects are closed, an unknown field", () => {
    expect(() => validateToolArguments(tool(params), call("t", {}))).toThrow();
    expect(() => validateToolArguments(tool(params), call("t", { text: "a", kind: "weekly" }))).toThrow();
    expect(() => validateToolArguments(tool(params), call("t", { text: "a", extra: 1 }))).toThrow();
  });

  it("keeps extra keys in an open object", () => {
    const open = obj({ name: str(), arguments: opt(obj({}, { open: true })) });
    expect(validateToolArguments(tool(open), call("t", { name: "x", arguments: { any: 1, thing: "y" } }))).toEqual({
      name: "x",
      arguments: { any: 1, thing: "y" },
    });
  });

  it("emits plain JSON Schema: optional fields are left out of required, and _activity can be added beside them", () => {
    expect(params).toMatchObject({ type: "object", required: ["text"], additionalProperties: false });
    const props = (params as unknown as { properties: Record<string, unknown> }).properties;
    const withActivity = { ...(params as object), properties: { ...props, _activity: str() } };
    expect(validateToolArguments(tool(withActivity), call("t", { text: "a", _activity: "Check" }))).toEqual({
      text: "a",
      _activity: "Check",
    });
  });
});

describe("run failures", () => {
  it("gives every reason its own copy and code, and never shows raw detail except a turn count", () => {
    const reasons = [
      "no_model",
      "aborted",
      "reset",
      "faulted",
      "orphaned",
      "interrupted",
      "restart_limit",
      "nothing_to_answer",
      "turn_limit",
    ];
    const messages = reasons.map((r) => runFailureError(r, "secret detail sk-123"));
    expect(new Set(messages.map((m) => m.message)).size).toBe(reasons.length);
    expect(messages.map((m) => m.code)).toEqual(reasons);
    for (const m of messages) expect(m.message).not.toContain("secret");
    expect(runFailureError("turn_limit", "12 turns").message).toContain("(12 turns)");
    expect(runFailureError("model_error", "upstream (503)")).toEqual({
      code: "provider_unavailable",
      message: "The model provider is temporarily unavailable (HTTP 503). Try again or choose another model.",
    });
  });
});

describe("tool results the Harness wrote", () => {
  it("finds Pi's code among the diagnostics, and none for an executed call", () => {
    expect(harnessCode([{ code: "invalid_arguments" }])).toBe("invalid_arguments");
    expect(harnessCode([{ code: "x" }, { code: "tool_unavailable" }])).toBe("tool_unavailable");
    expect(harnessCode([{ code: "some_tool_warning" }])).toBeUndefined();
    expect(harnessCode(undefined)).toBeUndefined();
  });
});

describe("thinking Default", () => {
  it("drops only pi-ai's effort none when no effort was requested", () => {
    expect(providerDefaultEffort({ model: "m", reasoning: { effort: "none" } }, undefined)).toEqual({ model: "m" });
    expect(providerDefaultEffort({ reasoning: { effort: "none" } }, "low")).toBeUndefined();
    expect(providerDefaultEffort({ reasoning: { effort: "high", summary: "auto" } }, undefined)).toBeUndefined();
    expect(providerDefaultEffort({ model: "m" }, undefined)).toBeUndefined();
  });
});
