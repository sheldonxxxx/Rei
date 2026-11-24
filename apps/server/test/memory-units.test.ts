import { describe, expect, it } from "vitest";
import {
  blobToVector,
  clipToContext,
  Embedder,
  EmbedderError,
  isRemoteUrl,
  l2normalise,
  OMLX_MODEL,
  vectorToBlob,
} from "../src/memory/embedder.ts";
import { FUSION, fuse } from "../src/memory/fusion.ts";
import { looksSecret, SECRET_REFUSAL } from "../src/memory/guard.ts";
import { bigramTokens, ftsText, hasIdLikeToken, matchExpr, queryTerms } from "../src/memory/keyword.ts";
import { CHUNK_TOKENS, chunkText, estimateTokens, snippetAround } from "../src/memory/text.ts";
import { VectorCache } from "../src/memory/vectors.ts";
import { knownTimeZone, localDay, localDayRange } from "../src/util/time.ts";
import { DIMS, FakeEmbedder, fakeVector } from "./helpers/fake-embedder.ts";

describe("the embeddings client", () => {
  const make = (fake: FakeEmbedder, key?: () => Promise<string | undefined>) =>
    new Embedder(
      { url: "http://omlx:8000/", model: OMLX_MODEL, provider: "omlx", apiModel: OMLX_MODEL },
      { fetch: fake.fetch, ...(key ? { readKey: key } : {}), timeoutMs: 200 },
    );

  it("returns unit-length vectors in input order even when the server answers out of order", async () => {
    const e = make(new FakeEmbedder());
    const [a, b] = await e.embedDocuments(["alpha beta", "gamma delta"]);
    expect(a).toHaveLength(DIMS);
    for (const v of [a!, b!]) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    const [a2] = await e.embedDocuments(["alpha beta"]);
    expect(a2).toEqual(a);
    expect(b).not.toEqual(a);
  });

  it("applies the document and query prompts of the model", async () => {
    const fake = new FakeEmbedder();
    const e = make(fake);
    await e.embedDocuments(["hello"]);
    await e.embedQuery("hello");
    expect(fake.calls.map((c) => c.inputs[0])).toEqual([
      "title: none | text: hello",
      "task: search result | query: hello",
    ]);
  });

  it("sends the bearer key when there is one, and never otherwise", async () => {
    const fake = new FakeEmbedder();
    await make(fake, async () => "sekret-key").embedQuery("x");
    await make(fake).embedQuery("x");
    expect(fake.authorizations).toEqual(["Bearer sekret-key", null]);
  });

  it("tells the kinds of failure apart: network, server, client", async () => {
    const fake = new FakeEmbedder();
    const e = make(fake);
    fake.down = true;
    await expect(e.embedQuery("x")).rejects.toMatchObject({ name: "EmbedderError", kind: "network" });
    fake.down = false;
    fake.status = 503;
    await expect(e.embedQuery("x")).rejects.toMatchObject({ kind: "server", status: 503 });
    fake.status = 429;
    await expect(e.embedQuery("x")).rejects.toMatchObject({ kind: "server" });
    fake.status = 400;
    await expect(e.embedQuery("x")).rejects.toMatchObject({ kind: "client", status: 400 });
  });

  it("rejects an answer that is not the right number of vectors or the right size", async () => {
    const wrongCount = new Embedder(
      { url: "http://e", model: OMLX_MODEL },
      { fetch: async () => Response.json({ data: [] }) },
    );
    await expect(wrongCount.embedDocuments(["a"])).rejects.toBeInstanceOf(EmbedderError);
    const wrongDims = new Embedder(
      { url: "http://e", model: OMLX_MODEL },
      { fetch: async () => Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }) },
    );
    await expect(wrongDims.embedDocuments(["a"])).rejects.toMatchObject({ kind: "server" });
    const notJson = new Embedder({ url: "http://e", model: OMLX_MODEL }, { fetch: async () => new Response("<html>") });
    await expect(notJson.embedDocuments(["a"])).rejects.toMatchObject({ kind: "server" });
  });

  it("gives up after its timeout", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError"))),
      );
    const e = new Embedder({ url: "http://e", model: OMLX_MODEL }, { fetch: hang, timeoutMs: 30 });
    await expect(e.embedQuery("x")).rejects.toMatchObject({
      kind: "network",
      message: expect.stringContaining("in time"),
    });
  });

  it("probes model discovery and inference through the OpenAI-compatible API", async () => {
    const fake = new FakeEmbedder();
    expect(await make(fake).probe()).toEqual({ build: "omlx", quant: "affine-6bit-g64-bf16" });
    const silent = new Embedder(
      { url: "http://e", model: OMLX_MODEL, apiModel: OMLX_MODEL },
      { fetch: async () => new Response("no", { status: 404 }) },
    );
    await expect(silent.probe()).rejects.toMatchObject({ status: 404 });
  });

  it("rejects an unknown model and calls only non-local endpoints remote", () => {
    expect(() => new Embedder({ url: "http://e", model: "nope" }, {})).toThrow(/Unknown embedder model/);
    for (const url of [
      "http://omlx:8000",
      "http://localhost:1",
      "http://127.0.0.1:1",
      "http://10.0.0.5",
      "http://192.168.1.2",
      "http://[::1]:8080",
    ])
      expect(isRemoteUrl(url)).toBe(false);
    for (const url of ["https://api.example.com/v1", "http://8.8.8.8", "not a url"])
      expect(isRemoteUrl(url)).toBe(true);
  });

  it("round-trips a vector through its BLOB and clips long input to the provider context", () => {
    const v = l2normalise([3, 4]);
    expect(Array.from(v)).toEqual([expect.closeTo(0.6, 5), expect.closeTo(0.8, 5)]);
    expect(Array.from(blobToVector(vectorToBlob(v)))).toEqual(Array.from(v));
    expect(() => l2normalise([0, 0])).toThrow(EmbedderError);
    const long = "word ".repeat(5_000);
    expect(estimateTokens(clipToContext(long))).toBeLessThanOrEqual(900);
    expect(clipToContext("short")).toBe("short");
  });
});

