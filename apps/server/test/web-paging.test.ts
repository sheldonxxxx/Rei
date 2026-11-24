import { describe, expect, it } from "vitest";
import { renderSlice, SLICE_CHARS } from "../src/web/cache.ts";
import { unfence } from "./helpers/fence.ts";

describe("paging a page", () => {
  const long = (n: number) => ({
    title: "Long",
    url: "https://x.example/long",
    text: Array.from({ length: n }, (_, i) => `Line ${i} ${"x".repeat(80)}`).join("\n"),
  });

  it("slices at most 20,000 characters, at a line break, with a footer that names the next offset", () => {
    const page = long(600);
    const first = renderSlice(page, 0) as { text: string };
    const fenced = unfence(first.text);
    const m = /^\n\n\[Showing characters 0–(\d+) of (\d+)\. Call web_fetch again with offset=(\d+) for more\.\]$/.exec(
      fenced.footer,
    )!;
    expect(m).not.toBeNull();
    const end = Number(m[1]);
    expect(Number(m[2])).toBe(page.text.length);
    expect(m[3]).toBe(m[1]);
    expect(end).toBeLessThanOrEqual(SLICE_CHARS);
    expect(end).toBeGreaterThan(SLICE_CHARS - 2_000);
    expect(page.text[end - 1]).toBe("\n");
    expect(fenced.body.startsWith("# Long\nhttps://x.example/long\n\nLine 0 ")).toBe(true);
    expect(fenced.origin).toBe("x.example");
  });

  it("walks to the end by following the footers, with no footer on the last slice", () => {
    const page = long(600);
    let offset = 0;
    let rebuilt = "";
    for (let i = 0; i < 10; i++) {
      const slice = unfence((renderSlice(page, offset) as { text: string }).text);
      const body = slice.body.replace(/^# Long\nhttps:\/\/x\.example\/long\n\n/, "");
      const m =
        /^\n\n\[Showing characters (\d+)–(\d+) of \d+\. Call web_fetch again with offset=\d+ for more\.\]$/.exec(
          slice.footer,
        );
      expect(Number(m?.[1] ?? offset)).toBe(offset);
      rebuilt += body + "\n";
      if (!m) break;
      offset = Number(m[2]);
    }
    expect(offset).toBeGreaterThan(0);
    expect(rebuilt.trim()).toBe(page.text.trim().replace(/[ \t]+\n/g, "\n"));
  });

  it("refuses an offset past the end", () => {
    const page = { title: "T", url: "https://x.example/", text: "short" };
    expect(renderSlice(page, 5)).toEqual({ error: "offset 5 is past the end of the page (5 characters)." });
    const slice = unfence((renderSlice(page, 0) as { text: string }).text);
    expect(slice).toMatchObject({ origin: "x.example", body: "# T\nhttps://x.example/\n\nshort", footer: "" });
  });

  it("does not cut a surrogate pair", () => {
    const page = { title: "T", url: "https://x.example/", text: "a".repeat(SLICE_CHARS - 1) + "😀" + "b".repeat(100) };
    const first = unfence((renderSlice(page, 0) as { text: string }).text);
    expect(first.footer).toContain(`Showing characters 0–${SLICE_CHARS - 1} of`);
  });
});
