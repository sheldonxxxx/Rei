import type { Message } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, sessions, settled, stepPayloads, treeOf } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const fork = (id: string, messageId: string) => server!.client.post(`/api/sessions/${id}/fork`, { messageId });
const assistants = (d: { messages: Message[] }): Message[] => d.messages.filter((m) => m.role === "assistant");

describe("fork", () => {
  it("opens a new session in the same tree with the messages up to the fork point, independent of the source", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await say(server, a, "alpha question");
    await settled(server, a, 1);
    await say(server, a, "beta question");
    const src = await settled(server, a, 2);
    await say(server, a, "gamma question");
    await settled(server, a, 3);
    const firstReply = assistants(src)[0]!;
    expect(firstReply.forkable).toBe(true);

    const res = await fork(a, firstReply.id);
    expect(res.status).toBe(200);
    const forked = res.body.session;
    expect(forked).toMatchObject({
      origin: "fork",
      agentId: (await detail(server, a)).session.agentId,
      depth: 0,
      parentSessionId: null,
      status: "idle",
    });
    expect(forked.forkedFrom).toEqual({ sessionId: a, messageId: firstReply.id });
    expect(forked.title).toBe((await detail(server, a)).session.title);
    expect(treeOf(server, forked.id)).toBe(treeOf(server, a));

    const f = await detail(server, forked.id);
    expect(f.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(f.messages[0]!.text).toBe("alpha question");
    expect(f.messages[1]!.text).toBe(firstReply.text);
    // Item ids come from the copied entries: the same as in the source chat, but the run is not this chat's.
    expect(f.messages[1]!.id).toBe(firstReply.id);
    expect(f.messages[1]!.runId).toBeNull();
    expect(f.messages[1]!.forkable).toBe(true);
    expect(f.runs).toHaveLength(0);

    // Independent: a new message in the fork does not reach the source, and the other way round.
    await say(server, forked.id, "fork only question");
    const f2 = await settled(server, forked.id, 1);
    expect(f2.messages.map((m) => m.text).join("|")).toContain("fork only question");
    await say(server, a, "source only question");
    const s2 = await settled(server, a, 4);
    expect(s2.messages.map((m) => m.text).join("|")).not.toContain("fork only question");
    expect((await detail(server, forked.id)).messages.map((m) => m.text).join("|")).not.toContain(
      "source only question",
    );
    expect((await detail(server, forked.id)).messages.map((m) => m.text).join("|")).not.toContain("beta question");
    expect((await sessions(server)).filter((s) => s.id === forked.id)).toHaveLength(1);
  });

  it("gives the fork's model the history up to the fork point, and nothing after it", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await say(server, a, "FIRST-MARK question");
    const d1 = await settled(server, a, 1);
    await say(server, a, "SECOND-MARK question");
    await settled(server, a, 2);
    const forked = (await fork(a, assistants(d1)[0]!.id)).body.session;
    await say(server, forked.id, "what did I ask");
    await settled(server, forked.id, 1);
    const payloads = stepPayloads(server, forked.id);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toContain("FIRST-MARK");
    expect(payloads[0]).toContain("what did I ask");
    expect(payloads[0]).not.toContain("SECOND-MARK");
    // Its trace steps belong to the fork, not to the source.
    expect(stepPayloads(server, a)).toHaveLength(2);
  });

  it("works while the source is busy, and neither disturbs the other", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await say(server, a, "quick one");
    const d1 = await settled(server, a, 1);
    await say(server, a, "slow one [len=9000]");
    await until(async () => assistants(await detail(server!, a)).length === 2, 10_000, "the long reply to start");

    const forked = (await fork(a, assistants(d1)[0]!.id)).body.session;
    await say(server, forked.id, "fork question");
    const f = await settled(server, forked.id, 1);
    expect(f.runs[0]!.status).toBe("completed");
    expect((await detail(server, a)).runs[1]!.status).toBe("running"); // the source was still going

    const s = await settled(server, a, 2);
    expect(s.runs.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(assistants(s)[1]!.text.length).toBe(9000);
    expect(s.messages.map((m) => m.text).join("|")).not.toContain("fork question");
  });

  it("forks a fork, and the copied replies stay forkable", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await say(server, a, "one");
    const d1 = await settled(server, a, 1);
    const f1 = (await fork(a, assistants(d1)[0]!.id)).body.session;
    await say(server, f1.id, "two");
    const d2 = await settled(server, f1.id, 1);
    const copied = assistants(await detail(server, f1.id))[0]!;
    const f2 = (await fork(f1.id, copied.id)).body.session;
    expect(f2.forkedFrom).toEqual({ sessionId: f1.id, messageId: copied.id });
    const nested = await detail(server, f2.id);
    expect(nested.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const own = assistants(d2)[1]!;
    const f3 = (await fork(f1.id, own.id)).body.session;
    expect((await detail(server, f3.id)).messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    await say(server, f3.id, "three");
    await settled(server, f3.id, 1);
    expect(treeOf(server, f3.id)).toBe(treeOf(server, a));
  });

  it("refuses messages that cannot be forked and unknown ids", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    const b = await chat(server);
    await say(server, a, "hello");
    const d = await settled(server, a, 1);
    const userMessage = d.messages.find((m) => m.role === "user")!;
    const r = await fork(a, userMessage.id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("not_forkable");
    expect((await fork(a, "msg_nope")).status).toBe(404);
    expect((await fork("ses_nope", userMessage.id)).status).toBe(404);
    // A message of another session is unknown to this one.
    expect((await fork(b, assistants(d)[0]!.id)).status).toBe(404);
    expect((await server.client.post(`/api/sessions/${a}/fork`, {})).status).toBe(400);

    // A reply that is still streaming is not forkable yet.
    await say(server, a, "long [len=9000]");
    const streaming = await until(
      async () => assistants(await detail(server!, a)).find((m) => m.status === "streaming"),
      10_000,
      "streaming",
    );
    expect((await fork(a, streaming.id)).status).toBe(409);

    // A failed reply is not forkable either.
    await settled(server, a, 2);
    await say(server, a, "boom [error]");
    const failed = await settled(server, a, 3);
    const errored = failed.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(errored.status).toBe("error");
    expect((await fork(a, errored.id)).status).toBe(409);
  });

  it("is protected like the other endpoints: sign-in and the CSRF header", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await say(server, a, "hello");
    const d = await settled(server, a, 1);
    const id = assistants(d)[0]!.id;
    expect((await server.client.post(`/api/sessions/${a}/fork`, { messageId: id }, { cookie: false })).status).toBe(
      401,
    );
    expect((await server.client.post(`/api/sessions/${a}/fork`, { messageId: id }, { csrf: false })).status).toBe(403);
    expect((await server.client.call("DELETE", `/api/sessions/${a}`, { cookie: false })).status).toBe(401);
    expect((await server.client.call("DELETE", `/api/sessions/${a}`, { csrf: false })).status).toBe(403);
    expect((await sessions(server)).some((s) => s.id === a)).toBe(true);
  });
});
