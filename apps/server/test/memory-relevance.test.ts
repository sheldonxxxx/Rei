import { describe, expect, it } from "vitest";
import type { FusedHit } from "../src/memory/fusion.ts";
import { relevantHits } from "../src/memory/relevance.ts";

const hit = (id: number, cosine: number | null = null): FusedHit => ({
  id,
  cosine,
  score: 0.2,
  keywordRank: 1,
  vectorRank: cosine === null ? null : 1,
});
const search = (query: string, text: string, cosine: number | null = null) =>
  relevantHits(query, [hit(1, cosine)], new Map([[1, text]]));

describe("history relevance", () => {
  it("does not interpret a high relative rank or common words as relevance", () => {
    expect(search("What is my blood type?", "My favourite cafe is by the station.")).toEqual([]);
    expect(search("what is my", "what is my", 0.99)).toEqual([]);
    expect(search("football team", "The notebook is teal.", 0.29)).toEqual([]);
  });
  it("keeps distinctive single words, complete topics, and one-character CJK queries", () => {
    for (const [q, text] of [
      ["kumquat", "We bought kumquat jam."],
      ["notebook colour", "The notebook colour is teal."],
      ["東", "明天去東京"],
    ]) {
      expect(search(q!, text!)[0]?.relevance).toBe("match");
    }
    expect(search("cat", "The cathedral is open.")).toEqual([]);
  });
  it("uses the entire candidate rather than its first 64 terms or displayed snippet", () => {
    expect(
      search("ocelot", Array.from({ length: 100 }, (_, n) => `word${n}`).join(" ") + " ocelot")[0]?.relevance,
    ).toBe("match");
  });
  it("normalises case, full-width characters and Latin accents", () => {
    expect(search("cafe", "CAFÉ in Paris")[0]?.relevance).toBe("match");
    expect(search("ＡＢ１２３", "Booking AB123")[0]?.relevance).toBe("match");
  });
  it("preserves exact identifiers while refusing semantic near misses and prefix collisions", () => {
    expect(search("booking XK7P2Q", "Booking XK7P2Q is for Osaka.")[0]?.relevance).toBe("match");
    expect(search("booking XK7P2Q", "Booking XK7P2R is for Osaka.", 0.95)).toEqual([]);
    expect(search("AB123", "Booking AB1234.", 0.95)).toEqual([]);
    expect(search("AB123", "Booking XAB123.", 0.95)).toEqual([]);
    expect(search("訂單 AB123", "訂單AB123已到達")[0]?.relevance).toBe("match");
  });
  it("checks complete emails, URLs and hyphenated codes rather than FTS fragments", () => {
    expect(search("ana@example.com", "Contact ana@other.com", 0.95)).toEqual([]);
    expect(search("ana@example.com", "Contact ana@example.com.uk", 0.95)).toEqual([]);
    expect(search("ana@example.com", "Contact ANA@example.com.")[0]?.relevance).toBe("match");
    expect(search("https://example.com/orders/123", "https://example.com/orders/1234", 0.95)).toEqual([]);
    expect(search("INV-123", "Invoice INV-124", 0.95)).toEqual([]);
    expect(search("INV-123", "Invoice INV-123")[0]?.relevance).toBe("match");
  });
  it("allows different passages to contain different requested identifiers in a comparison", () => {
    expect(search("compare INV-123 and INV-124", "Invoice INV-124")[0]?.relevance).toBe("match");
  });
  it("keeps exact numeric terms inside dates without matching digits inside a different code", () => {
    expect(search("2027", "The appointment is 2027-02-12.")[0]?.relevance).toBe("match");
    expect(search("123", "Booking AB123", 0.9)).toEqual([]);
  });
  it("keeps cross-language semantic evidence as explicitly uncertain leads", () => {
    expect(search("When is my dentist appointment?", "牙科覆診星期五下午三點。", 0.45)[0]?.relevance).toBe("related");
    expect(search("When is my dentist appointment?", "牙科覆診星期五下午三點。", 0.65)[0]?.relevance).toBe("match");
  });
  it("marks partial keyword evidence as a lead even when the embedder is off", () => {
    expect(search("Kyoto maples", "Kyoto hotel reservation")[0]?.relevance).toBe("related");
    expect(relevantHits("Kyoto maples", [hit(1)], new Map([[1, "Kyoto hotel reservation"]]), true)).toEqual([]);
  });
  it("limits uncertain leads without dropping a stronger result later in the ranking", () => {
    const rows = Array.from({ length: 8 }, (_, i) => hit(i, 0.45));
    const texts = new Map(rows.map((h) => [h.id, h.id === 7 ? "dentist appointment" : "牙科覆診"]));
    const found = relevantHits("dentist appointment", rows, texts);
    expect(found.filter((h) => h.relevance === "related")).toHaveLength(5);
    expect(found.at(-1)).toMatchObject({ id: 7, relevance: "match" });
  });
  it("drops candidates which cannot be hydrated and preserves accepted ranking", () => {
    const found = relevantHits(
      "kumquat",
      [hit(4), hit(2), hit(3)],
      new Map([
        [2, "kumquat"],
        [3, "kumquat"],
      ]),
    );
    expect(found.map((h) => h.id)).toEqual([2, 3]);
  });
});
