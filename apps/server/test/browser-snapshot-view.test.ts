import { describe, expect, it } from "vitest";
import { changesView, interactiveView, mapSnapshotRefs, snapshotRef, textView } from "../src/browser/snapshot-view.ts";

// A real page from page.ariaSnapshot({ mode: "ai" }), and the same page after the shop added a third item and the cart count changed.
const BEFORE = `- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - navigation [ref=e3]:
      - link "Home" [ref=e4] [cursor=pointer]:
        - /url: /
      - link "About" [ref=e5] [cursor=pointer]:
        - /url: /about
  - main [ref=e6]:
    - heading "Shop" [level=1] [ref=e7]
    - paragraph [ref=e8]: Welcome to the shop. Lots of words here.
    - list [ref=e9]:
      - listitem [ref=e10]:
        - text: Apples
        - button "Add" [ref=e11]
      - listitem [ref=e12]:
        - text: Pears
        - button "Add" [ref=e13]
    - generic [ref=e14] [cursor=pointer]: Clickable div
    - generic [ref=e15]:
      - generic [ref=e16]:
        - text: Email
        - textbox "Email" [ref=e17]
      - combobox [ref=e18]:
        - option "A" [selected]
        - option "B"
      - checkbox "Agree" [ref=e19]
      - button "Go" [ref=e20]
    - group [ref=e21]:
      - generic "More" [ref=e22]
      - text: hidden
    - generic [ref=e23]: "Cart: 0"`;
const AFTER = `- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - navigation [ref=e3]:
      - link "Home" [ref=e4] [cursor=pointer]:
        - /url: /
      - link "About" [ref=e5] [cursor=pointer]:
        - /url: /about
  - main [ref=e6]:
    - heading "Shop" [level=1] [ref=e7]
    - paragraph [ref=e8]: Welcome to the shop. Lots of words here.
    - list [ref=e9]:
      - listitem [ref=e10]:
        - text: Apples
        - button "Add" [ref=e11]
      - listitem [ref=e12]:
        - text: Pears
        - button "Add" [ref=e13]
      - listitem [ref=e24]:
        - text: Plums
        - button "Add" [ref=e25]
    - generic [ref=e14] [cursor=pointer]: Clickable div
    - generic [ref=e15]:
      - generic [ref=e16]:
        - text: Email
        - textbox "Email" [ref=e17]
      - combobox [ref=e18]:
        - option "A" [selected]
        - option "B"
      - checkbox "Agree" [ref=e19]
      - button "Go" [ref=e20]
    - group [ref=e21]:
      - generic "More" [ref=e22]
      - text: hidden
    - generic [ref=e23]: "Cart: 1"`;

it("rewrites only ref attributes and keeps a replaced frame's old and new refs distinct in changes", () => {
  const before = {
    generation: 1,
    prefixes: new Map([
      ["", "p1"],
      ["f3", "p2f3"],
    ]),
    raw: '- button "Main [ref=e9]" [ref=e1]\n- button "Old" [ref=f3e1]',
  };
  const after = {
    generation: 1,
    prefixes: new Map([
      ["", "p1"],
      ["f3", "p4f3"],
    ]),
    raw: '- button "Main [ref=e9]" [ref=e1]\n- button "New" [ref=f3e1]',
  };
  const scoped = (ref: string) => snapshotRef(after, ref);
  expect(mapSnapshotRefs(after.raw, scoped)).toBe('- button "Main [ref=e9]" [ref=p1e1]\n- button "New" [ref=p4f3e1]');
  const diff = changesView(before.raw, after.raw, (ref) => snapshotRef(before, ref), scoped);
  expect(diff).toMatchObject({ added: 1, changed: 0, removed: 1 });
  expect(mapSnapshotRefs(diff.text, scoped)).toBe('- button "New" [ref=p4f3e1] [new]\nRemoved: p2f3e1');
});

