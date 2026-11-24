// Pins the recall guidance in the memory and Knowledge prompt notes and tool descriptions: the read-side triggers that
// make a model look things up, and the routing between memory, search_history and Knowledge. Wording may change; these
// triggers must not silently disappear. Whether a real model follows them is measured by hand (eval/recall).
import { describe, expect, it } from "vitest";
import { KNOWLEDGE_NOTE } from "../src/knowledge/tools.ts";
import { MEMORY_NOTE } from "../src/memory/tools.ts";
import { recallRouterText } from "../src/pi/recall-router.ts";

describe("recall guidance", () => {
  it("memory note names when to search history and when to save", () => {
    for (const phrase of [
      "last time",
      "search_history",
      "history_context",
      "memory_add",
      "in the turn the user states them",
    ])
      expect(MEMORY_NOTE).toContain(phrase);
    expect(MEMORY_NOTE).toMatch(/Skip it for self-contained/);
  });

  it("knowledge note names when to read before starting and when to write", () => {
    for (const phrase of ["knowledge_search", "Read before you start", "skip it for self-contained"])
      expect(KNOWLEDGE_NOTE).toContain(phrase);
  });

  it("each note stays in its own layer", () => {
    expect(MEMORY_NOTE).not.toMatch(/Knowledge|knowledge_/);
    expect(KNOWLEDGE_NOTE).not.toMatch(/memory_add|search_history|history_context/);
    expect(KNOWLEDGE_NOTE).toContain("go to memory");
  });

  it("the router names only the layers the tree has, and ends with the save check", () => {
    const both = recallRouterText({ memory: true, knowledge: true })!;
    for (const tool of ["memory_add", "search_history", "knowledge_write"]) expect(both).toContain(tool);
    expect(both).toContain("Before you give your final answer");
    expect(recallRouterText({ memory: true, knowledge: false })).not.toContain("knowledge_write");
    expect(recallRouterText({ memory: false, knowledge: true })).not.toContain("memory_add");
    expect(recallRouterText({ memory: false, knowledge: false })).toBeUndefined();
  });
});
