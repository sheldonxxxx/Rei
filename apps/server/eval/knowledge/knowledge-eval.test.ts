// The Knowledge eval (Phase 2): how well an agent finds and keeps pages in a realistic workspace, with the real service,
// the real indexes and the real tools driven by the simulated model ("faux plumbing"). No real model: meaning search
// runs on the fake embedder (a bag of words in which listed synonyms share a dimension), so it runs in the normal suite.
// It seeds the hand-written pages in fixture.json (English, Chinese and mixed) among generated distractors (weekly
// reviews, meeting notes, reading notes: more than 200 pages in all) and checks:
//
// - search quality per category, keyword alone and fused with meaning: recall@5 and MRR@10, plus how often a question
//   with no answer still returns something. The "meaning" questions share no word with their page, so only the meaning
//   side can answer them; with the fake embedder that measures the plumbing (index, fusion, checks), not a model;
// - stale pages: an updated page is found by its new text, not its old text, and the old text stays in its history;
// - misfiled pages: found by an unscoped search, missing from a search scoped where they should have been;
// - high fan-out: browsing a parent with 52 children pages instead of flooding the context; the prompt pointer stays
//   inside its budget at this size;
// - token efficiency of the tools' answers.
//
// REI_EVAL_OUT=/path.json writes the metrics. RESULTS.md records a run; the assertions are floors just under it, so a
// change that makes finding pages worse fails here.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/memory/text.ts";
import { tool } from "../../test/helpers/approvals.ts";
import { FAKE_KNOWLEDGE_COSINE_FLOOR, FakeEmbedder, withEmbedder } from "../../test/helpers/fake-embedder.ts";
import { startSignedIn, type TestServer } from "../../test/helpers/server.ts";
import { chat, detail, say, settled, stepPayloads } from "../../test/helpers/sessions.ts";

interface FixturePage {
  key: string;
  parent?: string;
  title: string;
  description?: string;
  body?: string;
}
interface Question {
  id: string;
  cat: string;
  lang: string;
  q: string;
  gold: string[];
}
const fixture = (await import(join(import.meta.dirname, "fixture.json"), { with: { type: "json" } })).default as {
  pages: FixturePage[];
  updates: { key: string; body: string }[];
  questions: Question[];
};

let server: (TestServer & { totpSecret: string }) | undefined;
const k = () => server!.host.plane.knowledge;
const USER = { actor: "user" } as const;
const ids = new Map<string, string>();
let totalPages = 0;

const TOPICS = ["budget", "hiring", "roadmap", "offsite", "vendor review", "security audit", "pricing", "support rota"];
const BOOKS = [
  "Thinking in Systems",
  "The Pragmatic Programmer",
  "Deep Work",
  "人類大歷史",
  "Atomic Habits",
  "The Design of Everyday Things",
  "被討厭的勇氣",
  "Designing Data-Intensive Applications",
  "Project Hail Mary",
  "The Mom Test",
];

/**
 * What the fake embedder treats as the same meaning, for the "meaning" questions: stand-ins for what a real multilingual
 * model knows (car, automobile, sedan and 汽車 are built in or added here).
 */
const SYNONYMS: Record<string, string> = {
  汽車: "vehicle",
  physiotherapist: "physio",
  physiotherapy: "physio",
  pager: "paged",
};

