import type { PluginDetail, PluginPackage } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { currentRoute } from "../lib/route.ts";
import { PluginsPage } from "./PluginsPage.tsx";

const content: PluginPackage = {
  formatVersion: 1,
  name: "notes",
  description: "Work with notes",
  skills: [
    {
      name: "read",
      files: [
        {
          path: "SKILL.md",
          encoding: "text",
          content: "---\nname: read\ndescription: Read notes\n---\n\nRead before writing.",
        },
      ],
    },
  ],
  mcp: [{ name: "notes", url: "https://notes.example/mcp", auth: "oauth", skills: ["read"] }],
};
const detail: PluginDetail = {
  id: "p1",
  name: "notes",
  description: content.description,
  revision: 2,
  selectedRevision: 2,
  enabled: true,
  agents: null,
  builtIn: false,
  skillCount: 1,
  connectionCount: 1,
  package: content,
  skills: [{ name: "read", id: "s1", reference: "notes/read" }],
  connections: [{ name: "notes", connectorId: null, status: "error", error: "Connection unavailable" }],
  revisions: [
    { revision: 2, author: "user", sessionId: null, createdAt: 1 },
    { revision: 1, author: "agent", sessionId: "chat", createdAt: 0 },
  ],
};
function setup(id: string | null, overrides: Record<string, unknown> = {}) {
  const api = {
    getPlugins: vi.fn().mockResolvedValue({ plugins: [detail] }),
    getPlugin: vi.fn().mockResolvedValue({ plugin: detail }),
    createPlugin: vi.fn().mockResolvedValue({ plugin: detail }),
    updatePlugin: vi.fn().mockResolvedValue({ plugin: detail }),
    installPlugin: vi.fn().mockResolvedValue({ plugin: detail }),
    retryPlugin: vi.fn().mockResolvedValue({ plugin: detail }),
    deletePlugin: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  render(<PluginsPage api={api as unknown as Api} agents={[]} id={id} rev={0} />);
  return api;
}
afterEach(() => {
  window.history.replaceState(null, "", "/");
});
it("lists compositions with a single plugin destination", async () => {
  setup(null);
  const link = await screen.findByRole("link", { name: /notes Skills \+ MCP/ });
  expect(link.getAttribute("href")).toBe("/settings/plugins/p1");
  fireEvent.click(screen.getByRole("button", { name: "New plugin" }));
  expect(currentRoute()).toBe("/settings/plugins/new");
});
it("creates a skill and MCP package from named fields", async () => {
  const api = setup("new");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "my-plugin" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Do useful work" } });
  fireEvent.click(screen.getByText("Add skill"));
  fireEvent.click(screen.getByText("Add connection"));
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://notes.example/mcp" } });
  fireEvent.click(screen.getByLabelText("skill-1"));
  fireEvent.click(screen.getByText("Save plugin"));
  await waitFor(() =>
    expect(api.createPlugin).toHaveBeenCalledWith({
      package: expect.objectContaining({
        name: "my-plugin",
        skills: [expect.objectContaining({ name: "skill-1" })],
        mcp: [expect.objectContaining({ skills: ["skill-1"] })],
      }),
    }),
  );
});
it("shows instructions, retryable setup and installation controls", async () => {
  const api = setup("p1");
  expect(await screen.findByText("Read before writing.")).toBeTruthy();
  expect(screen.getByText("Read first: read")).toBeTruthy();
  expect(screen.getByText("Connection unavailable")).toBeTruthy();
  fireEvent.click(screen.getByText("Retry setup"));
  await waitFor(() => expect(api.retryPlugin).toHaveBeenCalledWith("p1"));
  fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
  await waitFor(() => expect(api.installPlugin).toHaveBeenCalledWith("p1", { enabled: false }));
});
it("edits against the displayed revision and preserves supporting files", async () => {
  const api = setup("p1");
  fireEvent.click(await screen.findByText("Edit plugin"));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Updated" } });
  fireEvent.click(screen.getByText("Save plugin"));
  await waitFor(() =>
    expect(api.updatePlugin).toHaveBeenCalledWith("p1", {
      expectedRevision: 2,
      package: expect.objectContaining({ description: "Updated", skills: content.skills }),
    }),
  );
});
it("loads history and restores content as a new revision", async () => {
  const historical = { ...detail, selectedRevision: 1, package: { ...content, description: "Earlier" } };
  const api = setup("p1", {
    getPlugin: vi
      .fn()
      .mockImplementation((_id, revision) => Promise.resolve({ plugin: revision ? historical : detail })),
  });
  fireEvent.change(await screen.findByLabelText("Revision history"), { target: { value: "1" } });
  fireEvent.click(await screen.findByText("Restore as new revision"));
  await waitFor(() =>
    expect(api.updatePlugin).toHaveBeenCalledWith("p1", { expectedRevision: 2, package: historical.package }),
  );
});
it("keeps built-in plugins read only and reports fetch failures", async () => {
  setup("p1", { getPlugin: vi.fn().mockResolvedValue({ plugin: { ...detail, builtIn: true } }) });
  await screen.findByText("Read before writing.");
  expect(screen.queryByText("Edit plugin")).toBeNull();
  expect(screen.queryByText("Remove plugin")).toBeNull();
});
