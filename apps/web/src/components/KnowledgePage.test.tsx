import type { KnowledgeOverview, KnowledgePageDetail, KnowledgeTreeNode } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../api/client.ts";
import { KnowledgePage, meaningText } from "./KnowledgePage.tsx";

const agent = { kind: "agent" as const, id: "a1", name: "Rei" };
const node = (id: string, title: string, extra: Partial<KnowledgeTreeNode> = {}): KnowledgeTreeNode => ({
  id,
  parentId: null,
  title,
  description: "",
  activityAt: 2000,
  updatedAt: 2000,
  updatedBy: agent,
  locked: false,
  pinned: false,
  inbox: false,
  childCount: 0,
  ...extra,
});
const inbox = node("inbox1", "Inbox", { inbox: true });
const plan = node("p1", "Training plan", { description: "Weekly runs" });
const overview: KnowledgeOverview = {
  pinned: [],
  recent: [plan],
  week: [{ actor: agent, created: 2, edited: 3 }],
  inbox: { id: inbox.id, count: 0, newest: [] },
  external: [],
  locked: [],
  trashCount: 1,
  pageCount: 2,
  meaning: { state: "indexing", sections: 10, embedded: 7, lastError: null },
};
const page = (revision: number, body: string): KnowledgePageDetail => ({
  page: {
    metadata: { tags: [] },
    id: "p1",
    parentId: null,
    title: "Training plan",
    description: "Weekly runs",
    revision,
    locked: false,
    pinned: false,
    inbox: false,
    external: true,
    createdBy: agent,
    createdAt: 1000,
    updatedBy: agent,
    updatedAt: 2000,
    activityAt: 2000,
    trashedAt: null,
  },
  body,
  ancestors: [],
  children: [],
  backlinks: [],
  files: [
    { fileId: "f_gone", versionId: null, name: "old.pdf", available: false, contentVersionId: null, mediaType: null },
  ],
  revisions: [
    {
      metadata: { tags: [] },
      revision,
      title: "Training plan",
      description: "",
      actor: agent,
      sessionId: null,
      sessionTitle: null,
      runId: null,
      external: true,
      note: null,
      createdAt: 1000,
      updatedAt: 2000,
    },
  ],
});
const BODY = "> [!TIP]\n> Warm up first\n\n- [ ] Easy 5k @Rei 📅 2020-01-01\n- [x] Rest\n\nSee [deck](file:f_gone).";

function setup(handlers: { save?: (body: unknown) => Response; body?: string } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let current = page(1, handlers.body ?? BODY);
  const api = createApi({
    fetch: async (url, init) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (path === "/api/knowledge/tags") return Response.json({ tags: ["running", "health"] });
      if (path === "/api/knowledge/tree") return Response.json({ pages: [plan, inbox] });
      if (path === "/api/knowledge/overview") return Response.json(overview);
      if (path.startsWith("/api/knowledge/search"))
        return Response.json({
          hits: [
            {
              pageId: "p1",
              title: "Training plan",
              path: "Training plan",
              section: "",
              snippet: "Weekly runs",
              updatedAt: 1,
              matched: path.includes("tags=") ? [] : ["meaning"],
            },
            {
              pageId: "inbox1",
              title: "Inbox",
              path: "Inbox",
              section: "",
              snippet: "",
              updatedAt: 1,
              matched: ["keyword", "meaning"],
            },
          ],
        });
      if (path === "/api/knowledge/pages/p1" && method === "GET") return Response.json(current);
      if (path === "/api/knowledge/pages/p1" && method === "PATCH") {
        current = page(2, BODY.replace("- [ ] Easy", "- [x] Easy"));
        return Response.json(current);
      }
      if (path === "/api/knowledge/pages/p1" && method === "PUT") {
        if (handlers.save) {
          const r = handlers.save(body);
          if (r.status === 409) current = page(5, "Changed by an agent");
          return r;
        }
        current = page(2, (body as { body: string }).body);
        return Response.json(current);
      }
      return Response.json({ ok: true });
    },
  });
  return { api, calls };
}

const props = { rev: 0, changedPageId: null, agents: [], defaultAgentId: "a1", onAsk: vi.fn(async () => {}) };

