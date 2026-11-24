import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "@rei/protocol";
import { ATTACHMENT_MAX_BYTES, MESSAGE_MAX_ATTACHMENT_BYTES } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentService } from "../src/attachments/service.ts";
import { indexableToolText } from "../src/memory/index.ts";
import { tool, waitPending } from "./helpers/approvals.ts";
import { type ExecServer, startExecServer } from "./helpers/exec.ts";
import { FakeMcpGateway, tool as mcpTool } from "./helpers/fake-mcp.ts";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";
import { chat, detail, settled, stepPayloads, workspaceOf } from "./helpers/sessions.ts";

let server: TestServer | ExecServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
async function upload(
  s: TestServer,
  id: string,
  file = new File(["  original\r\nbytes 🦊\n"], "../../notes.txt", { type: "text/plain" }),
  auth = true,
  csrf = true,
) {
  const form = new FormData();
  form.append("file", file);
  return s.client.fetcher(`/api/sessions/${id}/attachments`, {
    method: "POST",
    body: form,
    headers: { ...(auth ? { cookie: `rei_session=${s.client.cookie}` } : {}), ...(csrf ? { "x-rei": "1" } : {}) },
  });
}
const attach = async (s: TestServer, id: string, file?: File): Promise<Attachment> => {
  const response = await upload(s, id, file);
  expect(response.status).toBe(200);
  return (await response.json()).attachment;
};
const send = (
  s: TestServer,
  id: string,
  text: string,
  ids: string[] = [],
  mentions: unknown[] = [],
  requestId = crypto.randomUUID(),
) =>
  s.client.post(`/api/sessions/${id}/messages`, {
    requestId,
    text,
    files: ids.map((id) => {
      const a = s.host.plane.adapter.attachments!.row(id)!;
      return { fileId: a.file_id, versionId: a.version_id };
    }),
    mentions,
  });

