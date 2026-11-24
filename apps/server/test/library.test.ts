import { ATTACHMENT_MAX_BYTES, type Attachment, type LibraryFile } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";
import { chat, detail, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
async function upload(
  s: TestServer,
  name = "notes.txt",
  content: string | Uint8Array<ArrayBuffer> = "original bytes",
  path = "/api/files",
  type = "text/plain",
): Promise<LibraryFile> {
  const form = new FormData();
  form.append("file", new File([content], name, { type }));
  const response = await s.client.fetcher(path, {
    method: "POST",
    body: form,
    headers: { cookie: `rei_session=${s.client.cookie}`, "x-rei": "1" },
  });
  expect(response.status).toBe(200);
  return (await response.json()).file;
}
const url = (file: LibraryFile, version = file.current.versionId) =>
  `/api/files/${file.id}/versions/${version}/content`;
const libraryOf = (s: TestServer) => s.host.plane.adapter.attachments!.library!;
describe("persistent Library", () => {
  it("requires login and CSRF and bounds uploads", async () => {
    const s = (server = await startSignedIn());
    expect((await s.client.get("/api/files", { cookie: false })).status).toBe(401);
    expect((await s.client.post("/api/library/folders", { name: "work" }, { csrf: false })).status).toBe(403);
    const form = new FormData();
    form.append("file", new File(["small"], "big.bin"));
    const response = await s.client.fetcher("/api/files", {
      method: "POST",
      body: new Uint8Array(await new Response(form).arrayBuffer()),
      headers: {
        cookie: `rei_session=${s.client.cookie}`,
        "x-rei": "1",
        "content-type": new Response(form).headers.get("content-type")!,
        // Over 1 GiB plus the allowance for the form around the file: refused before the body is read.
        "content-length": String(ATTACHMENT_MAX_BYTES + 65_537),
      },
    });
    expect(response.status).toBe(413);
  });
  it("saves uploads without a chat and returns exact immutable original bytes", async () => {
    const s = (server = await startSignedIn()),
      file = await upload(s);
    expect(file.origin).toBe("upload");
    expect(file.current.number).toBe(1);
    expect(await (await s.client.raw("GET", url(file))).text()).toBe("original bytes");
    expect((await s.client.get("/api/files")).body.files.map((f: LibraryFile) => f.id)).toEqual([file.id]);
    const sameName = await upload(s);
    expect(sameName.id).not.toBe(file.id);
    s.clock.advance(86_400_001);
    await s.host.plane.adapter.attachments!.sweep();
    expect(await (await s.client.raw("GET", url(file))).text()).toBe("original bytes");
  });
  it("pins versions, rejects stale updates, and restores an old version as a new version", async () => {
    const s = (server = await startSignedIn()),
      first = await upload(s);
    const second = await upload(
      s,
      "notes.txt",
      "second bytes",
      `/api/files/${first.id}/versions?baseVersionId=${first.current.versionId}`,
    );
    expect(second.id).toBe(first.id);
    expect(second.current.number).toBe(2);
    expect(await (await s.client.raw("GET", url(first))).text()).toBe("original bytes");
    const form = new FormData();
    form.append("file", new File(["stale"], "notes.txt"));
    const stale = await s.client.fetcher(`/api/files/${first.id}/versions?baseVersionId=${first.current.versionId}`, {
      method: "POST",
      body: form,
      headers: { cookie: `rei_session=${s.client.cookie}`, "x-rei": "1" },
    });
    expect(stale.status).toBe(409);
    expect((await s.client.get(`/api/files/${first.id}`)).body.versions).toHaveLength(2);
    const restored = await s.client.post(`/api/files/${first.id}/restore-version`, {
      versionId: first.current.versionId,
      baseVersionId: second.current.versionId,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.file.current.number).toBe(3);
    expect(await (await s.client.raw("GET", url(restored.body.file))).text()).toBe("original bytes");
  });
  it("reuses files across chats, carries labels, and survives source deletion", async () => {
    const s = (server = await startSignedIn()),
      source = await chat(s),
      target = await chat(s);
    const form = new FormData();
    form.append("file", new File(["shared"], "shared.txt", { type: "text/plain" }));
    const response = await s.client.fetcher(`/api/sessions/${source}/attachments`, {
      method: "POST",
      body: form,
      headers: { cookie: `rei_session=${s.client.cookie}`, "x-rei": "1" },
    });
    const attachment: Attachment = (await response.json()).attachment;
    expect(attachment.fileId).toBeTruthy();
    const sent = await s.client.post(`/api/sessions/${target}/messages`, {
      requestId: "reuse",
      text: "read",
      files: [{ fileId: attachment.fileId, versionId: attachment.versionId, location: { page: 1 } }],
    });
    expect(sent.status).toBe(200);
    await settled(s, target);
    const message = (await detail(s, target)).messages.find((m) => m.role === "user")!;
    expect(message.attachments?.[0]).toMatchObject({
      fileId: attachment.fileId,
      versionId: attachment.versionId,
      location: { page: 1 },
    });
    expect(s.host.plane.store.getSession(target)?.taint).toContain("private");
    await s.client.raw("DELETE", `/api/sessions/${source}`);
    const saved = (await s.client.get(`/api/files/${attachment.fileId}`)).body;
    expect(saved.chats.map((c: { id: string }) => c.id)).toContain(target);
    expect(await (await s.client.raw("GET", url(saved.file))).text()).toBe("shared");
    expect(await (await s.client.raw("GET", `/api/sessions/${target}/attachments/${attachment.id}`)).text()).toBe(
      "shared",
    );
  });
  it("keeps library files after deleting their creating agent", async () => {
    const s = (server = await startSignedIn());
    const created = s.host.plane.store.createAgent({
      name: "Temporary agent",
      avatar: "📄",
      instructions: "Create documents",
    });
    const a = await s.host.plane.adapter.attachments!.upload(
      created.session.id,
      new File(["agent bytes"], "deliverable.txt"),
      undefined,
      created.agent.name,
    );
    const response = await s.client.raw("DELETE", `/api/agents/${created.agent.id}`);
    expect(response.status).toBe(200);
    const saved = (await s.client.get(`/api/files/${a.fileId}`)).body;
    expect(saved.file.origin).toBe("agent");
    expect(await (await s.client.raw("GET", url(saved.file))).text()).toBe("agent bytes");
  });
  it("supports folders, favorites, searching, stable pagination and filtering", async () => {
    const s = (server = await startSignedIn()),
      file = await upload(s, "Budget.csv", "a,b", "/api/files", "text/csv");
    const folder = (await s.client.post("/api/library/folders", { name: "Travel" })).body.folder;
    const child = (await s.client.post("/api/library/folders", { name: "Receipts", parentId: folder.id })).body.folder;
    expect(
      (
        await s.client.call("PATCH", `/api/library/folders/${folder.id}`, {
          body: { name: "Loop", parentId: child.id },
        })
      ).status,
    ).toBe(400);
    await s.client.call("PATCH", `/api/files/${file.id}`, {
      body: { favorite: true, folderId: folder.id, name: "Japan.csv" },
    });
    expect((await s.client.get(`/api/files?favorite=1&folder=${folder.id}&q=japan&type=csv`)).body.files).toHaveLength(
      1,
    );
    expect((await s.client.get("/api/files?origin=agent")).body.files).toHaveLength(0);
    await s.client.raw("DELETE", `/api/library/folders/${folder.id}`);
    expect((await s.client.get(`/api/files/${file.id}`)).body.file.folderId).toBeNull();
  });
  it("restores Trash, retains chat-pinned bytes after purge and eventually collects them", async () => {
    const s = (server = await startSignedIn()),
      file = await upload(s),
      id = await chat(s);
    await s.client.post(`/api/sessions/${id}/messages`, {
      requestId: "pin",
      text: "read",
      files: [{ fileId: file.id, versionId: file.current.versionId }],
    });
    await settled(s, id);
    expect((await s.client.raw("DELETE", `/api/files/${file.id}`, { body: { confirm: true } })).status).toBe(400);
    await s.client.call("PATCH", `/api/files/${file.id}`, { body: { trashed: true } });
    expect((await s.client.get("/api/files")).body.files).toHaveLength(0);
    expect((await s.client.get("/api/files?trash=1")).body.files).toHaveLength(1);
    expect(
      (
        await s.client.post(`/api/sessions/${id}/messages`, {
          requestId: "trashed",
          text: "read",
          files: [{ fileId: file.id, versionId: file.current.versionId }],
        })
      ).status,
    ).toBe(404);
    await s.client.call("PATCH", `/api/files/${file.id}`, { body: { trashed: false } });
    expect((await s.client.get("/api/files")).body.files).toHaveLength(1);
    await s.client.call("PATCH", `/api/files/${file.id}`, { body: { trashed: true } });
    expect((await s.client.raw("DELETE", `/api/files/${file.id}`, { body: {} })).status).toBe(400);
    expect((await s.client.raw("DELETE", `/api/files/${file.id}`, { body: { confirm: true } })).status).toBe(200);
    expect((await s.client.get(`/api/files/${file.id}`)).status).toBe(404);
    expect(
      await (await s.client.raw("GET", `/api/sessions/${id}/attachments/${file.current.attachmentId}`)).text(),
    ).toBe("original bytes");
    // The file's own ledger row says where its bytes are; purging it must take both the bytes and the row's state.
    const attachments = s.host.plane.adapter.attachments!;
    const objectId = attachments.row(file.current.attachmentId)!.object_id;
    const objectKey = s.host.plane.storage.registry.row(objectId)!.object_key;
    expect(await s.host.plane.storage.objects.head(objectKey)).toBeDefined();
    await s.client.raw("DELETE", `/api/sessions/${id}`);
    await new Promise((r) => setTimeout(r, 50));
    await libraryOf(s).collect();
    expect(await s.host.plane.storage.objects.head(objectKey)).toBeUndefined();
    expect(s.host.plane.storage.registry.row(objectId)!.state).toBe("deleted");
  });
  it("expires Trash after 30 days but keeps ordinary saved uploads", async () => {
    const s = (server = await startSignedIn()),
      file = await upload(s),
      kept = await upload(s, "kept.txt");
    await s.client.call("PATCH", `/api/files/${file.id}`, { body: { trashed: true } });
    s.clock.advance(30 * 86_400_000 + 1);
    await libraryOf(s).collect();
    expect(() => libraryOf(s).row(file.id)).toThrow("unavailable");
    expect(libraryOf(s).row(kept.id).id).toBe(kept.id);
  });
  it("keeps uploaded library files through a server restart", async () => {
    const s = (server = await startSignedIn()),
      _file = await upload(s);
    const dir = s.dir,
      cookie = s.client.cookie;
    await s.stop();
    const restarted = (server = await startTestServer({ dir }));
    restarted.client.cookie = cookie;
    const list = await restarted.client.get("/api/files");
    expect(list.status).toBe(200);
    expect(list.body.files).toHaveLength(1);
    expect(await (await restarted.client.raw("GET", url(list.body.files[0]))).text()).toBe("original bytes");
  });
  it("retains embedded media without promoting scratch tool output, then publishes idempotently", async () => {
    const s = (server = await startSignedIn()),
      id = await chat(s),
      lib = libraryOf(s);
    const retained = await lib.retainMedia(id, [
      { type: "image", mimeType: "image/png", data: btoa("PNG bytes") },
      { type: "resource", mimeType: "text/plain", text: "embedded file", uri: "file:///notes.txt" },
    ]);
    expect(lib.list().files).toHaveLength(0);
    expect(lib.list().files).toHaveLength(0);
    const service = s.host.plane.adapter.attachments!;
    const a = service.row(retained[0]!.mediaId)!;
    const published = await service.upload(
      id,
      new File([await service.bytes(a)], a.name, { type: a.media_type }),
      undefined,
      "Rei",
      "stable-call",
    );
    const again = await service.upload(id, new File(["different"], "different.png"), undefined, "Rei", "stable-call");
    expect(again).toEqual(published);
    expect(lib.list().files).toHaveLength(1);
    expect(lib.list().files[0]?.origin).toBe("agent");
  });
  it("serves interactive HTML only in a sandboxed, no-network response", async () => {
    const s = (server = await startSignedIn()),
      file = await upload(
        s,
        "demo.html",
        "<script>document.body.textContent='works'</script>",
        "/api/files",
        "text/html",
      );
    const response = await s.client.raw("GET", url(file).replace(/content$/, "html"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("allow-same-origin");
    const raw = await s.client.raw("GET", url(file));
    expect(raw.headers.get("content-disposition")).toContain("attachment;");
  });
});
