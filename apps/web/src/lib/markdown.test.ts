import { describe, expect, it } from "vitest";
import { type Block, parseInline, parseMarkdown, safeHref } from "./markdown.ts";

describe("parseMarkdown", () => {
  it("reads headings, paragraphs and rules", () => {
    expect(parseMarkdown("## Plan\nfirst line\nsecond line\n\n---")).toEqual([
      { t: "h", level: 2, slug: "plan", children: [{ t: "text", text: "Plan" }] },
      { t: "p", children: [{ t: "text", text: "first line" }, { t: "br" }, { t: "text", text: "second line" }] },
      { t: "hr" },
    ]);
  });

  it("reads bullet and ordered lists, with nesting and a start number", () => {
    const [list, ol] = parseMarkdown("- one\n  - inner\n- two\n\n3. three\n4. four");
    expect(list).toMatchObject({ t: "list", ordered: false });
    if (list?.t !== "list") throw new Error("not a list");
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject([
      { t: "p" },
      { t: "list", ordered: false, items: [[{ t: "p", children: [{ t: "text", text: "inner" }] }]] },
    ]);
    expect(ol).toMatchObject({ t: "list", ordered: true, start: 3 });
  });

  it("keeps a loose list together across blank lines", () => {
    const blocks = parseMarkdown("1. a\n\n2. b\n\n3. c");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ t: "list", items: [[{ t: "p" }], [{ t: "p" }], [{ t: "p" }]] });
  });

  it("reads fenced code verbatim and marks an unclosed fence as open", () => {
    expect(parseMarkdown("```ts\nconst a = **b**;\n```\nafter")).toEqual([
      { t: "code", lang: "ts", text: "const a = **b**;", open: false },
      { t: "p", children: [{ t: "text", text: "after" }] },
    ]);
    expect(parseMarkdown("```py\nprint(1)")).toEqual([{ t: "code", lang: "py", text: "print(1)", open: true }]);
  });

  it("reads tables with alignment and pads short rows", () => {
    const [table] = parseMarkdown("| a | b |\n|:--|--:|\n| 1 | `x|y` |\n| 2 |");
    expect(table).toMatchObject({
      t: "table",
      align: ["left", "right"],
      head: [[{ t: "text", text: "a" }], [{ t: "text", text: "b" }]],
      rows: [
        [[{ t: "text", text: "1" }], [{ t: "code", text: "x|y" }]],
        [[{ t: "text", text: "2" }], []],
      ],
    });
  });

  it("does not treat a half-streamed table header as a table", () => {
    expect(parseMarkdown("| a | b |")).toEqual([{ t: "p", children: [{ t: "text", text: "| a | b |" }] }]);
  });

  it("reads block quotes", () => {
    expect(parseMarkdown("> quoted\n> more")).toEqual([
      {
        t: "quote",
        blocks: [{ t: "p", children: [{ t: "text", text: "quoted" }, { t: "br" }, { t: "text", text: "more" }] }],
      },
    ]);
  });

  it("keeps HTML as text", () => {
    expect(parseMarkdown("<script>alert(1)</script>")).toEqual([
      { t: "p", children: [{ t: "text", text: "<script>alert(1)</script>" }] },
    ]);
  });
});

describe("parseInline", () => {
  it("reads strong, em, strike and code", () => {
    expect(parseInline("**b** *i* ~~s~~ `c` ***bi***")).toEqual([
      { t: "strong", children: [{ t: "text", text: "b" }] },
      { t: "text", text: " " },
      { t: "em", children: [{ t: "text", text: "i" }] },
      { t: "text", text: " " },
      { t: "del", children: [{ t: "text", text: "s" }] },
      { t: "text", text: " " },
      { t: "code", text: "c" },
      { t: "text", text: " " },
      { t: "strong", children: [{ t: "em", children: [{ t: "text", text: "bi" }] }] },
    ]);
  });

  it("leaves snake_case, lone stars and escapes alone", () => {
    expect(parseInline("snake_case_name")).toEqual([{ t: "text", text: "snake_case_name" }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", text: "2 * 3 * 4" }]);
    expect(parseInline("\\*not em\\*")).toEqual([{ t: "text", text: "*not em*" }]);
  });

  it("makes links only for http(s) and mailto", () => {
    expect(parseInline("[docs](https://example.com/a)")).toEqual([
      { t: "link", href: "https://example.com/a", children: [{ t: "text", text: "docs" }] },
    ]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ t: "text", text: "x" }]);
    expect(parseInline("[x](data:text/html,hi)")).toEqual([{ t: "text", text: "x" }]);
    expect(parseInline("see https://example.com.")).toEqual([
      { t: "text", text: "see " },
      { t: "link", href: "https://example.com", children: [{ t: "text", text: "https://example.com" }] },
      { t: "text", text: "." },
    ]);
  });

  it("handles CJK text next to emphasis", () => {
    expect(parseInline("這是**重點**。")).toEqual([
      { t: "text", text: "這是" },
      { t: "strong", children: [{ t: "text", text: "重點" }] },
      { t: "text", text: "。" },
    ]);
  });
});

