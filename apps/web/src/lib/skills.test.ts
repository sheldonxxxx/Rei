import { describe, expect, it } from "vitest";
import { SKILL_MD } from "../test/fixtures.ts";
import { importRequestFor, skillExportHref, splitSkillMd } from "./skills.ts";

describe("splitSkillMd", () => {
  it("splits the frontmatter fields from the instructions", () => {
    const { fields, body } = splitSkillMd(SKILL_MD);
    expect(fields).toEqual([
      ["name", "weekly-review"],
      ["description", "Summarise the week from my notes."],
    ]);
    expect(body.startsWith("# Weekly review")).toBe(true);
  });

  it("folds a wrapped value into its field, and leaves text without frontmatter whole", () => {
    expect(splitSkillMd("---\ndescription: one\n  two\nlicense: MIT\n---\nbody").fields).toEqual([
      ["description", "one two"],
      ["license", "MIT"],
    ]);
    expect(splitSkillMd("# just text")).toEqual({ fields: [], body: "# just text" });
  });
});

describe("importRequestFor", () => {
  it("sends a .zip whole as base64", async () => {
    const req = await importRequestFor(
      new File([new Uint8Array([0x50, 0x4b, 3, 4])], "weekly.zip", { type: "application/zip" }),
    );
    expect(req).toEqual({ zip: btoa("PK\x03\x04") });
  });

  it("turns a lone SKILL.md into a one-file skill", async () => {
    const req = await importRequestFor(new File([SKILL_MD], "SKILL.md", { type: "text/markdown" }));
    expect(req).toEqual({ files: [{ path: "SKILL.md", encoding: "text", content: SKILL_MD }] });
  });
});

describe("skillExportHref", () => {
  it("points at the export, for a version when asked", () => {
    expect(skillExportHref("a b")).toBe("/api/skills/a%20b/export");
    expect(skillExportHref("x", 3)).toBe("/api/skills/x/export?version=3");
  });
});
