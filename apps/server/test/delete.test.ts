import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "./helpers/client.ts";
import { FakeEmbedder, withEmbedder } from "./helpers/fake-embedder.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import {
  chat,
  childrenOf,
  detail,
  filesContaining,
  homeChat,
  restart,
  say,
  sessions,
  settled,
  treeDir,
  treeOf,
} from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const del = (id: string, withForks = false) =>
  server!.client.call("DELETE", `/api/sessions/${id}${withForks ? "?withForks=1" : ""}`);
const fork = async (id: string) => {
  const d = await detail(server!, id);
  const reply = d.messages.filter((m) => m.role === "assistant").at(-1)!;
  return (await server!.client.post(`/api/sessions/${id}/fork`, { messageId: reply.id })).body.session as {
    id: string;
  };
};
const store = () => server!.host.plane.store;
const ids = async () => (await sessions(server!)).map((s) => s.id);
const marker = (name: string) => `MARK${name}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

describe("delete", () => {
  it("removes a single-session tree: the folder, the rows and every trace of the text", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const m = marker("single");
    await say(server, id, `${m} tell me something`);
    await settled(server, id, 1);
    const treeId = treeOf(server, id);
    expect(existsSync(treeDir(server, treeId))).toBe(true);
    expect(
      store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM steps WHERE session_id = ?", id)!.n,
    ).toBeGreaterThan(0);
    expect(filesContaining(server.dir, m).length).toBeGreaterThan(0);

    const res = await del(id);
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(existsSync(treeDir(server, treeId))).toBe(false);
    expect(readdirSync(join(server.dir, "trees")).filter((n) => n.startsWith(".deleting-"))).toEqual([]);
    expect(await ids()).not.toContain(id);
    expect((await server.client.get(`/api/sessions/${id}`)).status).toBe(404);
    expect(store().treeRow(treeId)!.state).toBe("deleted");

    // Nothing of the session is left: rows, steps, blobs, runs, the database file, the tree folder.
    for (const table of ["overlays", "steps", "outbox", "attachment_refs"]) {
      expect(store().db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`, id)!.n).toBe(0);
    }
    expect(store().runs.forSession(id)).toEqual([]);
    expect(store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deletion_jobs")!.n).toBe(0);
    expect(filesContaining(server.dir, m)).toEqual([]);
    expect(server.logs.join("\n")).not.toContain(m);
    // The history index held the text too, as FTS tokens (lower-case) and in its entries: none of it is left, in the
    // tables or in the bytes of the database file and its log.
    for (const table of ["history_entries", "memory_suggestions", "memory_changes"]) {
      expect(store().db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`, id)!.n).toBe(0);
    }
    expect(
      store().db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM history_fts WHERE history_fts MATCH ?",
        `"${m.toLowerCase()}"`,
      )!.n,
    ).toBe(0);
    expect(store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_entries")!.n).toBe(0);
    expect(filesContaining(server.dir, m.toLowerCase())).toEqual([]);
    // The second delete says it is gone.
    expect((await del(id)).status).toBe(404);
  });

  it("purges the index, the vectors and the memory chips of a session, and keeps the lines it taught (their source goes)", async () => {
    server = await startSignedIn(withEmbedder(new FakeEmbedder()));
    const id = await chat(server);
    const m = marker("memory");
    await say(server, id, `${m} then save a fact [tool: memory_add {"text":"Kept fact about cats"}]`);
    await settled(server, id, 1);
    await server.host.plane.memory.history.settle();
    const set = store().db.get<{ id: number }>("SELECT id FROM memory_vector_sets")!.id;
    expect(
      store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_entries WHERE session_id = ?", id)!.n,
    ).toBeGreaterThan(0);
    expect(
      store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_vectors WHERE set_id = ?", set)!.n,
    ).toBeGreaterThan(0);
    expect(
      store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM overlays WHERE session_id = ? AND kind = 'memory'", id)!
        .n,
    ).toBe(1);

    expect((await del(id)).status).toBe(200);
    expect(store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_entries")!.n).toBe(0);
    expect(store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_vectors")!.n).toBe(0);
    expect(
      store().db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM history_fts WHERE history_fts MATCH ?",
        `"${m.toLowerCase()}"`,
      )!.n,
    ).toBe(0);
    expect(store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM overlays WHERE kind = 'memory'")!.n).toBe(0);
    expect(store().db.all<{ session_id: string | null }>("SELECT session_id FROM memory_changes")).toEqual([
      { session_id: null },
    ]);
    expect(filesContaining(server.dir, m)).toEqual([]);
    expect(filesContaining(server.dir, m.toLowerCase())).toEqual([]);
    // The fact is still there, with no source chat.
    const line = (await server.client.get("/api/memory")).body.profile[0];
    expect(line).toMatchObject({ text: "Kept fact about cats", source: null, sourceDeleted: true });
  });

  it("refuses a home chat", async () => {
    server = await startSignedIn();
    const home = (await server.client.get("/api/agents")).body.agents[0].homeSessionId as string;
    const res = await del(home);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("home_chat");
    expect(await ids()).toContain(home);
    expect((await del("ses_nope")).status).toBe(404);
  });

  it("only hides a fork and keeps the tree; the last session to go removes it", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await say(server, a, "hello there");
    await settled(server, a, 1);
    const f = await fork(a);
    const treeId = treeOf(server, a);

    // Deleting the source hides it; the fork lives on in the same tree and still works.
    expect((await del(a)).body).toEqual({ ok: true });
    expect(await ids()).not.toContain(a);
    expect(await ids()).toContain(f.id);
    expect(existsSync(treeDir(server, treeId))).toBe(true);
    expect(store().treeRow(treeId)!.state).toBe("live");
    expect(store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM overlays WHERE session_id = ?", a)!.n).toBe(0);
    expect(store().runs.forSession(a)).toEqual([]);
    await say(server, f.id, "still alive");
    await settled(server, f.id, 1);

    // Reopened after a restart, with the hidden root conversation left alone.
    server = Object.assign(await restart(server), { totpSecret: server.totpSecret });
    await say(server, f.id, "after restart");
    await settled(server, f.id, 2);

    // The fork is the last live session: its delete removes the tree.
    expect((await del(f.id)).body).toEqual({ ok: true });
    expect(existsSync(treeDir(server, treeId))).toBe(false);
    expect(store().treeRow(treeId)!.state).toBe("deleted");
  });

  it("deleting a fork leaves the source and its tree alone", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await say(server, a, "hello there");
    await settled(server, a, 1);
    const f = await fork(a);
    await del(f.id);
    expect(await ids()).toContain(a);
    expect(existsSync(treeDir(server, treeOf(server, a)))).toBe(true);
    await say(server, a, "more");
    await settled(server, a, 2);
  });

  it("withForks removes the session, its forks and the tree at once", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await say(server, a, "hello there");
    await settled(server, a, 1);
    const f1 = await fork(a);
    const f2 = await fork(f1.id);
    const other = await chat(server);
    const treeId = treeOf(server, a);
    expect((await del(a, true)).body).toEqual({ ok: true });
    const left = await ids();
    expect(left).not.toContain(a);
    expect(left).not.toContain(f1.id);
    expect(left).not.toContain(f2.id);
    expect(left).toContain(other);
    expect(existsSync(treeDir(server, treeId))).toBe(false);
    expect(store().treeRow(treeId)!.state).toBe("deleted");
  });

  it("withForks on a fork removes its own branch only", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await say(server, a, "hello there");
    await settled(server, a, 1);
    const f1 = await fork(a);
    const f2 = await fork(f1.id);
    await del(f1.id, true);
    const left = await ids();
    expect(left).toContain(a);
    expect(left).not.toContain(f1.id);
    expect(left).not.toContain(f2.id);
    expect(existsSync(treeDir(server, treeOf(server, a)))).toBe(true);
  });

  it("cancels a run in progress and deletes anyway", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const m = marker("busy");
    await say(server, id, `${m} write a lot [len=60000]`);
    await until(
      async () => (await detail(server!, id)).messages.some((x) => x.role === "assistant" && x.text.length > 50),
      10_000,
      "streaming",
    );
    const treeId = treeOf(server, id);
    const res = await del(id);
    expect(res.status).toBe(200);
    expect(existsSync(treeDir(server, treeId))).toBe(false);
    expect(store().runs.forSession(id)).toEqual([]);
    expect(store().nonTerminalRuns()).toEqual([]);
    expect(server.host.plane.adapter.trees.get(treeId)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(filesContaining(server.dir, m)).toEqual([]);
    // The server is still fine.
    const next = await chat(server);
    await say(server, next, "hi");
    await settled(server, next, 1);
  });

  it("tells both streams: session.removed on the global one and on the session's own, which then ends", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await say(server, id, "hello");
    await settled(server, id, 1);
    const g = await server.sse("/api/stream");
    const s = await server.sse(`/api/sessions/${id}/stream`);
    await g.waitFor((e) => e.event === "snapshot");
    await s.waitFor((e) => e.event === "snapshot");
    await del(id);
    expect((await g.waitFor((e) => e.event === "session.removed")).data.sessionId).toBe(id);
    expect((await s.waitFor((e) => e.event === "session.removed")).data.sessionId).toBe(id);
    await until(() => s.ended, 5_000, "the session stream to end");
    expect(server.host.plane.store.events.subscriberCount(`session:${id}`)).toBe(0);
    await g.close();
  });

  it("detaches the sessions it spawned: they stay, without a parent", async () => {
    server = await startSignedIn();
    const parent = homeChat(server);
    await say(server, parent, "[spawn: a job]");
    await settled(server, parent, 2);
    const [child] = await childrenOf(server, parent);
    await server.host.plane.adapter.deleteSession(parent, false, true);
    const after = (await sessions(server)).find((s) => s.id === child!.id)!;
    expect(after.parentSessionId).toBeNull();
    expect(after.origin).toBe("spawned");
    expect(existsSync(treeDir(server, treeOf(server, child!.id)))).toBe(true);
  });
});

describe("a crash in the middle of a delete", () => {
  it("is finished at startup when only the hiding was done", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const m = marker("crashA");
    await say(server, id, `${m} hello`);
    await settled(server, id, 1);
    const treeId = treeOf(server, id);
    // The first transaction of a delete, then the process dies.
    store().beginDeletion({ sessionIds: [id], treeId, removeTree: true });
    expect(await ids()).not.toContain(id);
    expect(store().deletionJobs()).toHaveLength(1);
    server = Object.assign(await restart(server), { totpSecret: server.totpSecret });
    expect(store().deletionJobs()).toHaveLength(0);
    expect(existsSync(treeDir(server, treeId))).toBe(false);
    expect(store().treeRow(treeId)!.state).toBe("deleted");
    expect(filesContaining(server.dir, m)).toEqual([]);
    expect(await ids()).not.toContain(id);
  });

  it("is finished at startup when the rows were purged but the blobs and the folder were not", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const m = marker("crashB");
    await say(server, id, `${m} hello`);
    await settled(server, id, 1);
    const treeId = treeOf(server, id);
    const jobId = store().beginDeletion({ sessionIds: [id], treeId, removeTree: true });
    const refs = store().purgeSessions(jobId);
    expect(refs.length).toBeGreaterThan(0);
    // The job remembers the blobs, since the step rows that named them are gone.
    expect(store().deletionJobs()[0]!.blobRefs).toEqual(refs);
    expect(filesContaining(server.dir, m).length).toBeGreaterThan(0);
    server = Object.assign(await restart(server), { totpSecret: server.totpSecret });
    expect(store().deletionJobs()).toHaveLength(0);
    expect(existsSync(treeDir(server, treeId))).toBe(false);
    expect(filesContaining(server.dir, m)).toEqual([]);
  });
});