describe("Knowledge UI", () => {
  it("shows the overview: totals, recent pages and this week per writer", async () => {
    const { api } = setup();
    render(<KnowledgePage api={api} pageId={null} {...props} />);
    const recent = await screen.findByRole("region", { name: "Recently updated" });
    expect(
      within(recent)
        .getByRole("link", { name: /Training plan/ })
        .getAttribute("href"),
    ).toBe("/knowledge/p1");
    const week = screen.getByRole("region", { name: "This week" });
    within(week).getByText("Rei");
    within(week).getByText("3");
    screen.getByText("Meaning search: 7 of 10 sections ready");
  });

  it("marks search results that were found by meaning alone", async () => {
    const { api } = setup();
    render(<KnowledgePage api={api} pageId={null} {...props} />);
    const box = await screen.findByRole("combobox", { name: "Search Knowledge" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "jogging schedule" } });
    const results = await screen.findByRole("listbox", { name: "Search results" }, { timeout: 2_000 });
    const [byMeaning, both] = within(results).getAllByRole("option");
    within(byMeaning!).getByText("similar meaning");
    expect(within(both!).queryByText("similar meaning")).toBeNull();
  });

  it("renders callouts, task chips and removed files, and ticks a task by its position", async () => {
    const { api, calls } = setup();
    render(<KnowledgePage api={api} pageId="p1" {...props} />);
    await screen.findByRole("heading", { name: "Training plan", level: 1 });
    expect(screen.getByRole("note").textContent).toContain("Warm up first");
    expect(screen.getByText("@Rei").className).toContain("md-chip-agent");
    expect(screen.getByText("2020-01-01").closest(".md-chip")?.className).toContain("overdue");
    expect(screen.getAllByText("File removed").length).toBeGreaterThan(0);
    expect(screen.queryByText("Outside content")).toBeNull();
    const box = screen.getByRole<HTMLInputElement>("checkbox", { name: /Task: Easy 5k/ });
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ task: { index: 0, done: true } }),
    );
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Task: Easy 5k/ }).checked).toBe(true),
    );
  });

  it("gives section headings ids and a copy-link button, and scrolls to a linked section", async () => {
    const scrolled: string[] = [];
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this.id);
    });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    window.history.replaceState(null, "", `/knowledge/p1#${encodeURIComponent("第二週-進度")}`);
    try {
      const { api } = setup({ body: "## Week 1\nx\n\n## 第二週 進度\ny\n\n## Notes\n\n## Notes" });
      const { unmount } = render(<KnowledgePage api={api} pageId="p1" {...props} />);
      const heading = await screen.findByRole("heading", { name: /第二週 進度/ });
      expect(heading.id).toBe("section-第二週-進度");
      expect(screen.getAllByRole("heading", { name: /Notes/ }).map((h) => h.id)).toEqual([
        "section-notes",
        "section-notes-1",
      ]);
      await waitFor(() => expect(scrolled).toContain("section-第二週-進度"));
      expect(new Set(scrolled)).toEqual(new Set(["section-第二週-進度"]));
      fireEvent.click(within(heading).getByRole("button", { name: "Copy section link" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("[第二週 進度](page:p1#第二週-進度)"));
      unmount();
      // An unknown slug opens the page at its top (the article, not a heading) and without an error.
      window.history.replaceState(null, "", "/knowledge/p1#nope");
      render(<KnowledgePage api={api} pageId="p1" {...props} />);
      const before = scrolled.length;
      await screen.findByRole("heading", { name: /Week 1/ });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await waitFor(() => expect(scrolled.slice(before)).toContain(""));
      expect(scrolled.slice(before).every((id) => !id.startsWith("section-"))).toBe(true);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      scroll.mockRestore();
      window.history.replaceState(null, "", "/");
    }
  });

  it("keeps the editor open on a conflict and offers to review the newer version", async () => {
    const { api } = setup({
      save: () => Response.json({ error: { code: "conflict", message: "changed" }, revision: 5 }, { status: 409 }),
    });
    render(<KnowledgePage api={api} pageId="p1" {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Page text (Markdown)" }), { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Page changed — review");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Page text (Markdown)" }).value).toBe("Mine");
    fireEvent.click(screen.getByRole("button", { name: "Discard mine, edit theirs" }));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Page text (Markdown)" }).value).toBe(
      "Changed by an agent",
    );
  });

  it("gives each page in the tree a plus icon that starts a subpage under it", async () => {
    const { api } = setup();
    render(<KnowledgePage api={api} pageId={null} {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add subpage under Training plan" }));
    const dialog = screen.getByRole("dialog", { name: "New page" });
    expect(dialog.textContent).toContain("Inside");
    expect(dialog.textContent).toContain("Training plan");
  });

  it("lists the most recently edited pages in a Recent block above the tree", async () => {
    const { api } = setup();
    render(<KnowledgePage api={api} pageId={null} {...props} />);
    const recent = await screen.findByRole("region", { name: "Recent pages" });
    expect(
      within(recent)
        .getByRole("link", { name: /Training plan/ })
        .getAttribute("href"),
    ).toBe("/knowledge/p1");
    // the block sits above the tree's own "Pages" heading
    const pages = screen.getByText("Pages");
    expect(recent.compareDocumentPosition(pages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no plus icon in the open page's header; Add subpage lives in the more menu", async () => {
    const { api } = setup();
    render(<KnowledgePage api={api} pageId="p1" {...props} />);
    await screen.findByRole("heading", { name: "Training plan", level: 1 });
    expect(screen.queryByRole("button", { name: "Add subpage to Training plan" })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More page actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Add subpage/ }));
    expect(screen.getByRole("dialog", { name: "New page" }).textContent).toContain("Training plan");
  });

  it("on a wide screen shows neither a sidebar button nor the phone back arrow", async () => {
    const { api } = setup();
    const onBack = vi.fn();
    render(<KnowledgePage api={api} pageId="p1" {...props} onBack={onBack} />);
    await screen.findByRole("heading", { name: "Training plan", level: 1 });
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("asks about a page in a new chat with the page and the question", async () => {
    const { api } = setup();
    const onAsk = vi.fn(async () => {});
    render(<KnowledgePage api={api} pageId="p1" {...props} onAsk={onAsk} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask about this page" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Am I on track?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() =>
      expect(onAsk).toHaveBeenCalledWith({ id: "p1", title: "Training plan" }, "Am I on track?", "a1"),
    );
  });
});

describe("meaningText", () => {
  it("says how search finds pages in each state", () => {
    const m = (state: KnowledgeOverview["meaning"]["state"]) =>
      meaningText({ state, sections: 3, embedded: 1, lastError: null });
    expect(m("off")).toBe("Keyword search only");
    expect(m("down")).toBe("Embedder down — keyword search only");
    expect(m("indexing")).toBe("Meaning search: 1 of 3 sections ready");
    expect(m("ready")).toBe("Keyword and meaning search");
  });
});

describe("Knowledge source editor", () => {
  it("carries unsaved properties into source, blocks invalid switches, and sends source alone", async () => {
    const { api, calls } = setup({ save: () => Response.json(page(2, "New body")) });
    render(<KnowledgePage api={api} pageId="p1" {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Unsaved title" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Tags" }), { target: { value: "知識" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Markdown Source" }));
    const source = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Markdown source" });
    expect(source.value).toContain("title: Unsaved title");
    expect(source.value).toContain("知識");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    fireEvent.change(source, { target: { value: "---\ntitle: X\nstatus: curated\n---\nNew body" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit properties and body" }));
    expect(screen.getByRole("alert").textContent).toContain("status");
    expect(screen.getByRole("textbox", { name: "Markdown source" })).toBeTruthy();
    const valid = "---\ntitle: New\ntags: [知識]\n---\nNew body";
    fireEvent.change(source, { target: { value: valid } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ baseRevision: 1, sourceMarkdown: valid }),
    );
  });

  it("returns parsed source to native fields without saving", async () => {
    const { api, calls } = setup();
    render(<KnowledgePage api={api} pageId="p1" {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Markdown Source" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Markdown source" }), {
      target: { value: "---\ntitle: Updated\ntags: [running]\n---\nNew body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit properties and body" }));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe("Updated");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Page text (Markdown)" }).value).toBe("New body");
    expect(screen.getByRole("button", { name: "Remove tag running" })).toBeTruthy();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
});
