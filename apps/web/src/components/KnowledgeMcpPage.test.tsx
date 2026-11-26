import type { KnowledgeMcpToken, KnowledgeTreeNode } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createApi } from "../api/client.ts";
import { KnowledgeMcpPage } from "./KnowledgeMcpPage.tsx";

const actor = { kind: "user" as const, id: null, name: "You" };

function node(id: string, title: string, parentId: string | null = null, childCount = 0): KnowledgeTreeNode {
  return {
    id,
    parentId,
    title,
    description: "",
    activityAt: 2000,
    updatedAt: 2000,
    updatedBy: actor,
    locked: false,
    pinned: false,
    inbox: false,
    childCount,
  };
}

function setup(initialTokens: KnowledgeMcpToken[] = [], extraNodes: KnowledgeTreeNode[] = []) {
  let tokens = [...initialTokens];
  let seq = 1;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const rootFolder = node("pg_root", "Projects", null, 1);
  const childFolder = node("pg_child", "Alpha", "pg_root", 0);
  const notesFolder = node("pg_notes", "Notes", null, 0);
  const treePages = [rootFolder, childFolder, notesFolder, ...extraNodes];
  const byId = new Map(treePages.map((p) => [p.id, p]));

  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur = byId.get(id);
    while (cur) {
      parts.unshift(cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(" › ") || id;
  };

  const api = createApi({
    fetch: async (url, init) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });

      if (path === "/api/knowledge/tree") {
        return Response.json({ pages: treePages });
      }
      if (path === "/api/knowledge/mcp/tokens" && method === "GET") {
        return Response.json({ endpointPath: "/api/mcp/knowledge", tokens });
      }
      if (path === "/api/knowledge/mcp/tokens" && method === "POST") {
        const req = body as {
          name: string;
          permissions?: { read?: boolean; write?: boolean; delete?: boolean };
          allowedPageIds?: string[];
        };
        const secret = `rei_kmcp_secret_value_${seq}`;
        const created: KnowledgeMcpToken = {
          id: `kmcp_${seq++}`,
          name: req.name,
          tokenPrefix: secret.slice(0, 15),
          enabled: true,
          permissions: {
            read: req.permissions?.read === true,
            write: req.permissions?.write === true,
            delete: req.permissions?.delete === true,
          },
          allowedPages: (req.allowedPageIds ?? []).map((id) => ({
            pageId: id,
            title: byId.get(id)?.title ?? id,
            path: pathOf(id),
            status: "live" as const,
          })),
          createdAt: 1000,
          updatedAt: 1000,
          lastUsedAt: null,
        };
        tokens = [created, ...tokens];
        return Response.json({ token: created, secret }, { status: 201 });
      }
      const rotateMatch = /^\/api\/knowledge\/mcp\/tokens\/([^/]+)\/rotate$/.exec(path);
      if (rotateMatch && method === "POST") {
        const id = decodeURIComponent(rotateMatch[1]!);
        const secret = `rei_kmcp_rotated_secret_${seq++}`;
        tokens = tokens.map((t) => (t.id === id ? { ...t, tokenPrefix: secret.slice(0, 15) } : t));
        const token = tokens.find((t) => t.id === id)!;
        return Response.json({ token, secret });
      }
      const itemMatch = /^\/api\/knowledge\/mcp\/tokens\/([^/]+)$/.exec(path);
      if (itemMatch && method === "PATCH") {
        const id = decodeURIComponent(itemMatch[1]!);
        const patch = body as {
          name?: string;
          enabled?: boolean;
          permissions?: { read?: boolean; write?: boolean; delete?: boolean };
          allowedPageIds?: string[];
        };
        tokens = tokens.map((t) => {
          if (t.id !== id) return t;
          return {
            ...t,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            ...(patch.permissions !== undefined
              ? {
                  permissions: {
                    read: patch.permissions.read ?? t.permissions.read,
                    write: patch.permissions.write ?? t.permissions.write,
                    delete: patch.permissions.delete ?? t.permissions.delete,
                  },
                }
              : {}),
            ...(patch.allowedPageIds !== undefined
              ? {
                  allowedPages: patch.allowedPageIds.map((pid) => ({
                    pageId: pid,
                    title: byId.get(pid)?.title ?? pid,
                    path: pathOf(pid),
                    status: "live" as const,
                  })),
                }
              : {}),
          };
        });
        return Response.json({ token: tokens.find((t) => t.id === id)! });
      }
      if (itemMatch && method === "DELETE") {
        const id = decodeURIComponent(itemMatch[1]!);
        tokens = tokens.filter((t) => t.id !== id);
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return { api, calls };
}

describe("KnowledgeMcpPage", () => {
  it("renders endpoint URL and empty deny-by-default state", async () => {
    const { api } = setup();
    render(<KnowledgeMcpPage api={api} />);
    expect(await screen.findByText(/No MCP tokens yet/)).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/api/mcp/knowledge`)).toBeTruthy();
    expect(screen.getAllByText(/Access is denied by default/i).length).toBeGreaterThanOrEqual(1);
  });

  it("creates a token in-pane with deny-all defaults, configures permissions/folders, reveals secret once inline, and clears on Done", async () => {
    const { api, calls } = setup();
    render(<KnowledgeMcpPage api={api} />);
    await screen.findByText(/No MCP tokens yet/);

    fireEvent.click(screen.getByRole("button", { name: "New token" }));
    expect(await screen.findByRole("heading", { name: "New MCP token" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    // Back to MCP returns to the list without saving.
    fireEvent.click(screen.getByRole("button", { name: "Back to MCP" }));
    expect(await screen.findByRole("heading", { name: "MCP" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New token" }));
    await screen.findByRole("heading", { name: "New MCP token" });

    // Defaults: Read, Write, Delete all off, and empty allowed folders note visible.
    const readSwitch = screen.getByRole("switch", { name: "Read" });
    const writeSwitch = screen.getByRole("switch", { name: "Write" });
    const deleteSwitch = screen.getByRole("switch", { name: "Delete" });
    expect(readSwitch.getAttribute("aria-checked")).toBe("false");
    expect(writeSwitch.getAttribute("aria-checked")).toBe("false");
    expect(deleteSwitch.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/No allowed folders selected/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Editor Bridge" } });
    fireEvent.click(readSwitch);
    fireEvent.click(writeSwitch);

    // Select Projects in the folder tree; Alpha becomes checked & disabled as Included.
    const projectsCheckbox = await screen.findByRole("checkbox", { name: "Projects" });
    fireEvent.click(projectsCheckbox);
    const alphaCheckbox = screen.getByRole("checkbox", { name: "Alpha" });
    expect(alphaCheckbox.getAttribute("aria-checked")).toBe("true");
    expect((alphaCheckbox as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Included")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Projects" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    // One-time secret reveal appears inline (not as a modal dialog).
    const reveal = await screen.findByRole("region", { name: /Token “Editor Bridge” created/ });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(reveal).getByText("rei_kmcp_secret_value_1")).toBeTruthy();
    expect(within(reveal).getByText("Authorization: Bearer rei_kmcp_secret_value_1")).toBeTruthy();

    // Verify submitted payload.
    const postCall = calls.find((c) => c.method === "POST" && c.path === "/api/knowledge/mcp/tokens");
    expect(postCall?.body).toEqual({
      name: "Editor Bridge",
      permissions: { read: true, write: true, delete: false },
      allowedPageIds: ["pg_root"],
    });

    // Dismissing clears the secret from the DOM/memory.
    fireEvent.click(within(reveal).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText("rei_kmcp_secret_value_1")).toBeNull());
    expect(screen.getByText("Editor Bridge")).toBeTruthy();
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("Write")).toBeTruthy();
  });

  it("supports hierarchical folder navigation, expand/collapse, child-to-parent consolidation, and search filtering", async () => {
    const { api } = setup();
    render(<KnowledgeMcpPage api={api} />);
    await screen.findByText(/No MCP tokens yet/);

    fireEvent.click(screen.getByRole("button", { name: "New token" }));
    const treeList = await screen.findByRole("list", { name: "Knowledge folders" });
    expect(within(treeList).getByRole("checkbox", { name: "Projects" })).toBeTruthy();
    expect(within(treeList).getByRole("checkbox", { name: "Alpha" })).toBeTruthy();

    // Collapse Projects -> Alpha hides.
    fireEvent.click(within(treeList).getByRole("button", { name: "Collapse Projects" }));
    expect(within(treeList).queryByRole("checkbox", { name: "Alpha" })).toBeNull();

    // Searching for Alpha auto-expands Projects and shows Alpha under Projects.
    fireEvent.change(screen.getByLabelText("Search Knowledge pages"), { target: { value: "Alpha" } });
    expect(within(treeList).getByRole("checkbox", { name: "Projects" })).toBeTruthy();
    const alphaMatch = within(treeList).getByRole("checkbox", { name: "Alpha" });
    fireEvent.click(alphaMatch);

    // Clearing search restores collapsed state while showing "1 selected" badge on Projects.
    fireEvent.click(screen.getByRole("button", { name: "Clear folder filter" }));
    expect(within(treeList).queryByRole("checkbox", { name: "Alpha" })).toBeNull();
    expect(within(treeList).getByText("1 selected")).toBeTruthy();

    // Selecting Projects consolidates the selected child into Projects alone.
    fireEvent.click(within(treeList).getByRole("checkbox", { name: "Projects" }));
    const selectedStrip = screen.getByRole("list", { name: "Selected allowed folders" });
    expect(within(selectedStrip).getByRole("button", { name: "Remove Projects" })).toBeTruthy();
    expect(within(selectedStrip).queryByRole("button", { name: "Remove Projects › Alpha" })).toBeNull();
  });

  it("edits a token in-pane (including removing a trashed folder), toggles enabled, rotates secret inline, and revokes", async () => {
    const existing: KnowledgeMcpToken = {
      id: "kmcp_existing",
      name: "Reader",
      tokenPrefix: "rei_kmcp_old000",
      enabled: true,
      permissions: { read: true, write: false, delete: false },
      allowedPages: [
        { pageId: "pg_trashed", title: "Old Folder", path: "Old Folder", status: "trashed" },
        { pageId: "pg_notes", title: "Notes", path: "Notes", status: "live" },
      ],
      createdAt: 1000,
      updatedAt: 1000,
      lastUsedAt: null,
    };
    const { api, calls } = setup([existing]);
    render(<KnowledgeMcpPage api={api} />);

    await screen.findByText("Reader");
    expect(screen.getByText("In Trash")).toBeTruthy();

    // Toggle enabled switch.
    const enableSwitch = screen.getByRole("switch", { name: "Enable Reader" });
    fireEvent.click(enableSwitch);
    await waitFor(() => expect(screen.getByText("Disabled")).toBeTruthy());

    // Edit token in-pane: remove trashed folder, enable Delete, rename.
    fireEvent.click(screen.getByRole("button", { name: "Edit Reader" }));
    expect(await screen.findByRole("heading", { name: "Edit MCP token" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Reader Plus" } });
    fireEvent.click(screen.getByRole("switch", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Old Folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByText("Reader Plus")).toBeTruthy());
    expect(screen.queryByText("In Trash")).toBeNull();
    expect(screen.getByText("Delete")).toBeTruthy();

    // Rotate secret with confirmation -> shows new one-time secret inline.
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret for Reader Plus" }));
    const rotateConfirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(rotateConfirm).getByRole("button", { name: "Rotate secret" }));
    const rotateReveal = await screen.findByRole("region", { name: /New secret for “Reader Plus”/ });
    expect(within(rotateReveal).getByText("rei_kmcp_rotated_secret_1")).toBeTruthy();
    fireEvent.click(within(rotateReveal).getByRole("button", { name: "Done" }));

    // Revoke token with confirmation -> removed from list.
    fireEvent.click(screen.getByRole("button", { name: "Revoke Reader Plus" }));
    const revokeConfirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(revokeConfirm).getByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(screen.getByText(/No MCP tokens yet/)).toBeTruthy());
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/knowledge/mcp/tokens/kmcp_existing")).toBe(true);
  });
});
