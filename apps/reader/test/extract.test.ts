import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { decodeBody, extractBody, extractHtml } from "../src/core/extract.ts";
import { type DomNode, htmlToMarkdown } from "../src/core/markdown.ts";
import { sectionsOf, slug } from "../src/core/sections.ts";
import { ReaderError } from "../src/core/types.ts";
import { ARTICLE_HTML, ARTICLE_URL } from "./fixtures/article.ts";

const md = (html: string, baseUrl?: string): string =>
  htmlToMarkdown(parseHTML(`<html><body>${html}</body></html>`).document.body as unknown as DomNode, { baseUrl });

describe("extracting an article page", () => {
  const page = extractHtml(ARTICLE_HTML, ARTICLE_URL);

  it("finds the title and keeps the article", () => {
    expect(page.title).toContain("Kyoto in Autumn");
    expect(page.text).toContain("Kyoto turns red and gold from **mid November** to early December.");
    expect(page.text).toContain("## When to go");
    expect(page.text).toContain("*20 November*");
  });

  it("drops scripts, styles, navigation, forms, hidden banners and the footer", () => {
    for (const junk of [
      "dataLayer",
      "position: fixed",
      "Destinations",
      "Deals",
      "Accept all cookies",
      "Search",
      "All rights reserved",
      "analytics",
    ])
      expect(page.text).not.toContain(junk);
  });

  it("resolves links against the page address and keeps their text", () => {
    expect(page.text).toContain("[temple guide](https://travel.example.com/guides/kyoto-temples)");
    expect(page.text).toContain("[foliage map](https://maps.example.org/kyoto?layer=foliage)");
  });

  it("writes lists with nesting, tables as pipe tables, code fenced with its language, and quotes", () => {
    expect(page.text).toContain(
      "- Mid November: the hills (Kurama, Takao)\n- Late November: central temples\n  - Eikando\n  - Tofukuji\n- Early December: the last colour at Daigoji",
    );
    expect(page.text).toContain(
      "| Temple | Fee | Opens |\n| --- | --- | --- |\n| Kinkaku-ji | 500 yen | 09:00 |\n| Eikando | 1,000 yen | 09:00 |",
    );
    expect(page.text).toContain("```bash\ncurl -s https://weather.example.net/kyoto.json | jq '.days[0]'\n```");
    expect(page.text).toContain("> The best view of Eikando is from the pond at 8:30, before the tour buses.");
  });
});

describe("the Markdown serializer", () => {
  it("handles headings, emphasis, breaks, rules, images by alt text and ordered lists with a start", () => {
    const out = md(
      '<h3>Title <em>here</em></h3><p>a<br>b</p><hr><img src="x.png" alt="A map"><ol start="3"><li>c</li><li>d</li></ol><p>del <s>old</s> <code>x` y</code></p>',
    );
    expect(out).toBe("### Title *here*\n\na\nb\n\n---\n\n[Image: A map]\n\n3. c\n4. d\n\ndel ~~old~~ ``x` y``");
  });

  it("does not turn javascript: or mailto: links into links, and resolves relative ones", () => {
    expect(
      md(
        '<p><a href="javascript:alert(1)">bad</a> <a href="mailto:a@b.c">mail</a> <a href="../up">up</a> <a href="#top">top</a></p>',
        "https://x.example/a/b/c",
      ),
    ).toBe("bad mail [up](https://x.example/a/up) top");
  });

  it("renders a block inside a link as content, and a one-column table as plain content", () => {
    expect(md('<a href="/x"><div><p>Card title</p><p>Card text</p></div></a>', "https://x.example/")).toBe(
      "Card title\n\nCard text",
    );
    expect(md("<table><tr><td><p>Only</p><p>layout</p></td></tr></table>")).toBe("Only\n\nlayout");
  });

  it("escapes pipes in table cells and pads short rows", () => {
    expect(md("<table><tr><th>a</th><th>b</th></tr><tr><td>x|y</td></tr></table>")).toBe(
      "| a | b |\n| --- | --- |\n| x\\|y |  |",
    );
  });

  it("keeps preformatted text exactly and uses a longer fence than the code holds", () => {
    expect(md("<pre>line 1\n  line 2\n```inside\n</pre>")).toBe("````\nline 1\n  line 2\n```inside\n````");
  });
});

