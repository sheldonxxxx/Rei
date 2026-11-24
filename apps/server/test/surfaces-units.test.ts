import {
  type A2uiComponent,
  failingChecks,
  pointerSet,
  resolveContext,
  resolveDynamic,
  resolveText,
} from "@rei/protocol";
import { describe, expect, it } from "vitest";
import { surfaceFallback } from "../src/surfaces/fallback.ts";
import {
  applyMessage,
  contentAt,
  pushRevision,
  type SurfaceRecord,
  setPointer,
  stateOf,
  summarize,
  toSurface,
} from "../src/surfaces/model.ts";
import { catalogNote } from "../src/surfaces/tools.ts";
import { checkComponent, checkSurface } from "../src/surfaces/validate.ts";

const C = (id: string, component: string, rest: Record<string, unknown> = {}): A2uiComponent => ({
  id,
  component,
  ...rest,
});
const label = (id: string, text: string) => C(id, "Text", { text });

describe("surface checks", () => {
  it("accepts a minimal surface", () => {
    expect(checkSurface([label("root", "hi")], {})).toEqual([]);
  });

  it("names an unknown component and lists the valid ones", () => {
    const err = checkComponent(C("root", "Carousel"), 0);
    expect(err).toContain('"Carousel"');
    expect(err).toContain("Table");
  });

  it("reports a bad prop in one line, by component", () => {
    const err = checkComponent(C("t", "Chart", { variant: "donut", labels: ["a"], series: [] }), 2);
    expect(err).toMatch(/^component "t" \(Chart\): \/variant/);
    expect(err).not.toContain("\n");
  });

  it("needs a root, unique ids, resolving references and no cycles", () => {
    expect(checkSurface([label("a", "x")], {}).join()).toContain("root");
    expect(checkSurface([label("root", "x"), label("root", "y")], {}).join()).toContain("used twice");
    expect(checkSurface([C("root", "Column", { children: ["gone"] })], {}).join()).toContain("gone");
    expect(
      checkSurface([C("root", "Column", { children: ["b"] }), C("b", "Card", { child: "root" })], {}).join(),
    ).toMatch(/cycle/i);
  });

  it("refuses http images, a pie with two series and table rows with unknown keys", () => {
    expect(checkSurface([C("root", "Image", { url: "http://x.example/a.png" })], {}).join()).toContain("https");
    const pie = C("root", "Chart", {
      variant: "pie",
      labels: ["a", "b"],
      series: [
        { name: "1", values: [1, 2] },
        { name: "2", values: [1, 2] },
      ],
    });
    expect(checkSurface([pie], {}).join()).toMatch(/one series/i);
    const table = C("root", "Table", { columns: [{ key: "a", label: "A" }], rows: [{ a: 1, b: 2 }] });
    expect(checkSurface([table], {}).join()).toContain('"b"');
  });

  it("checks data bound to a list prop against the prop's shape", () => {
    const table = C("root", "Table", { columns: [{ key: "a", label: "A" }], rows: { "@path": "/rows" } });
    expect(checkSurface([table], { rows: [{ a: 1 }] })).toEqual([]);
    expect(checkSurface([table], { rows: "nope" }).join()).toContain("/rows");
  });

  it("refuses a regex that does not compile", () => {
    const field = C("root", "TextField", {
      label: "x",
      value: { "@path": "/x" },
      "@checks": [{ condition: { "@call": "regex", args: { value: { "@path": "/x" }, pattern: "(" } }, message: "m" }],
    });
    expect(checkSurface([field], {}).join()).toMatch(/pattern/i);
  });

  it("caps the number of components", () => {
    const many = [C("root", "Column", { children: [] }), ...Array.from({ length: 200 }, (_, i) => label(`t${i}`, "x"))];
    expect(checkSurface(many, {}).join()).toContain("200");
  });
});

