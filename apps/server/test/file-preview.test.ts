import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentService } from "../src/attachments/service.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.destroy();
  server = undefined;
});
async function upload(name: string, mediaType = "application/octet-stream") {
  const s = (server = await startSignedIn()),
    id = await chat(s);
  const form = new FormData();
  form.append("file", new File(["original bytes"], name, { type: mediaType }));
  const response = await s.client.fetcher(`/api/sessions/${id}/attachments`, {
    method: "POST",
    body: form,
    headers: { cookie: `rei_session=${s.client.cookie}`, "x-rei": "1" },
  });
  const { attachment } = await response.json();
  return { s, id, url: `/api/sessions/${id}/attachments/${attachment.id}`, attachment };
}
describe("Office preview endpoint", () => {
  it("requires authentication and chat access before invoking conversion", async () => {
    const { s, url, attachment } = await upload("report.doc");
    const spy = vi.spyOn(AttachmentService.prototype, "previewOffice");
    expect((await s.client.fetcher(`${url}/preview`)).status).toBe(401);
    const other = await chat(s);
    expect((await s.client.raw("GET", `/api/sessions/${other}/attachments/${attachment.id}/preview`)).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
  it.each([
    "report.doc",
    "report.docx",
    "book.xls",
    "book.xlsx",
    "slides.ppt",
    "slides.pptx",
    "document.odt",
    "data.ods",
    "deck.odp",
    "notes.rtf",
  ])("serves a derived PDF for %s while preserving the original", async (name) => {
    const { s, url, id } = await upload(name);
    const spy = vi
      .spyOn(AttachmentService.prototype, "previewOffice")
      .mockResolvedValue(new TextEncoder().encode("%PDF-test"));
    const response = await s.client.raw("GET", `${url}/preview`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("%PDF-test");
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name }), id);
    expect(await (await s.client.raw("GET", url)).text()).toBe("original bytes");
  });
  it("returns an actionable error without an execution sandbox", async () => {
    const { s, url } = await upload("report.doc");
    const response = await s.client.get(`${url}/preview`);
    expect(response.status).toBe(503);
    expect(response.body.error.message).toContain("execution sandbox");
  });
  it("does not serve HTML or arbitrary files inline via the conversion endpoint", async () => {
    const { s, url } = await upload("page.html", "text/html");
    expect((await s.client.get(`${url}/preview`)).status).toBe(415);
    const original = await s.client.raw("GET", `${url}?preview=1`);
    expect(original.headers.get("content-type")).toBe("application/octet-stream");
    expect(original.headers.get("content-disposition")).toContain("attachment;");
  });
  it("discards a conversion if the chat disappears while it runs", async () => {
    const { s, url, id } = await upload("report.docx");
    vi.spyOn(AttachmentService.prototype, "previewOffice").mockImplementation(async () => {
      await s.client.raw("DELETE", `/api/sessions/${id}`);
      return new TextEncoder().encode("%PDF-test");
    });
    expect((await s.client.get(`${url}/preview`)).status).toBe(404);
  });
});
