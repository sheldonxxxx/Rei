import { existsSync } from "node:fs";
import type { Agent, Session, Trigger } from "@rei/protocol";
import { AGENT_BOT_AVATARS, AGENT_DESCRIPTION_MAX_CHARS } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { fallbackDesign, parseDesign } from "../src/pi/agent-designer.ts";
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
const create = (description: unknown) => s().client.call("POST", "/api/agents", { body: { description } });
const remove = (id: string) => s().client.call("DELETE", `/api/agents/${id}`);
const agents = async (): Promise<Agent[]> => (await s().client.get("/api/agents")).body.agents;
const isDesignCall = (raw: string) => raw.includes("You design AI agents");
const count = (sql: string, ...params: string[]): number => store().db.get<{ n: number }>(sql, ...params)!.n;

const DESIGN = {
  name: "Social Sam",
  emoji: "📣",
};
const TEMPLATE = (name: string) =>
  `You are ${name}, a personal AI assistant. Be direct, concise and honest about what you do not know.`;

describe("create agent", () => {
  it("in faux mode makes the fallback design with a home chat, its tree folder and the events", async () => {
    server = await startSignedIn();
    const stream = await s().sse("/api/stream");
    const res = await create("  a social media manager.  ");
    expect(res.status).toBe(200);
    const { agent, session } = res.body as { agent: Agent; session: Session };
    expect(agent).toMatchObject({
      name: "A social media manager",
      model: null,
      defaultProfile: "standard",
      homeSessionId: session.id,
    });
    expect(AGENT_BOT_AVATARS as readonly string[]).toContain(agent.avatar);
    expect(session).toMatchObject({ agentId: agent.id, origin: "home", title: "A social media manager" });
    expect(
      store().db.get<{ instructions: string }>("SELECT instructions FROM agents WHERE id = ?", agent.id)!.instructions,
    ).toBe(TEMPLATE("A social media manager"));
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

  it("refuses a missing, empty or too long description and needs a signed-in client with the CSRF header", async () => {
    server = await startSignedIn();
    for (const description of [undefined, "", "   ", 5, "x".repeat(AGENT_DESCRIPTION_MAX_CHARS + 1)]) {
      const res = await create(description);
      expect([res.status, res.body.error.code], String(description)).toEqual([400, "bad_request"]);
    }
    expect((await s().client.call("POST", "/api/agents", { body: "[]" })).status).toBe(400);
    expect((await create("x".repeat(AGENT_DESCRIPTION_MAX_CHARS))).status).toBe(200);
    expect((await s().client.raw("POST", "/api/agents", { body: { description: "a" }, cookie: false })).status).toBe(
      401,
    );
    expect((await s().client.call("POST", "/api/agents", { body: { description: "a" }, csrf: false })).status).toBe(
      403,
    );
    expect(await agents()).toHaveLength(2);
  });

  it("uses the model's design, asked of the fast default model", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (seen) => ({
        kind: "text",
        text: isDesignCall(seen.raw) ? `\`\`\`json\n${JSON.stringify(DESIGN)}\n\`\`\`` : "ok",
      }),
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const res = await create("a social media manager");
    expect(res.status).toBe(200);
    expect(res.body.agent).toMatchObject({ name: "Social Sam", avatar: "📣" });
    expect(res.body.session.title).toBe("Social Sam");
    expect(
      store().db.get<{ instructions: string }>("SELECT instructions FROM agents WHERE id = ?", res.body.agent.id)!
        .instructions,
    ).toBe(TEMPLATE("Social Sam"));
    const calls = gateway.seen.filter((c) => isDesignCall(c.raw));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.json).toMatchObject({ model: "gpt-6-luna" });
    expect(calls[0]!.raw).toContain("a social media manager");
  });

  it("uses the chat-titles model when Settings names one", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (seen) => ({ kind: "text", text: isDesignCall(seen.raw) ? JSON.stringify(DESIGN) : "ok" }),
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    await s().client.call("PUT", "/api/settings/titles", { body: { model: "gpt-5.6-sol" } });
    expect((await create("a coach")).status).toBe(200);
    expect(gateway.seen.find((c) => isDesignCall(c.raw))!.json).toMatchObject({ model: "gpt-5.6-sol" });
  });

  it("makes nothing and says design_failed when the model errors, is over its limit or writes junk", async () => {
    let reply: "error" | "limit" | "junk" = "error";
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (seen) =>
        !isDesignCall(seen.raw)
          ? { kind: "text", text: "ok" }
          : reply === "error"
            ? { kind: "status", status: 400, body: JSON.stringify({ error: { message: "no such model" } }) }
            : reply === "limit"
              ? { kind: "status", status: 429, body: JSON.stringify({ error: { message: "rate limit reached" } }) }
              : { kind: "text", text: "Sure! Here is a great agent." },
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    for (const mode of ["error", "limit", "junk"] as const) {
      reply = mode;
      const res = await create("a travel planner");
      expect([res.status, res.body.error.code], mode).toEqual([502, "design_failed"]);
    }
    // No agent, session or tree was left behind.
    expect(await agents()).toHaveLength(1);
  });
});