describe("surface model", () => {
  it("sets, appends and deletes data by pointer, refusing prototype keys", () => {
    let d = setPointer({}, "/a/b", 1);
    expect(d).toEqual({ a: { b: 1 } });
    d = setPointer({ l: [1] }, "/l/-", 2);
    expect(d).toEqual({ l: [1, 2] });
    d = setPointer(d, "/l/0", null);
    expect(d).toEqual({ l: [2] });
    expect(() => setPointer({}, "/__proto__/x", 1)).toThrow();
    expect(() => setPointer({}, "a", 1)).toThrow();
  });

  it("upserts components by id and drops what is no longer reachable", () => {
    const start = {
      components: [C("root", "Column", { children: ["a", "b"] }), label("a", "A"), label("b", "B")],
      dataModel: {},
    };
    const next = applyMessage(start, {
      version: "1.0",
      updateComponents: {
        surfaceId: "s",
        components: [C("root", "Column", { children: ["a", "c"] }), label("c", "C")],
      },
    });
    expect(next.components.map((c) => c.id).sort()).toEqual(["a", "c", "root"]);
  });

  it("keeps the newest revisions in full and folds older ones into the base", () => {
    const record: SurfaceRecord = {
      surfaceId: "s",
      sessionId: "ses_a",
      runId: "run_a",
      title: "T",
      catalogId: "rei/catalog/1",
      createdAt: 0,
      updatedAt: 0,
      revision: 0,
      components: [],
      dataModel: {},
      fallback: "",
      base: null,
      revisions: [],
      actions: [],
    };
    const author = { kind: "agent" as const, runId: "run_a", toolCallId: "c", tool: "show_surface" as const };
    pushRevision(record, {
      revision: 1,
      author,
      at: 0,
      summary: "",
      messages: [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "s",
            catalogId: "rei/catalog/1",
            components: [label("root", "0")],
            dataModel: { n: 0 },
          },
        },
      ],
    });
    for (let i = 2; i <= 60; i++)
      pushRevision(record, {
        revision: i,
        author,
        at: 0,
        summary: "",
        messages: [{ version: "1.0", updateDataModel: { surfaceId: "s", path: "/n", value: i } }],
      });
    expect(record.revisions.filter((r) => r.messages)).toHaveLength(50);
    expect(record.base?.revision).toBe(10);
    expect(contentAt(record, 5)).toBeUndefined();
    expect(contentAt(record, 10)?.dataModel).toEqual({ n: 10 });
    expect(contentAt(record, 42)?.dataModel).toEqual({ n: 42 });
  });

  it("is frozen for another session, removed, live with a feed, else idle", () => {
    const r = { sessionId: "a", removed: false, feed: undefined } as unknown as SurfaceRecord;
    expect(stateOf(r, "b")).toBe("frozen");
    expect(stateOf(r, "a")).toBe("idle");
    expect(stateOf({ ...r, feed: { kind: "worker", sessionId: "w", title: "W" } }, "a")).toBe("live");
    expect(stateOf({ ...r, removed: true }, "a")).toBe("removed");
    const removed = toSurface(
      { ...r, removed: true, revisions: [], components: [], dataModel: {} } as SurfaceRecord,
      "a",
    );
    expect(removed.message).toBeUndefined();
  });

  it("summarizes what a revision changed", () => {
    expect(summarize([{ version: "1.0", updateDataModel: { surfaceId: "s", path: "/x", value: null } }])).toBe(
      "Data /x removed",
    );
  });
});

