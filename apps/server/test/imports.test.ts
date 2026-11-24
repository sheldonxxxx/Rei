import type { Attachment, ImportTranscript, Message, Session } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { detail, filesContaining, restart, say, sessions, settled, stepPayloads } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const s = (): TestServer => server!;
const store = () => s().host.plane.store;
const agentId = () => store().defaultAgentId()!;
const day = 86_400_000;
const T0 = Date.UTC(2024, 0, 15, 9, 0, 0);

const transcript = (over: Partial<ImportTranscript> = {}): ImportTranscript => ({
  source: "test",
  sourceId: "conv-1",
  title: "Planning a garden",
  createdAt: T0,
  updatedAt: T0 + 2 * day,
  notice: "Imported from Test. Tool output was not part of the export.",
  turns: [
    { role: "user", at: T0, text: "Which herbs grow well on a sunny balcony? ZUCCHINIWORD" },
    {
      role: "assistant",
      at: T0 + 60_000,
      model: "test-model",
      thinking: ["**Considering light**\n\nSECRETTHOUGHT about sun hours"],
      text: "Basil, thyme and rosemary like full sun. PARSNIPWORD",
    },
    { role: "user", at: T0 + day, text: "And in shade?" },
    { role: "assistant", at: T0 + day + 60_000, text: "Mint and parsley cope with shade." },
  ],
  ...over,
});
const importChat = (t: ImportTranscript, agent = agentId()) =>
  s().client.post("/api/imports/sessions", { agentId: agent, transcript: t });
const search = async (q: string): Promise<{ sessionId: string }[]> =>
  (await s().client.get(`/api/history/search?q=${encodeURIComponent(q)}`)).body.hits;
const uploadFile = async (name: string, text: string): Promise<Attachment> => {
  const form = new FormData();
  form.append("file", new File([text], name, { type: "text/plain" }));
  const res = await s().client.fetcher("/api/imports/files", {
    method: "POST",
    body: form,
    headers: { cookie: `rei_session=${s().client.cookie}`, "x-rei": "1" },
  });
  expect(res.status).toBe(200);
  return (await res.json()).attachment;
};
const shown = (messages: Message[]) => messages.map((m) => [m.role, m.text]);

