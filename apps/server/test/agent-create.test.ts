import { existsSync } from "node:fs";
import type { Agent, Session, Trigger } from "@rei/protocol";
import { AGENT_BOT_AVATARS, AGENT_NAME_MAX_CHARS } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.ts";
import { STANDIN, startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, sessions, settled, treeDir, treeOf } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
let gateway: FakeGateway | undefined;
afterEach(async () => {
  await server?.destroy();
  await gateway?.close();
  server = undefined;
  gateway = undefined;
});
const s = (): TestServer => server!;
const store = () => s().host.plane.store;
const create = (name: unknown, avatar: unknown = "bot:cat") =>
  s().client.call("POST", "/api/agents", { body: { name, avatar } });
const remove = (id: string) => s().client.call("DELETE", `/api/agents/${id}`);
const agents = async (): Promise<Agent[]> => (await s().client.get("/api/agents")).body.agents;
const count = (sql: string, ...params: string[]): number => store().db.get<{ n: number }>(sql, ...params)!.n;

describe("create agent", () => {
  it("creates the named agent, its home chat and tree folder, and emits both events", async () => {
    server = await startSignedIn();
    const stream = await s().sse("/api/stream");
    const res = await create("  News Reporter  ");
    expect(res.status).toBe(200);
    const { agent, session } = res.body as { agent: Agent; session: Session };
    expect(agent).toMatchObject({
      name: "News Reporter",
      model: null,
      defaultProfile: "standard",
      homeSessionId: session.id,
    });
    expect(agent.avatar).toBe("bot:cat");
    expect(session).toMatchObject({ agentId: agent.id, origin: "home", title: "News Reporter" });
    expect(
      store().db.get<{ instructions: string }>("SELECT instructions FROM agents WHERE id = ?", agent.id)!.instructions,
    ).toBe("You are News Reporter, a personal AI assistant. Be direct, concise and honest about what you do not know.");
    expect(existsSync(treeDir(s(), treeOf(s(), session.id)))).toBe(true);

    // Both are announced, and the default agent stays the default.
    await stream.waitFor((e) => e.event === "agent.upserted" && e.data.agent.id === agent.id);
    await stream.waitFor((e) => e.event === "session.upserted" && e.data.session.id === session.id);
    stream.close?.();
    expect((await agents()).map((a) => a.id)).toContain(agent.id);
    expect((await s().client.get("/api/agents")).body.defaultAgentId).not.toBe(agent.id);
    expect((await sessions(s())).map((x) => x.id)).toContain(session.id);

    // The new agent's home chat can be talked to.
    await say(s(), session.id, "hello");
    await settled(s(), session.id, 1);
  });

  it("validates identity before creating anything and requires authentication and CSRF", async () => {
    server = await startSignedIn();
    for (const name of [undefined, "", "   ", 5, "x".repeat(AGENT_NAME_MAX_CHARS + 1)]) {
      const res = await create(name);
      expect([res.status, res.body.error.code], String(name)).toEqual([400, "bad_request"]);
    }
    for (const avatar of [undefined, null, "", "bot:!", "🙂".repeat(9)]) {
      const res = await s().client.call("POST", "/api/agents", { body: { name: "Reporter", avatar } });
      expect(res.status).toBe(400);
    }
    expect((await s().client.call("POST", "/api/agents", { body: "[]" })).status).toBe(400);
    const body = { name: "Reporter", avatar: "📰" };
    expect((await s().client.raw("POST", "/api/agents", { body, cookie: false })).status).toBe(401);
    expect((await s().client.call("POST", "/api/agents", { body, csrf: false })).status).toBe(403);
    expect(await agents()).toHaveLength(1);
    expect((await create("x".repeat(AGENT_NAME_MAX_CHARS))).status).toBe(200);
  });

  it("preserves the chosen name and emoji without any model call, including for older clients", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN, behavior: () => ({ kind: "status", status: 503 }) });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const res = await create("News Reporter", "  📰  ");
    expect(res.status).toBe(200);
    expect(res.body.agent).toMatchObject({ name: "News Reporter", avatar: "📰" });
    expect(res.body.session.title).toBe("News Reporter");

    const legacy = await s().client.post("/api/agents", { description: "a coach" });
    expect(legacy.status).toBe(200);
    expect(legacy.body.agent.name).toBe("A coach");
    expect(AGENT_BOT_AVATARS as readonly string[]).toContain(legacy.body.agent.avatar);
    expect(gateway.seen).toHaveLength(0);
    expect(count("SELECT COUNT(*) AS n FROM steps WHERE type = 'llm.call'")).toBe(0);
  });
});

