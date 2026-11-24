import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_FUSION, KnowledgeMeaning } from "../src/knowledge/meaning.ts";
import { GLOBAL_STREAM } from "../src/store/events.ts";
import { nullLogger } from "../src/util/log.ts";
import { tool } from "./helpers/approvals.ts";
import { FAKE_KNOWLEDGE_COSINE_FLOOR, FakeEmbedder, withEmbedder } from "./helpers/fake-embedder.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled, stepPayloads } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async () => (server = await startSignedIn());
const k = () => server!.host.plane.knowledge;
const USER = { actor: "user" } as const;
const agentId = () => server!.host.plane.store.listAgents()[0]!.id;
const talk = async (id: string, text: string) => {
  const before = (await detail(server!, id)).runs.length;
  await say(server!, id, text);
  return settled(server!, id, before + 1);
};
const lastPayload = (id: string): string => stepPayloads(server!, id).at(-1)!;

describe("Knowledge pages", () => {
  it("creates Inbox once, nests pages, and orders every listing by subtree activity", async () => {
    await start();
    const inbox = k().ensureInbox();
    expect(k().ensureInbox().id).toBe(inbox.id);
    const personal = k().create({ parentId: null, title: "Personal", description: "health, home" }, USER);
    server!.clock.advance(1_000);
    const projects = k().create({ parentId: null, title: "Projects" }, USER);
    server!.clock.advance(1_000);
    const fitness = k().create({ parentId: personal.id, title: "Fitness" }, USER);
    server!.clock.advance(1_000);
    const plan = k().create({ parentId: fitness.id, title: "Training plan", body: "# Goals\nRun 10k" }, USER);
    // A deep write bubbles up: Personal is now the most recent top-level page.
    expect(
      k()
        .children(null)
        .map((p) => p.title),
    ).toEqual(["Personal", "Projects", "Inbox"]);
    expect(k().path(plan.id)).toBe("Personal › Fitness › Training plan");
    expect(() => k().move(personal.id, plan.id, USER)).toThrow(/inside itself/);
    expect(() => k().move(inbox.id, projects.id, USER)).toThrow(/top level/);
    expect(k().childCount(personal.id)).toBe(1);
  });

  it("applies section ops, needs a base revision except for append and set_task, and reports conflicts by section", async () => {
    await start();
    const w = { actor: agentId(), sessionId: "s1" };
    const page = k().create(
      { parentId: null, title: "Plan", body: "Intro\n\n## Week 1\n- [ ] Run 5k\n\n## Week 2\nRest" },
      w,
    );
    const r1 = k().edit(page.id, [{ op: "append_to_section", section: "Week 1", text: "- [ ] Stretch" }], w, 1);
    expect(r1.page.body).toContain("- [ ] Run 5k\n- [ ] Stretch");
    expect(r1.changed).toContain("## Week 1");
    // No base revision: append and set_task are fine.
    k().edit(
      page.id,
      [
        { op: "set_task", task: "run 5k", done: true },
        { op: "append", text: "Notes at the end" },
      ],
      w,
    );
    expect(k().live(page.id).body).toContain("- [x] Run 5k");
    expect(k().live(page.id).body.endsWith("Notes at the end")).toBe(true);
    expect(() => k().edit(page.id, [{ op: "replace_section", section: "Week 2", text: "Long run" }], w)).toThrow(
      /needs baseRevision/,
    );
    let conflict: unknown;
    try {
      k().edit(page.id, [{ op: "replace_section", section: "Week 2", text: "Long run" }], w, 1);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ status: 409, revision: 3 });
    expect((conflict as { current: string }).current).toBe("## Week 2\nRest\n\nNotes at the end");
    const r2 = k().edit(page.id, [{ op: "replace_section", section: "§2", text: "Long run" }], w, 3);
    expect(r2.page.body).toContain("## Week 2\n\nLong run");
    expect(() => k().edit(page.id, [{ op: "replace_text", old: "nope", new: "x" }], w, 4)).toThrow(/not on the page/);
    expect(() => k().edit(page.id, [{ op: "append_to_section", section: "Week 9", text: "x" }], w, 4)).toThrow(
      /§1 Week 1 #week-1; §2 Week 2 #week-2/,
    );
  });

  it("coalesces one writer's burst into one revision and keeps separate writers apart", async () => {
    await start();
    const a = { actor: agentId(), sessionId: "s1" };
    const page = k().create({ parentId: null, title: "Log" }, a);
    k().edit(page.id, [{ op: "append", text: "one" }], a);
    k().edit(page.id, [{ op: "append", text: "two" }], a);
    // created + one coalesced edit
    expect(
      k()
        .revisions(page.id)
        .map((r) => [r.revision, r.note]),
    ).toEqual([
      [3, null],
      [1, "created"],
    ]);
    k().edit(page.id, [{ op: "append", text: "three" }], USER);
    server!.clock.advance(11 * 60_000);
    k().edit(page.id, [{ op: "append", text: "four" }], USER);
    expect(
      k()
        .revisions(page.id)
        .map((r) => r.revision),
    ).toEqual([5, 4, 3, 1]);
    const restored = k().restoreRevision(page.id, 3, 5, USER);
    expect(restored.body).toBe("one\n\ntwo");
    expect(k().revisions(page.id)[0]).toMatchObject({ revision: 6, note: "restored revision 3" });
  });

  it("lets agents only append to a locked page", async () => {
    await start();
    const a = { actor: agentId() };
    const page = k().create({ parentId: null, title: "Mine", body: "- [ ] task" }, USER);
    k().setFlags(page.id, { locked: true });
    expect(k().edit(page.id, [{ op: "append", text: "agent note" }], a).page.revision).toBe(2);
    expect(() => k().edit(page.id, [{ op: "set_task", task: "task", done: true }], a)).toThrow(/locked/);
    expect(() => k().trashPage(page.id, a)).toThrow(/locked/);
    expect(k().edit(page.id, [{ op: "set_task", index: 0, done: true }], USER).page.body).toContain("[x]");
  });

  it("ignores common words in a query, unless they are all it has", async () => {
    await start();
    const pasta = k().create({ parentId: null, title: "Pasta", body: "How to cook pasta: boil it." }, USER);
    const other = k().create(
      { parentId: null, title: "Taxes", body: "Where to send the form, and what to attach." },
      USER,
    );
    // "how", "to" and "the" are in both pages, but only the page about pasta has a word that says something.
    expect(
      k()
        .search("how to cook the pasta")
        .map((h) => h.pageId),
    ).toEqual([pasta.id]);
    // A query made only of common words is searched as typed, so "what to" is not an empty search.
    expect(
      k()
        .search("what to")
        .map((h) => h.pageId)
        .sort(),
    ).toEqual([pasta.id, other.id].sort());
    // Common words around a word nobody has find nothing.
    expect(k().search("how to zzqxv")).toEqual([]);
  });

  it("trashes a subtree as one action, restores it, and purges it with its revisions and index", async () => {
    await start();
    const top = k().create({ parentId: null, title: "Garden", body: "tomatoes and basil" }, USER);
    const child = k().create({ parentId: top.id, title: "Watering", body: "every morning" }, USER);
    expect(
      k()
        .search("tomatoes")
        .map((h) => h.pageId),
    ).toEqual([top.id]);
    expect(k().trashPage(top.id, USER)).toBe(2);
    expect(k().search("tomatoes")).toEqual([]);
    expect(k().search("morning")).toEqual([]);
    expect(
      k()
        .trash()
        .map((t) => t.id),
    ).toEqual([top.id]);
    expect(() => k().trashPage(k().ensureInbox().id, USER)).toThrow(/Inbox/);
    k().restorePage(top.id);
    expect(k().live(child.id).parent_id).toBe(top.id);
    expect(
      k()
        .search("morning")
        .map((h) => h.pageId),
    ).toEqual([child.id]);
    k().trashPage(top.id, USER);
    expect(() => k().purge(child.id)).toThrow(/Only a page in Trash/);
    expect(k().purge(top.id)).toBe(2);
    expect(k().page(child.id)).toBeUndefined();
    expect(k().revisions(top.id)).toEqual([]);
  });

  it("tells open views about every change on the live stream, after the write commits", async () => {
    await start();
    const seen: string[] = [];
    const stop = server!.host.plane.store.events.subscribe(GLOBAL_STREAM, (e) => {
      if (e.type === "knowledge.changed") seen.push(JSON.parse(e.data).pageId);
    });
    const page = k().create({ parentId: null, title: "Plan" }, USER);
    k().replace(page.id, { body: "Run" }, page.revision, USER);
    expect(() => k().replace(page.id, { body: "Stale" }, page.revision, USER)).toThrow();
    k().trashPage(page.id, USER);
    stop();
    expect(seen).toEqual([page.id, page.id, page.id]);
  });

  it("purges Trash after 30 days", async () => {
    await start();
    const page = k().create({ parentId: null, title: "Old" }, USER);
    k().trashPage(page.id, USER);
    server!.clock.advance(29 * 86_400_000);
    expect(k().purgeExpired()).toBe(0);
    server!.clock.advance(2 * 86_400_000);
    expect(k().purgeExpired()).toBe(1);
  });

  it("searches CJK text with single characters and bigrams, scoped to a subtree", async () => {
    await start();
    const a = k().create({ parentId: null, title: "旅行", body: "## 東京\n淺草寺和晴空塔" }, USER);
    const b = k().create({ parentId: null, title: "Work", body: "東京 office notes" }, USER);
    expect(k().search("晴空塔")[0]).toMatchObject({ pageId: a.id, section: "東京" });
    expect(
      new Set(
        k()
          .search("東")
          .map((h) => h.pageId),
      ),
    ).toEqual(new Set([a.id, b.id]));
    expect(
      k()
        .search("東京", { under: b.id })
        .map((h) => h.pageId),
    ).toEqual([b.id]);
  });

  it("validates page and file links and tracks backlinks", async () => {
    await start();
    const target = k().create({ parentId: null, title: "Target" }, USER);
    expect(() => k().create({ parentId: null, title: "Bad", body: "[x](page:pg_missing)" }, USER)).toThrow(
      /names no page/,
    );
    expect(() => k().create({ parentId: null, title: "Bad", body: "![x](file:fil_missing)" }, USER)).toThrow(
      /publish_files first/,
    );
    const from = k().create({ parentId: null, title: "From", body: `See [it](page:${target.id})` }, USER);
    expect(
      k()
        .backlinks(target.id)
        .map((p) => p.id),
    ).toEqual([from.id]);
    expect(() => k().create({ parentId: null, title: "Huge", body: "x".repeat(300 * 1024) }, USER)).toThrow(/256 KB/);
  });

  it("builds a pointer with top-level pages and recently updated pages at any depth", async () => {
    await start();
    k().ensureInbox();
    const personal = k().create({ parentId: null, title: "Personal", description: "health and home" }, USER);
    const fitness = k().create({ parentId: personal.id, title: "Fitness" }, USER);
    const plan = k().create({ parentId: fitness.id, title: "Training plan" }, { actor: agentId() });
    k().setFlags(personal.id, { pinned: true });
    const text = k().pointer(server!.clock.now());
    expect(text).toContain(`Personal (${personal.id}) — health and home`);
    expect(text).toContain(`Personal › Fitness › Training plan (${plan.id})`);
    expect(text).toContain("📌 Personal");
    const overview = k().overview(server!.clock.now());
    expect(overview.pinned.map((p) => p.id)).toEqual([personal.id]);
    expect(overview.week.find((w) => w.actor.kind === "agent")).toMatchObject({ created: 1 });
  });
});

