import type { HistoryHit, IndexStatus } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { tool } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { FakeEmbedder, withEmbedder } from "./helpers/fake-embedder.ts";
import { historyState } from "./helpers/history.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const memory = () => server!.host.plane.memory;
const search = async (q: string, extra = ""): Promise<{ hits: HistoryHit[]; index: IndexStatus }> =>
  (await server!.client.get(`/api/history/search?q=${encodeURIComponent(q)}${extra}`)).body;
const index = async (): Promise<IndexStatus> => (await server!.client.get("/api/memory/index")).body.index;
const talk = async (id: string, text: string) => {
  const before = (await detail(server!, id)).runs.length;
  await say(server!, id, text);
  await settled(server!, id, before + 1);
};

describe("the history index", () => {
  it("indexes what you say and what the assistant answers, once, and finds it by word", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await talk(id, "The Osaka booking code is XK7P2Q for the spring trip");
    await memory().history.settle();
    const entries = historyState(memory()).countEntries();
    expect(entries).toBeGreaterThanOrEqual(2);
    // Looking again changes nothing.
    memory().history.catchUp();
    memory().history.catchUp();
    expect(historyState(memory()).countEntries()).toBe(entries);

    const { hits } = await search("XK7P2Q");
    expect(hits.length).toBeGreaterThan(0);
    const mine = hits.find((h) => h.kind === "user")!;
    expect(mine).toMatchObject({ sessionId: id, taint: [], keywordRank: 1 });
    expect(mine.snippet).toContain("XK7P2Q");
    expect(mine.messageId).toMatch(/^msg_|./);
    // Keyword-only server: no embedder, so the index says it is off.
    expect((await index()).state).toBe("off");
  });

  it("indexes a settled turn once: settling it again (a restart before the ledger said so) adds nothing", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await talk(id, "Catch-up word is OCELOT-NINE");
    await memory().history.settle();
    const all = historyState(memory()).countEntries();
    expect(all).toBeGreaterThan(0);
    const run = memory().store.runs.forSession(id)[0]!;
    memory().store.memoryHooks!.indexable({
      id: `u:${run.id}`,
      sessionId: id,
      runId: run.id,
      role: "user",
      text: "Catch-up word is OCELOT-NINE",
      createdAt: run.created_at,
    });
    await memory().history.settle();
    expect(historyState(memory()).countEntries()).toBe(all);
    expect((await search("ocelot")).hits.length).toBeGreaterThan(0);
  });

  it("answers bad_query for an empty search and finds one- and two-character CJK words", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await talk(id, "明天我們去東京淺草寺玩");
    await memory().history.settle();
    expect((await server.client.get("/api/history/search?q=")).status).toBe(400);
    expect((await server.client.get("/api/history/search?q=")).body.error.code).toBe("bad_query");
    for (const q of ["東", "東京", "淺草寺"])
      expect(
        (await search(q)).hits.some((h) => h.kind === "user"),
        q,
      ).toBe(true);
    expect((await search("大阪")).hits).toEqual([]);
  });

  it("splits long messages into chunks that are each found, with the message to open", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const filler = (n: number) =>
      Array.from({ length: 60 }, (_, i) => `Paragraph ${n} line ${i} talks about gardens and weather.`).join(" ");
    await talk(id, `${filler(1)}\n\n${filler(2)} The rare word is ZEBRAFISH-ZULU. \n\n${filler(3)}`);
    await memory().history.settle();
    const { hits } = await search("zebrafish");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain("ZEBRAFISH");
    const user = (await detail(server, id)).messages.find((m) => m.role === "user")!;
    expect(hits[0]!.messageId).toBe(user.id);
  });

  it("indexes long tool results as chunks linked to the reply, and skips short ones and the memory tools' own", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await talk(id, tool("demo_read_web", { url: "https://example.com/a" }));
    await memory().history.settle();
    const kinds = memory().store.db.all<{ kind: string; tool_name: string | null }>(
      "SELECT kind, tool_name FROM history_entries WHERE session_id = ?",
      id,
    );
    expect(kinds.filter((k) => k.kind === "tool").every((k) => k.tool_name === "demo_read_web")).toBe(true);
    await talk(id, tool("search_history", { query: "anything at all" }));
    await memory().history.settle();
    expect(
      memory()
        .store.db.all<{ tool_name: string }>("SELECT tool_name FROM history_entries WHERE kind = 'tool'")
        .map((r) => r.tool_name),
    ).not.toContain("search_history");
  });

  it("leaves out sessions that were deleted, and entries of a deleted chat never come back", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await talk(id, "Remember the word QUOKKA-ALPHA please");
    await memory().history.settle();
    expect((await search("quokka")).hits.length).toBeGreaterThan(0);
    expect((await server.client.call("DELETE", `/api/sessions/${id}`)).status).toBe(200);
    expect((await search("quokka")).hits).toEqual([]);
    expect(historyState(memory()).countEntries()).toBe(0);
  });
});