describe("delete agent", () => {
  const trigger = (agentId: string): Trigger =>
    s().host.plane.triggers.store.create({
      agentId,
      createdBySessionId: null,
      fields: {
        name: "Daily",
        start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "UTC" } },
        action: { kind: "prompt", prompt: "hello" },
        landing: "new",
        report: "on_change",
        hideInList: true,
        latenessMinutes: 120,
        catchUp: "once",
        overlap: "skip",
        profile: "standard",
        allow: [],
      },
    });

  it("removes the agent with its chats, triggers, grants and memory, and tells the PWA", async () => {
    server = await startSignedIn();
    const made = (await create("A researcher")).body as { agent: Agent; session: Session };
    const other = (await create("A cook")).body as { agent: Agent; session: Session };
    const agentId = made.agent.id;
    const mine = (await s().client.post("/api/sessions", { agentId })).body.session.id as string;
    await say(s(), mine, "hello researcher");
    await settled(s(), mine, 1);
    await say(s(), made.session.id, "hello home");
    await settled(s(), made.session.id, 1);
    const trees = [mine, made.session.id].map((id) => treeOf(s(), id));
    const t = trigger(agentId);
    const keep = trigger(other.agent.id);
    store().db.run(
      "INSERT INTO grants (id, connector, operation, destination, length, session_id, agent_id, expires_at, approval_id, created_at) VALUES ('grt_x', 'demo', 'send', NULL, 'always', NULL, ?, NULL, 'apr_x', 1)",
      agentId,
    );
    expect((await s().client.post("/api/memory/lines", { doc: "agent", agentId, text: "Likes tea" })).status).toBe(200);
    expect(
      (await s().client.post("/api/memory/lines", { doc: "agent", agentId: other.agent.id, text: "Likes soup" }))
        .status,
    ).toBe(200);

    const stream = await s().sse("/api/stream");
    const res = await remove(agentId);
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    await stream.waitFor((e) => e.event === "agent.removed" && e.data.agentId === agentId);
    for (const id of [mine, made.session.id])
      await stream.waitFor((e) => e.event === "session.removed" && e.data.sessionId === id);
    stream.close?.();

    expect((await agents()).map((a) => a.id)).not.toContain(agentId);
    const live = (await sessions(s())).map((x) => x.id);
    expect(live).not.toContain(mine);
    expect(live).not.toContain(made.session.id);
    expect(live).toContain(other.session.id); // nothing of the other agent went
    for (const id of [mine, made.session.id]) expect((await s().client.get(`/api/sessions/${id}`)).status).toBe(404);
    for (const treeId of trees) {
      expect(existsSync(treeDir(s(), treeId))).toBe(false);
      expect(store().treeRow(treeId)!.state).toBe("deleted");
    }
    // The home chat was not replaced by a new one.
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ? AND deleted_at IS NULL", agentId)).toBe(0);
    for (const table of ["overlays", "steps"])
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id IN (?, ?)`, mine, made.session.id), table).toBe(
        0,
      );
    expect(count("SELECT COUNT(*) AS n FROM agents WHERE id = ?", agentId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM triggers WHERE agent_id = ?", agentId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM trigger_runs WHERE trigger_id = ?", t.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM grants WHERE agent_id = ?", agentId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM memory_lines WHERE agent_id = ?", agentId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM memory_changes WHERE agent_id = ?", agentId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM deletion_jobs")).toBe(0);
    // Another agent's rows stay.
    expect(count("SELECT COUNT(*) AS n FROM triggers WHERE id = ?", keep.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM memory_lines WHERE agent_id = ?", other.agent.id)).toBe(1);
    // The delete is in the edit log, and a later snapshot has no trace of the agent.
    const edits = (await s().client.get("/api/edits")).body.entries as {
      target: { kind: string; agentId?: string };
      field: string;
      before: string;
    }[];
    expect(
      edits.find((e) => e.target.kind === "agent" && e.target.agentId === agentId && e.field === "deleted")?.before,
    ).toBe("A researcher");
    const snapshot = await s().sse("/api/stream");
    const first = await snapshot.waitFor(() => true);
    snapshot.close?.();
    expect((first.data.agents as Agent[]).map((a) => a.id)).not.toContain(agentId);
  });

  it("stops the runs under way and deletes forks and spawned chats too", async () => {
    server = await startSignedIn();
    const made = (await create("A writer")).body as { agent: Agent; session: Session };
    const a = (await s().client.post("/api/sessions", { agentId: made.agent.id })).body.session.id as string;
    await say(s(), a, "first");
    await settled(s(), a, 1);
    const reply = (await detail(s(), a)).messages.filter((m) => m.role === "assistant").at(-1)!;
    const fork = (await s().client.post(`/api/sessions/${a}/fork`, { messageId: reply.id })).body.session.id as string;
    const b = (await s().client.post("/api/sessions", { agentId: made.agent.id })).body.session.id as string;
    expect((await say(s(), b, "go on")).status).toBe(200);
    expect((await remove(made.agent.id)).status).toBe(200);
    const live = (await sessions(s())).map((x) => x.id);
    for (const id of [a, fork, b, made.session.id]) expect(live).not.toContain(id);
    const runs = s().host.plane.store.runs;
    expect([a, fork, b].flatMap((id) => runs.nonTerminal(id))).toHaveLength(0);
  });

  it("refuses the default agent (409) and an unknown one (404) and changes nothing", async () => {
    server = await startSignedIn();
    const before = await agents();
    const defaultId = store().defaultAgentId()!;
    const home = before.find((a) => a.id === defaultId)!.homeSessionId;
    const id = await chat(s());
    const res = await remove(defaultId);
    expect([res.status, res.body.error.code]).toEqual([409, "default_agent"]);
    const missing = await remove("agt_nope");
    expect([missing.status, missing.body.error.code]).toEqual([404, "not_found"]);
    expect(await agents()).toEqual(before);
    const live = (await sessions(s())).map((x) => x.id);
    expect(live).toContain(home);
    expect(live).toContain(id);
    expect((await s().client.raw("DELETE", `/api/agents/${defaultId}`, { cookie: false })).status).toBe(401);
  });
});