describe("Knowledge tools", () => {
  it("lets an agent create, read by section, edit and search through compact tool output", async () => {
    await start();
    const inbox = k().ensureInbox();
    const id = await chat(server!);
    await talk(
      id,
      tool("knowledge_write", {
        action: "create",
        parentId: inbox.id,
        title: "Training plan",
        description: "Weekly running plan",
        body: "## Goals\nRun a 10k\n\n## Week 1\n- [ ] Easy 5k",
      }),
    );
    expect(lastPayload(id)).toContain("Created Inbox › Training plan");
    const page = k().children(inbox.id)[0]!;
    expect(lastPayload(id)).toContain(`Link: [Training plan](page:${page.id})`);
    expect(page.created_by).toBe(agentId());
    await talk(id, tool("knowledge_read", { pageId: page.id, section: "Week 1" }));
    const read = lastPayload(id);
    expect(read).toContain("revision 1");
    expect(read).toContain("Outline: §1 Goals");
    expect(read).toContain("- [ ] Easy 5k");
    await talk(
      id,
      tool("knowledge_write", {
        action: "edit",
        pageId: page.id,
        baseRevision: 1,
        ops: [
          { op: "set_task", task: "easy 5k", done: true },
          { op: "append_to_section", section: "Goals", text: "Sub-50 minutes" },
        ],
      }),
    );
    expect(lastPayload(id)).toContain("revision 2");
    await talk(id, tool("knowledge_search", { query: "10k" }));
    expect(lastPayload(id)).toContain(`Inbox › Training plan (${page.id})`);
    await talk(id, tool("knowledge_browse", {}));
    expect(lastPayload(id)).toContain(`Inbox (${inbox.id})`);
    // A second create with a near-identical title gets a hint against duplicates.
    await talk(id, tool("knowledge_write", { action: "create", parentId: "top", title: "Training plan" }));
    expect(lastPayload(id)).toContain("Similar pages already exist");
    // The pointer rides along in the prompt.
    expect(lastPayload(id)).toContain("Pinned and recently updated:");
  });

  it("shows section slugs, reads by #slug, and reports section links a write leaves pointing nowhere", async () => {
    await start();
    const target = k().create(
      {
        parentId: null,
        title: "Guide",
        body: "## Setup\nInstall\n\n## 第二週 進度\n進度\n\n## Notes\na\n\n## Notes\nb",
      },
      USER,
    );
    const linker = k().create(
      {
        parentId: null,
        title: "Index",
        body: `[setup](page:${target.id}#setup) · [進度](page:${target.id}#第二週-進度) · [b](page:${target.id}#notes-1)`,
      },
      USER,
    );
    // Backlinks still list the page once; the anchors ride beside the plain link.
    expect(
      k()
        .backlinks(target.id)
        .map((p) => p.id),
    ).toEqual([linker.id]);
    const id = await chat(server!);
    await talk(id, tool("knowledge_read", { pageId: target.id, section: "#notes-1" }));
    const read = lastPayload(id);
    expect(read).toContain("§1 Setup #setup");
    expect(read).toContain("§2 第二週 進度 #第二週-進度");
    expect(read).toContain("§4 Notes #notes-1");
    // The payload is JSON, so the newline is escaped.
    expect(read).toContain("## Notes\\nb");
    await talk(
      id,
      tool("knowledge_write", {
        action: "edit",
        pageId: target.id,
        baseRevision: 1,
        ops: [{ op: "replace_text", old: "## 第二週 進度", new: "## 第三週" }],
      }),
    );
    // The payload is the whole model request; look at the last tool answer only.
    const saved = lastPayload(id).slice(lastPayload(id).lastIndexOf("Saved Guide"));
    expect(saved).toContain("Saved Guide");
    expect(saved).toContain(`Section links that now point nowhere`);
    expect(saved).toContain(`Index (${linker.id}) → #第二週-進度`);
    expect(/Section links that now point nowhere[^"]*/.exec(saved)![0]).not.toContain("#setup");
    // A link to a section that does not exist is saved, and named.
    await talk(
      id,
      tool("knowledge_write", {
        action: "create",
        parentId: "top",
        title: "Pointer",
        body: `[gone](page:${target.id}#nope) [ok](page:${target.id}#setup)`,
      }),
    );
    const created = lastPayload(id).slice(lastPayload(id).lastIndexOf("Created Pointer"));
    expect(created).toContain("Created Pointer");
    expect(created).toContain(`page:${target.id}#nope`);
    expect(/These links name a section[^"]*/.exec(created)![0]).not.toContain("#setup");
  });

  it("returns a stale edit as a conflict with the section's current text, and requires an explicit parent", async () => {
    await start();
    const page = k().create({ parentId: null, title: "Shared", body: "## Status\nGreen" }, USER);
    k().edit(page.id, [{ op: "replace_section", section: "Status", text: "Amber" }], USER, 1);
    const id = await chat(server!);
    await talk(
      id,
      tool("knowledge_write", {
        action: "edit",
        pageId: page.id,
        baseRevision: 1,
        ops: [{ op: "replace_section", section: "Status", text: "Red" }],
      }),
    );
    const payload = lastPayload(id);
    expect(payload).toContain("now revision 2");
    expect(payload).toContain("Amber");
    expect(payload).toContain("Retry with baseRevision: 2");
    await talk(id, tool("knowledge_write", { action: "create", title: "Loose" }));
    expect(lastPayload(id)).toContain("create needs parentId");
  });
});

describe("Knowledge meaning search", () => {
  const meaningStart = async (fake = new FakeEmbedder()) => {
    server = await startSignedIn(withEmbedder(fake, { memory: { knowledgeCosineFloor: FAKE_KNOWLEDGE_COSINE_FLOOR } }));
    return fake;
  };
  const meaning = () => k().meaning!;
  const vectors = (pageId: string) =>
    server!.host.plane.store.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM knowledge_vectors WHERE page_id = ?",
      pageId,
    )!.n;

  it("finds a page that shares no word with the query, and says it matched by meaning", async () => {
    await meaningStart();
    const car = k().create(
      { parentId: null, title: "Car insurance renewal", body: "## Policy\nRenews in March with Acme." },
      USER,
    );
    k().create({ parentId: null, title: "Recipes", body: "## Soup\nLentils and onions." }, USER);
    await meaning().settle();
    // Inbox's title, plus each page's title row and its one section.
    expect(meaning().status()).toMatchObject({ state: "ready", sections: 5, embedded: 5 });
    // Keyword search alone has nothing for this paraphrase.
    expect(k().search("automobile")).toEqual([]);
    const hits = await k().find("automobile");
    expect(hits[0]).toMatchObject({ pageId: car.id, matched: ["meaning"] });
    // A short section's snippet starts at its heading, without the Markdown marker.
    expect((await k().find("lentils"))[0]?.snippet).toBe("Soup Lentils and onions.");
    // Shared words and meaning together.
    expect((await k().find("car renewal"))[0]).toMatchObject({ pageId: car.id, matched: ["keyword", "meaning"] });
    // The agent's tool and the search box use the same fused ranking.
    const res = await server!.client.get("/api/knowledge/search?q=automobile");
    expect(res.body.hits[0]).toMatchObject({ pageId: car.id, matched: ["meaning"] });
  });

  it("drops a meaning hit far below the best one, but keeps one that shares a word with the query", async () => {
    await start();
    const best = k().create({ parentId: null, title: "Best", body: "alpha" }, USER);
    const near = k().create({ parentId: null, title: "Near", body: "beta" }, USER);
    const far = k().create({ parentId: null, title: "Far", body: "gamma" }, USER);
    const word = k().create({ parentId: null, title: "Word", body: "delta quartz" }, USER);
    // Cosine with the query (1, 0): 0.9 for Best, 0.85 for Near, 0.75 for Far and Word, 0.2 for anything else.
    const vectorOf = (t: string) =>
      t.includes("Best")
        ? [0.9, 0.436]
        : t.includes("Near")
          ? [0.85, 0.527]
          : t.includes("Far") || t.includes("Word")
            ? [0.75, 0.661]
            : [0.2, 0.98];
    const search = async (band: number | undefined) => {
      const meaning = new KnowledgeMeaning({
        knowledge: k(),
        log: nullLogger,
        fusion: { ...KNOWLEDGE_FUSION, cosineFloor: 0.7 },
        ...(band === undefined ? {} : { band }),
        model: () => ({
          key: "band",
          embedDocuments: async (texts) => texts.map((t) => Float32Array.from(vectorOf(t))),
          embedQuery: async () => Float32Array.from([1, 0]),
        }),
      });
      await meaning.settle();
      const hits = await meaning.search("alpha quartz");
      meaning.stop();
      return hits;
    };
    // The default band is 0.1 under the best hit: Far (0.15 under) goes, Near stays, Word stays through its keyword.
    const hits = await search(undefined);
    expect(hits.map((h) => h.pageId).sort()).toEqual([best.id, near.id, word.id].sort());
    expect(hits.find((h) => h.pageId === word.id)?.matched).toContain("keyword");
    // With the band off, every page above the floor is there.
    expect((await search(1)).map((h) => h.pageId)).toContain(far.id);
    // No hit reaches the floor: nothing comes back from meaning, however close the best is to it.
    const none = new KnowledgeMeaning({
      knowledge: k(),
      log: nullLogger,
      model: () => ({
        key: "floor",
        embedDocuments: async (texts) => texts.map(() => Float32Array.from([0.6, 0.8])),
        embedQuery: async () => Float32Array.from([1, 0]),
      }),
    });
    await none.settle();
    expect(await none.search("nonsense")).toEqual([]);
    none.stop();
  });

  it("re-embeds only the sections an edit changed, and drops a trashed page's vectors with it", async () => {
    const fake = await meaningStart();
    const page = k().create(
      { parentId: null, title: "Doctor visits", body: "## Spring\nBlood test.\n\n## Autumn\nFlu shot." },
      USER,
    );
    await meaning().settle();
    expect(vectors(page.id)).toBe(3);
    const before = fake.embedded;
    k().edit(page.id, [{ op: "replace_section", section: "Autumn", text: "Flu shot and checkup." }], USER, 1);
    await meaning().settle();
    expect(fake.embedded - before).toBe(1);
    expect(vectors(page.id)).toBe(3);
    expect((await k().find("physician"))[0]?.pageId).toBe(page.id);
    k().trashPage(page.id, USER);
    expect(vectors(page.id)).toBe(0);
    expect(await k().find("physician")).toEqual([]);
    k().restorePage(page.id);
    await meaning().settle();
    expect(vectors(page.id)).toBe(3);
    expect((await k().find("physician"))[0]?.pageId).toBe(page.id);
  });

  it("falls back to keyword search while the model is down, and catches up when it answers again", async () => {
    const fake = new FakeEmbedder();
    fake.down = true;
    await meaningStart(fake);
    k().create({ parentId: null, title: "Car insurance renewal", body: "Renews in March." }, USER);
    await meaning().settle();
    expect(meaning().status()).toMatchObject({ state: "down", sections: 3, embedded: 0 });
    expect(meaning().status().lastError).toBeTruthy();
    expect(await k().find("automobile")).toEqual([]);
    expect((await k().find("renewal"))[0]).toMatchObject({ matched: ["keyword"] });
    fake.down = false;
    await vi.waitFor(() => expect(meaning().status().state).toBe("ready"), { timeout: 2_000 });
    expect((await k().find("automobile"))[0]?.title).toBe("Car insurance renewal");
    // Every section has its vector, but a search whose question cannot be embedded says the model is down.
    fake.down = true;
    expect((await k().find("renewal"))[0]).toMatchObject({ matched: ["keyword"] });
    expect(meaning().status()).toMatchObject({ state: "down", embedded: 3 });
    expect(meaning().status().lastError).toBeTruthy();
    fake.down = false;
    expect((await k().find("automobile"))[0]?.title).toBe("Car insurance renewal");
    expect(meaning().status()).toMatchObject({ state: "ready", lastError: null });
  });

  it("never compares a query with another model's vectors, and is off when meaning search is", async () => {
    await meaningStart();
    const page = k().create({ parentId: null, title: "Car insurance renewal" }, USER);
    await meaning().settle();
    const db = server!.host.plane.store.db;
    db.run("UPDATE knowledge_vectors SET model_key = 'another model'");
    k().edit(page.id, [{ op: "set_description", description: "Yearly" }], USER, 1);
    await meaning().settle();
    expect(db.get("SELECT COUNT(*) AS n FROM knowledge_vectors WHERE model_key = 'another model'")).toEqual({ n: 0 });
    expect(meaning().status().state).toBe("ready");
    await server!.host.plane.memory.history.configureEnabled(false);
    expect(meaning().status().state).toBe("off");
    expect(await k().find("automobile")).toEqual([]);
    expect((await k().find("renewal"))[0]).toMatchObject({ matched: ["keyword"] });
    expect(k().overview(server!.clock.now()).meaning.state).toBe("off");
  });

  it("does not keep a vector for text that changed while the model was embedding it", async () => {
    await meaningStart();
    meaning().stop();
    const page = k().create({ parentId: null, title: "Draft", body: "## Notes\nFirst words." }, USER);
    const real = server!.host.plane.memory.history.semanticModel()!;
    let raced = false;
    const racing = new KnowledgeMeaning({
      knowledge: k(),
      log: nullLogger,
      model: () => ({
        ...real,
        embedDocuments: async (texts) => {
          const out = await real.embedDocuments(texts);
          if (!raced) {
            raced = true;
            k().edit(page.id, [{ op: "replace_section", section: "Notes", text: "Second words." }], USER, 1);
          }
          return out;
        },
      }),
    });
    await racing.settle();
    const db = server!.host.plane.store.db;
    const stored = db.all<{ hash: string }>("SELECT hash FROM knowledge_vectors WHERE page_id = ?", page.id);
    const live = k()
      .indexedSections([page.id])
      .map((x) => x.key);
    expect(stored.map((r) => r.hash).sort()).toEqual([...live].sort());
    expect(racing.status()).toMatchObject({ state: "ready", embedded: racing.status().sections });
  });

  it("leaves out pages whose meaning is only as close as unrelated text is with a real model", async () => {
    await meaningStart();
    meaning().stop();
    const page = k().create({ parentId: null, title: "Car insurance renewal", body: "Renews in March." }, USER);
    // The car page's sections point one way and every other page's another; questions sit at the cosines EmbeddingGemma
    // gave related (0.8) and unrelated (0.5) ones with the car page.
    const angled = (cosine: number) => Float32Array.from([cosine, Math.sqrt(1 - cosine * cosine), 0]);
    const scaled = new KnowledgeMeaning({
      knowledge: k(),
      log: nullLogger,
      model: () => ({
        key: "two-dimensional",
        embedDocuments: async (texts) =>
          texts.map((t) => (t.includes("Car") ? angled(1) : Float32Array.from([0, 0, 1]))),
        embedQuery: async (text) => angled(text === "unrelated" ? 0.5 : 0.8),
      }),
    });
    await scaled.settle();
    expect(KNOWLEDGE_FUSION.cosineFloor).toBeGreaterThan(0.5);
    expect(await scaled.search("unrelated")).toEqual([]);
    expect((await scaled.search("related"))[0]).toMatchObject({ pageId: page.id, matched: ["meaning"] });
  });

  it("marks meaning-only hits in the agent's search results", async () => {
    await meaningStart();
    const page = k().create({ parentId: null, title: "Car insurance renewal", body: "Renews in March." }, USER);
    await meaning().settle();
    const id = await chat(server!);
    await talk(id, tool("knowledge_search", { query: "automobile" }));
    expect(lastPayload(id)).toContain(`Car insurance renewal (${page.id})`);
    expect(lastPayload(id)).toContain("(by meaning)");
  });
});

describe("Knowledge in chats", () => {
  it("links knowledge tool steps to the page they touched, with its current title", async () => {
    await start();
    const page = k().create({ parentId: null, title: "Shared", body: "## Status\nGreen" }, USER);
    const id = await chat(server!);
    await talk(id, tool("knowledge_write", { action: "edit", pageId: page.id, ops: [{ op: "append", text: "More" }] }));
    await talk(id, tool("knowledge_write", { action: "create", parentId: "top", title: "Fresh" }));
    await talk(id, tool("knowledge_read", { pageId: page.id }));
    k().replace(page.id, { title: "Shared notes" }, k().live(page.id).revision, USER);
    const trace = (await server!.client.get(`/api/sessions/${id}/trace`)).body as {
      runs: { steps: { toolName?: string; page?: { id: string; title: string; trashed: boolean } }[] }[];
    };
    const steps = trace.runs.flatMap((r) => r.steps).filter((s) => s.toolName?.startsWith("knowledge_"));
    const fresh = k()
      .children(null)
      .find((p) => p.title === "Fresh")!;
    expect(steps.map((s) => s.page)).toEqual(
      expect.arrayContaining([
        { id: page.id, title: "Shared notes", trashed: false },
        { id: fresh.id, title: "Fresh", trashed: false },
      ]),
    );
    expect(steps.filter((s) => s.page?.id === page.id)).toHaveLength(2);
  });

  it("lets a message mention a page by id only, and refuses a page in Trash", async () => {
    await start();
    const page = k().create({ parentId: null, title: "Recipes", body: "Bread: 500g flour" }, USER);
    const id = await chat(server!);
    const send = (pageId: string) =>
      server!.client.call("POST", `/api/sessions/${id}/messages`, {
        body: {
          requestId: crypto.randomUUID(),
          text: "@Recipes how much flour?",
          mentions: [{ kind: "page", id: pageId, label: "Recipes", start: 0, end: 8 }],
        },
      });
    const before = (await detail(server!, id)).runs.length;
    expect((await send(page.id)).status).toBe(200);
    await settled(server!, id, before + 1);
    const payload = lastPayload(id);
    expect(payload).toContain(`Referenced Knowledge page \\"Recipes\\" (page ID \\"${page.id}\\")`);
    expect(payload).not.toMatch(/revision 1/);
    k().trashPage(page.id, USER);
    const refused = await send(page.id);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("bad_mention");
  });
});

describe("Knowledge HTTP", () => {
  it("serves the tree, a page, the editor's save with conflicts, ticks, pins, trash and markdown export", async () => {
    await start();
    const c = server!.client;
    const created = await c.post("/api/knowledge/pages", { parentId: null, title: "Recipes", body: "- [ ] Buy flour" });
    expect(created.status).toBe(201);
    const id = created.body.page.id as string;
    expect((await c.get("/api/knowledge/tree")).body.pages.map((p: { title: string }) => p.title)).toContain("Recipes");
    const saved = await c.call("PUT", `/api/knowledge/pages/${id}`, {
      body: { baseRevision: 1, body: "- [ ] Buy flour\n- [ ] Bake" },
    });
    expect(saved.body.page.revision).toBe(2);
    const stale = await c.call("PUT", `/api/knowledge/pages/${id}`, { body: { baseRevision: 1, body: "lost" } });
    expect(stale.status).toBe(409);
    expect(stale.body.current).toContain("Bake");
    const ticked = await c.call("PATCH", `/api/knowledge/pages/${id}`, {
      body: { task: { index: 1, done: true }, pinned: true },
    });
    expect(ticked.body.body).toContain("- [x] Bake");
    expect(ticked.body.page.pinned).toBe(true);
    const md = await c.raw("GET", `/api/knowledge/pages/${id}/markdown`);
    expect(await md.text()).toContain("---\ntitle: Recipes\ntags: []\n---\n");
    expect((await c.post(`/api/knowledge/pages/${id}/trash`)).body).toEqual({ trashed: 1 });
    expect((await c.call("DELETE", `/api/knowledge/pages/${id}`, { body: {} })).status).toBe(400);
    expect((await c.call("DELETE", `/api/knowledge/pages/${id}`, { body: { confirm: true } })).body).toEqual({
      deleted: 1,
    });
    expect((await c.get("/api/knowledge/overview")).body.inbox.count).toBe(0);
  });
});

describe("Knowledge frontmatter and tags", () => {
  it("round-trips source, validates atomically, and snapshots/restores normalized tags with the body", async () => {
    await start();
    const c = server!.client;
    const sourceMarkdown =
      '---\ntitle: "true"\ndescription: A page\ntags: ["Ｒｅｉ", rei, "知識", "one   two"]\n---\n## Body\nKeep [self](https://example.com)\n';
    const created = await c.post("/api/knowledge/pages", { parentId: null, sourceMarkdown });
    expect(created.status).toBe(201);
    const id = created.body.page.id as string;
    expect(created.body.page.metadata).toEqual({ tags: ["Ｒｅｉ", "知識", "one two"] });
    expect(created.body.body).toBe("## Body\nKeep [self](https://example.com)\n");
    const exported = await (await c.raw("GET", `/api/knowledge/pages/${id}/markdown`)).text();
    const copy = await c.post("/api/knowledge/pages", { sourceMarkdown: exported });
    expect(copy.body.page.metadata).toEqual(created.body.page.metadata);
    expect(copy.body.body).toBe(created.body.body);
    const empty = await c.post("/api/knowledge/pages", { title: "Empty metadata", metadata: {} });
    expect(empty.status).toBe(201);
    expect(empty.body.page.metadata).toEqual({ tags: [] });
    const whitespace = "\n\nBody with blank lines\n";
    const whitespaceSaved = await c.call("PUT", `/api/knowledge/pages/${empty.body.page.id}`, {
      body: { baseRevision: 1, sourceMarkdown: `---\ntitle: Whitespace\n---\n${whitespace}` },
    });
    expect(whitespaceSaved.status).toBe(200);
    expect(whitespaceSaved.body.body).toBe(whitespace);
    const cleared = await c.call("PUT", `/api/knowledge/pages/${empty.body.page.id}`, {
      body: { baseRevision: 2, sourceMarkdown: "---\ntitle: Whitespace\n---\n\n" },
    });
    expect(cleared.body.body).toBe("\n");
    const before = k().detail(id);
    for (const header of [
      "title: X\ntitle: Y",
      "title: X\nstatus: curated",
      "title: X\ntags: [true]",
      "title: X\ntags: &x [hi]",
      "title: X\ntags: [!custom hi]",
    ]) {
      const failed = await c.call("PUT", `/api/knowledge/pages/${id}`, {
        body: { baseRevision: 1, sourceMarkdown: `---\n${header}\n---\nLost` },
      });
      expect(failed.status).toBe(400);
      expect(failed.body.error.message).toMatch(/line/);
      expect(failed.body.error.issues[0].line).toBeGreaterThan(0);
      expect(failed.body.error.issues[0].column).toBeGreaterThan(0);
      expect(k().detail(id)).toEqual(before);
    }
    expect(
      (
        await c.call("PUT", `/api/knowledge/pages/${id}`, {
          body: { baseRevision: 1, sourceMarkdown: exported, body: "mixed" },
        })
      ).status,
    ).toBe(400);
    const saved = await c.call("PUT", `/api/knowledge/pages/${id}`, {
      body: { baseRevision: 1, sourceMarkdown: "---\ntitle: New\n---\nNew body" },
    });
    expect(saved.body.page.metadata).toEqual({ tags: [] });
    expect(saved.body.page.description).toBe("");
    const restored = k().restoreRevision(id, 1, 2, USER);
    expect(restored.body).toBe(created.body.body);
    expect(k().toPage(restored).metadata).toEqual(created.body.page.metadata);
    expect(k().revisionDetail(id, 1).metadata).toEqual(created.body.page.metadata);
  });

  it("requires revision checks for agent tag mutations, retains literal body YAML, and respects locks", async () => {
    await start();
    const w = { actor: agentId(), sessionId: "tag-session" };
    const page = k().create({ parentId: null, title: "Tags", metadata: { tags: ["Rei"] } }, w);
    expect(() => k().edit(page.id, [{ op: "add_tags", tags: ["new"] }], w)).toThrow(/baseRevision/);
    k().edit(page.id, [{ op: "add_tags", tags: ["rei", "知識"] }], w, 1);
    k().edit(page.id, [{ op: "remove_tags", tags: ["ＲＥＩ"] }], w, 2);
    expect(k().detail(page.id).page.metadata.tags).toEqual(["知識"]);
    expect(
      k()
        .revisions(page.id)
        .map((r) => r.revision),
    ).toEqual([3, 1]);
    expect(() => k().edit(page.id, [{ op: "set_metadata", metadata: { tags: [] } }], w, 2)).toThrow(/changed/);
    k().setFlags(page.id, { locked: true });
    expect(() => k().edit(page.id, [{ op: "add_tags", tags: ["new"] }], w, 3)).toThrow(/locked/);
    k().edit(page.id, [{ op: "append", text: "---\ntags: [literal]\n---" }], w);
    expect(k().detail(page.id).page.metadata.tags).toEqual(["知識"]);
    expect(k().live(page.id).body).toContain("tags: [literal]");
    expect(k().live(page.id).taint).toContain("private");
  });

  it("finds tags and subtree matches beyond the old candidate cap, and derives suggestions only from live pages", async () => {
    await start();
    const root = k().create({ parentId: null, title: "Root" }, USER);
    k().create(
      {
        parentId: null,
        title: "Distractor",
        body: Array.from({ length: 410 }, (_, i) => `## Heading ${i}\nneedle`).join("\n\n"),
      },
      USER,
    );
    const target = k().create(
      { parentId: root.id, title: "Target", body: "needle", metadata: { tags: ["Ｒｅｉ", "知識"] } },
      USER,
    );
    expect(
      k()
        .search("needle", { under: root.id, tags: ["rei", "知識"] })
        .map((h) => h.pageId),
    ).toEqual([target.id]);
    expect(
      k()
        .search("", { tags: ["REI"] })
        .map((h) => h.pageId),
    ).toEqual([target.id]);
    expect(k().search("", { tags: ["rei", "missing"] })).toEqual([]);
    expect(
      k()
        .search("知識")
        .find((h) => h.pageId === target.id)?.snippet,
    ).not.toContain("tags:");
    expect(k().tagSuggestions()).toContain("知識");
    k().trashPage(target.id, USER);
    expect(k().tagSuggestions()).not.toContain("知識");
    expect(k().search("", { tags: ["rei"] })).toEqual([]);
    k().restorePage(target.id);
    expect(k().tagSuggestions()).toContain("知識");
    k().trashPage(target.id, USER);
    k().purge(target.id);
    expect(k().tagSuggestions()).not.toContain("知識");
  });
});

describe("Knowledge retrieval and agent metadata regression", () => {
  it("filters semantic candidates before limits and keeps metadata out of embedding inputs", async () => {
    await start();
    const root = k().create({ parentId: null, title: "Root" }, USER);
    const distractor = k().create(
      {
        parentId: null,
        title: "Distractor",
        body: Array.from({ length: 210 }, (_, i) => `## Section ${i}\nCloser match ${i}`).join("\n\n"),
      },
      USER,
    );
    const target = k().create(
      { parentId: root.id, title: "Target", body: "Relevant", metadata: { tags: ["special-label"] } },
      USER,
    );
    const inputs: string[] = [];
    const meaning = new KnowledgeMeaning({
      knowledge: k(),
      log: nullLogger,
      band: 1, // this is about crowding, not relevance: the target scores 0.2 under the distractor on purpose
      model: () => ({
        key: "filtered-regression",
        embedDocuments: async (texts) => {
          inputs.push(...texts);
          return texts.map((t) => Float32Array.from(t.includes("Target") ? [0.8, 0.6] : [1, 0]));
        },
        embedQuery: async () => Float32Array.from([1, 0]),
      }),
    });
    await meaning.settle();
    expect(inputs.join("\n")).not.toContain("special-label");
    expect(
      (await meaning.search("paraphrase", { under: root.id, tags: ["SPECIAL-LABEL"] })).map((h) => h.pageId),
    ).toEqual([target.id]);
    // Even without a filter, one page's many closer sections must not crowd every other page out.
    expect((await meaning.search("paraphrase")).map((h) => h.pageId)).toContain(target.id);
    expect((await meaning.search("paraphrase"))[0]?.pageId).not.toBeUndefined();
    k().trashPage(distractor.id, USER);
    expect((await meaning.search("paraphrase", { tags: ["special-label"] })).map((h) => h.pageId)).toEqual([target.id]);
    meaning.stop();
  });

  it("lets agents author source, mutate tags, read properties and browse with tag-only queries", async () => {
    await start();
    const id = await chat(server!);
    await talk(
      id,
      tool("knowledge_write", {
        action: "create",
        parentId: "top",
        sourceMarkdown: "---\ntitle: Tagged source\ntags: [Rei]\n---\nBody",
      }),
    );
    expect(lastPayload(id)).toContain("Created Tagged source");
    const page = k()
      .children(null)
      .find((p) => p.title === "Tagged source")!;
    await talk(
      id,
      tool("knowledge_write", {
        action: "edit",
        pageId: page.id,
        baseRevision: 1,
        ops: [{ op: "add_tags", tags: ["知識"] }],
      }),
    );
    expect(lastPayload(id)).toContain("revision 2");
    await talk(id, tool("knowledge_read", { pageId: page.id }));
    expect(lastPayload(id)).toContain("Tags: Rei, 知識");
    await talk(id, tool("knowledge_search", { tags: ["rei", "知識"] }));
    expect(lastPayload(id)).toContain(`Tagged source (${page.id})`);
    const payload = JSON.parse(lastPayload(id)) as {
      messages: { role: string; toolName?: string; content?: unknown }[];
    };
    const result = payload.messages.filter((m) => m.role === "toolResult" && m.toolName === "knowledge_search").at(-1);
    expect(JSON.stringify(result?.content)).not.toContain("(by meaning)");
    await talk(
      id,
      tool("knowledge_write", { action: "edit", pageId: page.id, baseRevision: 2, metadata: { tags: ["new"] } }),
    );
    expect(k().detail(page.id).page.metadata.tags).toEqual(["new"]);
  });
});
