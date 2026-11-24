// The shared rendering conformance fixtures (packages/protocol/fixtures/rendering.json, docs/rendering.md): every
// client's Markdown parser must turn each input into the expected structure. This runs the web parser against them.

import { findSlug } from "@rei/protocol";
import fixtures from "@rei/protocol/fixtures/rendering.json";
import { describe, expect, it } from "vitest";
import { type Block, parseMarkdown, splitChips } from "./markdown.ts";

describe("rendering conformance fixtures", () => {
  it("cover every dialect feature", () => {
    const names = new Set([...fixtures.markdown, ...fixtures.chips].map((c) => c.name));
    for (const feature of [
      "page-link",
      "page-section-link",
      "file-link",
      "file-image",
      "web-image",
      "setext-headings",
      "indented-code",
      "callouts",
      "toggles",
      "task-list",
      "task-chips",
      "ui-fence-is-code",
      "unclosed-fence",
      "footnote-basic",
      "footnote-no-definition-stays-text",
      "footnote-unused-definition-listed",
    ])
      expect(names).toContain(feature);
  });

  it.each(fixtures.markdown.map((c) => [c.name, c] as const))("markdown: %s", (_name, c) => {
    expect(parseMarkdown(c.input)).toEqual(c.expected);
  });

  it.each(fixtures.slugs.map((c) => [c.name, c] as const))("section slugs: %s", (_name, c) => {
    const slugs = parseMarkdown(c.input)
      .filter((b): b is Extract<Block, { t: "h" }> => b.t === "h")
      .map((h) => h.slug);
    expect(slugs).toEqual(c.expected);
    for (const l of c.lookups ?? []) expect(findSlug(c.expected, l.anchor)).toBe(l.index ?? -1);
  });

  it.each(fixtures.chips.map((c) => [c.name, c] as const))("task chips: %s", (_name, c) => {
    expect(splitChips(c.input)).toEqual(c.expected);
  });
});
