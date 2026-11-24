import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Api } from "../../api/client.ts";
import { agent } from "../../test/fixtures.ts";
import { AgentSettingsDialog } from "./AgentSettingsDialog.tsx";

function setup(allowedConnectorIds: string[] | null = null, fail = false) {
  const updateAgent = vi.fn().mockResolvedValue({});
  const getConnectors = fail
    ? vi.fn().mockRejectedValue(new Error("offline"))
    : vi.fn().mockResolvedValue({
        connectors: [
          { id: "notes", name: "Notes", status: "connected" },
          { id: "calendar", name: "Calendar", status: "needs_auth" },
        ],
      });
  render(
    <AgentSettingsDialog
      agent={agent({ allowedConnectorIds })}
      api={{ updateAgent, getConnectors } as unknown as Api}
      onClose={() => {}}
      onChangeLook={() => {}}
    />,
  );
  return updateAgent;
}

it("saves only selected connectors, including unavailable ones", async () => {
  const update = setup();
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
  fireEvent.change(screen.getByLabelText("Usable connectors"), { target: { value: "selected" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.any(String), { allowedConnectorIds: [] }));
});

it("saves a changed sandbox network mode", async () => {
  const update = setup();
  fireEvent.change(screen.getByLabelText("Sandbox network"), { target: { value: "any" } });
  expect(screen.getByText(/Allows any site on ports 80 and 443/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.any(String), { networkMode: "any" }));
});

it("opts in to creating triggers for other agents", async () => {
  const update = setup();
  const permission = screen.getByRole("switch", { name: "Create triggers for other agents" });
  expect(permission.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(permission);
  expect(permission.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(expect.any(String), { canCreateTriggersForOtherAgents: true }),
  );
});

it("restores all connectors and preserves an existing list on load failure", async () => {
  const update = setup(["notes", "removed"], true);
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load connectors");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Usable connectors"), { target: { value: "all" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.any(String), { allowedConnectorIds: null }));
});
