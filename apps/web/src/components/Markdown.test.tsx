import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown.tsx";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));

const fence = (lang: string, body: string, close = true) => `\`\`\`${lang}\n${body}${close ? "\n```" : ""}`;

describe("code blocks", () => {
  it("colours a known language and keeps the raw text", async () => {
    const { container } = render(<Markdown text={fence("ts", "const n: number = 1;")} />);
    await waitFor(() => expect(container.querySelector("code .hljs-keyword")?.textContent).toBe("const"));
    expect(container.querySelector("code")?.textContent).toBe("const n: number = 1;");
  });

  it("leaves an unknown or missing language plain", async () => {
    const { container } = render(
      <Markdown text={`${fence("nonsense", "const a = 1;")}\n\n${fence("", "const b = 2;")}`} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelectorAll("pre code")).toHaveLength(2);
    expect(container.querySelector(".hljs-keyword")).toBeNull();
  });
});

describe("mermaid fences", () => {
  beforeEach(() => {
    mermaid.initialize.mockReset();
    mermaid.render.mockReset();
  });

  it("draws a closed fence as a diagram in strict mode and can show its source", async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg data-testid="diagram"></svg>' });
    render(<Markdown text={fence("mermaid", "graph TD\n  A --> B")} />);
    expect(await screen.findByTestId("diagram")).toBeTruthy();
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", htmlLabels: false }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(screen.queryByTestId("diagram")).toBeNull();
    expect(screen.getByText(/A --> B/)).toBeTruthy();
  });

  it("does not draw a fence that is still open", async () => {
    render(<Markdown text={fence("mermaid", "graph TD\n  A --> B", false)} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(screen.getByText(/A --> B/)).toBeTruthy();
  });

  it("falls back to the code with a note on a syntax error", async () => {
    mermaid.render.mockRejectedValue(new Error("Parse error"));
    render(<Markdown text={fence("mermaid", "graph TD\n  A -->")} />);
    expect((await screen.findByRole("status")).textContent).toMatch(/syntax error/);
    expect(screen.getByText(/A -->/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  });
});

describe("section links", () => {
  it("opens a section link at its anchor and leaves chat headings without ids", () => {
    render(<Markdown text={"## Plan\n\n[w2](page:pg_1#第二週-進度) [top](page:pg_1)"} />);
    expect(screen.getByRole("link", { name: "w2" }).getAttribute("href")).toBe(
      `/knowledge/pg_1#${encodeURIComponent("第二週-進度")}`,
    );
    expect(screen.getByRole("link", { name: "top" }).getAttribute("href")).toBe("/knowledge/pg_1");
    expect(screen.getByRole("heading", { name: "Plan" }).id).toBe("");
    expect(screen.queryByRole("button", { name: "Copy section link" })).toBeNull();
  });
});

describe("footnotes", () => {
  const text = "Claim.[^a] Again.[^a] Other.[^b]\n\n[^a]: Source A, [site](https://example.com).\n[^b]: Source B.";

  it("shows numbered superscript references and a list of notes with back-links", () => {
    const { container } = render(<Markdown text={text} />);
    const refs = [...container.querySelectorAll("sup.md-fnref a")];
    expect(refs.map((a) => a.textContent)).toEqual(["1", "1", "2"]);
    const notes = [...container.querySelectorAll(".md-footnotes li")];
    expect(notes).toHaveLength(2);
    expect(notes[0]?.textContent).toContain("Source A, site");
    expect(notes[0]?.querySelectorAll("a.md-fn-back")).toHaveLength(2);
    expect(notes[0]?.querySelector('a[href="https://example.com"]')).toBeTruthy();
    // The definitions are not in the flow.
    expect(container.querySelector(".md > p")?.textContent).not.toContain("Source A");
  });

  it("links both ways", async () => {
    const { container } = render(<Markdown text={text} />);
    const ref = container.querySelector<HTMLAnchorElement>("sup.md-fnref a")!;
    const note = container.querySelector<HTMLElement>(".md-footnotes li")!;
    expect(ref.getAttribute("href")).toBe(`#${note.id}`);
    const back = note.querySelector<HTMLAnchorElement>("a.md-fn-back")!;
    expect(back.getAttribute("href")).toBe(`#${ref.id}`);
    note.scrollIntoView = vi.fn();
    await userEvent.click(ref);
    expect(note.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(note);
  });

  it("keeps anchors unique across messages", () => {
    const { container } = render(
      <>
        <Markdown text={text} />
        <Markdown text={text} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("leaves a reference without a definition as text, and lists an unused note", () => {
    const { container } = render(<Markdown text={"Hi[^gone] there.\n\n[^x]: Unused note."} />);
    expect(container.querySelector("sup")).toBeNull();
    expect(container.querySelector(".md > p")?.textContent).toBe("Hi[^gone] there.");
    expect(container.querySelector(".md-footnotes li")?.textContent).toContain("Unused note.");
    expect(container.querySelector("a.md-fn-back")).toBeNull();
  });
});

describe("inline chat citations", () => {
  it("reveals the source URL on keyboard focus and leaves no end-of-reply list", async () => {
    const href = "https://www.example.com/research";
    const { container } = render(
      <Markdown inlineCitations text={`Claim.[^a] Again.[^a]\n\n[^a]: **[Research report](${href})**.`} />,
    );
    const chips = screen.getAllByRole("button", { name: "example.com" });
    expect(chips).toHaveLength(2);
    expect(container.querySelector(".md > p")?.contains(chips[0]!)).toBe(true);
    expect(screen.queryByRole("list")).toBeNull();

    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(chips[0]);
    const card = await screen.findByRole("dialog", { name: "example.com" });
    const source = within(card).getByRole("link", { name: /Research report/ });
    expect(source.textContent).toContain(href);
    expect(source.getAttribute("href")).toBe(href);
    expect(source.getAttribute("target")).toBe("_blank");
    await user.keyboard("{Enter}");
    expect(card.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(chips[0]);
  });

  it("uses the same hover card for file references, text-only notes and unreferenced notes", async () => {
    render(
      <Markdown
        inlineCitations
        text={"Claim.[^a] Aside.[^b]\n\n[^a]: [Report.pdf](file:fl_example)\n[^b]: More context.\n[^c]: Extra note."}
      />,
    );
    expect(screen.queryByRole("list")).toBeNull();
    const user = userEvent.setup();
    const file = screen.getByRole("button", { name: "Report.pdf" });
    await user.hover(file);
    const fileCard = await screen.findByRole("dialog", { name: "Report.pdf" });
    expect(within(fileCard).getByRole("link", { name: "Report.pdf" }).getAttribute("href")).toBe("/library/fl_example");
    await user.click(file);
    await user.unhover(file);
    expect(fileCard.className).toContain("md-citation-card");
    await user.keyboard("{Escape}");
    await user.hover(screen.getByRole("button", { name: "Note" }));
    const noteCard = await screen.findByRole("dialog", { name: "Note" });
    expect(noteCard.className).toBe(fileCard.className);
    expect(within(noteCard).getByText("More context.")).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect((await screen.findByRole("dialog", { name: "Notes" })).textContent).toContain("Extra note.");
  });

  it("labels citations by distinct sources across rich note paragraphs and lists", async () => {
    const text =
      "Result.[^one] Other result.[^many]\n\n[^one]: Explanation above the source.\n\n  [Report](https://example.com/report)\n[^many]: Two separate reports.\n\n  - [First](https://example.com/first)\n  - [Second](https://example.org/second)\n  - [First again](https://example.com/first)";
    render(<Markdown inlineCitations text={text} />);
    expect(screen.getByRole("button", { name: "example.com" })).toBeTruthy();
    const user = userEvent.setup();
    await user.hover(screen.getByRole("button", { name: "example.com +1" }));
    const card = await screen.findByRole("dialog", { name: "example.com +1" });
    expect(within(card).getAllByRole("link")).toHaveLength(2);
    expect(within(card).getByText("Two separate reports.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Notes" })).toBeNull();
  });

  it("resolves a streamed citation when its definition arrives", () => {
    const text = "Claim.[^a]";
    const { rerender } = render(<Markdown inlineCitations streaming text={text} />);
    expect(screen.getByText(text)).toBeTruthy();
    rerender(<Markdown inlineCitations streaming text={`${text}\n\n[^a]: https://example.com/evidence`} />);
    expect(screen.getByRole("button", { name: "example.com" })).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("web images", () => {
  it("shows an http(s) image lazily, without a referrer, and no stray !", () => {
    const { container } = render(<Markdown text="Look: ![A chart](https://example.com/chart.png)" />);
    const img = screen.getByRole("img", { name: "A chart" });
    expect(img.getAttribute("src")).toBe("https://example.com/chart.png");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.classList.contains("md-image")).toBe(true);
    expect(container.textContent).toBe("Look: ");
  });

  it("turns an image that fails to load into a link to it", () => {
    const { container } = render(
      <Markdown text="![A chart](https://example.com/chart.png) ![](https://example.com/b.png)" />,
    );
    const images = [...container.querySelectorAll("img")];
    expect(images).toHaveLength(2);
    for (const img of images) fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "A chart" });
    expect(link.getAttribute("href")).toBe("https://example.com/chart.png");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    // Without alt text, the address is the link's text.
    expect(screen.getByRole("link", { name: "https://example.com/b.png" })).toBeTruthy();
    expect(container.textContent).not.toContain("!");
  });

  it("names a citation after a web image's site and keeps the image in the card", async () => {
    render(<Markdown inlineCitations text={"Claim.[^a]\n\n[^a]: ![Figure 2](https://cdn.example.net/fig2.png)"} />);
    const user = userEvent.setup();
    await user.hover(screen.getByRole("button", { name: "cdn.example.net" }));
    const card = await screen.findByRole("dialog", { name: "cdn.example.net" });
    expect(
      within(card)
        .getByRole("link", { name: /Figure 2/ })
        .getAttribute("href"),
    ).toBe("https://cdn.example.net/fig2.png");
    expect(within(card).getByRole("img", { name: "Figure 2" })).toBeTruthy();
  });

  it("shows only the alt text for an unsafe source", () => {
    const { container } = render(<Markdown text="![tracker](javascript:alert(1))" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).toBe("tracker");
  });
});

describe("underlined headings and indented code", () => {
  it("renders an underlined heading as a section heading on a page", () => {
    render(<Markdown text={"Setext heading\n--------------"} headingShift={1} sectionsOf="pg_1" />);
    const heading = screen.getByRole("heading", { level: 3, name: /Setext heading/ });
    expect(heading.id).toBe("section-setext-heading");
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("renders indented code as a code block with a copy button", () => {
    const { container } = render(<Markdown text={"Intro\n\n    indented code block"} />);
    expect(container.querySelector(".code-head span")?.textContent).toBe("code");
    expect(container.querySelector("pre code")?.textContent).toBe("indented code block");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  });
});
