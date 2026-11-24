import type { NotificationsResponse } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import type { PushEnv, PushSupport } from "../lib/push.ts";
import { PushDenied } from "../lib/push.ts";
import { NotificationSettings } from "./NotificationSettings.tsx";

const state = (devices = 0): NotificationsResponse => ({
  devices,
  preview: true,
});

function setup(
  opts: { support?: PushSupport; subscribed?: boolean; enable?: PushEnv["enable"]; api?: Record<string, unknown> } = {},
) {
  const push: PushEnv = {
    support: () => opts.support ?? "ok",
    subscribed: vi.fn().mockResolvedValue(opts.subscribed ?? false),
    enable: opts.enable ?? vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
  };
  const api = {
    getPushKey: vi.fn(),
    registerChannel: vi.fn(),
    getDevices: vi.fn(),
    removeChannel: vi.fn(),
    getNotifications: vi.fn().mockResolvedValue(state()),
    testNotifications: vi.fn().mockResolvedValue(undefined),
    updatePreview: vi.fn().mockResolvedValue({ ...state(), preview: false }),
    ...opts.api,
  };
  render(<NotificationSettings api={api as never} push={push} />);
  return { push, api };
}
const toggle = () => screen.getByRole("switch", { name: "Notifications on this device" });

describe("Notifications on this device", () => {
  it("is a switch that reflects the browser's subscription, and turns on through the push helper", async () => {
    const { push, api } = setup();
    await waitFor(() => expect(push.subscribed).toHaveBeenCalled());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    expect(push.enable).toHaveBeenCalledWith(api);
    expect(api.testNotifications).toHaveBeenCalledTimes(1);
  });

  it("starts on when this browser is subscribed, and off unsubscribes", async () => {
    const { push, api } = setup({ subscribed: true });
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(push.disable).toHaveBeenCalledWith(api);
  });

  it("when permission is refused, says it is blocked in the browser settings and drops the switch", async () => {
    setup({ enable: vi.fn().mockRejectedValue(new PushDenied()) });
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByText(/blocked/i)).toBeTruthy());
    expect(screen.getByText(/browser's settings/)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Notifications on this device" })).toBeNull();
  });

  it("shows the reason instead of a switch where push can't work", () => {
    const { unmount } = render(<div />);
    unmount();
    setup({ support: "needs_home_screen" });
    expect(screen.getByText("Add Rei to your Home Screen to get notifications here.")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Notifications on this device" })).toBeNull();
  });

  it("says it is unsupported, and blocked, from the start", () => {
    setup({ support: "unsupported" });
    expect(screen.getByText(/can't show notifications/)).toBeTruthy();
  });

  it("shows a server failure as a sentence and leaves the switch off", async () => {
    setup({ enable: vi.fn().mockRejectedValue(new ApiError(503, "gateway_unavailable", "x")) });
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/gateway/i));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });
});

describe("Show previews", () => {
  it("reflects the server's setting and turns previews off for every device", async () => {
    const { api } = setup();
    const sw = () => screen.getByRole("switch", { name: "Show previews" });
    await waitFor(() => expect(sw().hasAttribute("disabled")).toBe(false));
    expect(sw().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw());
    await waitFor(() => expect(api.updatePreview).toHaveBeenCalledWith(false));
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("puts the switch back and says why when saving fails", async () => {
    setup({ api: { updatePreview: vi.fn().mockRejectedValue(new ApiError(500, "internal", "x")) } });
    const sw = () => screen.getByRole("switch", { name: "Show previews" });
    await waitFor(() => expect(sw().hasAttribute("disabled")).toBe(false));
    fireEvent.click(sw());
    await screen.findByRole("alert");
    expect(sw().getAttribute("aria-checked")).toBe("true");
  });
});
