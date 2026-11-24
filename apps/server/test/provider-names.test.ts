import { describe, expect, it } from "vitest";
import { providerDisplayName } from "../src/providers/names.ts";

describe("provider display names", () => {
  it("shows a provider by its connection name, never its id", () => {
    const names = { "custom-1": "Dashscope via aigw", openai: "OpenAI" };
    expect(providerDisplayName(names, "custom-1")).toBe("Dashscope via aigw");
    expect(providerDisplayName(names, "openai")).toBe("OpenAI");
  });

  it("reads a provider whose connection is gone as removed, not as its id", () => {
    expect(providerDisplayName({ openai: "OpenAI" }, "custom-9")).toBe("Removed provider");
  });
});
