import type { Message } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { approve, askApproval, sayAndSettle, setProfile, todo } from "./helpers/approvals.ts";
import { until, ViewReader } from "./helpers/client.ts";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.ts";
import { STANDIN, startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
let gateway: FakeGateway | undefined;
afterEach(async () => {
  await server?.destroy();
  await gateway?.close();
  server = undefined;
  gateway = undefined;
});
const s = (): TestServer => server!;
const edit = (id: string, body: unknown) => s().client.post(`/api/sessions/${id}/edit`, body);
const users = (d: { messages: Message[] }) => d.messages.filter((m) => m.role === "user");
const texts = (d: { messages: Message[] }) => d.messages.map((m) => `${m.role}:${m.text}`);
const talk = async (id: string, text: string) => {
  const before = (await detail(s(), id)).runs.length;
  await say(s(), id, text);
  return settled(s(), id, before + 1);
};

describe("Edit and Retry", () => {
  it("a middle message: the same chat is cut back to before it, then holds the new text and its answer", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await talk(id, "alpha question");
    await talk(id, "beta question");
    const src = await talk(id, "gamma question");
    const beta = users(src)[1]!;
    expect(beta.editable).toBe(true);
    const listed = (await s().client.get("/api/sessions")).body.sessions.length;

    const res = await edit(id, { messageId: beta.id, text: "beta, reworded" });
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(id);
    expect(res.body.session.forkedFrom ?? null).toBeNull();
    expect((await s().client.get("/api/sessions")).body.sessions).toHaveLength(listed);

    const d = await settled(s(), id, 2);
    expect(d.runs.some((r) => r.id === res.body.runId && r.status === "completed")).toBe(true);
    expect(d.messages.find((m) => m.id === res.body.messageId)!.text).toBe("beta, reworded");
    expect(texts(d).filter((t) => t.startsWith("user:"))).toEqual(["user:alpha question", "user:beta, reworded"]);
    expect(d.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(d.messages[3]!.text).toContain("beta, reworded");
    // The kept prefix is the same messages, with their runs.
    expect(d.messages[0]!.id).toBe(src.messages[0]!.id);
    expect(d.messages[0]!.runId).toBe(src.messages[0]!.runId);
    expect(d.messages[1]!.id).toBe(src.messages[1]!.id);
  });

  it("the model sees the history before the message, and not the edited message or what followed", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (seen) => ({ kind: "text", text: `reply ${seen.n}` }),
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const id = await chat(s());
    await talk(id, "alpha question");
    await talk(id, "beta question");
    const src = await talk(id, "gamma question");
    gateway.seen.length = 0;
    await edit(id, { messageId: users(src)[1]!.id, text: "delta question" });
    await settled(s(), id, 2);
    await until(() => gateway!.seen.length >= 1, 10_000, "the model call");
    const raw = gateway.seen.find((c) => c.raw.includes("delta question"))!.raw;
    expect(raw).toContain("alpha question");
    expect(raw).not.toContain("beta question");
    expect(raw).not.toContain("gamma question");
  });

  it("the first message: the same chat starts over with the new text, and keeps its title", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (seen) => ({ kind: "text", text: `reply ${seen.n}` }),
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const id = await chat(s());
    const src = await talk(id, "alpha question");
    await talk(id, "beta question");
    const title = (await detail(s(), id)).session.title;
    gateway.seen.length = 0;
    const res = await edit(id, { messageId: users(src)[0]!.id, text: "omega question" });
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(id);
    const d = await until(
      async () => {
        const x = await detail(s(), id);
        return x.messages.length === 2 && x.messages[1]!.status === "complete" ? x : undefined;
      },
      10_000,
      "the rewound first message and its answer",
    );
    expect(texts(d)[0]).toBe("user:omega question");
    expect(d.session.title).toBe(title);
    const raw = gateway.seen.find((c) => c.raw.includes("omega question"))!.raw;
    expect(raw).not.toContain("alpha question");
    expect(raw).not.toContain("beta question");
  });

  it("keeps the profile and the taint of the chat", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await talk(id, '[tool: demo_read_web {"url":"https://a.test"}]');
    await s().client.call("PATCH", `/api/sessions/${id}`, { body: { profile: "strict" } });
    const src = await talk(id, "second");
    expect((await detail(s(), id)).session.taint).toContain("external");
    const res = await edit(id, { messageId: users(src)[1]!.id, text: "second again" });
    expect(res.body.session.profile).toBe("strict");
    expect(res.body.session.taint).toContain("external");
    await settled(s(), id, 2);
    const first = await edit(id, { messageId: users(src)[0]!.id, text: "first again" });
    expect(first.body.session.profile).toBe("strict");
    expect(first.body.session.taint).toContain("external");
  });

  it("refuses while the chat is busy, and the message being answered is not editable until its run ends", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const done = await talk(id, "short first");
    await say(s(), id, "write a lot [len=9000]");
    const running = await until(
      async () => {
        const d = await detail(s(), id);
        return d.runs.at(-1)?.status === "running" &&
          d.messages.some((m) => m.role === "assistant" && m.status === "streaming")
          ? d
          : undefined;
      },
      10_000,
      "a streaming reply",
    );
    const busy = users(running)[1]!;
    expect(busy.editable).toBeFalsy();
    const refused = await edit(id, { messageId: busy.id, text: "never mind" });
    expect([refused.status, refused.body.error.code]).toEqual([409, "busy"]);
    // An earlier message cannot be rewound either while the reply runs: the chat says why.
    const early = await edit(id, { messageId: users(done)[0]!.id, text: "short first, again" });
    expect([early.status, early.body.error.code]).toEqual([409, "busy"]);
    expect(early.body.error.message).toBe("Wait for the reply to finish, or stop it.");
    const end = await settled(s(), id, 2);
    expect(users(end)[1]!.editable).toBe(true);
    expect(texts(end).filter((t) => t.startsWith("user:"))).toEqual([
      "user:short first",
      "user:write a lot [len=9000]",
    ]);
  });

  it("editable flips when the run ends and is announced, and is false for what you did not type", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const stream = new ViewReader(await s().sse(`/api/sessions/${id}/stream`));
    await setProfile(s(), id, "strict");
    await askApproval(s(), id, todo("milk"));
    await approve(s(), id, { length: "once" });
    const d = await detail(s(), id);
    for (const m of d.messages) {
      if (m.role === "user") expect(m.editable, m.text).toBe(true);
      else expect(m.editable, m.role).toBeFalsy();
    }
    // What the stream showed of your message over time: not editable while it was being answered, then editable.
    await stream.waitForView((v) =>
      v.items.some((m) => m.role === "user" && m.text.startsWith("[tool") && m.editable === true),
    );
    const mine = stream.views.flatMap((v) => v.items.filter((m) => m.role === "user" && m.text.startsWith("[tool")));
    expect(mine.some((m) => !m.editable)).toBe(true);
    expect(mine.at(-1)!.editable).toBe(true);
    await stream.close();
  });

  it("refuses what is not yours to edit, empty text and unknown ids", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await talk(id, "alpha question");
    const d = await talk(id, "beta question");
    const reply = d.messages.find((m) => m.role === "assistant")!;
    let res = await edit(id, { messageId: reply.id, text: "x" });
    expect([res.status, res.body.error.code]).toEqual([409, "not_editable"]);
    res = await edit(id, { messageId: users(d)[0]!.id, text: "   " });
    expect([res.status, res.body.error.code]).toEqual([400, "bad_request"]);
    res = await edit(id, { messageId: users(d)[0]!.id });
    expect(res.status).toBe(400);
    res = await edit(id, { text: "x" });
    expect(res.status).toBe(400);
    res = await edit(id, { messageId: "msg_ghost", text: "x" });
    expect([res.status, res.body.error.code]).toEqual([404, "not_found"]);
    res = await edit("ses_ghost", { messageId: users(d)[0]!.id, text: "x" });
    expect([res.status, res.body.error.code]).toEqual([404, "not_found"]);
    const other = await chat(s());
    res = await edit(other, { messageId: users(d)[0]!.id, text: "x" });
    expect(res.status).toBe(404);
    // Nothing was changed by the refusals.
    expect(s().host.plane.store.branchesOf(id)).toHaveLength(0);
    expect(texts(await detail(s(), id))).toEqual(texts(d));
  });

  it("a message a surface sent was not typed, so it cannot be edited", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const d = await talk(id, "/demo ui");
    const reply = d.messages.find((m) => m.role === "assistant")!;
    const part = reply.parts!.find((p) => p.type === "surface")!;
    const surface = (part as { surface: { surfaceId: string; revision: number } }).surface;
    const ev = await s().client.post(`/api/sessions/${id}/surfaces/${surface.surfaceId}/actions`, {
      requestId: "req_edit_1",
      revision: surface.revision,
      dataModel: { city: "Kyoto" },
      action: {
        version: "1.0",
        action: {
          name: "looks_good",
          surfaceId: surface.surfaceId,
          sourceComponentId: "ok",
          timestamp: new Date().toISOString(),
          context: { city: "Kyoto" },
        },
      },
    });
    expect(ev.status).toBe(200);
    const after = await settled(s(), id, 2);
    const msg = after.messages.find((m) => m.id === ev.body.messageId)!;
    expect(msg.editable).toBeFalsy();
    const res = await edit(id, { messageId: msg.id, text: "x" });
    expect([res.status, res.body.error.code]).toEqual([409, "not_editable"]);
  });

  it("a message after a tool call and an approval can be rewound: the cut keeps them, the tail is gone", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await sayAndSettle(s(), id, "first hello");
    await setProfile(s(), id, "strict");
    await askApproval(s(), id, todo("milk"));
    await approve(s(), id, { length: "session" });
    const d = await sayAndSettle(s(), id, "last words");
    const res = await edit(id, { messageId: users(d).at(-1)!.id, text: "last words, reworded" });
    expect(res.status).toBe(200);
    const f = await until(
      async () => {
        const x = await detail(s(), id);
        return x.messages.at(-1)?.role === "assistant" &&
          x.messages.at(-1)?.status === "complete" &&
          x.messages.some((m) => m.text === "last words, reworded")
          ? x
          : undefined;
      },
      10_000,
      "the rewound answer",
    );
    // The approval belongs to the kept prefix, so it still shows; the replaced message does not.
    expect(f.messages.filter((m) => m.role === "approval")).toHaveLength(1);
    expect(f.messages.filter((m) => m.role === "user")).toHaveLength(3);
    expect(f.messages.some((m) => m.text === "last words")).toBe(false);
    expect(f.messages.at(-1)!.text).toContain("last words, reworded");
  });
});