describe("importing a past conversation", () => {
  it("writes one chat with the original title, dates, questions and answers, and no model call", async () => {
    server = await startSignedIn();
    const res = await importChat(transcript({ starred: true }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.created).toBe(true);
    const session = res.body.session as Session;
    expect(session).toMatchObject({
      origin: "import",
      title: "Planning a garden",
      pinned: true,
      createdAt: T0,
      updatedAt: T0 + 2 * day,
      preview: "Mint and parsley cope with shade.",
    });

    const d = await detail(s(), session.id);
    expect(shown(d.messages)).toEqual([
      ["notice", "Imported from Test. Tool output was not part of the export."],
      ["user", "Which herbs grow well on a sunny balcony? ZUCCHINIWORD"],
      ["assistant", "Basil, thyme and rosemary like full sun. PARSNIPWORD"],
      ["user", "And in shade?"],
      ["assistant", "Mint and parsley cope with shade."],
    ]);
    // Each question is grouped with its answer in one finished run, at the original times.
    expect(d.runs).toHaveLength(2);
    expect(d.runs.every((r) => r.status === "completed")).toBe(true);
    const [u1, a1] = d.messages.slice(1, 3);
    expect(u1!.runId).toBe(a1!.runId);
    expect(u1!.createdAt).toBe(T0);
    expect(a1!.createdAt).toBe(T0 + 60_000);
    expect(a1!.thinking).toEqual(["**Considering light**\n\nSECRETTHOUGHT about sun hours"]);
    expect(d.messages[4]!.thinking).toBeUndefined();
    expect(a1!.forkable).toBe(true);

    // No model ran, nothing was titled or notified, and nothing is up for the memory review.
    expect(stepPayloads(s(), session.id)).toEqual([]);
    expect(store().db.all("SELECT * FROM lifecycle_outbox WHERE session_id = ?", session.id)).toEqual([]);
    expect(store().db.all("SELECT * FROM outbox WHERE session_id = ?", session.id)).toEqual([]);

    // Sorted by its original date: an older chat than one made today.
    const today = (await s().client.post("/api/sessions", {})).body.session.id as string;
    const order = (await sessions(s())).map((x) => x.id);
    expect(order.indexOf(today)).toBeLessThan(order.indexOf(session.id));
  });

  it("makes questions and answers searchable, never the thinking", async () => {
    server = await startSignedIn();
    const id = (await importChat(transcript())).body.session.id as string;
    await until(async () => ((await search("ZUCCHINIWORD")).length > 0 ? true : undefined), 10_000, "user text hit");
    expect((await search("ZUCCHINIWORD")).some((h) => h.sessionId === id)).toBe(true);
    expect((await search("PARSNIPWORD")).some((h) => h.sessionId === id)).toBe(true);
    expect((await search("SECRETTHOUGHT")).some((h) => h.sessionId === id)).toBe(false);
  });

  it("continues like any chat: the model sees the earlier messages but not the thinking", async () => {
    server = await startSignedIn();
    const id = (await importChat(transcript())).body.session.id as string;
    await say(s(), id, "What about winter?");
    const d = await settled(s(), id, 3);
    expect(d.runs.at(-1)!.status).toBe("completed");
    expect(d.messages.at(-1)!.role).toBe("assistant");
    const payload = stepPayloads(s(), id).join("\n");
    expect(payload).toContain("ZUCCHINIWORD");
    expect(payload).toContain("PARSNIPWORD");
    expect(payload).toContain("What about winter?");
    expect(payload).not.toContain("SECRETTHOUGHT");
    // The new turn is your own words in your own chat: it may be reviewed; the imported ones never are.
    const rows = store().db.all<{ run_id: string; eligible: number }>(
      "SELECT run_id, eligible FROM lifecycle_outbox WHERE session_id = ? AND kind = 'run.completed'",
      id,
    );
    expect(rows).toEqual([{ run_id: d.runs.at(-1)!.id, eligible: 1 }]);
    // A chat that is moving again keeps its title.
    expect(store().getSession(id)!.title).toBe("Planning a garden");
  });

  it("is idempotent by source id, and a deleted import can be imported again", async () => {
    server = await startSignedIn();
    const first = (await importChat(transcript())).body;
    const again = await importChat(transcript({ title: "Changed" }));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, session: { id: first.session.id, title: "Planning a garden" } });
    expect((await sessions(s())).filter((x) => x.origin === "import")).toHaveLength(1);

    const lookup = await s().client.post("/api/imports/lookup", { source: "test", sourceIds: ["conv-1", "conv-2"] });
    expect(lookup.body).toEqual({ found: [{ sourceId: "conv-1", sessionId: first.session.id }] });

    await until(async () => ((await search("ZUCCHINIWORD")).length > 0 ? true : undefined), 10_000, "indexed");
    expect((await s().client.call("DELETE", `/api/sessions/${first.session.id}`)).status).toBe(200);
    expect(await search("ZUCCHINIWORD")).toEqual([]);
    expect(
      (await s().client.post("/api/imports/lookup", { source: "test", sourceIds: ["conv-1"] })).body.found,
    ).toEqual([]);

    const redo = await importChat(transcript());
    expect(redo.body.created).toBe(true);
    expect(redo.body.session.id).not.toBe(first.session.id);
  });

  it("redoes an import a crash left half-written", async () => {
    server = await startSignedIn();
    // A pending import with its half-made chat, as a process that died mid-import leaves it.
    const half = store().beginImport(agentId(), "test", "conv-1");
    server = (await restart(s())) as typeof server;
    const res = await importChat(transcript());
    expect(res.body.created).toBe(true);
    expect(res.body.session.id).not.toBe(half.session.id);
    await until(async () => (store().getSessionRowAny(half.session.id)?.deleted_at ? true : undefined), 5_000, "gone");
    expect((await sessions(s())).filter((x) => x.origin === "import").map((x) => x.id)).toEqual([res.body.session.id]);
  });

  it("carries uploaded files and shows missing ones as placeholders", async () => {
    server = await startSignedIn();
    const notes = await uploadFile("notes.txt", "soil pH 6.5");
    const res = await importChat(
      transcript({
        turns: [
          {
            role: "user",
            at: T0,
            text: "Here are my notes",
            attachments: [
              { name: "notes.txt", mediaType: "text/plain", size: 11, attachmentId: notes.id },
              { name: "photo.jpg", mediaType: "image/jpeg", size: 123_456 },
              { name: "video.mp4", mediaType: "video/mp4", size: 99_000_000, unavailable: "Too large to import" },
            ],
          },
          { role: "assistant", at: T0 + 1000, text: "Thanks." },
        ],
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const id = res.body.session.id as string;
    const user = (await detail(s(), id)).messages.find((m) => m.role === "user")!;
    expect(user.attachments).toEqual([
      { id: notes.id, name: "notes.txt", mediaType: "text/plain", size: 11 },
      expect.objectContaining({
        name: "photo.jpg",
        mediaType: "image/jpeg",
        size: 123_456,
        unavailable: "Not in export",
      }),
      expect.objectContaining({ name: "video.mp4", unavailable: "Too large to import" }),
    ]);
    const bytes = await s().client.fetcher(`/api/sessions/${id}/attachments/${notes.id}`, {
      headers: { cookie: `rei_session=${s().client.cookie}` },
    });
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe("soil pH 6.5");

    // A file is used once: another import cannot claim it.
    const other = await importChat(
      transcript({
        sourceId: "conv-2",
        turns: [
          {
            role: "user",
            at: T0,
            text: "x",
            attachments: [{ name: "n.txt", mediaType: "text/plain", size: 11, attachmentId: notes.id }],
          },
        ],
      }),
    );
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe("attachment_unavailable");
    expect((await sessions(s())).filter((x) => x.origin === "import")).toHaveLength(1);
  });

  it("handles a chat that starts with a reply, unanswered questions, and replies in a row", async () => {
    server = await startSignedIn();
    const res = await importChat(
      transcript({
        notice: undefined,
        turns: [
          { role: "assistant", at: T0, text: "Hello! How can I help?" },
          { role: "user", at: T0 + 1, text: "First question" },
          { role: "user", at: T0 + 2, text: "Second question" },
          { role: "assistant", at: T0 + 3, text: "Part one.", thinking: ["a"] },
          { role: "assistant", at: T0 + 4, text: "Part two.", thinking: ["b"] },
          { role: "assistant", at: T0 + 5, text: "", thinking: ["c"] },
          { role: "user", at: T0 + 6, text: "Unanswered" },
        ],
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = await detail(s(), res.body.session.id);
    expect(shown(d.messages.filter((m) => m.text !== ""))).toEqual([
      ["notice", "This chat was imported. Only its messages came along."],
      ["notice", "The chat began with this reply."],
      ["assistant", "Hello! How can I help?"],
      ["user", "First question"],
      ["user", "Second question"],
      ["assistant", "Part one.\n\nPart two."],
      ["user", "Unanswered"],
    ]);
    expect(d.messages.find((m) => m.text === "Part one.\n\nPart two.")!.thinking).toEqual(["a", "b", "c"]);
    expect(d.runs.every((r) => r.status === "completed")).toBe(true);
    expect(res.body.session.preview).toBe("Unanswered");
  });

  it("keeps a long chat within limits and pages it like any other", async () => {
    server = await startSignedIn();
    const turns: ImportTranscript["turns"] = [];
    for (let i = 0; i < 1000; i++) {
      turns.push({ role: "user", at: T0 + i * 2000, text: `Question ${i} ${"q".repeat(120)}` });
      turns.push({ role: "assistant", at: T0 + i * 2000 + 1000, text: `Answer ${i} ${"a".repeat(120)}` });
    }
    const res = await importChat(transcript({ turns }));
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    const d = await detail(s(), res.body.session.id);
    expect(d.messages.at(-1)!.text.startsWith("Answer 999 ")).toBe(true);
    expect(d.messages.length).toBeLessThan(200);
    expect(store().runs.forSession(res.body.session.id)).toHaveLength(1000);
  }, 60_000);

  it("refuses an unknown agent and leaves nothing behind", async () => {
    server = await startSignedIn();
    const res = await importChat(transcript(), "agt_missing");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("unknown_agent");
    expect((await sessions(s())).filter((x) => x.origin === "import")).toEqual([]);
    expect(filesContaining(s().dir, "ZUCCHINIWORD")).toEqual([]);
  });
});
