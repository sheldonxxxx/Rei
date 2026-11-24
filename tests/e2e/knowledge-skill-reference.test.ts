// Drift check for the built-in `rei-knowledge` skill: every example in its Markdown reference must parse to structure
// (headings, lists, tables, callouts, tasks, links…), not plain text. Lives in tests/e2e because it spans two workspaces:
// the web parser is the reference implementation of the dialect (docs/rendering.md); the server only ships the text.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Block, type Inline, parseMarkdown } from "../../apps/web/src/lib/markdown.ts";

const REFERENCE = resolve(import.meta.dirname, "../../apps/server/src/skills/knowledge/references/markdown.md");
const EXAMPLE = /^(`{4,})markdown\n([\s\S]*?)\n\1$/gm;

const examples = [...readFileSync(REFERENCE, "utf8").matchAll(EXAMPLE)].map((m) => m[2]!);

const plain = (inline: Inline[]): boolean => inline.every((i) => i.t === "text" || i.t === "br");
const structured = (b: Block): boolean => b.t !== "p" || !plain(b.children);

/** Every inline node kind and block kind the examples produced. */
function kinds(blocks: Block[], out = new Set<string>()): Set<string> {
  const inline = (list: Inline[]) =>
    list.forEach((i) => {
      out.add(i.t);
      if ("children" in i) inline(i.children);
    });
  for (const b of blocks) {
    out.add(b.t);
    if (b.t === "p" || b.t === "h") inline(b.children);
    if (b.t === "quote") kinds(b.blocks, out);
    if (b.t === "callout") kinds(b.blocks, out);
    if (b.t === "list") {
      if (b.tasks?.some(Boolean)) out.add("task");
      for (const item of b.items) kinds(item, out);
    }
  }
  return out;
}

describe("rei-knowledge references/markdown.md", () => {
  it("has examples", () => {
    expect(examples.length).toBeGreaterThanOrEqual(6);
  });

  it.each(examples.map((e, i) => [i, e] as const))("example %i parses to structure, not plain text", (_i, example) => {
    const blocks = parseMarkdown(example);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      // A plain paragraph is allowed only as the prose line of a link example; the rest must be structure.
      if (!structured(block)) expect(blocks.some((b) => b.t === "p" && !plain(b.children))).toBe(true);
    }
    expect(blocks.some(structured)).toBe(true);
  });

  it("covers each documented feature", () => {
    const seen = kinds(parseMarkdown(examples.join("\n\n")));
    for (const k of ["h", "strong", "em", "del", "code", "list", "task", "table", "callout", "page", "file", "image"])
      expect(seen, k).toContain(k);
    const callouts = parseMarkdown(examples.join("\n\n")).filter((b) => b.t === "callout");
    expect(callouts.map((c) => (c.t === "callout" ? c.fold : null)).sort()).toEqual([null, "closed"].sort());
  });
});
