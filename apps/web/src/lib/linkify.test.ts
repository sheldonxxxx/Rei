import { describe, expect, it } from "vitest";
import { linkify } from "./linkify.ts";

describe("linkify", () => {
  it("finds http(s) links and trims trailing punctuation", () => {
    expect(linkify("see https://example.com/a?b=1, then (http://x.org).")).toEqual([
      { type: "text", text: "see " },
      { type: "link", text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { type: "text", text: ", then (" },
      { type: "link", text: "http://x.org", href: "http://x.org" },
      { type: "text", text: ")." },
    ]);
  });
  it("keeps a balanced paren inside the URL", () => {
    const [seg] = linkify("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(seg).toMatchObject({ type: "link", href: "https://en.wikipedia.org/wiki/Foo_(bar)" });
  });
  it("ignores other schemes and returns plain text unchanged", () => {
    expect(linkify("javascript:alert(1) and <b>hi</b>")).toEqual([
      { type: "text", text: "javascript:alert(1) and <b>hi</b>" },
    ]);
  });
});
