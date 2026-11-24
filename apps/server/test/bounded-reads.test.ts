// Files can be 1 GiB, but nothing loads one whole into memory or hands it to a model. Each path that needs the bytes in
// memory keeps a smaller limit of its own and says so; the file itself stays stored and downloadable. The sizes here are
// written into the database, so no large file is made.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Attachment, LibraryFile } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICE_PREVIEW_MAX_BYTES } from "../src/attachments/office-preview.ts";
import { MEMORY_READ_MAX_BYTES } from "../src/attachments/service.ts";
import { BROWSER_UPLOAD_MAX_BYTES, readUploadSource } from "../src/browser/upload-source.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

async function post(s: TestServer, path: string, name: string, content = "small bytes") {
  const form = new FormData();
  form.append("file", new File([content], name));
  const response = await s.client.fetcher(path, {
    method: "POST",
    body: form,
    headers: { cookie: `rei_session=${s.client.cookie}`, "x-rei": "1" },
  });
  expect(response.status).toBe(200);
  return response.json();
}

const resize = (s: TestServer, attachmentId: string, size: number) =>
  s.host.plane.store.db.run("UPDATE attachments SET size = ? WHERE id = ?", size, attachmentId);

describe("bounded reads of large files", () => {
  it("refuses an Office preview over 100 MiB and still serves the original", async () => {
    server = await startSignedIn();
    const s = server;
    const id = await chat(s);
    const attachment: Attachment = (await post(s, `/api/sessions/${id}/attachments`, "deck.pptx")).attachment;
    resize(s, attachment.id, OFFICE_PREVIEW_MAX_BYTES + 1);
    const preview = await s.client.raw("GET", `/api/sessions/${id}/attachments/${attachment.id}/preview`);
    expect(preview.status).toBe(413);
    const body = await preview.json();
    expect(body.error.code).toBe("preview_too_large");
    expect(body.error.message).toContain("100 MiB");
  });

  it("reads a file into memory only under a limit, and its start at any size", async () => {
    server = await startSignedIn();
    const s = server;
    const attachments = s.host.plane.adapter.attachments!;
    const file: LibraryFile = (await post(s, "/api/files", "notes.txt", "0123456789")).file;
    const row = () => attachments.row(file.current.attachmentId)!;
    expect(new TextDecoder().decode(await attachments.bytes(row()))).toBe("0123456789");
    await expect(attachments.bytes(row(), 4)).rejects.toMatchObject({ status: 413, code: "file_too_large_to_read" });
    resize(s, file.current.attachmentId, MEMORY_READ_MAX_BYTES + 1);
    await expect(attachments.bytes(row())).rejects.toMatchObject({ status: 413, code: "file_too_large_to_read" });
    resize(s, file.current.attachmentId, 10);
    expect(new TextDecoder().decode(await attachments.head(row(), 4))).toBe("0123");
  });

  it("refuses an HTML preview over 2 MiB", async () => {
    server = await startSignedIn();
    const s = server;
    const file: LibraryFile = (await post(s, "/api/files", "page.html", "<p>hi</p>")).file;
    resize(s, file.current.attachmentId, 2 * 1024 * 1024 + 1);
    const response = await s.client.raw("GET", `/api/files/${file.id}/versions/${file.current.versionId}/html`);
    expect(response.status).toBe(413);
  });

  it("hands a website a Library file of at most 25 MiB", async () => {
    server = await startSignedIn();
    const s = server;
    const id = await chat(s);
    const file: LibraryFile = (await post(s, "/api/files", "form.pdf", "%PDF-1.7")).file;
    const library = s.host.plane.adapter.attachments!.library!;
    const session = s.host.plane.store.getSessionRow(id)!;
    const source = { type: "library" as const, fileId: file.id, versionId: file.current.versionId };
    const read = await readUploadSource(source, session, { library }, BACKGROUND_CONTEXT);
    expect(new TextDecoder().decode(read.bytes)).toBe("%PDF-1.7");
    resize(s, file.current.attachmentId, BROWSER_UPLOAD_MAX_BYTES + 1);
    await expect(readUploadSource(source, session, { library }, BACKGROUND_CONTEXT)).rejects.toThrow(
      "Files uploaded to a website can be at most 25 MiB.",
    );
  });
});
