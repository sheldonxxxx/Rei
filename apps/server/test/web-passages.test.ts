import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { initializeDatabase } from "../src/db/schema.ts";
import { estimateTokens } from "../src/memory/text.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { WebDocumentStore } from "../src/web/documents.ts";
import {
  PASSAGE_MAX_TOKENS,
  PASSAGE_MIN_TOKENS,
  passagesOf,
  type RankedPassage,
  selectPassages,
} from "../src/web/passages.ts";
import { sectionsOf } from "./helpers/sections.ts";

const para = (n: number, words = 60) => `Paragraph ${n} ${"lorem ipsum dolor sit amet ".repeat(words / 5)}.`;

describe("cutting a page into passages", () => {
  it("covers each section with passages of at most the max, never crossing a section, keeping the heading path", () => {
    const text = [
      "Intro text before any heading.",
      "",
      "# Guide",
      "",
      ...Array.from({ length: 30 }, (_, i) => `${para(i)}\n`),
      "## Install",
      "",
      "Run the installer.",
      "",
    ].join("\n");
    const sections = sectionsOf(text);
    const passages = passagesOf(text, sections);
    expect(passages.map((p) => p.ord)).toEqual(passages.map((_, i) => i));
    for (const p of passages) {
      const s = sections.find((x) => x.id === p.sectionId)!;
      expect(p.start).toBeGreaterThanOrEqual(s.start);
      expect(p.end).toBeLessThanOrEqual(s.end);
      expect(p.path).toEqual(s.path);
      expect(p.tokens).toBeLessThanOrEqual(PASSAGE_MAX_TOKENS);
      expect(p.tokens).toBe(estimateTokens(text.slice(p.start, p.end)));
      expect(text.slice(p.start, p.end)).toBe(text.slice(p.start, p.end).trimEnd());
    }
    const guide = passages.filter((p) => p.sectionId === "guide");
    expect(guide.length).toBeGreaterThan(1);
    // Every passage but the last in a section reaches the minimum.
    for (const p of guide.slice(0, -1)) expect(p.tokens).toBeGreaterThanOrEqual(PASSAGE_MIN_TOKENS);
    expect(passages.find((p) => p.sectionId === "install")!.path).toEqual(["Guide", "Install"]);
    expect(text.slice(passages[0]!.start, passages[0]!.end)).toBe("Intro text before any heading.");
    // Together they hold every paragraph.
    const joined = passages.map((p) => text.slice(p.start, p.end)).join("\n");
    for (let i = 0; i < 30; i++) expect(joined).toContain(`Paragraph ${i} `);
  });

  it("keeps a fenced code block and a table whole when they fit", () => {
    const code = [
      "```ts",
      ...Array.from({ length: 40 }, (_, i) => `const v${i} = ${i}; // ${"x".repeat(20)}`),
      "```",
    ].join("\n");
    const table = [
      "| key | value |",
      "| --- | --- |",
      ...Array.from({ length: 40 }, (_, i) => `| k${i} | v${i} |`),
    ].join("\n");
    const text = `# Doc\n\n${para(1, 300)}\n\n${code}\n\n${para(2, 300)}\n\n${table}\n`;
    const passages = passagesOf(text, sectionsOf(text)).map((p) => text.slice(p.start, p.end));
    expect(passages.some((p) => p.includes(code))).toBe(true);
    expect(passages.some((p) => p.includes(table))).toBe(true);
  });

  it("cuts a table longer than a passage at row boundaries, and a long CJK paragraph by characters", () => {
    const table = [
      "| key | value |",
      "| --- | --- |",
      ...Array.from({ length: 400 }, (_, i) => `| key${i} | ${"v".repeat(30)} |`),
    ].join("\n");
    const cjk = "京都の秋は美しい".repeat(300);
    const text = `# T\n\n${table}\n\n# C\n\n${cjk}\n`;
    const passages = passagesOf(text, sectionsOf(text));
    for (const p of passages) expect(p.tokens).toBeLessThanOrEqual(PASSAGE_MAX_TOKENS);
    const rows = passages.filter((p) => p.sectionId === "t").map((p) => text.slice(p.start, p.end));
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows.slice(1)) expect(r.startsWith("| key")).toBe(true);
    expect(passages.filter((p) => p.sectionId === "c").length).toBeGreaterThan(1);
  });

  it("treats a page without sections as one top section", () => {
    const text = '{\n  "a": 1\n}';
    expect(passagesOf(text, [])).toEqual([
      { ord: 0, sectionId: "top", path: [], start: 0, end: text.length, tokens: estimateTokens(text) },
    ]);
  });
});

