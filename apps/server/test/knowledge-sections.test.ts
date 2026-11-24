// Section anchors on the server: the shared slug fixtures (packages/protocol/fixtures/rendering.json, the same cases
// the web parser runs), `#slug` lookups and the section links a page makes.
import { readFileSync } from "node:fs";
import { findSlug } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import {
  chunks,
  findSection,
  insertSectionAfter,
  outline,
  ownText,
  refs,
  replaceSection,
  sections,
  sectionText,
} from "../src/knowledge/markdown.ts";

interface SlugCase {
  name: string;
  input: string;
  expected: string[];
  lookups?: { anchor: string; index: number | null }[];
}
const fixtures = JSON.parse(
  readFileSync(new URL("../../../packages/protocol/fixtures/rendering.json", import.meta.url), "utf8"),
) as { slugs: SlugCase[] };

describe("section slugs", () => {
  it.each(fixtures.slugs.map((c) => [c.name, c] as const))("fixture: %s", (_name, c) => {
    expect(
      sections(c.input)
        .slice(1)
        .map((s) => s.slug),
    ).toEqual(c.expected);
    for (const l of c.lookups ?? []) expect(findSlug(c.expected, l.anchor)).toBe(l.index ?? -1);
  });

  it("finds a section by #slug, in any script, with numbered repeats", () => {
    const body = "# Plan\n\n## Week 2: Shipping!\nShip it\n\n## 第二週 進度\n進度\n\n## Notes\none\n\n## Notes\ntwo";
    expect(findSection(body, "#week-2-shipping").heading).toBe("Week 2: Shipping!");
    expect(findSection(body, "#第二週-進度").heading).toBe("第二週 進度");
    expect(findSection(body, `#${encodeURIComponent("第二週-進度")}`).index).toBe(3);
    expect(findSection(body, "#notes-1").index).toBe(5);
    // A heading line still names a section by its text.
    expect(findSection(body, "## Week 2: Shipping!").index).toBe(2);
    expect(() => findSection(body, "#nope")).toThrow(/§2 Plan > Week 2: Shipping! #week-2-shipping/);
  });

  it("shows each section's slug in the outline", () => {
    expect(outline("## Goals\nRun\n\n### 目標 一\nx")).toEqual([
      "  §1 Goals #goals (≈9)",
      "    §2 目標 一 #目標-一 (≈5)",
    ]);
  });

  it("collects section links, leaves file links alone and ignores links in code", () => {
    const found = refs(
      "[a](page:pg_1#week-2) [b](page:pg_1#week-2) [c](page:pg_2#第二週-進度) [d](page:pg_3#) [e](file:f_1#x)\n```\n[f](page:pg_9#y)\n```",
    );
    expect(found.pages).toEqual(["pg_1", "pg_2", "pg_3"]);
    expect(found.anchors).toEqual([
      { pageId: "pg_1", anchor: "week-2" },
      { pageId: "pg_2", anchor: "第二週-進度" },
    ]);
    expect(found.files).toEqual([]);
  });
});

describe("footnote definitions", () => {
  const body = [
    "Intro[^a].",
    "",
    "[^a]: Intro source.",
    "",
    "## Findings",
    "",
    "A claim[^b].",
    "",
    "[^b]: Findings source, [report](page:pg_1#week-2).",
    "    continued on a second line",
    "",
    "## Next",
    "",
    "Later.",
  ].join("\n");

  it("does not break section detection", () => {
    expect(sections(body).map((s) => s.heading)).toEqual(["", "Findings", "Next"]);
    expect(outline(body)).toHaveLength(3);
  });

  it("keeps a definition in the section it was written in, for reading and search", () => {
    const [top, findings, next] = sections(body);
    expect(ownText(body, top!)).toContain("[^a]: Intro source.");
    expect(ownText(body, top!)).not.toContain("Findings source");
    expect(sectionText(body, findings!)).toContain("[^b]: Findings source");
    expect(sectionText(body, findings!)).toContain("continued on a second line");
    expect(sectionText(body, next!)).not.toContain("[^");
    const found = chunks(body).filter((c) => c.text.includes("Findings source"));
    expect(found.map((c) => c.path)).toEqual([["Findings"]]);
  });

  it("still sees links inside a definition", () => {
    expect(refs(body).anchors).toEqual([{ pageId: "pg_1", anchor: "week-2" }]);
  });
});

describe("underlined headings", () => {
  const body = ["Intro", "", "Plan", "====", "Goals", "", "Two", "lines", "---", "Detail", "", "## Plan", "x"].join(
    "\n",
  );

  it("are sections, with the text above the underline as the heading", () => {
    const all = sections(body);
    expect(all.map((s) => [s.level, s.heading, s.slug, s.start, s.headEnd])).toEqual([
      [0, "", "", 0, 0],
      [1, "Plan", "plan", 2, 4],
      [2, "Two lines", "two-lines", 6, 9],
      [2, "Plan", "plan-1", 11, 12],
    ]);
    expect(all[1]!.end).toBe(body.split("\n").length);
    expect(ownText(body, all[0]!)).toBe("Intro\n");
    expect(findSection(body, "Two lines").index).toBe(2);
    expect(findSection(body, "#plan-1").index).toBe(3);
  });

  it("keep their whole heading when a section's text is replaced, and can start a new section", () => {
    expect(replaceSection(body, "Two lines", "New detail").body).toContain("Two\nlines\n---\n\nNew detail\n\n## Plan");
    const added = insertSectionAfter(body, "#plan-1", "Later\n=====\nSoon").body;
    expect(sections(added).map((s) => s.heading)).toEqual(["", "Plan", "Two lines", "Plan", "Later"]);
  });

  it("are not made by --- after a blank line, list item, quote, table, footnote, fence or indented code", () => {
    const none = [
      "Para\n\n---",
      "- item\n---",
      "- item\n--",
      "> quoted\n---",
      "| a |\n|---|\n| 1 |\n---",
      "[^n]: note\n  more\n---",
      "```\ncode\n```\n---",
      "    code\n---",
      "- item\n\n  inside\n  ---",
      "* * *\n---",
    ];
    for (const text of none) expect(sections(text), text).toHaveLength(1);
    // A table whose separator row is dashes stays a table.
    expect(sections("a | b\n---|---\n1 | 2")).toHaveLength(1);
    // Paragraph text after a table or quote is a new paragraph, which can be underlined.
    expect(sections("> q\nText\n---").map((s) => s.heading)).toEqual(["", "Text"]);
  });

  it("are not made by a lone - on the last line, which a streaming reply may be starting a list item with", () => {
    expect(sections("Title\n-")).toHaveLength(1);
    expect(sections("Title\n-\n").map((s) => s.heading)).toEqual(["", "Title"]);
    expect(sections("Title\n--").map((s) => s.heading)).toEqual(["", "Title"]);
  });
});
