import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Message, Run, Session } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { until, ViewReader } from "./helpers/client.ts";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";

type Detail = { session: Session; messages: Message[]; runs: Run[] };
let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const newChat = async (s: TestServer, agentId?: string) =>
  (await s.client.post("/api/sessions", agentId ? { agentId } : {})).body.session as Session;
const send = (s: TestServer, id: string, text: string, requestId: string = crypto.randomUUID()) =>
  s.client.post(`/api/sessions/${id}/messages`, { requestId, text });
const detail = async (s: TestServer, id: string) => (await s.client.get(`/api/sessions/${id}`)).body as Detail;
const settled = (s: TestServer, id: string, runs = 1) =>
  until(
    async () => {
      const d = await detail(s, id);
      return d.runs.length >= runs && d.runs.every((r) => !["queued", "running"].includes(r.status)) ? d : undefined;
    },
    20_000,
    "runs to finish",
  );

describe("seeding", () => {
  it("seeds the default agent and its home chat once, across restarts", async () => {
    server = await startSignedIn();
    const agents = (await server.client.get("/api/agents")).body;
    expect(agents.agents).toHaveLength(1);
    expect(agents.defaultAgentId).toBe(agents.agents[0].id);
    const sessions = (await server.client.get("/api/sessions")).body.sessions as Session[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.origin).toBe("home");
    expect(sessions[0]!.agentId).toBe(agents.defaultAgentId);
    expect(sessions[0]!.title).not.toBe("");

    const { dir, totpSecret } = server;
    void totpSecret;
    await server.stop();
    server = Object.assign(await startTestServer({ dir }), { totpSecret });
    // The account survives; sign in again with a fresh code step.
    server.clock.advance(31_000);
    const { totpCode } = await import("../src/auth/totp.ts");
    await server.client.post("/api/auth/login", {
      password: (await import("./helpers/server.ts")).PASSWORD,
      totpCode: await totpCode(totpSecret, server.clock.now()),
    });
    expect((await server.client.get("/api/agents")).body.agents).toHaveLength(1);
    expect((await server.client.get("/api/sessions")).body.sessions).toHaveLength(1);
  });

  it("answers unknown_agent and not_found with the protocol codes", async () => {
    server = await startSignedIn();
    const bad = await server.client.post("/api/sessions", { agentId: "nope" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("unknown_agent");
    expect((await server.client.get("/api/sessions/nope")).status).toBe(404);
    expect((await send(server, "nope", "hi")).status).toBe(404);
    expect((await server.client.post("/api/sessions/nope/cancel")).status).toBe(404);
  });

  it("validates messages: empty_message and too_long", async () => {
    server = await startSignedIn();
    const s = await newChat(server);
    const empty = await send(server, s.id, "   ");
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("empty_message");
    const long = await send(server, s.id, "x".repeat(32_001));
    expect(long.status).toBe(413);
    expect(long.body.error.code).toBe("too_long");
  });
});

describe("new chat and send", () => {
  it("creates a new tree folder per chat", async () => {
    server = await startSignedIn();
    const a = await newChat(server);
    const b = await newChat(server);
    expect(a.id).not.toBe(b.id);
    expect(a.origin).toBe("user");
    expect(a.status).toBe("idle");
    const trees = join(server.dir, "trees");
    const folders = readdirSync(trees);
    // The home chat's tree plus one per new chat.
    expect(folders.length).toBe(3);
    const treeIds = server.host.plane.store.liveTreeIds();
    expect(treeIds).toHaveLength(3);
    for (const id of treeIds) expect(existsSync(join(trees, id))).toBe(true);
  });

  it("gives deltas first, then the committed assistant message", async () => {
    server = await startSignedIn();
    const s = await newChat(server);
    const sse = new ViewReader(await server.sse(`/api/sessions/${s.id}/stream`));
    const snap = await sse.waitForView(() => true);
    expect(snap.session.id).toBe(s.id);
    const res = await send(server, s.id, "hello there [len=900]");
    expect(res.status).toBe(200);
    const { messageId, runId } = res.body;
    expect(messageId).toBeTruthy();
    expect(runId).toBeTruthy();

    // The reply grows while it streams (Pi's live generation), then completes from the stored entry.
    await sse.waitForView((v) =>
      v.items.some((i) => i.role === "assistant" && i.status === "streaming" && i.text.length > 0),
    );
    const finalView = await sse.waitForView((v) =>
      v.items.some((i) => i.role === "assistant" && i.status === "complete"),
    );
    const final = { data: { message: finalView.items.find((i) => i.role === "assistant")! } };
    const d = await settled(server, s.id);
    expect(d.messages).toHaveLength(2);
    expect(d.messages[0]).toMatchObject({
      id: messageId,
      role: "user",
      runId,
      text: "hello there [len=900]",
      status: "complete",
    });
    const reply = d.messages[1]!;
    expect(reply).toMatchObject({ role: "assistant", runId, status: "complete" });
    expect(reply.text.length).toBe(900);
    expect(final.data.message.text).toBe(reply.text);
    expect(d.runs[0]).toMatchObject({ id: runId, status: "completed" });
    expect(d.session.status).toBe("idle");
    expect(d.session.preview.length).toBeLessThanOrEqual(200);
    expect(d.session.title).toContain("hello there");

    // Every streamed text was a prefix of the final reply.
    const streamed = sse.views
      .map((v) => v.items.find((i) => i.role === "assistant" && i.status === "streaming")?.text)
      .filter((t): t is string => t !== undefined && t.length > 0);
    expect(streamed.length).toBeGreaterThan(0);
    for (const t of streamed) expect(reply.text.startsWith(t)).toBe(true);
    await sse.close();
  });

  it("is idempotent by requestId", async () => {
    server = await startSignedIn();
    const s = await newChat(server);
    const first = await send(server, s.id, "one", "req-1");
    const again = await send(server, s.id, "one", "req-1");
    expect(again.body).toEqual(first.body);
    await settled(server, s.id);
    const third = await send(server, s.id, "one", "req-1");
    expect(third.body).toEqual(first.body);
    await new Promise((r) => setTimeout(r, 300));
    const d = await detail(server, s.id);
    expect(d.runs).toHaveLength(1);
    expect(d.messages).toHaveLength(2);
  });

  it("is still idempotent after a restart, with no second run or reply", async () => {
    server = await startSignedIn();
    const s = await newChat(server);
    const first = await send(server, s.id, "survive", "req-r");
    const before = await settled(server, s.id);
    const { dir, totpSecret, clock } = server;
    const cookie = server.client.cookie;
    await server.stop();
    server = Object.assign(await startTestServer({ dir, clock }), { totpSecret });
    server.client.cookie = cookie;
    const again = await send(server, s.id, "survive", "req-r");
    expect(again.body).toEqual(first.body);
    await new Promise((r) => setTimeout(r, 500));
    const after = await detail(server, s.id);
    expect(after.runs).toHaveLength(1);
    expect(after.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(after.messages[1]!.text).toBe(before.messages[1]!.text);
  });

  it("queues a second message while the first is running and answers both in order", async () => {
    server = await startSignedIn();
    const s = await newChat(server);
    const a = await send(server, s.id, "first [len=3000]", "q-1");
    const b = await send(server, s.id, "second", "q-2");
    expect(a.body.runId).not.toBe(b.body.runId);
    const mid = await detail(server, s.id);
    expect(mid.runs.find((r) => r.id === b.body.runId)?.status).toBe("queued");
    const d = await settled(server, s.id, 2);
    expect(d.runs.map((r) => r.status)).toEqual(["completed", "completed"]);
    // Each reply sits right after its own user message, although the queued one was created while the first streamed.
    expect(d.messages.map((m) => [m.runId, m.role])).toEqual([
      [a.body.runId, "user"],
      [a.body.runId, "assistant"],
      [b.body.runId, "user"],
      [b.body.runId, "assistant"],
    ]);
    const reply = (runId: string) => d.messages.find((m) => m.runId === runId && m.role === "assistant")!;
    expect(reply(a.body.runId).text.length).toBe(3000);
    expect(reply(b.body.runId).text).toContain("Echo: second");
    expect(reply(a.body.runId).createdAt).toBeLessThanOrEqual(reply(b.body.runId).createdAt);
    expect(d.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["first [len=3000]", "second"]);
  });

  it("cancels a running reply: the partial text is kept as aborted and the run is cancelled", async () => {
    server = await startSignedIn();
    const s = await newChat(server);
    const sse = new ViewReader(await server.sse(`/api/sessions/${s.id}/stream`));
    const { body } = await send(server, s.id, "long one [len=60000]");
    await sse.waitForView((v) =>
      v.items.some((i) => i.role === "assistant" && i.status === "streaming" && i.text.length > 0),
    );
    const cancel = await server.client.post(`/api/sessions/${s.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelledRunId).toBe(body.runId);
    const d = await settled(server, s.id);
    expect(d.runs[0]!.status).toBe("cancelled");
    const reply = d.messages.find((m) => m.role === "assistant")!;
    expect(reply.status).toBe("aborted");
    expect(reply.text.length).toBeLessThan(60_000);
    expect(d.messages).toHaveLength(2);
    expect(d.session.status).toBe("idle");
    // Cancelling an idle chat is a no-op.
    expect((await server.client.post(`/api/sessions/${s.id}/cancel`)).body.cancelledRunId).toBeNull();
    // The chat still works afterwards.
    await send(server, s.id, "after the cancel");
    const d2 = await settled(server, s.id, 2);
    expect(d2.runs[1]!.status).toBe("completed");
    await sse.close();
  });

  it("withdraws queued messages on cancel", async () => {
    server = await startSignedIn();
    const s = await newChat(server);
    await send(server, s.id, "first [len=60000]");
    const queued = await send(server, s.id, "second");
    await until(
      async () => (await detail(server!, s.id)).messages.some((m) => m.role === "assistant" && m.text.length > 0),
      10_000,
      "streaming",
    );
    await server.client.post(`/api/sessions/${s.id}/cancel`);
    const d = await settled(server, s.id, 2);
    expect(d.runs.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(d.runs[1]!.id).toBe(queued.body.runId);
    expect(d.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("reports a model failure as an error message and a failed run, and the next message still works", async () => {
    server = await startSignedIn();
    const s = await newChat(server);
    await send(server, s.id, "please fail [error]");
    const d = await settled(server, s.id);
    expect(d.runs[0]!.status).toBe("failed");
    expect(d.runs[0]!.error?.code).toBe("model_error");
    const reply = d.messages.find((m) => m.role === "assistant");
    expect(reply?.status).toBe("error");
    expect(reply?.error?.code).toBe("model_error");
    expect(JSON.stringify(d)).not.toContain("faux model failure"); // no raw upstream detail
    await send(server, s.id, "and now a good one");
    const d2 = await settled(server, s.id, 2);
    expect(d2.runs[1]!.status).toBe("completed");
  });

  it("publishes session changes on the global stream", async () => {
    server = await startSignedIn();
    const g = await server.sse("/api/stream");
    const snap = await g.waitFor((e) => e.event === "snapshot");
    expect(snap.data.agents).toHaveLength(1);
    expect(snap.data.sessions).toHaveLength(1);
    const s = await newChat(server);
    await g.waitFor((e) => e.event === "session.upserted" && e.data.session.id === s.id);
    await send(server, s.id, "ping");
    await g.waitFor(
      (e) => e.event === "session.upserted" && e.data.session.id === s.id && e.data.session.status === "running",
    );
    await g.waitFor(
      (e) =>
        e.event === "session.upserted" &&
        e.data.session.id === s.id &&
        e.data.session.status === "idle" &&
        e.data.session.preview !== "",
    );
    await g.close();
  });
});