describe("selecting passages", () => {
  const p = (sectionId: string, tokens: number, ord: number): RankedPassage => ({
    ord,
    sectionId,
    path: [],
    start: 0,
    end: 0,
    tokens,
    score: -ord,
  });

  it("takes at most two from a section before the others, skips what does not fit, and lists the sections left out", () => {
    const ranked = [p("a", 100, 0), p("a", 100, 1), p("a", 100, 2), p("b", 100, 3), p("c", 900, 4), p("d", 300, 5)];
    const sel = selectPassages(ranked, (x) => x.tokens, 700);
    expect(sel.passages.map((x) => x.ord)).toEqual([0, 1, 3, 5, 2]);
    expect(sel.passages.reduce((a, x) => a + x.exactTokens, 0)).toBeLessThanOrEqual(700);
    expect(sel.moreSections).toEqual(["c"]);
  });
});

describe("passage search in the document store", () => {
  const dirs: string[] = [];
  const dbs: Db[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) (db as unknown as { close: () => void }).close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const store = () => {
    const dir = mkdtempSync(join(tmpdir(), "rei-passages-"));
    dirs.push(dir);
    const db = openSqliteDb(join(dir, "app.db"));
    initializeDatabase(db);
    dbs.push(db);
    return { db, docs: new WebDocumentStore(db, () => 0) };
  };
  const page = (text: string, title = "Page") => ({
    title,
    url: "https://x.example/",
    text,
    sections: sectionsOf(text),
  });
  const longPage = [
    "# Travel guide",
    "",
    ...Array.from({ length: 12 }, (_, i) => `## Region ${i}\n\n${para(i, 200)}\n`),
    "## When to go",
    "",
    "The maples turn red in mid November, which is the best time to visit.",
    "",
    "## 京都の紅葉",
    "",
    "京都の紅葉は十一月下旬が見頃です。",
  ].join("\n");

  it("finds the matching passage of a long page, in English and in Japanese, and checks it against the text by offsets", async () => {
    const { docs } = store();
    const doc = await docs.put("agt", "s", "https://x.example/", page(longPage));
    const en = docs.search(doc, "when do the maples turn red?");
    expect(doc.text.slice(en.passages[0]!.start, en.passages[0]!.end)).toContain("mid November");
    expect(en.passages[0]!.sectionId).toBe("when-to-go");
    const ja = docs.search(doc, "紅葉の見頃");
    expect(doc.text.slice(ja.passages[0]!.start, ja.passages[0]!.end)).toContain("十一月下旬");
    expect(ja.termsFound).toBeGreaterThan(0);
    // A query with nothing to match returns nothing, and so does one whose words are not on the page.
    expect(docs.search(doc, "???").passages).toEqual([]);
    expect(docs.search(doc, "zebra quokka").passages).toEqual([]);
  });

  it("boosts a heading match over a body mention", async () => {
    const { docs } = store();
    const text = `# Doc\n\n## Pricing\n\nPlans start at 5 dollars.\n\n## Other\n\nSee pricing above for details on what you pay.\n`;
    const doc = await docs.put("agt", "s", "https://x.example/", page(text));
    expect(docs.search(doc, "pricing").passages[0]!.sectionId).toBe("pricing");
  });

  it("only searches the given document, reindexes changed text, and drops passages with their document", async () => {
    const { db, docs } = store();
    const a = await docs.put("agt", "s", "https://a.example/", page("# A\n\nApples grow here."));
    const b = await docs.put("agt", "s", "https://b.example/", page("# B\n\nBananas grow here."));
    expect(docs.search(a, "bananas").passages).toEqual([]);
    expect(docs.search(b, "bananas").passages).toHaveLength(1);
    const before = docs.passages(a.id);
    // The same text keeps its passages (same rows); new text gets new ones.
    await docs.put("agt", "s", "https://a.example/", page("# A\n\nApples grow here."));
    expect(db.all("SELECT id FROM web_passages WHERE document_id = ?", a.id)).toHaveLength(before.length);
    const changed = await docs.put("agt", "s", "https://a.example/", page("# A\n\nCherries grow here now."));
    expect(docs.search(changed, "apples").passages).toEqual([]);
    expect(docs.search(changed, "cherries").passages).toHaveLength(1);
    // Deleting documents (any path: prune, purge, agent or session deletion) takes the passages and the index rows along.
    db.run("DELETE FROM web_documents");
    expect(db.all("SELECT id FROM web_passages")).toEqual([]);
    expect(db.all("SELECT rowid FROM web_passages_fts")).toEqual([]);
  });
});
