import { ATTACHMENT_MAX_BYTES, MESSAGE_MAX_ATTACHMENT_BYTES } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import {
  attachmentLimit,
  bestChoice,
  changedDraft,
  isLargePaste,
  mentionQuery,
  parseSlashAction,
  pastedFileName,
  replaceDraft,
  slashQuery,
} from "./composer.ts";

const mention = { kind: "chat" as const, id: "s1", label: "Same name", start: 3, end: 13 };
describe("composer input rules", () => {
  it("counts Unicode code points at the paste threshold", () => {
    expect(isLargePaste("x".repeat(4000))).toBe(false);
    expect(isLargePaste("x".repeat(4001))).toBe(true);
    expect(isLargePaste("🦊".repeat(4000))).toBe(false);
    expect(isLargePaste("🦊".repeat(4001))).toBe(true);
  });
  it("names repeated pastes without collisions", () => {
    const date = new Date(2026, 10, 3, 12, 1, 2);
    expect(pastedFileName(date, [])).toBe("pasted-text-20261103-120102.txt");
    expect(pastedFileName(date, ["pasted-text-20261103-120102.txt", "pasted-text-20261103-120102-2.txt"])).toBe(
      "pasted-text-20261103-120102-3.txt",
    );
  });
  it("enforces file count, per-file and aggregate sizes", () => {
    expect(attachmentLimit({ size: ATTACHMENT_MAX_BYTES }, [])).toBeNull();
    expect(attachmentLimit({ size: ATTACHMENT_MAX_BYTES + 1 }, [])).toContain("1 GiB");
    expect(
      attachmentLimit(
        { size: 0 },
        Array.from({ length: 10 }, () => ({ size: 0 })),
      ),
    ).toContain("10 attachments");
    expect(attachmentLimit({ size: 1 }, [{ size: MESSAGE_MAX_ATTACHMENT_BYTES }])).toContain("2 GiB");
  });
  it("recognizes @ at word boundaries, including a query with spaces, but not email", () => {
    expect(mentionQuery("mail a@b.com", 12)).toBeNull();
    expect(mentionQuery("hello @Same na", 14)).toEqual({ start: 6, query: "Same na" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });
  it("moves stable mention ranges when text is inserted before them", () => {
    expect(replaceDraft("hi @Same name end", [mention], 0, 0, "🦊").mentions).toEqual([
      { ...mention, start: 5, end: 15 },
    ]);
  });
  it("removes the whole token on a partial edit, retaining surrounding text", () => {
    const result = changedDraft("hi @Same name end", [mention], "hi @Same nam end");
    expect(result.text).toBe("hi  end");
    expect(result.mentions).toEqual([]);
  });
  it("keeps adjacent tokens when typing at their boundary", () => {
    expect(replaceDraft("hi @Same name end", [mention], 13, 13, "!").mentions).toEqual([mention]);
  });
});

describe("slash commands", () => {
  it("opens only for a first token that starts with a slash, with the caret inside it", () => {
    expect(slashQuery("/", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(slashQuery("/rev", 4)).toEqual({ start: 0, end: 4, query: "rev" });
    expect(slashQuery("/rev", 2)).toEqual({ start: 0, end: 4, query: "rev" });
    expect(slashQuery("  /acme/review", 14)).toEqual({ start: 2, end: 14, query: "acme/review" });
    // The caret before the slash, or past the token, is ordinary typing.
    expect(slashQuery("/rev", 0)).toBeNull();
    expect(slashQuery("/rev now", 8)).toBeNull();
    expect(slashQuery("/compact keep the plan", 18)).toBeNull();
  });

  it("stays out of sentences, paths, URLs, code and IME composition", () => {
    expect(slashQuery("please /review this", 11)).toBeNull();
    expect(slashQuery("see https://example.com/a", 25)).toBeNull();
    expect(slashQuery("cd src/lib", 10)).toBeNull();
    expect(slashQuery("```\n/review", 11)).toBeNull();
    expect(slashQuery("`/review`", 4)).toBeNull();
    expect(slashQuery("/rev", 4, true)).toBeNull();
    expect(slashQuery("", 0)).toBeNull();
  });

  it("measures offsets in UTF-16 code units, like a textarea", () => {
    expect(slashQuery("/🦊x", 4)).toEqual({ start: 0, end: 4, query: "🦊x" });
  });

  it("parses a complete /compact with optional guidance, and nothing else", () => {
    expect(parseSlashAction("/compact")).toEqual({ kind: "compact" });
    expect(parseSlashAction("  /compact  ")).toEqual({ kind: "compact" });
    expect(parseSlashAction("/Compact keep the decisions\nand the plan ")).toEqual({
      kind: "compact",
      instructions: "keep the decisions\nand the plan",
    });
    expect(parseSlashAction("/compacted")).toBeNull();
    expect(parseSlashAction("/compactkeep")).toBeNull();
    expect(parseSlashAction("/skill compact")).toBeNull();
    expect(parseSlashAction("/unknown thing")).toBeNull();
    expect(parseSlashAction("please /compact")).toBeNull();
  });
});

describe("picker highlight", () => {
  const rows = (...labels: string[]) => labels.map((label) => ({ label }));

  it("keeps the first row while nothing is typed", () => {
    expect(bestChoice(rows("/compact", "review"), "")).toBe(0);
    expect(bestChoice([], "")).toBe(0);
  });

  it("prefers a name prefix, then a later word, then the inside of a name, then anything else", () => {
    const list = rows("other", "preview", "code review", "Review");
    expect(bestChoice(list, "rev")).toBe(3);
    expect(bestChoice(list.slice(0, 3), "rev")).toBe(2);
    expect(bestChoice(list.slice(0, 2), "rev")).toBe(1);
    expect(bestChoice(list.slice(0, 1), "rev")).toBe(0);
    expect(bestChoice(rows("/compact", "acme/summarize"), "summ")).toBe(1);
    expect(bestChoice(rows("review", "/compact"), "comp")).toBe(1);
  });

  it("passes over a disabled row unless every row is disabled", () => {
    expect(bestChoice([{ label: "git", disabled: true }, { label: "Git notes" }], "git")).toBe(1);
    expect(bestChoice([{ label: "git", disabled: true }], "git")).toBe(0);
  });
});