beforeAll(async () => {
  server = await startSignedIn(
    withEmbedder(new FakeEmbedder(SYNONYMS), { memory: { knowledgeCosineFloor: FAKE_KNOWLEDGE_COSINE_FLOOR } }),
  );
  const agent = server.host.plane.store.listAgents()[0]!.id;
  const writer = { actor: agent, sessionId: "eval" };
  k().ensureInbox();
  for (const p of fixture.pages) {
    server.clock.advance(60_000);
    const page = k().create(
      {
        parentId: p.parent ? ids.get(p.parent)! : null,
        title: p.title,
        ...(p.description ? { description: p.description } : {}),
        ...(p.body ? { body: p.body } : {}),
      },
      writer,
    );
    ids.set(p.key, page.id);
  }
  // Distractors share the fixture's vocabulary (run, plan, review, release, insurance, project) on purpose.
  const reviews = k().create({ parentId: null, title: "Weekly reviews", description: "One page per week" }, USER);
  for (let w = 1; w <= 52; w++) {
    server.clock.advance(1_000);
    k().create(
      {
        parentId: reviews.id,
        title: `Week ${w} review`,
        body: `## Wins\n- Ran ${10 + (w % 15)} km in total\n- Moved the project plan forward\n\n## Next week\n- [ ] Review the release notes\n- [ ] Plan ${TOPICS[w % TOPICS.length]} follow-ups`,
      },
      writer,
    );
  }
  const meetings = k().create({ parentId: null, title: "Meeting notes", description: "Notes per meeting" }, USER);
  for (let m = 1; m <= 60; m++) {
    server.clock.advance(1_000);
    const topic = TOPICS[m % TOPICS.length]!;
    k().create(
      {
        parentId: meetings.id,
        title: `2026-${String((m % 12) + 1).padStart(2, "0")}-${String((m % 27) + 1).padStart(2, "0")} ${topic}`,
        body: `Attendees: Priya, Tom, Marco.\n\n## Notes\nDiscussed the ${topic} and the next release. Insurance for the offsite is still open.\n\n## Actions\n- [ ] Tom to draft the ${topic} proposal\n- [ ] Marco to update the test plan`,
      },
      writer,
    );
  }
  const reading = k().create({ parentId: null, title: "Reading notes", description: "Books and articles" }, USER);
  for (let r = 1; r <= 60; r++) {
    server.clock.advance(1_000);
    const book = BOOKS[r % BOOKS.length]!;
    k().create(
      {
        parentId: reading.id,
        title: `${book} — part ${Math.ceil(r / BOOKS.length)}`,
        body: `## 重點 Key ideas\nChapter notes on ${book}. Habits, systems and feedback loops; keep a weekly review.\n\n## Quotes\n> Small changes compound.`,
      },
      writer,
    );
  }
  for (const u of fixture.updates) {
    server.clock.advance(60_000);
    const page = k().live(ids.get(u.key)!);
    k().replace(page.id, { body: u.body }, page.revision, USER);
  }
  totalPages = k().tree().length;
  await k().meaning!.settle();
}, 120_000);
afterAll(async () => {
  await server?.destroy();
});

interface Row {
  cat: string;
  n: number;
  recall5: number;
  mrr10: number;
}