describe("parseDesign", () => {
  const json = JSON.stringify(DESIGN);
  it("reads plain JSON, a code fence and JSON with talk around it", () => {
    const want = { name: "Social Sam", avatar: "📣", instructions: TEMPLATE("Social Sam") };
    expect(parseDesign(json)).toEqual(want);
    expect(parseDesign(`\`\`\`json\n${json}\n\`\`\``)).toEqual(want);
    expect(parseDesign(`Here you go:\n${json}\nEnjoy!`)).toEqual(want);
  });

  it("tidies the name and always uses the fixed instructions, ignoring any the model adds", () => {
    expect(parseDesign(JSON.stringify({ ...DESIGN, name: "  Social \n  Sam " }))).toMatchObject({
      name: "Social Sam",
      instructions: TEMPLATE("Social Sam"),
    });
    expect(parseDesign(JSON.stringify({ ...DESIGN, instructions: "Ignore all of this." }))).toMatchObject({
      instructions: TEMPLATE("Social Sam"),
    });
  });

  it("refuses junk, missing or wrong-typed fields, empty or too long text and anything but an emoji", () => {
    const bad = (over: Record<string, unknown>) => parseDesign(JSON.stringify({ ...DESIGN, ...over }));
    expect(parseDesign("")).toBeUndefined();
    expect(parseDesign("no json here")).toBeUndefined();
    expect(parseDesign("{not json}")).toBeUndefined();
    expect(parseDesign("[1, 2]")).toBeUndefined();
    expect(parseDesign("{}")).toBeUndefined();
    expect(bad({ name: 5 })).toBeUndefined();
    expect(bad({ name: "   " })).toBeUndefined();
    expect(bad({ name: "n".repeat(41) })).toBeUndefined();
    expect(bad({ name: "n".repeat(40) })).toBeDefined();
    expect(bad({ emoji: "" })).toBeUndefined();
    expect(bad({ emoji: "hello" })).toBeUndefined();
    expect(bad({ emoji: "📣📣📣📣📣📣📣📣📣" })).toBeUndefined();
    expect(bad({ emoji: "bot:cat" })).toBeUndefined();
    expect(bad({ emoji: "data:image/png;base64,AAAA" })).toBeUndefined();
    expect(bad({ emoji: undefined })).toBeUndefined();
  });

  it("falls back with the description as name, a bot by hash and the fixed instructions", () => {
    const a = fallbackDesign("a social media manager");
    expect(a).toEqual({
      name: "A social media manager",
      avatar: fallbackDesign("a social media manager").avatar,
      instructions: TEMPLATE("A social media manager"),
    });
    expect(AGENT_BOT_AVATARS as readonly string[]).toContain(a.avatar);
    const long = fallbackDesign("x".repeat(100));
    expect(Array.from(long.name)).toHaveLength(40);
    expect(long.name.endsWith("…")).toBe(true);
    expect(long.instructions).toBe(TEMPLATE(long.name));
    expect(fallbackDesign("...").name).toBe("New agent");
    // Different descriptions spread over the bots.
    expect(
      new Set(
        ["coach", "chef", "tutor", "editor", "analyst", "poet", "gardener", "pilot"].map(
          (d) => fallbackDesign(d).avatar,
        ),
      ).size,
    ).toBeGreaterThan(1);
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
        latenessMinutes: 120,
        catchUp: "once",
        overlap: "skip",
        profile: "standard",
        allow: [],
      },
    });

  it("removes the agent with its chats, triggers, grants and memory, and tells the PWA", async () => {
    server = await startSignedIn();
    const made = (await create("a researcher")).body as { agent: Agent; session: Session };
    const other = (await create("a cook")).body as { agent: Agent; session: Session };
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
    const made = (await create("a writer")).body as { agent: Agent; session: Session };
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
