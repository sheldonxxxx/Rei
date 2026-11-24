import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { navigate } from "../lib/route.ts";
import { ComposerSettings } from "./ComposerSettings.tsx";

describe("ComposerSettings", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));
  it("shows no model when unconfigured and refreshes the default after returning from Settings", async () => {
    const getModels = vi.fn().mockResolvedValue({ default: "old-model", models: [] });
    render(
      <ComposerSettings
        api={{ getModels } as unknown as Api}
        agent={{ id: "a1", model: null, thinkingLevel: "off" } as never}
        session={{ profile: "standard" } as never}
        onPermissions={() => {}}
      />,
    );
    await screen.findByText("No models available");
    expect(screen.queryByText("old-model")).toBeNull();
    getModels.mockResolvedValue({ default: "local/tiny", models: ["local/tiny"] });
    act(() => navigate("/s/elsewhere"));
    await waitFor(() => expect(screen.getByText("local/tiny")).toBeTruthy());
  });
});