describe("composer attachments and references", () => {
  it("requires authentication and CSRF, sanitizes filenames, and returns the exact original bytes", async () => {
    const s = (server = await startSignedIn());
    const id = await chat(s);
    expect((await upload(s, id, undefined, false)).status).toBe(401);
    expect((await upload(s, id, undefined, true, false)).status).toBe(403);
    const attachment = await attach(s, id);
    expect(attachment.name).toBe("notes.txt");
    const res = await s.client.raw("GET", `/api/sessions/${id}/attachments/${attachment.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment;");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("  original\r\nbytes 🦊\n");
    const other = await chat(s);
    expect((await s.client.get(`/api/sessions/${other}/attachments/${attachment.id}`)).status).toBe(404);
    expect((await send(s, other, "read", [attachment.id])).status).toBe(200);
  });

  it("bounds multipart uploads before parsing and enforces counts and mention ranges", async () => {
    const s = (server = await startSignedIn());
    const id = await chat(s);
    // Refused from its declared length, before a byte of the body is read (a streamed body is bounded as it arrives:
    // test/multipart.test.ts).
    const form = new FormData();
    form.append("file", new File(["small"], "big.bin"));
    const declared = await s.client.fetcher(`/api/sessions/${id}/attachments`, {
      method: "POST",
      body: new Uint8Array(await new Response(form).arrayBuffer()),
      headers: {
        cookie: `rei_session=${s.client.cookie}`,
        "x-rei": "1",
        "content-type": new Response(form).headers.get("content-type")!,
        "content-length": String(ATTACHMENT_MAX_BYTES + 65_537),
      },
    });
    expect(declared.status).toBe(413);
    expect((await declared.json()).error.message).toBe("Files can be at most 1 GiB.");
    const attachment = await attach(s, id);
    expect((await send(s, id, "read", Array(11).fill(attachment.id))).status).toBe(400);
    expect(
      (await send(s, id, "@Missing", [], [{ kind: "chat", id: "gone", label: "Missing", start: 0, end: 8 }])).body.error
        .code,
    ).toBe("bad_mention");
    expect(
      (await send(s, id, "@Other", [], [{ kind: "chat", id: await chat(s), label: "Other", start: 1, end: 6 }])).status,
    ).toBe(400);
    expect(
      (await send(s, id, "@Gone", [], [{ kind: "connector", id: "gone", label: "Gone", start: 0, end: 5 }])).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("stages arbitrary files before the model call, supports attachment-only sends, and deduplicates retries", async () => {
    const s = await startExecServer();
    server = s;
    const id = await chat(s);
    const attachment = await attach(s, id, new File([new Uint8Array([0, 1, 255, 128])], "binary.bin"));
    const requestId = crypto.randomUUID();
    const first = await send(s, id, "", [attachment.id], [], requestId);
    expect(first.status).toBe(200);
    const d = await settled(s, id);
    expect(d.runs[0]!.status).toBe("completed");
    const user = d.messages.find((m) => m.role === "user")!;
    expect(user.attachments).toEqual([attachment]);
    expect(
      readFileSync(join(s.root, workspaceOf(s, id), ".attachments", user.runId!, `${attachment.id}-binary.bin`)),
    ).toEqual(Buffer.from([0, 1, 255, 128]));
    expect(stepPayloads(s, id).join()).toContain("binary.bin");
    const again = await send(s, id, "", [attachment.id], [], requestId);
    expect(again.body).toEqual(first.body);
    expect((await detail(s, id)).runs).toHaveLength(1);
  });

  it("keeps attachments in forks after deleting their uploading chat, and preserves them when retrying", async () => {
    const s = await startExecServer();
    server = s;
    const id = await chat(s);
    const attachment = await attach(s, id);
    await send(s, id, "read", [attachment.id]);
    const d = await settled(s, id);
    const assistant = d.messages.find((m) => m.role === "assistant")!;
    const fork = (await s.client.post(`/api/sessions/${id}/fork`, { messageId: assistant.id })).body.session
      .id as string;
    expect((await detail(s, fork)).messages.find((m) => m.role === "user")!.attachments).toEqual([attachment]);
    await s.client.call("DELETE", `/api/sessions/${id}`);
    expect((await s.client.get(`/api/sessions/${fork}/attachments/${attachment.id}`)).status).toBe(200);
    const user = (await detail(s, fork)).messages.find((m) => m.role === "user")!;
    const retried = await s.client.post(`/api/sessions/${fork}/edit`, { messageId: user.id, text: "read again" });
    expect(retried.status).toBe(200);
    const next = await settled(s, retried.body.session.id);
    expect(next.messages.find((m) => m.role === "user")!.attachments).toEqual([attachment]);
    s.clock.advance(86_400_001);
    await s.host.plane.adapter.attachments!.sweep();
    expect((await s.client.get(`/api/sessions/${fork}/attachments/${attachment.id}`)).status).toBe(200);
  });

  it("fails visibly without a sandbox and leaves attachment-only messages retryable", async () => {
    const s = (server = await startSignedIn());
    const id = await chat(s);
    const attachment = await attach(s, id);
    await send(s, id, "", [attachment.id]);
    const d = await settled(s, id);
    expect(d.runs[0]!.error?.code).toBe("attachment_staging_failed");
    expect(d.messages.find((m) => m.role === "user")!.editable).toBe(true);
    expect(stepPayloads(s, id)).toEqual([]);
    const user = d.messages.find((m) => m.role === "user")!;
    const retry = await s.client.post(`/api/sessions/${id}/edit`, { messageId: user.id, text: "" });
    expect(retry.status).toBe(200);
    expect((await settled(s, retry.body.session.id)).messages.find((m) => m.role === "user")!.attachments).toEqual([
      attachment,
    ]);
  });

  it("keeps successful uploads in Library after 24 hours, including abandoned drafts", async () => {
    const s = (server = await startSignedIn());
    const id = await chat(s);
    const kept = await attach(s, id);
    const abandoned = await attach(s, id);
    await send(s, id, "keep", [kept.id]);
    await settled(s, id);
    s.clock.advance(86_400_001);
    const service = s.host.plane.adapter.attachments!;
    const abandonedObject = service.registry.row(service.row(abandoned.id)!.object_id)!;
    await service.sweep();
    expect(service.row(abandoned.id)?.file_id).toBeDefined();
    // The abandoned upload was promoted to the Library by the send, so its object must still be there.
    expect(await service.objects.head(abandonedObject.object_key)).toBeDefined();
    expect(service.row(kept.id)).toBeDefined();
  });

  it("passes stable chat references to the model and reads across agents on demand", async () => {
    const s = (server = await startSignedIn());
    const other = s.host.plane.adapter.createAgent({ name: "Other", avatar: "O", instructions: "Help." });
    await send(s, other.session.id, "remember the violet heron");
    await settled(s, other.session.id);
    const id = await chat(s);
    const mentions = [{ kind: "chat", id: other.session.id, label: "Other", start: 0, end: 6 }];
    await send(s, id, `@Other ${tool("read_chat", { session_id: other.session.id })}`, [], mentions);
    const d = await settled(s, id);
    expect(d.runs[0]!.status).toBe("completed");
    expect(d.messages.find((m) => m.role === "user")!.mentions).toEqual(mentions);
    expect(stepPayloads(s, id).join()).toContain("Referenced chat");
    expect(stepPayloads(s, id).some((payload) => payload.includes("violet heron"))).toBe(true);
    const user = d.messages.find((m) => m.role === "user")!;
    const shifted = mentions.map((m) => ({ ...m, start: m.start + 7, end: m.end + 7 }));
    const edited = await s.client.post(`/api/sessions/${id}/edit`, {
      messageId: user.id,
      text: `Prefix ${user.text}`,
      mentions: shifted,
    });
    expect(edited.status).toBe(200);
    const next = await settled(s, edited.body.session.id);
    expect(next.messages.find((m) => m.role === "user")!.mentions).toEqual(shifted);
  });

  it("enforces aggregate upload size independently of the browser", async () => {
    const s = (server = await startSignedIn());
    const id = await chat(s);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const attachment = await attach(s, id);
      ids.push(attachment.id);
      s.host.plane.store.db.run(
        "UPDATE attachments SET size = ? WHERE id = ?",
        MESSAGE_MAX_ATTACHMENT_BYTES / 4,
        attachment.id,
      );
    }
    const refused = await send(s, id, "read", ids);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain("2 GiB");
    expect(() =>
      new AttachmentService(s.host.plane.store, s.host.plane.storage.objects, s.host.plane.storage.registry).validate(
        id,
        "@x",
        [{ kind: "chat", id, label: "x", start: 0, end: 2 }],
      ),
    ).toThrow("unavailable");
  });
});

function readResult(s: TestServer, id: string) {
  const payloads = stepPayloads(s, id).map((p) => JSON.parse(p));
  const result = payloads
    .flatMap((p) => p.messages)
    .filter((m) => m.role === "toolResult" && m.toolName === "read_chat")
    .at(-1);
  return JSON.parse(result.content[0].text) as {
    messages: { id: string; text: string; offset: number; continued: boolean }[];
    next_cursor: string | null;
  };
}

describe("context recovery and history boundaries", () => {
  it("stages a queued attachment and restores mentions after a process restart", async () => {
    const s = await startSignedIn({ config: { exec: { mode: "local" } } });
    server = s;
    const id = await chat(s),
      reference = await chat(s);
    const attachment = await attach(s, id);
    const mentions = [{ kind: "chat" as const, id: reference, label: "Reference", start: 0, end: 10 }];
    // Queued for admission (as an approval's or a trigger's input is) when the process stops.
    const sent = s.host.plane.store.tx(() =>
      s.host.plane.store.queueAdmission({
        sessionId: id,
        requestId: "before-restart",
        role: "user",
        text: "@Reference read this",
        attachments: [attachment],
        mentions,
      }),
    );
    const cookie = s.client.cookie;
    await s.stop();
    const next = (server = await startTestServer({ dir: s.dir, config: { exec: { mode: "local" } } }));
    next.client.cookie = cookie;
    const d = await settled(next, id);
    expect(d.runs[0]!.status).toBe("completed");
    expect(d.messages.find((m) => m.id === sent.messageId)).toMatchObject({ attachments: [attachment], mentions });
    const payload = stepPayloads(next, id).join();
    expect(payload.includes("Referenced chat")).toBe(true);
    expect(payload.includes("notes.txt")).toBe(true);
  });

  it("paginates long messages without losing text and rejects invalid cursors", async () => {
    const s = (server = await startSignedIn());
    const source = await chat(s),
      caller = await chat(s);
    // The reply is empty ([empty]), and read_chat leaves empty replies out: only the long message is read.
    const text = `[empty]${"abcdef".repeat(2100)}`;
    await send(s, source, text);
    await settled(s, source);
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      await send(s, caller, tool("read_chat", { session_id: source, ...(cursor ? { cursor } : {}) }));
      await settled(s, caller, page + 1);
      const result = readResult(s, caller);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.text.length).toBeLessThanOrEqual(6000);
      collected.push(result.messages[0]!.text);
      cursor = result.next_cursor;
    }
    expect(collected.join("")).toBe(text);
    expect(cursor).toBeNull();
    await send(s, caller, tool("read_chat", { session_id: source, cursor: "bad" }));
    await settled(s, caller, 4);
    expect(stepPayloads(s, caller).at(-1)!.includes("Invalid chat cursor")).toBe(true);
  });

  it("propagates history provenance and refuses deleted chats", async () => {
    server = await startSignedIn();
    const s = server;
    const source = await chat(s),
      caller = await chat(s);
    await send(s, source, "private violet heron");
    const history = await settled(s, source);
    const said = history.messages.find((m) => m.role === "user")!;
    s.host.plane.store.addTaint(source, ["external", "private"]);
    await send(s, caller, tool("read_chat", { session_id: source }));
    await settled(s, caller);
    expect(readResult(s, caller).messages.find((m) => m.id === said.id)!.text).toBe("private violet heron");
    expect(JSON.parse(s.host.plane.store.getSessionRow(caller)!.taint)).toEqual(["external", "private"]);
    await s.client.call("DELETE", `/api/sessions/${source}`);
    await send(s, caller, tool("read_chat", { session_id: source }));
    await settled(s, caller, 2);
    expect(stepPayloads(s, caller).at(-1)!.includes("That chat is unavailable")).toBe(true);
  });

  it("tells the caller how to find a valid message ID when the one given is unknown", async () => {
    server = await startSignedIn();
    const s = server;
    const source = await chat(s),
      caller = await chat(s);
    await send(s, source, "hello");
    await settled(s, source);
    // A run ID is not a message ID: messages are keyed by their own ids (e.g. a:<run id>).
    await send(s, caller, tool("read_chat", { session_id: source, message_id: "run_01a1d9558937379a5f5ed629" }));
    await settled(s, caller);
    const output = stepPayloads(s, caller).at(-1)!;
    expect(output.includes("That message is unavailable.")).toBe(true);
    expect(output.includes("call read_chat with only session_id to list this chat's messages")).toBe(true);
  });

  it("connector mentions preserve approval requirements and accepted sends stay idempotent after deletion", async () => {
    const gw = new FakeMcpGateway();
    gw.add("con_notes", "Notes", [mcpTool("search_notes", "Read notes", { readOnlyHint: true })]);
    const s = (server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } }));
    const id = await chat(s);
    const requestId = crypto.randomUUID();
    const text = `@Notes ${tool("notes__search_notes", {})}`;
    const mentions = [{ kind: "connector", id: "con_notes", label: "Notes", start: 0, end: 6 }];
    const first = await send(s, id, text, [], mentions, requestId);
    expect(first.status).toBe(200);
    expect((await waitPending(s, id))[0]!.actionClass).toBe("read_external");
    expect(gw.calls).toHaveLength(0);
    expect(stepPayloads(s, id).join().includes("- notes__search_notes: Read notes")).toBe(true);
    gw.connectors = [];
    const again = await send(s, id, text, [], mentions, requestId);
    expect(again.body).toEqual(first.body);
  });
});

it("does not reindex read_chat tool results as new history", () => {
  expect(indexableToolText("read_chat", [{ type: "text", text: "retrieved history ".repeat(100) }])).toBeUndefined();
});
