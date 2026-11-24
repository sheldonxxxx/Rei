import { filePreview } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePreview, previewRows } from "../lib/filePreview.ts";
import { FilePreview } from "./FilePreview.tsx";
import { MessageAttachments } from "./MessageItem.tsx";

vi.mock("./NativeDocument.tsx", () => ({
  NativeDocument: ({ name, onError }: { name: string; onError: (message: string) => void }) => (
    <div title={`Preview of ${name}`}>
      <button type="button" onClick={() => onError("Unsupported Office feature")}>
        Simulate renderer failure
      </button>
    </div>
  ),
}));
const file = { id: "att_1", name: "notes.txt", mediaType: "application/octet-stream", size: 42 };
const fetchText = (text: string) =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => new Response(text)),
  );
afterEach(() => vi.unstubAllGlobals());

describe("file preview", () => {
  it.each([
    ["page.HTML", "html"],
    ["notes.md", "markdown"],
    ["old.doc", "office"],
    ["book.xls", "office"],
    ["slides.ppt", "office"],
    ["report.docx", "office"],
    ["data.xlsx", "office"],
    ["deck.pptx", "office"],
    ["data.csv", "csv"],
    ["photo.svg", "image"],
    ["clip.mp4", "video"],
    ["record.mp3", "audio"],
    ["archive.zip", "unsupported"],
  ])("classifies %s without a browser MIME type", (name, kind) => {
    expect(filePreview({ name, mediaType: "application/octet-stream" }).kind).toBe(kind);
  });
  it("opens attachments without downloading, restores focus on Escape, and preserves the download link", async () => {
    fetchText("hello <script>bad()</script>");
    render(<MessageAttachments sessionId="s1" attachments={[file]} />);
    const open = screen.getByRole("button", { name: "Preview notes.txt" });
    open.focus();
    fireEvent.click(open);
    expect(await screen.findByRole("dialog", { name: "notes.txt" })).toBeTruthy();
    expect(await screen.findByText("hello <script>bad()</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("download")).toBe("notes.txt");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(open));
  });
  it("isolates HTML with an opaque origin and network-blocking CSP and exposes source", async () => {
    fetchText('<h1>Hello</h1><script>parent.hacked=true</script><img src="https://example.com/tracker">');
    render(<FilePreview sessionId="s1" file={{ ...file, name: "page.html" }} onClose={vi.fn()} />);
    const frame = await screen.findByTitle("Preview of page.html");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")!.indexOf("Content-Security-Policy")).toBeLessThan(
      frame.getAttribute("srcdoc")!.indexOf("<script>"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByText(/parent.hacked=true/)).toBeTruthy();
    expect(screen.queryByTitle("Preview of page.html")).toBeNull();
  });
  it("renders Markdown and quoted CSV tables", async () => {
    fetchText("# Report\n\n**Ready**");
    const view = render(<FilePreview sessionId="s1" file={{ ...file, name: "report.md" }} onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Report" })).toBeTruthy();
    view.unmount();
    fetchText('Name,Note\nAda,"one,two"');
    render(<FilePreview sessionId="s1" file={{ ...file, name: "data.csv" }} onClose={vi.fn()} />);
    expect(await screen.findByRole("cell", { name: "one,two" })).toBeTruthy();
  });
  it("loads original Office bytes directly and offers conversion only after explicit selection", async () => {
    fetchText("original Office bytes");
    render(<FilePreview sessionId="s1" file={{ ...file, name: "slides.ppt" }} onClose={vi.fn()} />);
    expect(await screen.findByTitle("Preview of slides.ppt")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/s1/attachments/att_1",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
      "/api/sessions/s1/attachments/att_1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Simulate renderer failure" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Unsupported Office feature");
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Compatibility preview" }));
    expect(await screen.findByTitle("Preview of compatibility-preview.pdf")).toBeTruthy();
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/sessions/s1/attachments/att_1/preview",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("shows server errors and retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ error: { message: "Preview busy" } }, { status: 429 }))
        .mockResolvedValueOnce(new Response("worked")),
    );
    render(<FilePreview sessionId="s1" file={file} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Preview busy");
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    expect(await screen.findByText("worked")).toBeTruthy();
  });
  it("does not fetch oversized text or unsupported binary files", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const view = render(<FilePreview sessionId="s1" file={{ ...file, size: 3 * 1024 * 1024 }} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("2 MiB"));
    view.unmount();
    render(<FilePreview sessionId="s1" file={{ ...file, name: "archive.zip" }} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("No preview"));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("aborts a pending load on close", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const view = render(<FilePreview sessionId="s1" file={file} onClose={vi.fn()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
  it("parses multiline and escaped CSV cells and bounds wide/long data", () => {
    expect(previewRows('a,"b\nc","d""e"\r\n1,2,3', ",").rows).toEqual([
      ["a", "b\nc", 'd"e'],
      ["1", "2", "3"],
    ]);
    expect(previewRows("1,2,3\n4,5,6\n7,8,9", ",", 2, 2)).toEqual({
      rows: [
        ["1", "2"],
        ["4", "5"],
      ],
      truncated: true,
    });
    expect(decodePreview(new Uint8Array([255, 254, 65, 0]).buffer)).toBe("A");
  });
});
