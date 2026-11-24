import { afterEach, describe, expect, it } from "vitest";
import { tool } from "./helpers/approvals.ts";
import { FakeEmbedder, withEmbedder } from "./helpers/fake-embedder.ts";
import { historyState } from "./helpers/history.ts";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, sessions, settled } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const store = () => server!.host.plane.store;
const memory = () => server!.host.plane.memory;
const get = (path: string) => server!.client.get(path);
const post = (path: string, body: unknown = {}) => server!.client.post(path, body);
const patch = (path: string, body: unknown) => server!.client.call("PATCH", path, { body });
const del = (path: string) => server!.client.call("DELETE", path);
const talk = async (id: string, text: string) => {
  const before = (await detail(server!, id)).runs.length;
  await say(server!, id, text);
  return settled(server!, id, before + 1);
};
const homeOf = async () => (await get("/api/agents")).body.agents[0] as { id: string; homeSessionId: string };

describe("the memory page's API", () => {
  it("lists the docs, adds, edits, confirms and removes lines as you, with every version kept", async () => {
    server = await startSignedIn();
    const agent = (await homeOf()).id;
    expect((await get("/api/memory")).body).toEqual({
      profile: [],
      agents: [{ agentId: agent, lines: [], usedTokens: 0, tokenBudget: 1000 }],
      userUsedTokens: 0,
      userTokenBudget: 3000,
      usedTokens: 0,
    });

    const added = await post("/api/memory/lines", { doc: "profile", text: "  Prefers   window seats " });
    expect(added.status).toBe(200);
    expect(added.body.line).toMatchObject({
      id: "m1",
      doc: "profile",
      agentId: null,
      text: "Prefers window seats",
      source: null,
      sourceDeleted: false,
    });
    expect(added.body.change).toMatchObject({
      op: "add",
      by: "user",
      sessionId: null,
      before: null,
      after: "Prefers window seats",
      undoable: true,
    });
    const note = await post("/api/memory/lines", { doc: "agent", agentId: agent, text: "Answer briefly" });
    expect(note.body.line).toMatchObject({ id: "m2", doc: "agent", agentId: agent });
    const listed = (await get("/api/memory")).body;
    expect(listed.profile.map((l: { text: string }) => l.text)).toEqual(["Prefers window seats"]);
    expect(listed.agents[0].lines.map((l: { text: string }) => l.text)).toEqual(["Answer briefly"]);
    expect(listed.usedTokens).toBeGreaterThan(0);

    // A different text replaces; the same text only confirms.
    server.clock.advance(60_000);
    const replaced = await patch("/api/memory/lines/m1", { text: "Prefers aisle seats" });
    expect(replaced.body.change).toMatchObject({
      op: "replace",
      by: "user",
      before: "Prefers window seats",
      after: "Prefers aisle seats",
    });
    server.clock.advance(60_000);
    const confirmed = await patch("/api/memory/lines/m1", { text: "Prefers aisle seats" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.change).toMatchObject({
      op: "confirm",
      by: "user",
      before: "Prefers aisle seats",
      after: "Prefers aisle seats",
    });
    expect(confirmed.body.line.confirmedAt).toBeGreaterThan(replaced.body.line.confirmedAt);
    expect(confirmed.body.line.text).toBe("Prefers aisle seats");

    const history = (await get("/api/memory/lines/m1/changes")).body.changes as { op: string }[];
    expect(history.map((c) => c.op)).toEqual(["add", "replace", "confirm"]);

    const removed = await del("/api/memory/lines/m1");
    expect(removed.body.change).toMatchObject({ op: "remove", before: "Prefers aisle seats", after: null });
    expect((await get("/api/memory")).body.profile).toEqual([]);
    // The removed line's versions are still there, so a remove can be undone.
    expect((await post(`/api/memory/changes/${removed.body.change.id}/undo`)).body.line.text).toBe(
      "Prefers aisle seats",
    );
  });

  it("answers errors with codes: empty, too_long, over_budget, unknown_agent, not_found", async () => {
    server = await startSignedIn();
    const code = (r: { status: number; body: { error: { code: string } } }) => `${r.status} ${r.body.error.code}`;
    expect(code(await post("/api/memory/lines", { doc: "profile", text: "   " }))).toBe("400 empty");
    expect(code(await post("/api/memory/lines", { doc: "profile", text: "x".repeat(501) }))).toBe("400 too_long");
    expect(code(await post("/api/memory/lines", { doc: "agent", agentId: "agt_nope", text: "hi" }))).toBe(
      "400 unknown_agent",
    );
    expect(code(await post("/api/memory/lines", { doc: "nope", text: "hi" }))).toMatch(/^400 /);
    expect(code(await patch("/api/memory/lines/m404", { text: "hi" }))).toBe("404 not_found");
    expect(code(await del("/api/memory/lines/m404"))).toBe("404 not_found");
    expect(code(await get("/api/memory/lines/m404/changes"))).toBe("404 not_found");
    for (let i = 0; i < 60; i++) {
      const r = await post("/api/memory/lines", {
        doc: "profile",
        text: `Line ${i} ${"alpha beta gamma delta ".repeat(18)}`,
      });
      if (r.status !== 200) {
        expect(code(r)).toBe("400 over_budget");
        return;
      }
    }
    throw new Error("the budget was never reached");
  });

  it("needs the cookie and the CSRF header, like every other call", async () => {
    server = await startSignedIn();
    expect((await server.client.call("GET", "/api/memory", { cookie: false })).status).toBe(401);
    expect(
      (await server.client.call("POST", "/api/memory/lines", { csrf: false, body: { doc: "profile", text: "x" } }))
        .status,
    ).toBe(403);
    expect((await server.client.call("GET", "/api/history/search?q=x", { cookie: false })).status).toBe(401);
  });

  it("tells every open screen with memory.changed when the lines change", async () => {
    server = await startSignedIn();
    const sse = await server.sse("/api/stream");
    await post("/api/memory/lines", { doc: "profile", text: "Streams events" });
    const seen = await sse.waitFor(
      (e) => JSON.stringify(e).includes("memory.changed") && JSON.stringify(e).includes('"lines"'),
      5_000,
    );
    expect(seen).toBeDefined();
    await sse.close();
  });
});

describe("history search over HTTP", () => {
  it("filters common-word noise, keeps exact codes, and labels keyword fallback leads", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await talk(id, "My Kyoto hotel booking is AB123. The cathedral is open.");
    await memory().history.settle();
    const search = async (q: string) => (await get(`/api/history/search?q=${encodeURIComponent(q)}`)).body.hits;
    expect(await search("What is my favourite football team?")).toEqual([]);
    expect(await search("AB124")).toEqual([]);
    expect(await search("cat")).toEqual([]);
    expect((await search("AB123"))[0]).toMatchObject({ relevance: "match", sessionId: id });
    expect((await search("Kyoto maples"))[0]).toMatchObject({ relevance: "related", sessionId: id });
  });

  const second = () => {
    store().db.run(
      "INSERT INTO agents (id, name, avatar, default_profile, instructions, home_session_id, created_at) VALUES ('agt_dot', 'Dot', 'bot:cat', 'standard', '', NULL, ?)",
      server!.clock.now(),
    );
    return "agt_dot";
  };

  it("searches every agent by default and narrows with agent=<id>; an unknown id is a 400 unknown_agent", async () => {
    server = await startSignedIn();
    const dot = second();
    const mine = await chat(server);
    const theirs = (await post("/api/sessions", { agentId: dot })).body.session.id as string;
    await talk(mine, "Pomelo from the first agent");
    await talk(theirs, "Pomelo from the second agent");
    await memory().history.settle();
    const q = (extra = "") => get(`/api/history/search?q=pomelo${extra}`);
    const all = (await q()).body.hits as { sessionId: string; agentId: string; kind: string }[];
    expect(new Set(all.map((h) => h.sessionId))).toEqual(new Set([mine, theirs]));
    const only = (await q(`&agent=${dot}`)).body.hits as { sessionId: string; agentId: string }[];
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((h) => h.sessionId === theirs && h.agentId === dot)).toBe(true);
    const home = (await homeOf()).id;
    expect(((await q(`&agent=${home}`)).body.hits as { sessionId: string }[]).every((h) => h.sessionId === mine)).toBe(
      true,
    );
    const bad = await q("&agent=agt_nobody");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("unknown_agent");
    // An empty agent is "every agent".
    expect(((await q("&agent=")).body.hits as unknown[]).length).toBe(all.length);
  });

  it("narrows meaning search by agent too", async () => {
    const fake = new FakeEmbedder();
    server = await startSignedIn(withEmbedder(fake));
    const dot = second();
    const mine = await chat(server);
    const theirs = (await post("/api/sessions", { agentId: dot })).body.session.id as string;
    await talk(mine, "I drive a sedan");
    await talk(theirs, "I drive an automobile too");
    await memory().history.settle();
    const hits = (await get(`/api/history/search?q=${encodeURIComponent("vehicle")}&agent=${dot}`)).body.hits as {
      sessionId: string;
      vectorRank: number | null;
    }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.sessionId === theirs)).toBe(true);
    expect(hits.some((h) => h.vectorRank !== null)).toBe(true);
    const everyone = (await get(`/api/history/search?q=${encodeURIComponent("vehicle")}`)).body.hits as {
      sessionId: string;
    }[];
    expect(new Set(everyone.map((h) => h.sessionId))).toEqual(new Set([mine, theirs]));
  });

  it("limits the number of hits", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    for (let i = 0; i < 4; i++) await talk(id, `Sorbet number ${i}`);
    await memory().history.settle();
    expect(((await get("/api/history/search?q=sorbet&limit=3")).body.hits as unknown[]).length).toBe(3);
    expect((await get("/api/history/search?q=sorbet&limit=x")).body.error.code).toBe("bad_query");
  });
});

