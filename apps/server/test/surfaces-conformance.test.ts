// A2UI v1.0 conformance (ADR 0014): Rei's catalog is a valid A2UI catalog, the official example passes Rei's validator,
// every surface Rei's own scenarios send is a valid A2UI message, and the basic components Rei copied are unchanged.
import { compile } from "@earendil-works/pi-schema";
import type { A2uiComponent, A2uiMessage } from "@rei/protocol";
import { A2UI_BASE, a2uiSchemas, reiCatalog1 } from "@rei/protocol/surface-schemas";
import { describe, expect, it } from "vitest";
import { DEMO_FORM, DEMO_TRIP, liveSurface } from "../src/pi/faux-surfaces.ts";
import { checkMessages, checkSurface, messageValidator } from "../src/surfaces/validate.ts";

type Json = Record<string, unknown>;
const create = (components: unknown[], data: Json = {}): A2uiMessage => ({
  version: "1.0",
  createSurface: {
    surfaceId: "s1",
    catalogId: "rei/catalog/1",
    components: components as A2uiComponent[],
    dataModel: data,
  },
});

describe("A2UI v1.0 conformance", () => {
  it("Rei's catalog validates against the official catalog definition schema", () => {
    const v = compile(a2uiSchemas.catalogDefinition, {
      // Component definitions are JSON Schemas themselves; the meta-schema is not vendored, so any object passes it.
      schemas: {
        [`${A2UI_BASE}common_types.json`]: a2uiSchemas.commonTypes,
        "https://json-schema.org/draft/2020-12/schema": { type: ["object", "boolean"] },
      },
    });
    const ok = v.check(reiCatalog1 as unknown);
    expect(ok ? [] : v.errors(reiCatalog1 as unknown)).toEqual([]);
  });

  it("the official example messages pass Rei's validator", () => {
    const messages = (a2uiSchemas.exampleLoginForm as unknown as { messages: A2uiMessage[] }).messages;
    expect(messages.length).toBeGreaterThan(0);
    // The example names the basic catalog; Rei serves its own, which includes every basic component.
    const asRei = messages.map((m) => {
      const c = (m as { createSurface?: Json }).createSurface;
      return c ? ({ ...m, createSurface: { ...c, catalogId: "rei/catalog/1" } } as A2uiMessage) : m;
    });
    expect(checkMessages(asRei)).toEqual([]);
  });

  it("every surface the faux scenarios show is a valid A2UI message and passes Rei's rules", () => {
    const live = liveSurface("ses_x");
    for (const s of [DEMO_TRIP, DEMO_FORM, live]) {
      const data = (s.data ?? {}) as Json;
      const msg = create(s.components, data);
      expect(messageValidator().check(msg as unknown), s.title).toBe(true);
      expect(checkMessages([msg]), s.title).toEqual([]);
      expect(checkSurface(s.components as A2uiComponent[], data), s.title).toEqual([]);
    }
  });

  // Rei leaves out Video, AudioPlayer and Modal (docs/surfaces.md); every basic component it keeps is copied verbatim.
  it("the basic components Rei copied equal the originals once common_types refs are absolute", () => {
    const basic = a2uiSchemas.basicCatalog as { components: Json };
    const rei = reiCatalog1 as unknown as { components: Json };
    const absolute = (v: unknown): unknown =>
      JSON.parse(JSON.stringify(v).replaceAll('"common_types.json#', `"${A2UI_BASE}common_types.json#`));
    const left = ["Video", "AudioPlayer", "Modal"];
    expect(Object.keys(basic.components).filter((n) => !(n in rei.components))).toEqual(left);
    for (const [name, schema] of Object.entries(basic.components)) {
      if (left.includes(name)) continue;
      expect(JSON.stringify(rei.components[name]).replaceAll("catalog.json#", "")).toBe(
        JSON.stringify(absolute(schema)).replaceAll("catalog.json#", ""),
      );
    }
  });
});
