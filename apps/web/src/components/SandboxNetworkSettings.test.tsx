import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { SandboxNetworkSettings } from "./SandboxNetworkSettings.tsx";

const DEFAULTS = ["pypi.org", "github.com"];

function setup(whitelist: string[] = DEFAULTS, update?: ReturnType<typeof vi.fn>) {
  const updateSandboxNetwork =
    update ??
    vi.fn().mockImplementation(async (req: { whitelist?: string[] }) => ({
      whitelist: req.whitelist ?? DEFAULTS,
      defaults: DEFAULTS,
    }));
  const api = {
    getSandboxNetwork: vi.fn().mockResolvedValue({ whitelist, defaults: DEFAULTS }),
    updateSandboxNetwork,
  };
  render(<SandboxNetworkSettings api={api as unknown as Api} />);
  return updateSandboxNetwork;
}
const entryBox = () => screen.getByLabelText("Add a site or network");
const list = () => within(screen.getByRole("list", { name: "Sandbox whitelist" }));

describe("SandboxNetworkSettings", () => {
  it("says a local-network address needs both its name and its address on the list", async () => {
    setup();
    expect(await screen.findByText("pypi.org")).toBeTruthy();
    expect(screen.getByText(/both its host name and the address are on this list/)).toBeTruthy();
  });

  it("lists the saved entries and saves an added one, trimmed", async () => {
    const update = setup();
    expect(await screen.findByText("pypi.org")).toBeTruthy();
    expect((screen.queryByRole("button", { name: "Save whitelist" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(entryBox(), { target: { value: " 10.0.0.0/8 " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save whitelist" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ whitelist: ["pypi.org", "github.com", "10.0.0.0/8"] }));
    expect(await screen.findByText("Saved. Applies to the next request.")).toBeTruthy();
  });

  it("removes an entry, refuses a duplicate, and restores the defaults", async () => {
    const update = setup(["pypi.org", "github.com", "*.corp.example"]);
    fireEvent.click(await screen.findByRole("button", { name: "Remove github.com" }));
    expect(list().queryByText("github.com")).toBeNull();
    fireEvent.change(entryBox(), { target: { value: "PYPI.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toContain("already on the list");
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ reset: true }));
    expect(await list().findByText("github.com")).toBeTruthy();
  });

  it("keeps the edited list when the server refuses the save", async () => {
    setup(
      DEFAULTS,
      vi.fn().mockRejectedValue(new ApiError(400, "bad_request", "The whitelist must be a list of host names.")),
    );
    await screen.findByText("pypi.org");
    fireEvent.change(entryBox(), { target: { value: "bad host" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save whitelist" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(list().getByText("bad host")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });
});
