import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { browserTimeZone, saveBrowserTimeZoneIfUnset, TimeZoneSetting } from "./TimeZoneSetting.tsx";

describe("saveBrowserTimeZoneIfUnset", () => {
  it("saves the browser's zone when none is saved yet", async () => {
    const api = {
      getTimeZone: vi.fn().mockResolvedValue({ timeZone: null }),
      updateTimeZone: vi.fn().mockResolvedValue({ timeZone: "x" }),
    };
    await saveBrowserTimeZoneIfUnset(api as never);
    expect(api.updateTimeZone).toHaveBeenCalledWith({ timeZone: browserTimeZone() });
  });

  it("leaves a zone the user has saved alone", async () => {
    const api = {
      getTimeZone: vi.fn().mockResolvedValue({ timeZone: "Europe/Paris" }),
      updateTimeZone: vi.fn(),
    };
    await saveBrowserTimeZoneIfUnset(api as never);
    expect(api.updateTimeZone).not.toHaveBeenCalled();
  });

  it("does not fail the app when the server cannot be reached", async () => {
    const api = {
      getTimeZone: vi.fn().mockRejectedValue(new Error("offline")),
      updateTimeZone: vi.fn(),
    };
    await expect(saveBrowserTimeZoneIfUnset(api as never)).resolves.toBeUndefined();
    expect(api.updateTimeZone).not.toHaveBeenCalled();
  });
});

describe("TimeZoneSetting", () => {
  it("shows the saved zone and saves a change", async () => {
    const api = {
      getTimeZone: vi.fn().mockResolvedValue({ timeZone: "Asia/Macau" }),
      updateTimeZone: vi.fn().mockResolvedValue({ timeZone: "Europe/Paris" }),
    };
    render(<TimeZoneSetting api={api as never} />);
    const select = (await screen.findByLabelText("Time zone")) as HTMLSelectElement;
    expect(select.value).toBe("Asia/Macau");
    fireEvent.change(select, { target: { value: "Europe/Paris" } });
    await waitFor(() => expect(api.updateTimeZone).toHaveBeenCalledWith({ timeZone: "Europe/Paris" }));
  });

  it("says the zone is not set when none is saved", async () => {
    const api = {
      getTimeZone: vi.fn().mockResolvedValue({ timeZone: null }),
      updateTimeZone: vi.fn(),
    };
    render(<TimeZoneSetting api={api as never} />);
    expect(await screen.findByRole("option", { name: "Not set" })).toBeTruthy();
  });
});
