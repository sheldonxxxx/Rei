import type { TitleSettings as Settings } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import { TitleSettings } from "./TitleSettings.tsx";

const settings = (over: Partial<Settings> = {}): Settings => ({
  enabled: true,
  model: null,
  default: "gpt-6-luna",
  ...over,
});

function setup(initial: Settings = settings(), api: Record<string, unknown> = {}) {
  const fake = {
    getTitleSettings: vi.fn().mockResolvedValue(initial),
    updateTitleSettings: vi.fn().mockImplementation(async (req: Partial<Settings>) => ({ ...initial, ...req })),
    getModels: vi
      .fn()
      .mockResolvedValue({ default: "gpt-6.1-sol", models: ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-sol"] }),
    ...api,
  };
  render(<TitleSettings api={fake as never} />);
  return fake;
}
const select = () => screen.getByLabelText("Chat titles") as HTMLSelectElement;

describe("TitleSettings", () => {
  it("shows the default model and the model list", async () => {
    setup();
    await screen.findByRole("option", { name: "gpt-5.6-sol" });
    expect(screen.getByRole("option", { name: "Default (gpt-6-luna)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Off/ })).toBeTruthy();
    expect(select().value).toBe("");
  });

  it("picking a model saves it; Default goes back to null; Off turns titles off", async () => {
    const api = setup();
    await screen.findByRole("option", { name: "gpt-5.6-sol" });
    fireEvent.change(select(), { target: { value: "gpt-5.6-sol" } });
    await waitFor(() =>
      expect(api.updateTitleSettings).toHaveBeenLastCalledWith({ enabled: true, model: "gpt-5.6-sol" }),
    );
    await waitFor(() => expect(select().value).toBe("gpt-5.6-sol"));
    fireEvent.change(select(), { target: { value: "" } });
    await waitFor(() => expect(api.updateTitleSettings).toHaveBeenLastCalledWith({ enabled: true, model: null }));
    fireEvent.change(select(), { target: { value: "\u0000off" } });
    await waitFor(() => expect(api.updateTitleSettings).toHaveBeenLastCalledWith({ enabled: false }));
  });

  it("reflects what is saved: off, or a model the list lacks", async () => {
    setup(settings({ enabled: false }));
    await waitFor(() => expect(select().value).toBe("\u0000off"));
  });

  it("marks the saved model unavailable when the model list cannot be loaded", async () => {
    setup(settings({ model: "my-model" }), { getModels: vi.fn().mockRejectedValue(new ApiError(500, "x", "")) });
    await waitFor(() => expect(select().value).toBe("my-model"));
    expect((screen.getByRole("option", { name: "Current model unavailable" }) as HTMLOptionElement).disabled).toBe(
      true,
    );
  });

  it("shows a save error", async () => {
    setup(settings(), { updateTitleSettings: vi.fn().mockRejectedValue(new ApiError(400, "bad_request", "")) });
    await screen.findByRole("option", { name: "gpt-5.6-sol" });
    fireEvent.change(select(), { target: { value: "gpt-5.6-sol" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
