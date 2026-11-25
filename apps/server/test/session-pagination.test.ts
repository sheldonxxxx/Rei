import type { SessionsResponse } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { Reply } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, homeChat } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

describe("progressive session history", () => {
  it("pages tied timestamps without duplicates, excludes hidden runs, and keeps direct metadata lookup", async () => {
    server = await startSignedIn();
    const store = server.host.plane.store;
    const ids: string[] = [];
    for (let n = 0; n < 65; n++) ids.push(await chat(server));
    for (const id of ids) store.db.run("UPDATE sessions SET updated_at = 100 WHERE id = ?", id);
    store.db.run(
      "UPDATE sessions SET origin = 'trigger', hide_in_list = 1, status = 'completed' WHERE id = ?",
      ids[0]!,
    );
    store.db.run("UPDATE sessions SET deleted_at = 1 WHERE id = ?", ids[1]!);
    const agent = store.defaultAgentId()!;
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const reply: Reply<SessionsResponse> = await server.client.get(
        `/api/sessions?paged=1&agent=${agent}${cursor ? `&before=${cursor}` : ""}`,
      );
      expect(reply.status).toBe(200);
      expect(reply.body.sessions.length).toBeLessThanOrEqual(30);
      all.push(...reply.body.sessions.map((s: { id: string }) => s.id));
      cursor = reply.body.nextCursor ?? null;
      if (all.length === 30) {
        // A loaded row moves to the top; it must not reappear in a later page.
        store.db.run("UPDATE sessions SET updated_at = 200 WHERE id = ?", all[0]!);
      }
    } while (cursor);
    expect(new Set(all).size).toBe(63);
    expect(all).toHaveLength(63);
    expect(all).not.toContain(homeChat(server));
    expect(all).not.toContain(ids[0]);
    const related = await server.client.get(`/api/sessions/${ids[0]}/related`);
    expect(related.body.sessions.map((s: { id: string }) => s.id)).toContain(ids[0]);
    expect((await server.client.get(`/api/sessions/${ids[1]}/related`)).status).toBe(404);
    expect((await server.client.get("/api/sessions?paged=1&before=invalid")).status).toBe(400);
    const other = store.createAgent({ name: "Other", avatar: "O", instructions: "" });
    const foreign = (await server.client.post("/api/sessions", { agentId: other.agent.id })).body.session.id as string;
    expect(store.sessionPage(agent, undefined).sessions.map((s) => s.id)).not.toContain(foreign);
    expect(store.sessionPage(other.agent.id, undefined).sessions.map((s) => s.id)).toEqual([foreign]);
    const seed = store.sessionSeed();
    expect(seed.length).toBeLessThanOrEqual(8);
    expect(seed.map((s) => s.id)).toContain(homeChat(server));
    expect(seed.length).toBeLessThan(all.length);
  });

  it("lists visible trigger runs by default and hidden ones only when asked (the Hidden trigger sessions filter)", async () => {
    server = await startSignedIn();
    const store = server.host.plane.store;
    const hiddenId = await chat(server);
    const visibleId = await chat(server);
    store.db.run(
      "UPDATE sessions SET origin = 'trigger', hide_in_list = 1, status = 'completed' WHERE id = ?",
      hiddenId,
    );
    store.db.run(
      "UPDATE sessions SET origin = 'trigger', hide_in_list = 0, status = 'completed' WHERE id = ?",
      visibleId,
    );
    const agent = store.defaultAgentId()!;
    const defaultIds = store.sessionPage(agent, undefined).sessions.map((s) => s.id);
    expect(defaultIds).not.toContain(hiddenId);
    expect(defaultIds).toContain(visibleId);
    expect(store.sessionPage(agent, undefined, 30, { triggers: true }).sessions.map((s) => s.id)).toContain(hiddenId);
    const reply = await server.client.get(`/api/sessions?paged=1&agent=${agent}&triggers=1`);
    expect(reply.body.sessions.map((s: { id: string }) => s.id)).toContain(hiddenId);
  });
});
