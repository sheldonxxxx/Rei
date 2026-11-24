import type { LibraryDetail, LibraryFile } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../api/client.ts";
import { libraryAttachment } from "../lib/library.ts";
import { agent } from "../test/fixtures.ts";
import { openMenu } from "../test/menu.ts";
import { FilePreview } from "./FilePreview.tsx";
import { LibraryContext } from "./LibraryContext.tsx";
import { LibraryPage } from "./LibraryPage.tsx";

const file: LibraryFile = {
  id: "f1",
  name: "report.md",
  origin: "agent",
  creator: "Rei",
  createdAt: 1000,
  updatedAt: 2000,
  folderId: null,
  favorite: false,
  trashedAt: null,
  current: {
    fileId: "f1",
    versionId: "v2",
    attachmentId: "a2",
    number: 2,
    name: "report.md",
    mediaType: "text/markdown",
    size: 12,
    createdAt: 2000,
    creator: "Rei",
  },
};
const detail: LibraryDetail = {
  file,
  versions: [file.current, { ...file.current, versionId: "v1", attachmentId: "a1", number: 1 }],
  chats: [{ id: "s1", title: "Originating chat" }],
};
function api() {
  return createApi({
    fetch: async (url, init) => {
      const path = String(url);
      if (path.startsWith("/api/files?")) return Response.json({ files: [file], folders: [], nextCursor: null });
      if (path === "/api/files/f1" && (!init?.method || init.method === "GET")) return Response.json(detail);
      if (init?.method === "PATCH") return Response.json({ file });
      return Response.json({ ok: true });
    },
  });
}
describe("Library UI", () => {
  it("recovers from an empty search by clearing search, type and origin while keeping the current view", async () => {
    const client = api();
    const list = vi.spyOn(client, "listFiles").mockImplementation(async (query) => ({
      files: query?.q || query?.type || query?.origin ? [] : [file],
      folders: [],
      nextCursor: null,
    }));
    render(<LibraryPage api={client} />);
    await screen.findByRole("button", { name: "Preview report.md" });
    fireEvent.click(screen.getByRole("radio", { name: "Favorites" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search library" }), { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by type" }), { target: { value: "pdf" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by origin" }), { target: { value: "upload" } });
    expect(await screen.findByRole("heading", { name: "No matching files" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByRole("button", { name: "Preview report.md" })).toBeTruthy();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "", type: "", origin: "", favorite: "1" }));
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it.each([
    ["All files", "No files here yet"],
    ["Favorites", "No favorites yet"],
    ["Trash", "Trash is empty"],
  ])("explains an empty %s view", async (view, heading) => {
    const client = api();
    vi.spyOn(client, "listFiles").mockResolvedValue({ files: [], folders: [], nextCursor: null });
    render(<LibraryPage api={client} />);
    fireEvent.click(screen.getByRole("radio", { name: view }));
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(Boolean(screen.queryByRole("button", { name: "Upload files" }))).toBe(view === "All files");
  });

  it("offers a retry instead of claiming the library is empty when loading fails", async () => {
    const client = api();
    vi.spyOn(client, "listFiles")
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({ files: [file], folders: [], nextCursor: null });
    render(<LibraryPage api={client} />);
    expect(await screen.findByRole("heading", { name: "Couldn’t load files" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "No files here yet" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Preview report.md" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists saved files, switches layout, selects files, and moves them to Trash", async () => {
    const client = api(),
      patch = vi.spyOn(client, "patchFile");
    render(<LibraryPage api={client} />);
    expect(await screen.findByRole("button", { name: "Preview report.md" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(document.querySelector(".library-files.is-list")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select report.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("f1", { trashed: true }));
  });
  it("has no per-file Download or Rename button on cards or rows", async () => {
    render(<LibraryPage api={api()} />);
    await screen.findByRole("button", { name: "Preview report.md" });
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("the file modal uses icon buttons for info, history and download, and a delete icon moves the file to Trash", async () => {
    const client = api(),
      patch = vi.spyOn(client, "patchFile"),
      onClose = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("# Saved report"));
    render(
      <LibraryContext.Provider value={{ api: client, agents: [], defaultAgentId: "agent", ask: vi.fn(async () => {}) }}>
        <FilePreview file={libraryAttachment(file)} onClose={onClose} />
      </LibraryContext.Provider>,
    );
    for (const name of ["File info", "History"]) {
      const button = await screen.findByRole("button", { name });
      expect(button.textContent?.trim()).toBe("");
    }
    expect(screen.getByRole("link", { name: "Download" }).textContent?.trim()).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("f1", { trashed: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("puts upload, new folder, sorting and refresh in the header menus", async () => {
    const client = api();
    const list = vi.spyOn(client, "listFiles").mockResolvedValue({ files: [file], folders: [], nextCursor: null });
    render(<LibraryPage api={client} />);
    await screen.findByRole("button", { name: "Preview report.md" });
    openMenu(screen.getByRole("button", { name: "New" }));
    expect(await screen.findByRole("menuitem", { name: "Upload files" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
    expect(await screen.findByRole("dialog", { name: "New folder" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openMenu(screen.getByRole("button", { name: "View options" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Name" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "name" })));
  });

  it("shows file information and immutable history for the inspected version", async () => {
    const client = api();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("# Saved report"));
    render(
      <LibraryContext.Provider value={{ api: client, agents: [], defaultAgentId: "agent", ask: vi.fn(async () => {}) }}>
        <FilePreview
          file={{ ...libraryAttachment(file), versionId: "v1", id: "a1" }}
          sessionId="s1"
          onClose={vi.fn()}
        />
      </LibraryContext.Provider>,
    );
    expect(await screen.findByText(/A newer version is available/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "File info" }));
    expect(await screen.findByRole("link", { name: "Originating chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByRole("button", { name: "Restore as new version" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Ask about this file" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fetcher.mockRestore();
  });

  it("puts the agent selector and Use in chat in the footer, without a question box", async () => {
    const client = api(),
      reuse = vi.fn(async () => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("# Saved report"));
    render(
      <LibraryContext.Provider
        value={{ api: client, agents: [], defaultAgentId: "agent", reuse, ask: vi.fn(async () => {}) }}
      >
        <FilePreview file={libraryAttachment(file)} onClose={vi.fn()} />
      </LibraryContext.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Use in chat" }));
    await waitFor(() => expect(reuse).toHaveBeenCalledWith(expect.objectContaining({ fileId: "f1" }), "agent"));
    expect(screen.getByRole("combobox", { name: "Agent for file" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Ask about this file" })).toBeNull();
  });

  it("changing the target agent does not reload the file preview", async () => {
    const client = api();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("# Saved report"));
    const contentRequests = () => fetcher.mock.calls.filter(([url]) => String(url).includes("/content")).length;
    render(
      <LibraryContext.Provider
        value={{
          api: client,
          agents: [
            agent({ id: "a1", name: "First", homeSessionId: "s1" }),
            agent({ id: "a2", name: "Second", homeSessionId: "s2" }),
          ],
          defaultAgentId: "a1",
          reuse: vi.fn(async () => {}),
          ask: vi.fn(async () => {}),
        }}
      >
        <FilePreview file={libraryAttachment(file)} onClose={vi.fn()} />
      </LibraryContext.Provider>,
    );
    await waitFor(() => expect(contentRequests()).toBe(1));
    fireEvent.change(screen.getByRole("combobox", { name: "Agent for file" }), { target: { value: "a2" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("combobox", { name: "Agent for file" })).toHaveProperty("value", "a2");
    expect(contentRequests()).toBe(1);
    fetcher.mockRestore();
  });
});
