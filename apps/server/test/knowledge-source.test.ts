import {
  normalizeMetadata,
  normalizeTags,
  parseKnowledgeSource,
  serializeKnowledgeSource,
} from "@rei/protocol/knowledge-source";
import { describe, expect, it } from "vitest";

describe("Knowledge source validation", () => {
  it("preserves reserved scalars, Unicode, links and literal body headers", () => {
    for (const title of ["true", "null", "2026-11-12", "知識: 設計", "# heading"]) {
      const page = { title, description: "Portable", metadata: { tags: ["false", "a/b", "知識"] } };
      const body = "\n---\ntitle: literal body\n---\n[link](page:pg_123)\n";
      expect(parseKnowledgeSource(serializeKnowledgeSource(page, body))).toEqual({ ...page, body });
    }
  });
  it("rejects unsupported YAML and fields, malformed/missing headers and invalid collections", () => {
    for (const source of [
      "body",
      "---\ntitle: X",
      "---\n- item\n---\n",
      "---\ntitle: true\n---\n",
      "---\ntitle: X\ntags: [[nested]]\n---\n",
      "---\ntitle: X\naliases: [Y]\n---\n",
      "---\ntitle: &t X\ndescription: *t\n---\n",
    ])
      expect(() => parseKnowledgeSource(source)).toThrow();
    expect(() => normalizeTags(["\u0000"])).toThrow(/control/);
    expect(() => normalizeTags(["a".repeat(41)])).toThrow(/40/);
    expect(() => normalizeTags(Array.from({ length: 21 }, (_, i) => `${i}`))).toThrow(/20/);
    expect(() => normalizeMetadata({ locked: true })).toThrow(/Supported/);
    expect(() => parseKnowledgeSource(`---\ntitle: X\n#${"a".repeat(16384)}\n---\n`)).toThrow(/16 KiB/);
    expect(normalizeTags([" one   two ", "ONE TWO", "知識", "知識"])).toEqual(["one two", "知識"]);
  });
});