describe("interactiveView", () => {
  const view = interactiveView(BEFORE);
  it("keeps what can be acted on, with its /url and options", () => {
    for (const line of [
      '- link "Home" [ref=e4] [cursor=pointer]:',
      "  - /url: /about",
      '- textbox "Email" [ref=e17]',
      "- combobox [ref=e18]:",
      '- option "A" [selected]',
      '- option "B"',
      '- checkbox "Agree" [ref=e19]',
      '- button "Go" [ref=e20]',
      "- generic [ref=e14] [cursor=pointer]: Clickable div",
    ]) {
      expect(view).toContain(line);
    }
  });
  it("keeps the heading and the labels that tell the two Add buttons apart", () => {
    expect(view).toContain('- heading "Shop" [level=1] [ref=e7]');
    expect(view).toMatch(/- listitem \[ref=e10\]:\n\s+- text: Apples\n\s+- button "Add" \[ref=e11\]/);
    expect(view).toMatch(/- listitem \[ref=e12\]:\n\s+- text: Pears\n\s+- button "Add" \[ref=e13\]/);
    expect(view).toContain("- text: Email");
  });
  it("drops prose and what is only there to look at", () => {
    expect(view).not.toContain("Welcome to the shop");
    expect(view).not.toContain("e8]");
    expect(view).not.toContain("Cart: 0");
    expect(view).not.toContain("hidden");
    expect(view).not.toContain("e22");
  });
  it("collapses unnamed wrappers and keeps named landmarks", () => {
    for (const ref of ["e1]", "e15]", "e16]", "e21]"]) expect(view).not.toContain(ref);
    expect(view).toMatch(/^- banner \[ref=e2\]:\n {2}- navigation \[ref=e3\]:\n {4}- link "Home"/);
    // The form's children moved up to sit beside the list.
    expect(view).toContain('\n  - textbox "Email" [ref=e17]');
  });
  it("clips a long label", () => {
    const out = interactiveView(`- listitem [ref=e1]:\n  - text: ${"x".repeat(200)}\n  - button "Go" [ref=e2]`);
    expect(out.split("\n")[1]!.length).toBeLessThanOrEqual(2 + 80);
  });
  it("is empty when there is nothing to act on", () => {
    expect(interactiveView('- generic [ref=e1]:\n  - heading "Hi" [ref=e2]\n  - paragraph [ref=e3]: text')).toBe("");
    expect(interactiveView("")).toBe("");
  });
});

describe("changesView", () => {
  it("reports an added element with its subtree and a changed one, under their ancestors", () => {
    const r = changesView(BEFORE, AFTER);
    expect(r).toMatchObject({ added: 2, changed: 1, removed: 0 });
    expect(r.text).toBe(
      [
        "- generic [active] [ref=e1]:",
        "  - main [ref=e6]:",
        "    - list [ref=e9]:",
        "      - listitem [ref=e24] [new]:",
        "        - text: Plums",
        '        - button "Add" [ref=e25]',
        '    - generic [ref=e23] [changed]: "Cart: 1"',
      ].join("\n"),
    );
    expect(r.text).not.toContain("e11");
  });
  it("lists removed refs, capped", () => {
    const r = changesView('- list [ref=e1]:\n  - button "A" [ref=e2]\n  - button "B" [ref=e3]', "- list [ref=e1]:");
    expect(r).toMatchObject({ added: 0, changed: 0, removed: 2 });
    expect(r.text).toContain("Removed: e2, e3");
    const many = (n: number) => Array.from({ length: n }, (_, i) => `- button "b" [ref=e${i}]`).join("\n");
    expect(changesView(many(60), "").text).toContain(", … and 10 more");
  });
  it("sees a change in a ref-less child, but not a move", () => {
    const a = '- list [ref=e1]:\n  - link "x" [ref=e2]:\n    - /url: /a\n  - button "y" [ref=e3]';
    expect(changesView(a, a.replace("/a", "/b")).text).toContain('- link "x" [ref=e2] [changed]:\n    - /url: /b');
    const moved = '- list [ref=e1]:\n  - button "y" [ref=e3]\n  - link "x" [ref=e2]:\n    - /url: /a';
    expect(changesView(a, moved)).toEqual({ text: "", added: 0, changed: 0, removed: 0 });
  });
  it("is empty when nothing changed", () => {
    expect(changesView(BEFORE, BEFORE)).toEqual({ text: "", added: 0, changed: 0, removed: 0 });
  });

  it("does not count focus moving as a change", () => {
    const moved = BEFORE.replace("- generic [active] [ref=e1]:", "- generic [ref=e1]:").replace(
      '- button "Go" [ref=e20]',
      '- button "Go" [active] [ref=e20]',
    );
    expect(moved).not.toBe(BEFORE);
    expect(changesView(BEFORE, moved)).toEqual({ text: "", added: 0, changed: 0, removed: 0 });
  });
});

describe("textView", () => {
  const view = textView(BEFORE);

  it("reads as text: headings, prose, list entries on one line, links as Markdown", () => {
    expect(view).toContain("# Shop");
    expect(view).toContain("Welcome to the shop. Lots of words here.");
    expect(view).toContain("- Apples [button: Add] [ref=e11]");
    expect(view).toContain("[Home](/) [ref=e4]");
  });

  it("keeps refs only on what can be acted on", () => {
    expect(view).toContain('textbox "Email" [ref=e17]');
    expect(view).toContain('checkbox "Agree" [ref=e19]');
    expect(view).toContain("[Clickable div] [ref=e14]");
    expect(view).not.toContain("[ref=e8]"); // the paragraph
    expect(view).not.toContain("[ref=e1]");
    expect(view).toContain("Cart: 0");
  });

  it("is much shorter than the full snapshot", () => {
    expect(view.length).toBeLessThan(BEFORE.length * 0.6);
  });

  it("drops links without text that go nowhere", () => {
    expect(textView('- link [ref=e1] [cursor=pointer]:\n  - /url: "#"')).toBe("");
  });
});
