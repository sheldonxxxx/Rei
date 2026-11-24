import { describe, expect, it } from "vitest";
import { withNativeSearch } from "../src/pi/native-search.ts";

describe("withNativeSearch", () => {
  it("swaps the web_search function tool for OpenAI's built-in tool and requests sources", () => {
    const out = withNativeSearch({
      model: "gpt-5",
      tools: [
        { type: "function", name: "web_search", parameters: {} },
        { type: "function", name: "web_fetch", parameters: {} },
      ],
    }) as { tools: unknown[]; include: string[] };
    expect(out.tools).toEqual([{ type: "function", name: "web_fetch", parameters: {} }, { type: "web_search" }]);
    expect(out.include).toEqual(["web_search_call.action.sources"]);
  });

  it("does not duplicate the built-in tool or the include entry", () => {
    const once = withNativeSearch({ tools: [], include: ["reasoning.encrypted_content"] });
    const twice = withNativeSearch(once) as { tools: unknown[]; include: string[] };
    expect(twice.tools).toEqual([{ type: "web_search" }]);
    expect(twice.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
  });

  it("leaves a non-object payload alone", () => {
    expect(withNativeSearch(undefined)).toBeUndefined();
  });
});