describe("Knowledge eval", () => {
  it("seeds more than 200 pages", () => {
    expect(totalPages).toBeGreaterThan(200);
  });

  const evaluate = async (search: (q: string) => Promise<string[]>) => {
    const perCat = new Map<string, { n: number; recall: number; rr: number }>();
    let noAnswer = 0;
    let noAnswerReturned = 0;
    const misses: string[] = [];
    for (const q of fixture.questions) {
      const hits = await search(q.q);
      if (q.gold.length === 0) {
        noAnswer++;
        if (hits.length > 0) noAnswerReturned++;
        continue;
      }
      const gold = q.gold.map((g) => ids.get(g)!);
      const top5 = hits.slice(0, 5);
      const recall = gold.filter((g) => top5.includes(g)).length / gold.length;
      const first = hits.findIndex((h) => gold.includes(h));
      const rr = first >= 0 ? 1 / (first + 1) : 0;
      if (recall < 1) misses.push(`${q.id} ${q.q}`);
      // "shared words": every question keyword search can answer by construction.
      for (const cat of [q.cat, "all", ...(q.cat === "meaning" ? [] : ["shared words"])]) {
        const c = perCat.get(cat) ?? { n: 0, recall: 0, rr: 0 };
        c.n++;
        c.recall += recall;
        c.rr += rr;
        perCat.set(cat, c);
      }
    }
    const rows: Row[] = [...perCat].map(([cat, c]) => ({
      cat,
      n: c.n,
      recall5: Number((c.recall / c.n).toFixed(3)),
      mrr10: Number((c.rr / c.n).toFixed(3)),
    }));
    const row = (cat: string): Row => rows.find((r) => r.cat === cat)!;
    return { rows, row, noAnswer, noAnswerReturned, misses };
  };
  const runs: Record<string, Awaited<ReturnType<typeof evaluate>>> = {};
  const report = (name: string, run: Awaited<ReturnType<typeof evaluate>>) => {
    runs[name] = run;
    const table = [
      "| category | questions | recall@5 | MRR@10 |",
      "| --- | --- | --- | --- |",
      ...run.rows.map((r) => `| ${r.cat} | ${r.n} | ${r.recall5.toFixed(3)} | ${r.mrr10.toFixed(3)} |`),
      `| no-answer: returned something | ${run.noAnswer} | ${run.noAnswerReturned}/${run.noAnswer} | |`,
    ].join("\n");
    console.log(
      `Knowledge eval (${name}), ${totalPages} pages\n${table}${run.misses.length ? `\nMisses: ${run.misses.join("; ")}` : ""}`,
    );
    if (process.env.REI_EVAL_OUT)
      writeFileSync(process.env.REI_EVAL_OUT, JSON.stringify({ pages: totalPages, runs }, null, 2));
  };

  it("finds pages by keyword in English, Chinese and mixed text, and reports no-answer behaviour", async () => {
    const run = await evaluate(async (q) =>
      k()
        .search(q, { limit: 10 })
        .map((h) => h.pageId),
    );
    report("keyword", run);
    // Floors just under the recorded run (RESULTS.md).
    expect(run.row("shared words").recall5).toBeGreaterThanOrEqual(0.95);
    expect(run.row("shared words").mrr10).toBeGreaterThanOrEqual(0.9);
    expect(run.row("chinese").recall5).toBeGreaterThanOrEqual(0.9);
    expect(run.row("mixed").recall5).toBeGreaterThanOrEqual(0.9);
    // The meaning questions really share no word with their pages.
    expect(run.row("meaning").recall5).toBe(0);
    expect(run.noAnswerReturned).toBe(0);
  });

  it("finds pages that share no word with the question once meaning is fused in, without losing the keyword hits", async () => {
    expect(k().meaning!.status()).toMatchObject({ state: "ready" });
    const run = await evaluate(async (q) => (await k().find(q, { limit: 10 })).map((h) => h.pageId));
    report("keyword + meaning", run);
    // REI_EVAL_DEBUG=1 prints each question's top five and which ranking found each hit.
    if (process.env.REI_EVAL_DEBUG)
      for (const q of fixture.questions)
        console.log(
          q.id,
          q.q,
          q.gold,
          (await k().find(q.q, { limit: 5 })).map((h) => `${h.title}[${h.matched.join("+")}]`).join(" | "),
        );
    // Floors just under the recorded run (RESULTS.md). The fake embedder's cosines are not a real model's, so the
    // no-answer count guards against regressions only; the cosine floor itself was calibrated on EmbeddingGemma.
    expect(run.row("meaning").recall5).toBeGreaterThanOrEqual(0.8);
    expect(run.row("all").recall5).toBeGreaterThanOrEqual(0.95);
    expect(run.row("shared words").recall5).toBeGreaterThanOrEqual(0.95);
    expect(run.row("shared words").mrr10).toBeGreaterThanOrEqual(0.95);
    expect(run.row("chinese").recall5).toBeGreaterThanOrEqual(0.9);
    expect(run.noAnswerReturned).toBeLessThanOrEqual(2);
  });

  it("finds a stale page by its new text only, and keeps the old text in its history", () => {
    const id = ids.get("stale")!;
    const hits = (q: string) =>
      k()
        .search(q, { limit: 5 })
        .map((h) => h.pageId);
    expect(hits("cleaner Friday afternoon")[0]).toBe(id);
    expect(
      k()
        .search("Wednesday morning", { limit: 30 })
        .some((h) => h.pageId === id),
    ).toBe(false);
    const history = k().revisions(id);
    expect(history.length).toBe(2);
    expect(k().revision(id, 1)!.body).toContain("Wednesday");
  });

  it("finds a misfiled page anywhere, but not in a search scoped where it should have been", () => {
    const id = ids.get("misfiled")!;
    expect(k().search("Zurich car insurance", { limit: 5 })[0]!.pageId).toBe(id);
    expect(
      k()
        .search("Zurich car insurance", { under: ids.get("finance")! })
        .some((h) => h.pageId === id),
    ).toBe(false);
    expect(k().path(id)).toBe("Recipes › Car insurance renewal");
  });

  it("pages a high fan-out parent and keeps the prompt pointer inside its budget", async () => {
    const reviews = k()
      .children(null, 50)
      .find((p) => p.title === "Weekly reviews")!;
    expect(k().childCount(reviews.id)).toBe(52);
    const pointer = k().pointer(server!.clock.now());
    console.log(`Pointer: ${estimateTokens(pointer)} tokens with ${totalPages} pages`);
    expect(estimateTokens(pointer)).toBeLessThanOrEqual(600);
    expect(pointer).toContain("Top level:");
    const id = await chat(server!);
    const before = (await detail(server!, id)).runs.length;
    await say(server!, id, tool("knowledge_browse", { pageId: reviews.id, limit: 10 }));
    await settled(server!, id, before + 1);
    const out = stepPayloads(server!, id).at(-1)!;
    expect(out).toContain("Week 52 review");
    expect(out).not.toContain("Week 1 review (");
    expect(out).toMatch(/offset[^0-9]*10/);
  });

  it("keeps tool answers compact: search hits are short, and a long page is read a section at a time", async () => {
    const long = k().create(
      {
        parentId: ids.get("work")!,
        title: "Architecture notes",
        body: Array.from(
          { length: 40 },
          (_, i) =>
            `## Component ${i + 1}\n${"The service keeps state in SQLite and publishes events to the stream. ".repeat(12)}`,
        ).join("\n\n"),
      },
      USER,
    );
    const id = await chat(server!);
    const talk = async (text: string) => {
      const before = (await detail(server!, id)).runs.length;
      await say(server!, id, text);
      await settled(server!, id, before + 1);
      return stepPayloads(server!, id).at(-1)!;
    };
    const tokensOfLastToolResult = (payload: string) => {
      const parsed = JSON.parse(payload) as { messages?: { role: string; content: unknown }[] };
      const last = [...(parsed.messages ?? [])].reverse().find((m) => m.role === "toolResult" || m.role === "tool");
      return estimateTokens(JSON.stringify(last?.content ?? ""));
    };
    const search = await talk(tool("knowledge_search", { query: "release" }));
    const read = await talk(tool("knowledge_read", { pageId: long.id }));
    const section = await talk(tool("knowledge_read", { pageId: long.id, section: "Component 33" }));
    const sizes = {
      search: tokensOfLastToolResult(search),
      read: tokensOfLastToolResult(read),
      section: tokensOfLastToolResult(section),
      wholePage: estimateTokens(k().live(long.id).body),
    };
    console.log(`Tool answers (tokens): ${JSON.stringify(sizes)}`);
    expect(sizes.search).toBeLessThanOrEqual(900);
    // The text stops near 1500 tokens at a section boundary; the outline of all 40 sections comes on top, each line with
    // its #slug so agents can write section links (about 100 tokens for 40 sections).
    expect(read).toContain("Outline:");
    expect(read).toContain('read on with section: \\"§');
    expect(sizes.read).toBeLessThanOrEqual(2_100);
    expect(section).toContain("Component 33");
    expect(sizes.section).toBeLessThanOrEqual(760);
  });
});