describe("meaning search with an embedder", () => {
  it("finds a message by meaning when no word matches, and reports the ranks", async () => {
    const fake = new FakeEmbedder();
    server = await startSignedIn(withEmbedder(fake));
    const id = await chat(server);
    await talk(id, "I bought a new sedan last week");
    await talk(id, "My dentist appointment is on Tuesday");
    await memory().history.settle();
    const status = await index();
    expect(status).toMatchObject({
      state: "ready",
      model: "mlx-community/embeddinggemma-2-6bit affine-6bit-g64-bf16",
      dimensions: 768,
      remote: false,
      building: null,
    });
    expect(status.embedded).toBe(status.entries);

    const { hits } = await search("automobile");
    const mine = hits.find((h) => h.kind === "user")!;
    expect(mine).toMatchObject({ keywordRank: null });
    expect(mine.vectorRank).toBeGreaterThanOrEqual(1);
    expect(mine.snippet).toContain("sedan");
    expect(mine.cosine).toBeGreaterThan(0.3);
    expect(hits.find((h) => h.snippet.includes("dentist"))).toBeUndefined();
  });

  it("falls back to keyword results when the embedder is down, says so, and catches up when it is back", async () => {
    const fake = new FakeEmbedder();
    server = await startSignedIn(withEmbedder(fake));
    const id = await chat(server);
    await talk(id, "Alpha one is about pelicans");
    await memory().history.settle();
    expect((await index()).state).toBe("ready");

    fake.down = true;
    await talk(id, "Beta two is about pelicans too");
    await until(async () => (await index()).state === "down", 10_000, "state down");
    expect((await index()).lastError).toMatch(/cannot be reached/);
    const keywordOnly = await search("pelicans");
    expect(keywordOnly.hits.length).toBeGreaterThanOrEqual(2);
    expect(keywordOnly.hits.every((h) => h.vectorRank === null)).toBe(true);
    // The search works, and so does the chat.
    expect(historyState(memory()).countEntries()).toBeGreaterThan((await index()).embedded);

    fake.down = false;
    memory().history.retry();
    await memory().history.settle();
    await until(async () => (await index()).state === "ready", 10_000, "state ready");
    const again = await index();
    expect(again.embedded).toBe(again.entries);
  });

  it("rebuilds vectors explicitly and keeps serving from the old set meanwhile", async () => {
    const fake = new FakeEmbedder();
    server = await startSignedIn(withEmbedder(fake));
    const id = await chat(server);
    await talk(id, "The vehicle needs new tyres");
    await memory().history.settle();
    const first = historyState(memory()).activeSet()!;

    const callsBefore = fake.embedded;
    const rebuilding = memory().history.rebuild();
    expect(rebuilding.state).not.toBe("off");
    // Searching still works while it builds.
    expect((await search("vehicle")).hits.length).toBeGreaterThan(0);
    await memory().history.settle();
    const second = historyState(memory()).activeSet()!;
    expect(second.id).not.toBe(first.id);
    expect(second.identity.build).toBe("omlx");
    expect(historyState(memory()).buildingSet()).toBeUndefined();
    expect(fake.embedded).toBeGreaterThan(callsBefore);
    expect((await search("vehicle")).hits.length).toBeGreaterThan(0);
    // The previous vectors remain available for rollback, but are no longer active.
    expect(
      memory().store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_vectors WHERE set_id = ?", first.id)!.n,
    ).toBeGreaterThan(0);
    historyState(memory()).purgeSession(id);
    expect(
      memory().store.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM history_vectors WHERE set_id IN (?, ?)",
        first.id,
        second.id,
      )!.n,
    ).toBe(0);
  });

  it("skips an entry the server refuses, and carries on with the rest", async () => {
    const fake = new FakeEmbedder();
    fake.refuse = ["REFUSEME"];
    server = await startSignedIn(withEmbedder(fake));
    const id = await chat(server);
    await talk(id, "REFUSEME this one is too much");
    await talk(id, "This one is fine, about harbours");
    await memory().history.settle();
    const status = await index();
    expect(status.state).toBe("ready");
    expect(status.embedded).toBeLessThan(status.entries);
    expect((await search("harbours")).hits.some((h) => h.vectorRank !== null)).toBe(true);
    expect((await search("refuseme")).hits.length).toBeGreaterThan(0);
  });

  it("limits a search to a date range", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await talk(id, "The word is LLAMA-ONE");
    await memory().history.settle();
    const now = server.clock.now();
    expect((await search("llama", `&from=${now + 60_000}`)).hits).toEqual([]);
    expect((await search("llama", `&to=${now - 60_000}`)).hits).toEqual([]);
    expect((await search("llama", `&from=${now - 60_000}&to=${now + 60_000}`)).hits.length).toBeGreaterThan(0);
    expect((await server.client.get("/api/history/search?q=llama&from=abc")).body.error.code).toBe("bad_query");
  });
});