describe("surface fallback", () => {
  it("writes everything a surface shows as text", () => {
    const text = surfaceFallback(
      "Trip",
      [
        C("root", "Column", { children: ["t", "table", "b"] }),
        label("t", "Hello"),
        C("table", "Table", { title: "Hotels", columns: [{ key: "n", label: "Name" }], rows: { "@path": "/rows" } }),
        C("b", "Button", { child: "bl", action: { event: { name: "go" } } }),
        label("bl", "Go"),
      ],
      { rows: [{ n: "Inn" }] },
    );
    expect(text.split("\n")).toEqual(["Trip", "Hello", "Hotels", "Name", "Inn", "[Go]"]);
  });

  it("expands templates and masks obscured fields", () => {
    const text = surfaceFallback(
      "T",
      [
        C("root", "Column", { children: { path: "/items", componentId: "item" } }),
        C("item", "Text", { text: { "@path": "name" } }),
        C("pw", "TextField", { label: "Password", variant: "obscured", value: "secret" }),
      ],
      { items: [{ name: "one" }, { name: "two" }] },
    );
    expect(text).toBe("T\none\ntwo");
  });
});

describe("surface evaluation", () => {
  const data = { email: "a@b.co", n: "3", items: [{ name: "x" }] };
  it("resolves bindings, relative paths in a scope and formatString", () => {
    expect(resolveDynamic({ "@path": "/email" }, { data })).toBe("a@b.co");
    expect(resolveDynamic({ "@path": "name" }, { data, scope: "/items/0" })).toBe("x");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: A2UI formatString interpolation, not a JS template.
    expect(resolveText({ "@call": "formatString", args: { value: "n=${/n} \\${/n}" } }, { data })).toBe("n=3 ${/n}");
  });

  it("runs the catalog's check functions", () => {
    const check = (condition: unknown) => failingChecks({ "@checks": [{ condition, message: "bad" }] }, { data });
    expect(check({ "@call": "email", args: { value: { "@path": "/email" } } })).toEqual([]);
    expect(check({ "@call": "numeric", args: { value: { "@path": "/n" }, min: 4 } })).toEqual(["bad"]);
    expect(check({ "@call": "required", args: { value: "" } })).toEqual(["bad"]);
    expect(check({ "@call": "length", args: { value: "abc", max: 2 } })).toEqual(["bad"]);
    expect(check({ "@call": "regex", args: { value: "abc", pattern: "^a" } })).toEqual([]);
    expect(check({ "@call": "and", args: { values: [true, { "@call": "not", args: { value: false } }] } })).toEqual([]);
    expect(check({ "@call": "or", args: { values: [false, false] } })).toEqual(["bad"]);
  });

  it("resolves an action context and sets data immutably, refusing prototype keys", () => {
    expect(resolveContext({ e: { "@path": "/email" }, k: 1 }, { data })).toEqual({ e: "a@b.co", k: 1 });
    const before = { a: { b: 1 } };
    const after = pointerSet(before, "/a/c", 2);
    expect(before).toEqual({ a: { b: 1 } });
    expect(after).toEqual({ a: { b: 1, c: 2 } });
    expect(pointerSet(before, "/__proto__/x", 1)).toBe(before);
  });
});

describe("component errors name the accepted fields", () => {
  it("lists the fields of a component and of an item, and reports every error", () => {
    const column = checkComponent({ id: "a", component: "Column", gap: 2, children: [] }, 0);
    expect(column).toContain('unknown field "gap"; fields: id,');
    const image = (url: string) => ({ url, description: "d" });
    const gallery = checkComponent(
      { id: "g", component: "Gallery", images: [1, 2, 3, 4, 5].map(() => image("https://x.test/a.png")) },
      0,
    );
    expect(gallery).toContain('images[0]: unknown field "description"; fields: url, caption, link');
    expect(gallery).toContain("images[4]: unknown field");
    const links = checkComponent({ id: "l", component: "Links", links: [{ label: "x", url: "https://x.test" }] }, 0);
    expect(links).toContain('links[0]: "title" is required; fields: url, title, description, site, image');
    expect(links).toContain('links[0]: unknown field "label"; fields: url, title, description, site, image');
  });
});

describe("catalogNote", () => {
  it("shows the item fields of list properties", () => {
    const note = catalogNote();
    expect(note).toContain("images: {url, caption?, link?}[]|binding");
    expect(note).toContain("links: {url, title, description?, site?, image?}[]|binding");
  });
});
