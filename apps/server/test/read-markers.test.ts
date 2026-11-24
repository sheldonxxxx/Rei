// Read markers (issue 11): one per session, shared by every device. Unread = agent entries (visible replies, trigger
// lines) after the marker; the marker never moves backwards, and a change reaches every device as session.upserted.
import type { Message, Session } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, homeChat, restart, say, sessions, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const s = (): TestServer => server!;
const session = async (id: string): Promise<Session> => (await detail(s(), id)).session;
const mark = (id: string, itemId: string, at: number) =>
  s().client.call("PUT", `/api/sessions/${id}/read-marker`, { body: { itemId, at } });
const replies = async (id: string): Promise<Message[]> =>
  (await detail(s(), id)).messages.filter((m) => m.role === "assistant" && m.status === "complete");

describe("read markers", () => {
  it("keeps session order and activity dates when an old chat is opened and read after restart", async () => {
    server = await startSignedIn();
    const older = await chat(s());
    await say(s(), older, "An older conversation");
    await settled(s(), older);
    server!.clock.advance(86_400_000);
    const newer = await chat(s());
    await say(s(), newer, "A newer conversation");
    await settled(s(), newer);
    const before = await sessions(s());
    server = await restart(s());
    server.clock.advance(2 * 86_400_000);

    const opened = await detail(s(), older);
    expect(opened.session.updatedAt).toBe(before.find((x) => x.id === older)!.updatedAt);
    const reply = opened.messages.find((m) => m.role === "assistant")!;
    expect((await mark(older, reply.id, reply.createdAt)).body.unread).toBe(0);
    await detail(s(), newer);
    const after = await sessions(s());
    expect(after.map((x) => [x.id, x.updatedAt])).toEqual(before.map((x) => [x.id, x.updatedAt]));

    await say(s(), older, "New activity should still move this chat first");
    await settled(s(), older, 2);
    expect((await sessions(s()))[0]!.id).toBe(older);
  });

  it("counts each visible agent reply as unread, and not the user's own messages", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    expect((await session(id)).unread).toBe(0);
    await say(s(), id, "hello");
    await settled(s(), id);
    expect((await session(id)).unread).toBe(1);
    await say(s(), id, "again");
    await settled(s(), id, 2);
    expect((await session(id)).unread).toBe(2);
    const listed = (await s().client.get("/api/sessions")).body.sessions as Session[];
    expect(listed.find((x) => x.id === id)?.unread).toBe(2);
  });

  it("advances to a seen item, recounts, and never moves backwards", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await say(s(), id, "one");
    await settled(s(), id);
    await say(s(), id, "two");
    await settled(s(), id, 2);
    const [first, second] = await replies(id);
    expect(first && second).toBeTruthy();

    const res = await mark(id, first!.id, first!.createdAt);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ marker: { itemId: first!.id, at: first!.createdAt }, unread: 1 });
    expect((await session(id)).unread).toBe(1);

    expect((await mark(id, second!.id, second!.createdAt)).body.unread).toBe(0);
    // An older item (another device catching up) leaves the marker where it is.
    const back = await mark(id, first!.id, first!.createdAt);
    expect(back.body).toEqual({ marker: { itemId: second!.id, at: second!.createdAt }, unread: 0 });
    expect((await session(id)).unread).toBe(0);
  });

  it("counts a trigger line in the home chat as an agent entry", async () => {
    server = await startSignedIn();
    const home = homeChat(s());
    expect((await session(home)).unread).toBe(0);
    await s().host.plane.adapter.commands.triggerLine(home, {
      kind: "notify",
      triggerId: "trg_test",
      triggerName: "Morning check",
      triggerRunId: null,
      sessionId: null,
      text: "Good morning",
    });
    expect((await session(home)).unread).toBe(1);
  });

  it("tells every device when the count changes, so another browser clears its badge", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await say(s(), id, "hello");
    await settled(s(), id);
    const stream = await s().sse("/api/stream");
    await stream.waitFor((e) => e.event === "snapshot");
    const [reply] = await replies(id);
    await mark(id, reply!.id, reply!.createdAt);
    const upserted = await stream.waitFor(
      (e) => e.event === "session.upserted" && e.data.session.id === id && e.data.session.unread === 0,
    );
    expect(upserted.id).toBeDefined();
    await stream.close();
  });

  it("refuses an unknown session and a malformed marker", async () => {
    server = await startSignedIn();
    expect((await mark("ses_missing", "a:x", 1)).status).toBe(404);
    const id = await chat(s());
    const bad = await mark(id, "", -1);
    expect(bad.status).toBe(400);
    expect(bad.body.error.issues.length).toBeGreaterThan(0);
  });

  it("a reply that arrives after the marker is unread again", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await say(s(), id, "one");
    await settled(s(), id);
    const [first] = await replies(id);
    await mark(id, first!.id, first!.createdAt);
    expect((await session(id)).unread).toBe(0);
    await say(s(), id, "two");
    await settled(s(), id, 2);
    await until(async () => (await session(id)).unread === 1, 5_000, "the new reply to count");
  });
});
