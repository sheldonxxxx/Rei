import type { Device } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DevicesSettings } from "./DevicesSettings.tsx";

const device = (over: Partial<Device>): Device => ({
  id: "dev_a",
  label: "Safari on macOS",
  kind: "web",
  createdAt: Date.now() - 86_400_000,
  lastSeenAt: Date.now(),
  current: false,
  active: false,
  channels: [],
  ...over,
});

function setup(devices: Device[]) {
  let list = devices;
  const api = {
    getDevices: vi.fn(async () => ({ devices: list })),
    renameDevice: vi.fn(async (id: string, label: string) => {
      list = list.map((d) => (d.id === id ? { ...d, label } : d));
      return list.find((d) => d.id === id)!;
    }),
    revokeDevice: vi.fn(async (id: string) => {
      list = list.filter((d) => d.id !== id);
      return { ok: true as const };
    }),
  };
  const onLogout = vi.fn();
  render(<DevicesSettings api={api} onLogout={onLogout} />);
  return { api, onLogout };
}

it("lists devices with this one marked, the ones in use, and their notification channels", async () => {
  setup([
    device({ id: "dev_here", current: true, active: true }),
    device({
      id: "dev_phone",
      label: "Rei on iPhone",
      kind: "ios",
      active: true,
      channels: [{ id: "ch_1", kind: "apns", state: "not_configured", createdAt: 1 }],
    }),
  ]);
  expect(await screen.findByText("This device")).toBeTruthy();
  expect(screen.getByText("In use")).toBeTruthy();
  expect(screen.getByText(/Apple notifications \(not set up on this server\)/)).toBeTruthy();
});

it("renames a device", async () => {
  const { api } = setup([device({ id: "dev_here", current: true })]);
  fireEvent.click(await screen.findByRole("button", { name: "Rename Safari on macOS" }));
  fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Work Mac" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Work Mac")).toBeTruthy();
  expect(api.renameDevice).toHaveBeenCalledWith("dev_here", "Work Mac");
});

it("signs another device out after a confirmation, and signs you out when it is this one", async () => {
  const { api, onLogout } = setup([
    device({ id: "dev_here", current: true }),
    device({ id: "dev_old", label: "Firefox on Windows" }),
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out Firefox on Windows" }));
  expect(api.revokeDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Sign out device" }));
  await waitFor(() => expect(screen.queryByText("Firefox on Windows")).toBeNull());
  expect(onLogout).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Sign out Safari on macOS" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign out here" }));
  await waitFor(() => expect(onLogout).toHaveBeenCalled());
});
