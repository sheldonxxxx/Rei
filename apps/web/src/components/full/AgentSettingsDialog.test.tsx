import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Api } from "../../api/client.ts";
import { agent } from "../../test/fixtures.ts";
import { AgentSettingsDialog } from "./AgentSettingsDialog.tsx";

function setup(
  allowedConnectorIds: string[] | null = null,
  fail = false,
  wide = true,
  allowedKnowledgePageIds: string[] | null = null,
  knowledgePages: { id: string; parentId: string | null; title: string }[] = [
    { id: "pg_root", parentId: null, title: "Projects" },
    { id: "pg_child", parentId: "pg_root", title: "Rei" },
  ],
) {
  const updateAgent = vi.fn().mockResolvedValue({});
  const getConnectors = fail
    ? vi.fn().mockRejectedValue(new Error("offline"))
    : vi.fn().mockResolvedValue({
        connectors: [
          { id: "notes", name: "Notes", status: "connected" },
          { id: "calendar", name: "Calendar", status: "needs_auth" },
        ],
      });
  const knowledgeTree = vi.fn().mockResolvedValue({
    pages: knowledgePages.map((p) => ({
      ...p,
      description: "",
      activityAt: 1000,
      updatedAt: 1000,
      updatedBy: { kind: "user", id: null, name: "You" },
      locked: false,
      pinned: false,
      inbox: false,
      childCount: knowledgePages.filter((c) => c.parentId === p.id).length,
    })),
  });
  render(
    <AgentSettingsDialog
      agent={agent({ allowedConnectorIds, allowedKnowledgePageIds })}
      wide={wide}
      api={{ updateAgent, getConnectors, knowledgeTree } as unknown as Api}
      onClose={() => {}}
      onChangeLook={() => {}}
    />,
  );
  return updateAgent;
}

function goSection(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

it("saves only selected connectors, including unavailable ones", async () => {
  const update = setup();
  goSection("Connectors");
  fireEvent.change(screen.getByLabelText("Usable connectors"), { target: { value: "selected" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Notes" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Calendar/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(expect.any(String), { allowedConnectorIds: ["notes", "calendar"] }),
  );
});

it("can disable all connectors", async () => {
  const update = setup();
  goSection("Connectors");
  fireEvent.change(screen.getByLabelText("Usable connectors"), { target: { value: "selected" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.any(String), { allowedConnectorIds: [] }));
});

it("saves a changed sandbox network mode", async () => {
  const update = setup();
  goSection("Tools");
  fireEvent.change(screen.getByLabelText("Sandbox network"), { target: { value: "any" } });
  expect(screen.getByText(/Allows any site on ports 80 and 443/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.any(String), { networkMode: "any" }));
});

it("opts in to managing triggers for other agents", async () => {
  const update = setup();
  goSection("Automation");
  const triggers = screen.getByLabelText("Triggers") as HTMLSelectElement;
  expect(triggers.value).toBe("own");
  fireEvent.change(triggers, { target: { value: "all" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.any(String), { capabilities: { triggers: "all" } }));
});

it("hides Sandbox network when Sandbox is switched off and preserves edits across sections", async () => {
  const update = setup();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Researcher" } });
  goSection("Tools");
  expect(screen.getByLabelText("Sandbox network")).toBeTruthy();
  const sandbox = screen.getByRole("switch", { name: "Sandbox" });
  expect(sandbox.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(sandbox);
  expect(sandbox.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByLabelText("Sandbox network")).toBeNull();
  goSection("Context & data");
  fireEvent.change(screen.getByLabelText("Knowledge"), { target: { value: "read" } });
  fireEvent.change(screen.getByLabelText("Chat history"), { target: { value: "own" } });
  goSection("Automation");
  fireEvent.change(screen.getByLabelText("Worker delegation"), { target: { value: "off" } });
  goSection("General");
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Researcher");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(expect.any(String), {
      name: "Researcher",
      capabilities: {
        sandbox: false,
        knowledge: "read",
        chatHistory: "own",
        delegation: "off",
      },
    }),
  );
});

it("renders the mobile sheet shell when wide is false and saves changes", async () => {
  const update = setup(null, false, false);
  expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeTruthy();
  goSection("Context & data");
  fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "read" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.any(String), { capabilities: { memory: "read" } }));
});

it("keeps mode='model' as a compact dialog without section nav", () => {
  render(
    <AgentSettingsDialog
      mode="model"
      agent={agent()}
      api={
        { getModels: vi.fn().mockResolvedValue({ default: "gpt-6.1-sol", models: ["gpt-6.1-sol"] }) } as unknown as Api
      }
      onClose={() => {}}
      onChangeLook={() => {}}
    />,
  );
  expect(screen.queryByRole("navigation", { name: "Agent settings sections" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Model settings" })).toBeTruthy();
});

it("restores all connectors and preserves an existing list on load failure", async () => {
  const update = setup(["notes", "removed"], true);
  goSection("Connectors");
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load connectors");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Usable connectors"), { target: { value: "all" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.any(String), { allowedConnectorIds: null }));
});

it("scopes Knowledge to selected folders, hides scope when Knowledge is off, and restores All Knowledge", async () => {
  const update = setup();
  goSection("Context & data");
  expect(screen.getByLabelText("Knowledge scope")).toBeTruthy();

  // Switch Knowledge to off -> scope control disappears.
  fireEvent.change(screen.getByLabelText("Knowledge"), { target: { value: "off" } });
  expect(screen.queryByLabelText("Knowledge scope")).toBeNull();

  // Switch Knowledge back to read -> scope control reappears, select folder tree.
  fireEvent.change(screen.getByLabelText("Knowledge"), { target: { value: "read" } });
  fireEvent.change(screen.getByLabelText("Knowledge scope"), { target: { value: "selected" } });
  const projectsCheckbox = await screen.findByRole("checkbox", { name: "Projects" });
  fireEvent.click(projectsCheckbox);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(expect.any(String), {
      allowedKnowledgePageIds: ["pg_root"],
      capabilities: { knowledge: "read" },
    }),
  );

  // Resetting an existing scoped agent back to All Knowledge sends null.
  const updateReset = setup(null, false, true, ["pg_root"]);
  goSection("Context & data");
  expect((screen.getAllByLabelText("Knowledge scope").at(-1) as HTMLSelectElement).value).toBe("selected");
  fireEvent.change(screen.getAllByLabelText("Knowledge scope").at(-1)!, { target: { value: "all" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);
  await waitFor(() => expect(updateReset).toHaveBeenCalledWith(expect.any(String), { allowedKnowledgePageIds: null }));
});
