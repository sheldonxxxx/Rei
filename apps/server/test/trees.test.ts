import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "./helpers/client.ts";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const chat = async (s: TestServer) => (await s.client.post("/api/sessions", {})).body.session.id as string;
const say = (s: TestServer, id: string, text: string, requestId: string = crypto.randomUUID()) =>
  s.client.post(`/api/sessions/${id}/messages`, { requestId, text });
const done = (s: TestServer, id: string, runs = 1) =>
  until(async () => {
    const d = (await s.client.get(`/api/sessions/${id}`)).body;
    return d.runs.length >= runs && d.runs.every((r: { status: string }) => r.status === "completed") ? d : undefined;
  });
const treeOf = (s: TestServer, sessionId: string) => s.host.plane.store.getSessionRow(sessionId)!.tree_id;
const trees = (s: TestServer) => join(s.dir, "trees");

describe("tree folders", () => {
  it("gives every chat its own folder and creates the Pi database when the chat is first used", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    const b = await chat(server);
    expect(treeOf(server, a)).not.toBe(treeOf(server, b));
    expect(existsSync(join(trees(server), treeOf(server, a), "pi.sqlite"))).toBe(false);
    await say(server, a, "hi");
    await done(server, a);
    expect(existsSync(join(trees(server), treeOf(server, a), "pi.sqlite"))).toBe(true);
    expect(existsSync(join(trees(server), treeOf(server, b), "pi.sqlite"))).toBe(false);
  });

  it("deletes a tree: refuses while it has work, then removes the folder, hides the chat, and never reuses the id", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const treeId = treeOf(server, id);
    const g = await server.sse("/api/stream");
    await g.waitFor((e) => e.event === "snapshot");
    await say(server, id, "long [len=60000]");
    await until(
      async () =>
        (await server!.client.get(`/api/sessions/${id}`)).body.messages.some(
          (m: { role: string }) => m.role === "assistant",
        ),
      10_000,
      "a running reply",
    );
    await expect(server.host.plane.adapter.deleteTree(treeId)).rejects.toThrow(/unfinished/);
    expect(existsSync(join(trees(server), treeId))).toBe(true);

    await server.client.post(`/api/sessions/${id}/cancel`);
    await until(
      async () => (await server!.client.get(`/api/sessions/${id}`)).body.runs[0].status === "cancelled",
      10_000,
      "cancel",
    );
    await server.host.plane.adapter.deleteTree(treeId);
    expect(existsSync(join(trees(server), treeId))).toBe(false);
    expect(readdirSync(trees(server)).filter((n) => n.startsWith(".deleting-"))).toEqual([]);
    expect(server.host.plane.adapter.trees.get(treeId)).toBeUndefined();

    const removed = await g.waitFor((e) => e.event === "session.removed");
    expect(removed.data.sessionId).toBe(id);
    const list = (await server.client.get("/api/sessions")).body.sessions as { id: string }[];
    expect(list.some((s) => s.id === id)).toBe(false);
    await g.close();
  });

  it("finishes a half-done delete on the next start (sweep)", async () => {
    server = await startSignedIn();
    const dir = server.dir;
    const { totpSecret } = server;
    const cookie = server.client.cookie;
    await server.stop();
    // What a crash between the rename and the removal leaves behind.
    const doomed = join(dir, "trees", ".deleting-tr_leftover");
    mkdirSync(doomed, { recursive: true });
    writeFileSync(join(doomed, "pi.sqlite"), "x");
    server = Object.assign(await startTestServer({ dir }), { totpSecret });
    server.client.cookie = cookie;
    expect(existsSync(doomed)).toBe(false);
    expect(server.logs.join("\n")).toContain("trees.swept");
  });

  it("recreates a missing folder for a live tree, and drops a stray -wal that has no database", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const treeId = treeOf(server, id);
    const dir = server.dir;
    const { totpSecret } = server;
    const cookie = server.client.cookie;
    await server.stop();
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "trees", treeId), { recursive: true });
    server = Object.assign(await startTestServer({ dir }), { totpSecret });
    server.client.cookie = cookie;
    expect(existsSync(join(dir, "trees", treeId))).toBe(true);

    writeFileSync(join(dir, "trees", treeId, "pi.sqlite-wal"), "stale wal from some other database");
    writeFileSync(join(dir, "trees", treeId, "pi.sqlite-shm"), "stale shm");
    await say(server, id, "works anyway");
    await done(server, id);
    expect(existsSync(join(dir, "trees", treeId, "pi.sqlite"))).toBe(true);
  });
});

describe("open and close", () => {
  it("closes an idle tree and reopens it on the next message", async () => {
    server = await startSignedIn({ config: { idleCloseMs: 300, tickMs: 100 } });
    const id = await chat(server);
    const treeId = treeOf(server, id);
    await say(server, id, "first");
    await done(server, id);
    await until(() => server!.host.plane.adapter.trees.get(treeId) === undefined, 5_000, "idle close");
    await say(server, id, "second");
    const d = await done(server, id, 2);
    expect(d.messages.filter((m: { role: string }) => m.role === "assistant")).toHaveLength(2);
  });

  it("never closes a tree with a run in flight", async () => {
    server = await startSignedIn({ config: { idleCloseMs: 100, tickMs: 100 } });
    const id = await chat(server);
    const treeId = treeOf(server, id);
    await say(server, id, "keep going [len=6000]");
    await new Promise((r) => setTimeout(r, 1_000));
    expect(server.host.plane.adapter.trees.get(treeId)).toBeDefined();
    await done(server, id);
  });
});