describe("chunking", () => {
  it("keeps short text as one chunk and splits long text under the token limit with overlap", () => {
    expect(chunkText("A short note.")).toEqual(["A short note."]);
    const paragraph = (n: number) =>
      Array.from({ length: 40 }, (_, i) => `Sentence ${n}-${i} is about something quite particular.`).join(" ");
    const text = [1, 2, 3, 4].map(paragraph).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(CHUNK_TOKENS + 8);
    // Nothing is lost: every sentence is in some chunk.
    for (let n = 1; n <= 4; n++)
      for (const i of [0, 20, 39]) expect(chunks.some((c) => c.includes(`Sentence ${n}-${i} `))).toBe(true);
  });

  it("splits CJK text, which has no spaces, by size", () => {
    const text = "我今天去了東京的淺草寺，然後吃了拉麵。".repeat(120);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(CHUNK_TOKENS + 8);
    expect(chunks.join("")).toContain("淺草寺");
  });

  it("cuts a snippet around the query's terms", () => {
    const text = `${"filler ".repeat(200)}the booking code is XK7P2Q for Osaka ${"more ".repeat(200)}`;
    const s = snippetAround(text, ["xk7p2q"]);
    expect(s).toContain("XK7P2Q");
    expect(s.length).toBeLessThanOrEqual(310);
  });

  it("drops markdown marks from a snippet", () => {
    expect(
      snippetAround(
        "## History\n- It was under **Qin** rule, see [Wikipedia](https://en.wikipedia.org/wiki/Macau) and `code`.",
        ["qin"],
      ),
    ).toBe("History It was under Qin rule, see Wikipedia and code.");
  });
});

describe("keyword tokens", () => {
  it("splits CJK into single characters and bigrams so one- and two-character words are found", () => {
    expect(bigramTokens("東京タワー")).toEqual(["東京", "京タ", "タワ", "ワー"]);
    expect(bigramTokens("東")).toEqual(["東"]);
    expect(ftsText("東京").split(" ")).toEqual(["東", "京", "東京"]);
    expect(bigramTokens("Hello, World 42")).toEqual(["hello", "world", "42"]);
    expect(matchExpr("東")).not.toBeNull();
    expect(matchExpr("東京")).not.toBeNull();
    expect(matchExpr("!!! ---")).toBeNull();
    expect(queryTerms("Booking XK7P2Q")).toEqual(["booking", "xk7p2q"]);
  });

  it("spots identifier-like tokens in a query", () => {
    for (const q of ["booking XK7P2Q", "order 48213377", "mail me at a.b@example.com", "https://example.com/x"])
      expect(hasIdLikeToken(q), q).toBe(true);
    for (const q of ["what did I say about dentists", "my sister"]) expect(hasIdLikeToken(q), q).toBe(false);
  });
});

