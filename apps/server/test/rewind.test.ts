import type { Message } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { approve, askApproval, setProfile, todo, waitPending } from "./helpers/approvals.ts";
import { until, ViewReader } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const s = (): TestServer => server!;
const edit = (id: string, body: unknown) => s().client.post(`/api/sessions/${id}/edit`, body);
const switchVersion = (id: string, messageId: string, to: "prev" | "next") =>
  s().client.post(`/api/sessions/${id}/version`, { messageId, to });
const users = (d: { messages: Message[] }) => d.messages.filter((m) => m.role === "user");
const userTexts = (items: readonly Message[]) => items.filter((m) => m.role === "user").map((m) => m.text);
const talk = async (id: string, text: string) => {
  const before = (await detail(s(), id)).runs.length;
  await say(s(), id, text);
  return settled(s(), id, before + 1);
};
/** Rewinds a message and waits until the new text is answered in the same chat. */
const rewind = async (id: string, messageId: string, text: string) => {
  const res = await edit(id, { messageId, text });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return until(
    async () => {
      const d = await detail(s(), id);
      const last = d.messages.at(-1);
      return d.messages.some((m) => m.id === res.body.messageId) &&
        last?.role === "assistant" &&
        last.status === "complete" &&
        d.runs.every((r) => r.status !== "running" && r.status !== "queued")
        ? d
        : undefined;
    },
    15_000,
    `the answer to "${text}"`,
  );
};
const branches = (id: string) => s().host.plane.store.branchesOf(id);
const search = async (q: string): Promise<{ sessionId: string; snippet: string }[]> =>
  (await s().client.get(`/api/history/search?q=${encodeURIComponent(q)}`)).body.hits;

describe("Rewind in place: the session stream", () => {
  it("every watcher gets a full replacement view of the new conversation, then follows it", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await talk(id, "alpha question");
    const src = await talk(id, "beta question");
    const one = new ViewReader(await s().sse(`/api/sessions/${id}/stream`));
    const two = new ViewReader(await s().sse(`/api/sessions/${id}/stream`));
    await one.waitForView((v) => userTexts(v.items).length === 2);
    await two.waitForView((v) => userTexts(v.items).length === 2);
    const snapshotsBefore = one.sse.events.filter((e) => e.event === "snapshot").length;

    const res = await edit(id, { messageId: users(src)[1]!.id, text: "beta, reworded" });
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(id);

    for (const reader of [one, two]) {
      // The answer to the new text streams in on the new conversation.
      const view = await reader.waitForView(
        (v) =>
          userTexts(v.items).join("|") === "alpha question|beta, reworded" &&
          v.items.at(-1)?.role === "assistant" &&
          v.items.at(-1)?.status === "complete",
        15_000,
        "the rewound view with its answer",
      );
      expect(view.items.some((m) => m.text === "beta question")).toBe(false);
      const snapshots = reader.sse.events.filter((e) => e.event === "snapshot");
      expect(snapshots.length).toBeGreaterThan(snapshotsBefore);
      const first = snapshots[0]!;
      const replacement = snapshots.at(-1)!;
      expect(replacement.data.epoch).not.toBe(first.data.epoch);
      for (const frame of reader.sse.events.slice(0, reader.sse.events.indexOf(replacement))) {
        if (frame.event !== "patch") continue;
        expect(frame.data.remove ?? []).not.toContain(users(src)[1]!.id);
        expect(frame.data.upsert?.some((m: Message) => m.text === "beta, reworded")).not.toBe(true);
      }
      expect(reader.error).toBeUndefined();
    }
    await one.close();
    await two.close();
  });
});

