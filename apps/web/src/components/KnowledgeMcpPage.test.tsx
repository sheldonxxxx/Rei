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

function setup(initialTokens: KnowledgeMcpToken[] = []) {
  let tokens = [...initialTokens];
  let seq = 1;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const rootFolder = node("pg_root", "Projects", null, 1);
  const childFolder = node("pg_child", "Alpha", "pg_root", 0);
  const notesFolder = node("pg_notes", "Notes", null, 0);

  const api = createApi({
    fetch: async (url, init) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });

      if (path === "/api/knowledge/tree") {
        return Response.json({ pages: [rootFolder, childFolder, notesFolder] });
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
            title: id === "pg_root" ? "Projects" : id === "pg_child" ? "Alpha" : "Notes",
            path: id === "pg_child" ? "Projects › Alpha" : id === "pg_root" ? "Projects" : "Notes",
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
                    title: pid === "pg_root" ? "Projects" : pid === "pg_child" ? "Alpha" : "Notes",
                    path: pid === "pg_child" ? "Projects › Alpha" : pid === "pg_root" ? "Projects" : "Notes",
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

  it("creates a token with deny-all defaults, configures permissions/folders, reveals secret once, and clears on close", async () => {
    const { api, calls } = setup();
    render(<KnowledgeMcpPage api={api} />);
    await screen.findByText(/No MCP tokens yet/);

    fireEvent.click(screen.getByRole("button", { name: "New token" }));
    const dialog = await screen.findByRole("dialog", { name: "New MCP token" });

    // Defaults: Read, Write, Delete all off, and empty allowed folders note visible.
    const readSwitch = within(dialog).getByRole("switch", { name: "Read" });
    const writeSwitch = within(dialog).getByRole("switch", { name: "Write" });
    const deleteSwitch = within(dialog).getByRole("switch", { name: "Delete" });
    expect(readSwitch.getAttribute("aria-checked")).toBe("false");
    expect(writeSwitch.getAttribute("aria-checked")).toBe("false");
    expect(deleteSwitch.getAttribute("aria-checked")).toBe("false");
    expect(within(dialog).getByText(/No allowed folders added/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Token name"), { target: { value: "Editor Bridge" } });
    fireEvent.click(readSwitch);
    fireEvent.click(writeSwitch);

    // Search Knowledge pages and add Projects folder.
    await within(dialog).findByRole("button", { name: "Add Projects" });
    fireEvent.change(within(dialog).getByLabelText("Search Knowledge pages"), { target: { value: "Projects" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Projects" }));
    expect(within(dialog).getByRole("button", { name: "Remove Projects" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Create token" }));

    // One-time secret reveal dialog appears.
    const reveal = await screen.findByRole("dialog", { name: /Token “Editor Bridge” created/ });
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

  it("edits a token (including removing a trashed folder), toggles enabled, rotates secret, and revokes", async () => {
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

    // Edit token: remove trashed folder, enable Delete, rename.
    fireEvent.click(screen.getByRole("button", { name: "Edit Reader" }));
    const editDialog = await screen.findByRole("dialog", { name: "Edit MCP token" });
    fireEvent.change(within(editDialog).getByLabelText("Token name"), { target: { value: "Reader Plus" } });
    fireEvent.click(within(editDialog).getByRole("switch", { name: "Delete" }));
    fireEvent.click(within(editDialog).getByRole("button", { name: "Remove Old Folder" }));
    fireEvent.click(within(editDialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByText("Reader Plus")).toBeTruthy());
    expect(screen.queryByText("In Trash")).toBeNull();
    expect(screen.getByText("Delete")).toBeTruthy();

    // Rotate secret with confirmation -> shows new one-time secret.
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret for Reader Plus" }));
    const rotateConfirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(rotateConfirm).getByRole("button", { name: "Rotate secret" }));
    const rotateReveal = await screen.findByRole("dialog", { name: /New secret for “Reader Plus”/ });
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