describe("the index endpoints", () => {
  it("reports the index state and starts a rebuild", async () => {
    const fake = new FakeEmbedder();
    server = await startSignedIn(withEmbedder(fake));
    const id = await chat(server);
    await talk(id, "Something to index");
    await memory().history.settle();
    const status = (await get("/api/memory/index")).body.index;
    expect(status).toMatchObject({ state: "ready", dimensions: 768, remote: false });
    const first = historyState(memory()).activeSet()!.id;
    const rebuilt = await post("/api/memory/index/rebuild");
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body.index.state).toMatch(/indexing|ready/);
    await memory().history.settle();
    expect(historyState(memory()).activeSet()!.id).not.toBe(first);
    expect((await get("/api/memory/index")).body.index.state).toBe("ready");
  });

  it("is simply off without an embedder", async () => {
    server = await startSignedIn();
    expect((await get("/api/memory/index")).body.index).toMatchObject({
      state: "off",
      model: null,
      dimensions: null,
      embedded: 0,
      building: null,
      remote: false,
    });
    expect((await post("/api/memory/index/rebuild")).body.index.state).toBe("off");
  });
});

describe("clearing a home chat", () => {
  it("refuses a plain delete, and with clearHome=1 starts a fresh home chat in a new tree", async () => {
    server = await startSignedIn();
    const before = await homeOf();
    await talk(before.homeSessionId, "HOME-SECRET-ALPHA lives here");
    await talk(before.homeSessionId, tool("memory_add", { text: "Keeps a kept fact" }));
    await memory().history.settle();
    const oldTree = store().getSessionRowAny(before.homeSessionId)!.tree_id;

    const refused = await del(`/api/sessions/${before.homeSessionId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("home_chat");

    const events = await server.sse("/api/stream");
    const cleared = await del(`/api/sessions/${before.homeSessionId}?clearHome=1`);
    expect(cleared.status).toBe(200);
    const after = await homeOf();
    expect(after.id).toBe(before.id);
    expect(after.homeSessionId).not.toBe(before.homeSessionId);
    const fresh = await detail(server, after.homeSessionId);
    expect(fresh.session).toMatchObject({ origin: "home", status: "idle" });
    expect(fresh.messages).toEqual([]);
    expect(store().getSessionRowAny(after.homeSessionId)!.tree_id).not.toBe(oldTree);
    expect((await sessions(server)).map((s) => s.id)).not.toContain(before.homeSessionId);
    expect((await get(`/api/sessions/${before.homeSessionId}`)).status).toBe(404);
    // What the home chat taught stays (the line keeps its text; its source chat is gone), what it said does not.
    const line = (await get("/api/memory")).body.profile[0];
    expect(line.text).toBe("Keeps a kept fact");
    expect(line).toMatchObject({ source: null, sourceDeleted: true });
    expect((await get("/api/history/search?q=HOME-SECRET-ALPHA")).body.hits).toEqual([]);
    await events.waitFor((e) => JSON.stringify(e).includes("agent.upserted"), 5_000);
    await events.close();
    // The new home chat works.
    await talk(after.homeSessionId, "hello again");
  });
});

describe("guided memory setup", () => {
  it("applies keyword mode immediately, preserves vectors, and persists across restart", async () => {
    const fake = new FakeEmbedder();
    server = await startSignedIn(withEmbedder(fake));
    expect((await get("/api/memory/setup")).body).toMatchObject({ enabled: true, available: true });
    await memory().history.settle();
    const sets = store().db.all("SELECT * FROM memory_vector_sets");
    expect((await post("/api/memory/setup", { enabled: false })).body.enabled).toBe(false);
    expect(memory().history.status().state).toBe("off");
    expect(store().db.all("SELECT * FROM memory_vector_sets")).toEqual(sets);
    const dir = server.dir;
    const totpSecret = server.totpSecret;
    await server.stop();
    server = Object.assign(await startTestServer({ ...withEmbedder(fake), dir }), { totpSecret });
    expect(memory().history.setupSettings()).toMatchObject({ enabled: false, available: true });
    await memory().history.configureEnabled(true);
    expect(memory().history.status().state).not.toBe("off");
  });

  it("rejects invalid choices and offers keyword search without an installed embedder", async () => {
    server = await startSignedIn();
    expect((await get("/api/memory/setup")).body).toEqual({ enabled: false, available: false, model: null });
    expect((await post("/api/memory/setup", { enabled: "yes" })).status).toBe(400);
    expect((await post("/api/memory/setup", { enabled: true })).status).toBe(400);
    expect((await post("/api/memory/setup", { enabled: false })).status).toBe(200);
  });
});