describe("Rewind in place: versions and records", () => {
  it("rewinding the first message of a version makes a sibling, not a nested branch; a later message nests", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await talk(id, "alpha question");
    const src = await talk(id, "beta question");
    const original = s().host.plane.store.getSessionRow(id)!.pi_conversation_id!;
    const v2 = await rewind(id, users(src)[1]!.id, "beta two");
    expect(userTexts(v2.messages)).toEqual(["alpha question", "beta two"]);
    expect(users(v2).map((item) => item.versions)).toEqual([undefined, { index: 2, count: 2 }]);
    const [orig, second] = branches(id);
    expect(orig).toMatchObject({ pi_conversation_id: original, parent_conversation_id: null, cut_entry_id: null });
    expect(second).toMatchObject({ parent_conversation_id: original, replaced_message_id: users(src)[1]!.id });
    expect(s().host.plane.store.getSessionRow(id)!.pi_conversation_id).toBe(second!.pi_conversation_id);

    // Version 2's first message again: a third version of the same message, hanging off the same parent at the same cut.
    const v3 = await rewind(id, users(v2)[1]!.id, "beta three");
    expect(userTexts(v3.messages)).toEqual(["alpha question", "beta three"]);
    const third = branches(id)[2]!;
    expect(third.parent_conversation_id).toBe(original);
    expect(third.cut_entry_id).toBe(second!.cut_entry_id);

    // A message after it: a branch of version 3.
    const more = await talk(id, "gamma question");
    const nested = await rewind(id, users(more)[2]!.id, "gamma two");
    expect(userTexts(nested.messages)).toEqual(["alpha question", "beta three", "gamma two"]);
    const fourth = branches(id)[3]!;
    expect(fourth.parent_conversation_id).toBe(third.pi_conversation_id);
    expect(Number(fourth.cut_entry_id)).toBeGreaterThan(Number(third.cut_entry_id));
    expect(users(nested).map((item) => item.versions)).toEqual([
      undefined,
      { index: 3, count: 3 },
      { index: 2, count: 2 },
    ]);
    const watch = new ViewReader(await s().sse(`/api/sessions/${id}/stream`));
    await watch.waitForView((v) => userTexts(v.items).includes("gamma two"));
    const start = watch.sse.events.filter((event) => event.event === "snapshot").length;

    expect((await switchVersion(id, users(nested)[1]!.id, "prev")).status).toBe(200);
    const selected = await watch.waitForView((v) => userTexts(v.items).join("|") === "alpha question|beta two");
    expect(users({ messages: selected.items })[1]!.versions).toEqual({ index: 2, count: 3 });
    expect(watch.sse.events.filter((event) => event.event === "snapshot").length).toBeGreaterThan(start);
    const current = await detail(s(), id);
    expect(current.session.preview).not.toContain("gamma");
    expect((await switchVersion(id, users(current)[1]!.id, "prev")).status).toBe(200);
    const oldest = await detail(s(), id);
    expect(userTexts(oldest.messages)).toEqual(["alpha question", "beta question"]);
    expect(users(oldest)[1]!.versions).toEqual({ index: 1, count: 3 });
    expect((await switchVersion(id, users(oldest)[1]!.id, "prev")).body.error.code).toBe("no_version");
    expect((await switchVersion(id, users(oldest)[1]!.id, "next")).status).toBe(200);
    expect((await switchVersion(id, users(current)[1]!.id, "next")).status).toBe(200);
    expect(userTexts((await detail(s(), id)).messages)).toEqual(["alpha question", "beta three", "gamma two"]);
    expect(s().host.plane.store.getSessionRow(id)!.pi_conversation_id).toBe(fourth.pi_conversation_id);
    await watch.close();
    // Still one chat.
    const list = (await s().client.get("/api/sessions")).body.sessions as { id: string }[];
    expect(list.filter((x) => x.id === id)).toHaveLength(1);
  });

  it("a rewind of the first message keeps nothing, then a later rewind there is a sibling of it", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const src = await talk(id, "alpha question");
    await talk(id, "beta question");
    const one = await rewind(id, users(src)[0]!.id, "alpha two");
    expect(userTexts(one.messages)).toEqual(["alpha two"]);
    const two = await rewind(id, users(one)[0]!.id, "alpha three");
    expect(userTexts(two.messages)).toEqual(["alpha three"]);
    const [orig, a, b] = branches(id);
    expect(a!.cut_entry_id).toBeNull();
    expect(b!.cut_entry_id).toBeNull();
    expect(a!.parent_conversation_id).toBe(orig!.pi_conversation_id);
    expect(b!.parent_conversation_id).toBe(orig!.pi_conversation_id);
    expect(two.session.title).toBe(src.session.title);
    expect(users(two)[0]!.versions).toEqual({ index: 3, count: 3 });
    expect((await switchVersion(id, users(two)[0]!.id, "prev")).status).toBe(200);
    expect((await switchVersion(id, users(one)[0]!.id, "prev")).status).toBe(200);
    const original = await detail(s(), id);
    expect(userTexts(original.messages)).toEqual(["alpha question", "beta question"]);
    expect(users(original)[0]!.versions).toEqual({ index: 1, count: 3 });
  });

  it("refuses rewind and switching while an approval waits", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const src = await talk(id, "alpha question");
    const current = await rewind(id, users(src)[0]!.id, "alpha two");
    await setProfile(s(), id, "strict");
    await say(s(), id, todo("milk"));
    await waitPending(s(), id, 1);
    const messageId = users(current)[0]!.id;
    for (const res of [
      await edit(id, { messageId, text: "alpha again" }),
      await switchVersion(id, messageId, "prev"),
    ]) {
      expect([res.status, res.body.error.code]).toEqual([409, "busy"]);
      expect(res.body.error.message).toBe("Wait for the reply to finish, or stop it.");
    }
    expect(branches(id)).toHaveLength(2);
  });

  it("recall, cards and runs follow the active chain: the replaced tail is not found or shown", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await talk(id, "PREFIXWORD alpha question");
    await setProfile(s(), id, "strict");
    await askApproval(s(), id, todo("milk"));
    await approve(s(), id, { length: "once" });
    const tail = await talk(id, "TAILWORD beta question");
    expect(tail.messages.some((m) => m.role === "approval")).toBe(true);
    await s().host.plane.memory.history.settle();
    expect((await search("TAILWORD")).some((h) => h.sessionId === id)).toBe(true);

    // Rewind the last message: the prefix (its words, its approval card, its runs) stays, the tail goes.
    const middle = await rewind(id, users(tail).at(-1)!.id, "MIDWORD beta again");
    expect(middle.messages.filter((m) => m.role === "approval")).toHaveLength(1);
    expect(middle.runs.map((r) => r.id)).toEqual(expect.arrayContaining(tail.runs.slice(0, 2).map((r) => r.id)));
    await s().host.plane.memory.history.settle();
    expect((await search("TAILWORD")).some((h) => h.sessionId === id)).toBe(false);
    expect((await search("PREFIXWORD")).some((h) => h.sessionId === id)).toBe(true);
    expect((await search("MIDWORD")).some((h) => h.sessionId === id)).toBe(true);

    // Rewind the first message: the approval card and everything after belong to the replaced versions.
    const after = await rewind(id, users(middle)[0]!.id, "fresh start");
    expect(after.messages.some((m) => m.role === "approval")).toBe(false);
    expect(after.runs.map((r) => r.id)).not.toContain(tail.runs.at(-1)!.id);
    await s().host.plane.memory.history.settle();
    expect((await search("TAILWORD")).some((h) => h.sessionId === id)).toBe(false);
    expect((await search("PREFIXWORD")).some((h) => h.sessionId === id)).toBe(false);
    expect((await search("MIDWORD")).some((h) => h.sessionId === id)).toBe(false);
    const view = await s().client.get(`/api/sessions/${id}`);
    expect(view.body.messages.some((m: Message) => m.role === "approval")).toBe(false);
    expect((await switchVersion(id, users(after)[0]!.id, "prev")).status).toBe(200);
    const restored = await detail(s(), id);
    expect(restored.messages.some((m) => m.role === "approval")).toBe(true);
    expect(restored.runs.map((r) => r.id)).toEqual(middle.runs.map((r) => r.id));
    expect((await switchVersion(id, users(restored).at(-1)!.id, "prev")).status).toBe(200);
    await s().host.plane.memory.history.settle();
    expect((await search("TAILWORD")).some((h) => h.sessionId === id)).toBe(true);
    expect((await search("MIDWORD")).some((h) => h.sessionId === id)).toBe(false);
  });

  it("updates a fork's source link as its source message becomes hidden and visible again", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const src = await talk(id, "original question");
    const reply = src.messages.find((m) => m.role === "assistant")!;
    const forked = await s().client.post(`/api/sessions/${id}/fork`, { messageId: reply.id });
    expect(forked.status).toBe(200);
    const forkId = forked.body.session.id;
    const watch = new ViewReader(await s().sse(`/api/sessions/${forkId}/stream`));
    await watch.waitForView((v) => v.session.forkedFrom?.messageId === reply.id);
    const replaced = await rewind(id, users(src)[0]!.id, "different question");
    await watch.waitForView((v) => v.session.forkedFrom?.onAnotherVersion === true);
    expect((await detail(s(), forkId)).session.forkedFrom?.onAnotherVersion).toBe(true);
    await talk(forkId, "follow up in the fork");
    expect((await switchVersion(id, users(replaced)[0]!.id, "prev")).status).toBe(200);
    await watch.waitForView((v) => !v.session.forkedFrom?.onAnotherVersion);
    await watch.close();
  });

  it("deleting the chat purges every version's Rei records while a surviving fork keeps using the tree", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const prefix = await talk(id, "PURGEALPHA question");
    const reply = prefix.messages.find((m) => m.role === "assistant")!;
    const forked = await s().client.post(`/api/sessions/${id}/fork`, { messageId: reply.id });
    expect(forked.status).toBe(200);
    const src = await talk(id, "PURGEBETA question");
    await rewind(id, users(src)[1]!.id, "PURGEGAMMA question");
    const db = s().host.plane.store.db;
    await s().host.plane.memory.history.settle();
    expect(
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_entries WHERE session_id = ?", id)!.n,
    ).toBeGreaterThan(0);
    expect((await s().client.call("DELETE", `/api/sessions/${id}`)).status).toBe(200);
    await until(() => !s().host.plane.store.getSessionRowAny(id) || branches(id).length === 0, 10_000, "the purge");
    expect(branches(id)).toHaveLength(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_entries WHERE session_id = ?", id)!.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM session_branches WHERE session_id = ?", id)!.n).toBe(0);
    const child = await talk(forked.body.session.id, "the fork still answers");
    expect(userTexts(child.messages)).toEqual(["PURGEALPHA question", "the fork still answers"]);
  });
});
