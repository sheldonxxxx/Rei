import { describe, expect, it } from "vitest";
import { indexStatus, memoryChange, memoryLine, memoryMessage, message } from "../test/fixtures.ts";
import {
  dayBound,
  describeIndex,
  groupMessages,
  highlightParts,
  hitRole,
  isStale,
  queryTerms,
  sourceLabel,
  staleFor,
  whyLine,
} from "./memory.ts";
import { parseChatRoute, parseRoute, sessionHref } from "./route.ts";
import { ago } from "./time.ts";

const DAY = 86_400_000;

describe("staleness", () => {
  it("is stale only past the limit, and says how long in months", () => {
    const now = 1_000 * DAY;
    expect(isStale({ confirmedAt: now - 179 * DAY }, now)).toBe(false);
    expect(isStale({ confirmedAt: now - 181 * DAY }, now)).toBe(true);
    expect(staleFor({ confirmedAt: now - 250 * DAY }, now)).toBe("Not confirmed for 8 months");
    expect(staleFor({ confirmedAt: now - 190 * DAY }, now)).toBe("Not confirmed for 6 months");
  });
});

describe("ago", () => {
  it("reads like a person would say it", () => {
    const now = 1_000 * DAY;
    expect(ago(now - 20_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(ago(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(ago(now - DAY, now)).toBe("yesterday");
    expect(ago(now - 12 * DAY, now)).toBe("12 days ago");
    expect(ago(now - 95 * DAY, now)).toBe("3 months ago");
    expect(ago(now - 800 * DAY, now)).toBe("2 years ago");
  });
});

describe("sourceLabel", () => {
  it("names the chat, you, or a deleted chat", () => {
    expect(sourceLabel(memoryLine({ source: { sessionId: "s1", messageId: "m1", sessionTitle: "Tokyo trip" } }))).toBe(
      "From Tokyo trip",
    );
    expect(sourceLabel(memoryLine())).toBe("Added by you");
    expect(sourceLabel(memoryLine({ sourceDeleted: true }))).toBe("Chat deleted");
  });
});

describe("groupMessages", () => {
  const chip = (id: string, op: "add" | "confirm" = "add") =>
    memoryMessage({ change: memoryChange({ id: `c-${id}`, op }) }, { id });
  it("joins consecutive change chips into one row and leaves the rest alone", () => {
    const rows = groupMessages([message({ id: "u" }), chip("a"), chip("b"), message({ id: "r" }), chip("c")]);
    expect(rows.map((g) => (g.kind === "chips" ? g.messages.map((m) => m.id).join("+") : g.message.id))).toEqual([
      "u",
      "a+b",
      "r",
      "c",
    ]);
  });
  it("drops a confirmation (no chip) without splitting the row around it", () => {
    const rows = groupMessages([chip("a"), chip("x", "confirm"), chip("b")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "chips" && rows[0].messages.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("describeIndex", () => {
  it("ready, indexing, rebuilding, down and off", () => {
    expect(describeIndex(indexStatus()).text).toBe(
      "Ready · 1,234 entries · mlx-community/embeddinggemma-2-6bit affine-6bit-g64-bf16",
    );
    expect(describeIndex(indexStatus({ state: "indexing", embedded: 340 })).text).toBe("Indexing 340 of 1,234");
    const rebuild = describeIndex(
      indexStatus({ state: "indexing", building: { model: "gemma-2", embedded: 10, total: 1234 } }),
    );
    expect(rebuild.text).toBe("Rebuilding the index for gemma-2: 10 of 1,234");
    expect(rebuild.progress).toEqual({ done: 10, total: 1234 });
    const down = describeIndex(indexStatus({ state: "down" }));
    expect(down.text).toBe("Embedder down — keyword search only");
    expect(down.canRebuild).toBe(false);
    expect(describeIndex(indexStatus({ state: "off", model: null })).text).toBe("Off — keyword search only");
  });
});

describe("search result text", () => {
  it("labels who said it and why it matched", () => {
    expect(hitRole({ kind: "user", toolName: null })).toBe("You");
    expect(hitRole({ kind: "tool", toolName: "web_fetch" })).toBe("Tool: web_fetch");
    expect(whyLine({ keywordRank: 2, vectorRank: 1, cosine: 0.712 })).toBe("keyword #2 · meaning #1, 0.71");
    expect(whyLine({ keywordRank: 3, vectorRank: null, cosine: null })).toBe("keyword #3");
  });

  it("marks the words of the query, case-insensitively, and never as HTML", () => {
    const parts = highlightParts("Hotel in Shinjuku <b>hotel</b>", "hotel");
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(["Hotel", "hotel"]);
    expect(parts.map((p) => p.text).join("")).toBe("Hotel in Shinjuku <b>hotel</b>");
  });

  it("marks CJK by its two-character runs and escapes regex characters", () => {
    expect(queryTerms("東京酒店")).toEqual(expect.arrayContaining(["東京酒店", "東京", "京酒", "酒店"]));
    expect(
      highlightParts("我們訂了東京的酒店", "東京酒店")
        .filter((p) => p.match)
        .map((p) => p.text),
    ).toEqual(["東京", "酒店"]);
    expect(highlightParts("cost (USD) $5", "(USD) $5").some((p) => p.match)).toBe(true);
    expect(highlightParts("plain", "")).toEqual([{ text: "plain", match: false }]);
  });
});

describe("dayBound", () => {
  it("is the start or the end of that local day", () => {
    expect(dayBound("2026-10-31", "start")).toBe(new Date(2026, 9, 31, 0, 0, 0, 0).getTime());
    expect(dayBound("2026-10-31", "end")).toBe(new Date(2026, 9, 31, 23, 59, 59, 999).getTime());
    expect(dayBound("", "start")).toBeUndefined();
  });
});

describe("routes", () => {
  it("builds and parses a link to a chat, or to one message in it", () => {
    expect(sessionHref("s 1")).toBe("/s/s%201");
    expect(sessionHref("s1", "m 9")).toBe("/s/s1?m=m%209");
    expect(parseChatRoute("/s/s%201?m=m%209")).toEqual({ sessionId: "s 1", messageId: "m 9" });
    expect(parseChatRoute("/s/s1")).toEqual({ sessionId: "s1", messageId: null });
    expect(parseRoute("/s/s1?m=x")).toBe("s1");
    expect(parseChatRoute("/memory")).toEqual({ sessionId: null, messageId: null });
    expect(parseChatRoute("/s/%E0%A4%A")).toEqual({ sessionId: null, messageId: null });
  });
});