describe("extraction fallbacks and types", () => {
  it("falls back to the body text when Readability finds no article", () => {
    const page = extractHtml(
      "<html><head><title>Tiny</title></head><body><p>Just a line.</p><ul><li>one</li><li>two</li></ul></body></html>",
      "https://x.example/tiny",
    );
    expect(page.title).toBe("Tiny");
    expect(page.text).toBe("Just a line.\n\n- one\n- two");
  });

  it("never throws on broken markup", () => {
    const page = extractHtml("<div><p>Open <b>tags <i>everywhere<table><td>x</div></p>", "https://x.example/");
    expect(page.text).toContain("x");
  });

  it("passes text and Markdown through, pretty-prints JSON, and refuses other types", () => {
    const bytes = (t: string) => new TextEncoder().encode(t);
    expect(extractBody(bytes("# Notes\nhello"), "text/markdown", "https://x.example/n.md")).toMatchObject({
      title: "Notes",
      text: "# Notes\nhello",
      quality: "success",
      extractor: "text",
      sections: [{ id: "notes", level: 1, heading: "Notes", start: 0, end: 13 }],
    });
    expect(extractBody(bytes("plain words"), "text/plain; charset=utf-8", "https://x.example/p").text).toBe(
      "plain words",
    );
    expect(extractBody(bytes('{"a":[1,2],"b":{"c":true}}'), "application/json", "https://x.example/j").text).toBe(
      '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": true\n  }\n}',
    );
    expect(extractBody(bytes('{"a":1}'), "application/vnd.api+json", "https://x.example/j").text).toContain('"a": 1');
    for (const type of ["application/pdf", "image/png", "application/zip", "text/css"]) {
      expect(() => extractBody(bytes("x"), type, "https://x.example/")).toThrow(ReaderError);
    }
    expect(() => extractBody(bytes("x"), "application/pdf", "https://x.example/")).toThrow(
      "not a readable page (application/pdf)",
    );
  });

  it("sniffs HTML when there is no content type, and refuses binary", () => {
    const bytes = (t: string) => new TextEncoder().encode(t);
    expect(
      extractBody(
        bytes("<!doctype html><html><head><title>S</title></head><body><p>sniffed</p></body></html>"),
        undefined,
        "https://x.example/",
      ).text,
    ).toBe("sniffed");
    expect(() =>
      extractBody(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2]), undefined, "https://x.example/"),
    ).toThrow(ReaderError);
  });

  it("decodes by the charset in the header, then by <meta charset>, else UTF-8", () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    expect(decodeBody(latin1, "text/plain; charset=iso-8859-1")).toBe("café");
    const withMeta = new Uint8Array([...new TextEncoder().encode('<meta charset="iso-8859-1">'), 0xe9]);
    expect(decodeBody(withMeta, "text/html")).toBe('<meta charset="iso-8859-1">é');
    expect(decodeBody(new TextEncoder().encode("日本語"), "text/plain; charset=nonsense")).toBe("日本語");
  });
});

describe("sections", () => {
  it("gives each heading a stable slug id, numbers repeats, and keeps the text before the first heading as top", () => {
    const text =
      "Intro line.\n\n# Guide\n\nA.\n\n## When to go\n\nB.\n\n## When to go\n\nC.\n\n### [Fees](https://x.example/f) **now**\n\nD.";
    const sections = sectionsOf(text);
    expect(sections.map((s) => s.id)).toEqual(["top", "guide", "when-to-go", "when-to-go-2", "fees-now"]);
    expect(sections.map((s) => s.path)).toEqual([
      [],
      ["Guide"],
      ["Guide", "When to go"],
      ["Guide", "When to go"],
      ["Guide", "When to go", "[Fees](https://x.example/f) **now**"],
    ]);
    // Contiguous and covering: each section ends where the next begins.
    expect(sections[0]!.start).toBe(0);
    for (let i = 1; i < sections.length; i++) expect(sections[i]!.start).toBe(sections[i - 1]!.end);
    expect(sections.at(-1)!.end).toBe(text.length);
    expect(text.slice(sections[2]!.start, sections[2]!.end)).toBe("## When to go\n\nB.\n\n");
  });

  it("ignores headings inside fenced code, and keeps CJK and other scripts in ids", () => {
    const text = "# 通車時程\n\n```bash\n# not a heading\n```\n\n~~~~\n## nor this\n~~~~\n\n## Über uns\n";
    expect(sectionsOf(text).map((s) => s.id)).toEqual(["通車時程", "über-uns"]);
    expect(slug("Step 1: Install!")).toBe("step-1-install");
    expect(sectionsOf("# !!!\n\n# ???\n").map((s) => s.id)).toEqual(["section", "section-2"]);
    expect(sectionsOf("").length).toBe(0);
  });

  it("does not let a heading named like a numbered repeat collide with one", () => {
    expect(sectionsOf("# A\n# A-2\n# A\n").map((s) => s.id)).toEqual(["a", "a-2", "a-3"]);
  });
});

