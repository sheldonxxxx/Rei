import type { MemoryExtractionSettings as Settings } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import { MemoryExtractionSettings } from "./MemoryExtractionSettings.tsx";

function setup(initial: Settings = { enabled: false, everyNTurns: 5 }, api: Record<string, unknown> = {}) {
  const fake = {
    getMemoryExtraction: vi.fn().mockResolvedValue(initial),
    updateMemoryExtraction: vi.fn().mockImplementation(async (req: Partial<Settings>) => ({ ...initial, ...req })),
    ...api,
  };
  render(<MemoryExtractionSettings api={fake as never} />);
  return fake;
}
const toggle = () => screen.getByRole("switch", { name: "Background memory review" });

describe("MemoryExtractionSettings", () => {
  it("is off by default and says what it reads, what it costs, and that the agent's memory tools still work", async () => {
    setup();
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    const help = screen.getByText(/Off by default/);
    expect(help.textContent).toMatch(/each chat/);
    expect(help.textContent).toMatch(/your new messages/);
    expect(help.textContent).toMatch(/earlier messages are not backfilled/);
    expect(help.textContent).toMatch(/source reply’s model/);
    expect(screen.getByLabelText("Review every N replies")).toBeTruthy();
  });

  it("turning it on saves it, and turning it off saves that", async () => {
    const api = setup();
    await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle());
    await waitFor(() => expect(api.updateMemoryExtraction).toHaveBeenLastCalledWith({ enabled: true }));
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle());
    await waitFor(() => expect(api.updateMemoryExtraction).toHaveBeenLastCalledWith({ enabled: false }));
  });

  it("reflects a setting that is already on", async () => {
    setup({ enabled: true, everyNTurns: 5 });
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
  });

  it("shows the error and keeps the saved state when a change fails", async () => {
    setup(
      { enabled: false, everyNTurns: 5 },
      { updateMemoryExtraction: vi.fn().mockRejectedValue(new ApiError(500, "internal", "Could not save.")) },
    );
    await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("shows the error when the setting cannot be read, and the switch stays off and disabled", async () => {
    setup(
      { enabled: true, everyNTurns: 5 },
      { getMemoryExtraction: vi.fn().mockRejectedValue(new ApiError(500, "internal", "Down.")) },
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(toggle().hasAttribute("disabled")).toBe(true);
  });
});