describe("fusion", () => {
  const vec = (...ids: number[]) => ids.map((id, i) => ({ id, cosine: 0.9 - i * 0.05 }));
  const kw = (...ids: number[]) => ids.map((id) => ({ id }));

  it("ranks what both sides found first, and records each side's rank and the cosine", () => {
    const hits = fuse("a question", vec(1, 2, 3), kw(3, 4, 1));
    expect(
      hits
        .map((h) => h.id)
        .slice(0, 2)
        .sort(),
    ).toEqual([1, 3]);
    const one = hits.find((h) => h.id === 1)!;
    expect(one).toMatchObject({ vectorRank: 1, keywordRank: 3 });
    expect(one.cosine).toBeCloseTo(0.9);
    expect(hits.find((h) => h.id === 4)).toMatchObject({ vectorRank: null, keywordRank: 2, cosine: null });
  });

  it("drops vector hits below the cosine floor, and works with either side empty", () => {
    const low = [{ id: 9, cosine: FUSION.cosineFloor - 0.01 }];
    expect(fuse("q", low, kw(1)).map((h) => h.id)).toEqual([1]);
    expect(fuse("q", [], kw(5, 6)).map((h) => h.id)).toEqual([5, 6]);
    expect(fuse("q", vec(7, 8), []).map((h) => h.id)).toEqual([7, 8]);
  });

  it("gives the keyword side more weight for a query with an identifier", () => {
    const plain = fuse("my sister", vec(1), kw(2));
    const coded = fuse("booking XK7P2Q", vec(1), kw(2), { kind: "fusion", vectorWeight: 1 });
    expect(plain[0]!.id).toBe(1);
    expect(coded[0]!.id).toBe(2);
  });

  it("can search by keyword alone or by meaning alone", () => {
    expect(fuse("q", vec(1, 2), kw(3), { kind: "keyword" }).map((h) => h.id)).toEqual([3]);
    expect(fuse("q", vec(1, 2), kw(3), { kind: "vector" }).map((h) => h.id)).toEqual([1, 2]);
  });
});

describe("the vector cache", () => {
  it("answers the nearest vectors first, and forgets deleted ones", () => {
    const cache = new VectorCache(2);
    cache.set(1, l2normalise([1, 0]));
    cache.set(2, l2normalise([1, 1]));
    cache.set(3, l2normalise([0, 1]));
    const near = cache.search(l2normalise([1, 0.1]), 2);
    expect(near.map((n) => n.id)).toEqual([1, 2]);
    expect(near[0]!.cosine).toBeGreaterThan(near[1]!.cosine);
    cache.delete(1);
    expect(cache.search(l2normalise([1, 0]), 5).map((n) => n.id)).not.toContain(1);
    expect(cache.size).toBe(2);
  });
});

describe("the fake embedder's meaning", () => {
  it("puts synonyms close and unrelated words apart (so the tests can stand in for a model)", () => {
    const dot = (a: number[], b: number[]) => {
      const na = l2normalise(a);
      const nb = l2normalise(b);
      return na.reduce((s, x, i) => s + x * nb[i]!, 0);
    };
    expect(dot(fakeVector("my car"), fakeVector("my automobile"))).toBeGreaterThan(0.9);
    expect(dot(fakeVector("my car"), fakeVector("dentist appointment"))).toBeLessThan(0.1);
  });
});

describe("the secret guard", () => {
  it("refuses keys, passwords, one-time codes and card numbers", () => {
    for (const t of [
      "my password is hunter2hunter2",
      "api key sk-abcdefghijklmnopqrstuvwxyz0123456789",
      "card 4111 1111 1111 1111",
      "the one-time code is 482913",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ])
      expect(looksSecret(t), t).toBe(true);
    expect(SECRET_REFUSAL).toMatch(/never holds passwords/);
  });
  it("lets ordinary facts through", () => {
    for (const t of [
      "Prefers aisle seats",
      "Lives in Osaka",
      "Daughter's birthday is 3 March",
      "Phone number ends in 42",
    ])
      expect(looksSecret(t), t).toBe(false);
  });
});

describe("local days", () => {
  // 2026-10-30 20:00 UTC: already the 31st in Macau, still the 30th in New York.
  const at = Date.UTC(2026, 9, 30, 20, 0);

  it("dates a moment in the zone it is given", () => {
    expect(localDay(at, "Asia/Macau")).toBe("2026-10-31");
    expect(localDay(at, "America/New_York")).toBe("2026-10-30");
    expect(localDay(at, "UTC")).toBe("2026-10-30");
  });

  it("accepts only zones the runtime knows", () => {
    expect(knownTimeZone("Asia/Macau")).toBe("Asia/Macau");
    expect(knownTimeZone("Mars/Olympus")).toBeUndefined();
    expect(knownTimeZone("")).toBeUndefined();
    expect(knownTimeZone(42)).toBeUndefined();
  });

  it("turns a date into its whole day in the process zone", () => {
    const r = localDayRange("2026-10-31")!;
    expect(localDay(r.start)).toBe("2026-10-31");
    expect(localDay(r.end)).toBe("2026-10-31");
    expect(localDay(r.end + 1)).toBe("2026-11-01");
    expect(localDayRange("2026-10-31T10:00")).toBeUndefined();
  });
});