describe("page quality", () => {
  const page = (body: string, head = "") =>
    extractHtml(
      `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`,
      "https://x.example/p",
    );
  const prose = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `<p>Paragraph ${i} explains one more thing about the topic in plain words.</p>`,
    ).join("");

  it("calls a bot check or a sign-in wall blocked, and says why", () => {
    const captcha = page(
      '<h1>Checking if the site connection is secure</h1><p>Verify you are human.</p><div class="cf-turnstile"></div>',
      '<script src="/cdn-cgi/challenge-platform/x.js"></script>',
    );
    expect(captcha).toMatchObject({ quality: "blocked", reasons: ["bot_check"] });
    const login = page(
      '<main><h1>Sign in to continue</h1><form><input type="password"><button>Sign in</button></form></main>',
    );
    expect(login).toMatchObject({ quality: "blocked", reasons: ["login_wall"] });
  });

  it("keeps real pages that only carry bot-check or password markup", () => {
    // A post with a reCAPTCHA on its comment form, and an article that shows a password field in an example.
    expect(
      page(`<article><h1>Post</h1>${prose(30)}</article><form><div class="g-recaptcha"></div></form>`).quality,
    ).toBe("success");
    expect(page(`<article><h1>How to log in</h1>${prose(20)}<input type="password"></article>`).quality).toBe(
      "success",
    );
  });

  it("calls an app shell requires_js, including one whose site chrome would extract fine", () => {
    const empty = page('<div id="root"></div>', '<script type="module" src="/a.js"></script>');
    expect(empty).toMatchObject({ quality: "requires_js", text: "", extractor: "none", reasons: ["empty_app"] });
    const chrome = page(
      `<header><nav>${Array.from({ length: 30 }, (_, i) => `<a href="/${i}">Link number ${i}</a>`).join(" ")}</nav></header><main><div aria-busy="true">Loading…</div></main><footer>${prose(3)}</footer>`,
      '<script src="/app.js"></script>',
    );
    expect(chrome).toMatchObject({ quality: "requires_js", reasons: ["empty_main"] });
  });

  it("keeps short pages and server-rendered app pages", () => {
    // A short page with an analytics script, and a Next.js page rendered on the server (data and HTML both present).
    expect(
      page("<main><h1>All systems operational</h1><p>No incidents today.</p></main>", "<script>gtag()</script>")
        .quality,
    ).toBe("success");
    const ssr = page(
      `<div id="__next"><article><h1>Release notes</h1>${prose(10)}</article></div><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"x":"A string from the data that is long enough to harvest."}}}</script>`,
      '<script src="/_next/main.js"></script>',
    );
    expect(ssr).toMatchObject({ quality: "success", extractor: "readability" });
    expect(ssr.text).toContain("Paragraph 9 explains");
  });

  it("reads the content a shell embeds: JSON-LD first, then app data, then the description", () => {
    const shell = '<div id="app">Loading…</div>';
    const js = '<script src="/app.js"></script>';
    const body = "The desk surface should sit at or just below elbow height. ".repeat(3);
    const ld = page(
      shell,
      `${js}<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"S"},{"@type":"Article","headline":"Desks","articleBody":"${body}"}]}</script><meta name="description" content="Short summary.">`,
    );
    expect(ld).toMatchObject({ quality: "success", extractor: "json-ld", title: "Desks", reasons: ["empty_app"] });
    expect(ld.text).toContain("elbow height");

    const next = page(
      `${shell}<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"post":{"title":"Notes 4.2","url":"https://x.example/a/long/path/that/is/not/prose","html":"<p>Version 4.2 adds <strong>partial refunds</strong> for individual line items on every paid plan.</p>","cls":"flex items-center justify-between gap-4 px-6"}}}}</script>`,
      js,
    );
    expect(next).toMatchObject({ extractor: "next-data", title: "Notes 4.2", quality: "low_quality" });
    expect(next.text).toBe("Version 4.2 adds **partial refunds** for individual line items on every paid plan.");

    const meta = page(
      '<noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div>',
      `${js}<meta property="og:description" content="Festival runs 5 to 14 December."><meta property="og:title" content="Lights">`,
    );
    expect(meta).toMatchObject({
      quality: "low_quality",
      extractor: "meta",
      title: "Lights",
      text: "Festival runs 5 to 14 December.",
    });
  });
});