describe("safeHref", () => {
  it("allows only http, https and mailto", () => {
    expect(safeHref(" https://a.b ")).toBe("https://a.b");
    expect(safeHref("mailto:me@example.com")).toBe("mailto:me@example.com");
    expect(safeHref("JavaScript:alert(1)")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
  });
});

describe("Knowledge blocks", () => {
  it("parses page and file links and file images, leaving other schemes as text", () => {
    expect(parseInline("[Plan](page:p_1) and [deck](file:f_2@v_3) ![chart](file:f_4)")).toEqual([
      { t: "page", pageId: "p_1", children: [{ t: "text", text: "Plan" }] },
      { t: "text", text: " and " },
      { t: "file", fileId: "f_2", versionId: "v_3", children: [{ t: "text", text: "deck" }] },
      { t: "text", text: " " },
      { t: "image", fileId: "f_4", versionId: null, alt: "chart" },
    ]);
    expect(parseInline("[x](pages:nope)")).toEqual([{ t: "text", text: "x" }]);
  });

  it("turns GitHub callouts into callouts, foldable with - and +", () => {
    const [plain, folded] = parseMarkdown("> [!WARNING]\n> Mind the gap\n\n> [!tip]- Shortcuts\n> Use ⌘K");
    expect(plain).toMatchObject({ t: "callout", kind: "warning", fold: null, title: [] });
    expect(folded).toMatchObject({
      t: "callout",
      kind: "tip",
      fold: "closed",
      title: [{ t: "text", text: "Shortcuts" }],
    });
    expect(parseMarkdown("> [!NOTE]+\n> Open")[0]).toMatchObject({ fold: "open" });
    expect(parseMarkdown("> just a quote")[0]!.t).toBe("quote");
  });

  it("numbers tasks in page order, nested ones included, and leaves tasks in quotes unnumbered", () => {
    const blocks = parseMarkdown("- [ ] One\n  - [x] One.a\n- [X] Two\n- plain\n\n> - [ ] Quoted\n\n1. [ ] Three");
    const list = blocks[0] as Extract<Block, { t: "list" }>;
    expect(list.tasks).toEqual([{ done: false, index: 0 }, { done: true, index: 2 }, null]);
    const nested = list.items[0]![1] as Extract<Block, { t: "list" }>;
    expect(nested.tasks).toEqual([{ done: true, index: 1 }]);
    expect(list.items[0]![0]).toEqual({ t: "p", children: [{ t: "text", text: "One" }] });
    const quoted = (blocks[1] as Extract<Block, { t: "quote" }>).blocks[0] as Extract<Block, { t: "list" }>;
    expect(quoted.tasks).toEqual([{ done: false, index: null }]);
    expect((blocks[2] as Extract<Block, { t: "list" }>).tasks).toEqual([{ done: false, index: 3 }]);
  });
});

describe("footnotes", () => {
  it("numbers references by first use and shares a number between repeats", () => {
    const blocks = parseMarkdown("A[^b] B[^a] C[^b]\n\n[^a]: one\n[^b]: two");
    expect(blocks[0]).toMatchObject({
      children: [
        { t: "text" },
        { t: "fnref", n: 1, use: 1 },
        { t: "text" },
        { t: "fnref", n: 2, use: 1 },
        { t: "text" },
        { t: "fnref", n: 1, use: 2 },
      ],
    });
    expect(blocks[1]).toMatchObject({
      t: "footnotes",
      items: [
        { n: 1, uses: 2, blocks: [{ children: [{ text: "two" }] }] },
        { n: 2, uses: 1, blocks: [{ children: [{ text: "one" }] }] },
      ],
    });
  });

  it("does not disturb task numbering or section slugs", () => {
    const blocks = parseMarkdown("# Top\n\n[^a]: note\n\n- [ ] one[^a]\n- [x] two");
    expect(blocks[0]).toMatchObject({ t: "h", slug: "top" });
    expect(blocks[1]).toMatchObject({ t: "list", tasks: [{ index: 0 }, { index: 1 }] });
  });

  it("reads a definition only at the start of a line, and never in a quote", () => {
    const [quote] = parseMarkdown("> [^a]: not a note\n\nref[^a]");
    expect(quote?.t).toBe("quote");
    expect(parseMarkdown("x [^a]: inline\n\nref[^a]").some((b) => b.t === "footnotes")).toBe(false);
  });
});

const p = (text: string): Block => ({ t: "p", children: [{ t: "text", text }] });

describe("underlined (setext) headings", () => {
  it("makes paragraph text over === a level 1 heading and over --- a level 2 heading, with section slugs", () => {
    expect(parseMarkdown("Setext heading\n==============\n\nNext\n--------------")).toEqual([
      { t: "h", level: 1, slug: "setext-heading", children: [{ t: "text", text: "Setext heading" }] },
      { t: "h", level: 2, slug: "next", children: [{ t: "text", text: "Next" }] },
    ]);
  });

  it("accepts an underline indented up to three spaces with trailing spaces, and not four", () => {
    expect(parseMarkdown("Title\n   ---   ")[0]).toMatchObject({ t: "h", level: 2, slug: "title" });
    expect(parseMarkdown("Title\n    ---")).toEqual([
      { t: "p", children: [{ t: "text", text: "Title" }, { t: "br" }, { t: "text", text: "---" }] },
    ]);
  });

  it("turns a paragraph of several lines into one heading, slugged with spaces", () => {
    expect(parseMarkdown("Two\nlines\n===")).toEqual([
      {
        t: "h",
        level: 1,
        slug: "two-lines",
        children: [{ t: "text", text: "Two" }, { t: "br" }, { t: "text", text: "lines" }],
      },
    ]);
  });

  it("numbers repeated slugs across # and underlined headings in document order", () => {
    const slugs = parseMarkdown("## Notes\n\nNotes\n-----\n\n# Notes").map((b) => (b.t === "h" ? b.slug : null));
    expect(slugs).toEqual(["notes", "notes-1", "notes-2"]);
  });

  it("keeps --- a rule after a blank line, a list item, a quote, a table and a fence", () => {
    expect(parseMarkdown("above\n\n---")).toEqual([p("above"), { t: "hr" }]);
    expect(parseMarkdown("- item\n---")).toEqual([
      { t: "list", ordered: false, start: 1, items: [[p("item")]] },
      { t: "hr" },
    ]);
    expect(parseMarkdown("> quoted\n---")).toEqual([{ t: "quote", blocks: [p("quoted")] }, { t: "hr" }]);
    expect(parseMarkdown("| a |\n|---|\n| 1 |\n---").map((b) => b.t)).toEqual(["table", "hr"]);
    expect(parseMarkdown("```\ncode\n```\n---").map((b) => b.t)).toEqual(["code", "hr"]);
  });

  it("keeps a table whose separator row is dashes", () => {
    expect(parseMarkdown("a | b\n---|---\n1 | 2")[0]).toMatchObject({
      t: "table",
      rows: [[[{ text: "1" }], [{ text: "2" }]]],
    });
    expect(parseMarkdown("| a | b |\n| --- | --- |")[0]).toMatchObject({
      t: "table",
      head: [[{ text: "a" }], [{ text: "b" }]],
    });
    expect(parseMarkdown("intro\n| a |\n| --- |").map((b) => b.t)).toEqual(["p", "table"]);
  });

  it("leaves a lazy line under a list item as text, never an underline", () => {
    expect(parseMarkdown("- item\n--")).toEqual([
      {
        t: "list",
        ordered: false,
        start: 1,
        items: [[{ t: "p", children: [{ t: "text", text: "item" }, { t: "br" }, { t: "text", text: "--" }] }]],
      },
    ]);
    expect(parseMarkdown("- item\n===")[0]).toMatchObject({ t: "list", items: [[{ t: "p" }]] });
  });

  it("underlines inside a quote or list item without making a section", () => {
    expect(parseMarkdown("> Quoted\n> ---")).toEqual([
      { t: "quote", blocks: [{ t: "h", level: 2, children: [{ t: "text", text: "Quoted" }] }] },
    ]);
  });

  it("settles a streaming underline on what the complete line will be", () => {
    // A lone `-` may still become a list item: until the line is complete, the paragraph shows alone.
    expect(parseMarkdown("Setext heading\n-")).toEqual([p("Setext heading")]);
    expect(parseMarkdown("Setext heading\n- ")).toEqual([p("Setext heading")]);
    expect(parseMarkdown("Setext heading\n- a")).toEqual([
      p("Setext heading"),
      { t: "list", ordered: false, start: 1, items: [[p("a")]] },
    ]);
    const heading = { t: "h", level: 2, slug: "setext-heading", children: [{ t: "text", text: "Setext heading" }] };
    for (const text of ["Setext heading\n--", "Setext heading\n---", "Setext heading\n-\n", "Setext heading\n-\nmore"])
      expect(parseMarkdown(text)[0]).toEqual(heading);
    expect(parseMarkdown("Setext heading\n=")[0]).toMatchObject({ t: "h", level: 1 });
    // The same inside a list item that is still streaming.
    expect(parseMarkdown("- Intro:\n  -")).toEqual([{ t: "list", ordered: false, start: 1, items: [[p("Intro:")]] }]);
  });
});

describe("indented code", () => {
  it("reads four spaces or a tab as code with no language, less one level, keeping inner blank lines", () => {
    expect(parseMarkdown("Intro\n\n    const a = 1;\n\n      nested();\n\n\nAfter")).toEqual([
      p("Intro"),
      { t: "code", lang: "", text: "const a = 1;\n\n  nested();", open: false },
      p("After"),
    ]);
    expect(parseMarkdown("\tline one\n\t\tline two")).toEqual([
      { t: "code", lang: "", text: "line one\n\tline two", open: false },
    ]);
    expect(parseMarkdown("# Title\n    code")[1]).toEqual({ t: "code", lang: "", text: "code", open: false });
  });

  it("lets an indented line continue a paragraph", () => {
    expect(parseMarkdown("Text\n    continued")).toEqual([
      { t: "p", children: [{ t: "text", text: "Text" }, { t: "br" }, { t: "text", text: "continued" }] },
    ]);
  });

  it("leaves indented list content as list content", () => {
    expect(parseMarkdown("- a\n\n      deeper\n- b\n    - nested")).toEqual([
      {
        t: "list",
        ordered: false,
        start: 1,
        items: [
          [p("a"), p("deeper")],
          [p("b"), { t: "list", ordered: false, start: 1, items: [[p("nested")]] }],
        ],
      },
    ]);
    expect(parseMarkdown("1. Step\n\n    More about the step.")).toEqual([
      { t: "list", ordered: true, start: 1, items: [[p("Step"), p("More about the step.")]] },
    ]);
  });

  it("leaves an indented footnote continuation as the note's text", () => {
    expect(parseMarkdown("Ref[^n].\n\n[^n]: First\n    second\n\n        deeper")).toEqual([
      {
        t: "p",
        children: [
          { t: "text", text: "Ref" },
          { t: "fnref", n: 1, use: 1 },
          { t: "text", text: "." },
        ],
      },
      {
        t: "footnotes",
        items: [
          {
            n: 1,
            uses: 1,
            blocks: [
              { t: "p", children: [{ t: "text", text: "First" }, { t: "br" }, { t: "text", text: "second" }] },
              p("deeper"),
            ],
          },
        ],
      },
    ]);
  });
});

describe("web images", () => {
  it("reads an http(s) image with its alt text, never leaving a stray !", () => {
    expect(parseInline('see ![a chart](https://example.com/c.png) and ![](http://example.com/d.png "Title")')).toEqual([
      { t: "text", text: "see " },
      { t: "webimage", src: "https://example.com/c.png", alt: "a chart" },
      { t: "text", text: " and " },
      { t: "webimage", src: "http://example.com/d.png", alt: "" },
    ]);
  });

  it("shows only the alt text for an unsafe or unparseable source", () => {
    expect(parseInline("![x](javascript:alert(1))")).toEqual([{ t: "text", text: "x" }]);
    expect(parseInline("![pic](data:image/png;base64,AAAA)")).toEqual([{ t: "text", text: "pic" }]);
    expect(parseInline("![mail](mailto:me@example.com)")).toEqual([{ t: "text", text: "mail" }]);
    expect(parseInline("![rel](/images/a.png)")).toEqual([{ t: "text", text: "rel" }]);
    expect(parseInline("![broken](https://)")).toEqual([{ t: "text", text: "broken" }]);
    expect(parseInline("a ![](javascript:x) b")).toEqual([
      { t: "text", text: "a " },
      { t: "text", text: " b" },
    ]);
  });

  it("keeps Library images as they were", () => {
    expect(parseInline("![chart](file:f_4@v_2)")).toEqual([
      { t: "image", fileId: "f_4", versionId: "v_2", alt: "chart" },
    ]);
  });
});
