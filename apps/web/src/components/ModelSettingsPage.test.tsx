import type { ModelSettingsResponse } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelSettingsPage } from "./ModelSettingsPage.tsx";

const initial: ModelSettingsResponse = {
  fast: { model: "gpt-6-luna", firstEventMs: 120_000, idleMs: 30_000, totalMs: 600_000 },
  standard: { model: "gpt-6.1-sol", firstEventMs: 120_000, idleMs: 30_000, totalMs: 600_000 },
  capabilities: [],
};

describe("ModelSettingsPage", () => {
  it("shows current defaults and saves model choices", async () => {
    const api = {
      getModelSettings: vi.fn().mockResolvedValue(initial),
      getModels: vi.fn().mockResolvedValue({
        default: initial.standard.model,
        models: ["gpt-6-luna", "gpt-6.1-sol", "local/quick"],
      }),
      getProviders: vi.fn().mockResolvedValue({ connections: [] }),
      updateModelSettings: vi.fn().mockImplementation(async (patch) => ({
        ...initial,
        ...patch,
        standard: { ...initial.standard, ...patch.standard },
      })),
    };
    render(<ModelSettingsPage api={api as never} />);
    const standard = (await screen.findByLabelText("Agent chats")) as HTMLSelectElement;
    const fast = screen.getByLabelText("Background tasks") as HTMLSelectElement;
    expect(standard.value).toBe("gpt-6.1-sol");
    expect(fast.value).toBe("gpt-6-luna");

    fireEvent.change(standard, { target: { value: "local/quick" } });
    expect(screen.queryByRole("heading", { name: "Agent chat timeouts" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(api.updateModelSettings).toHaveBeenCalledWith({
        fast: { model: "gpt-6-luna" },
        standard: { model: "local/quick" },
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("Saved.");
  });

  it("shows connection-prefixed models by connection name while keeping the stored value", async () => {
    const api = {
      getModelSettings: vi.fn().mockResolvedValue(initial),
      getModels: vi.fn().mockResolvedValue({
        default: initial.standard.model,
        models: ["gpt-6-luna", "gpt-6.1-sol", "local/quick"],
        labels: { "local/quick": "Local endpoint/quick" },
      }),
      getProviders: vi.fn().mockResolvedValue({ connections: [] }),
      updateModelSettings: vi.fn(),
    };
    render(<ModelSettingsPage api={api as never} />);
    const standard = (await screen.findByLabelText("Agent chats")) as HTMLSelectElement;
    const options = within(standard).getAllByRole("option", { name: "Local endpoint/quick" }) as HTMLOptionElement[];
    expect(options.map((option) => option.value)).toEqual(["local/quick"]);
    expect(screen.queryByRole("option", { name: "local/quick" })).toBeNull();
    expect(standard.value).toBe("gpt-6.1-sol");
  });

  const withLimits = {
    ...initial,
    capabilities: [
      {
        id: "gpt-6.1-sol",
        contextWindow: { value: 8192, source: "built_in" },
        maxTokens: { value: null, source: "unknown" },
      },
    ],
  } as const;
  const limitsApi = () => ({
    getModelSettings: vi.fn().mockResolvedValue(withLimits),
    getModels: vi.fn().mockResolvedValue({ default: "gpt-6.1-sol", models: ["gpt-6-luna", "gpt-6.1-sol"] }),
    getProviders: vi.fn().mockResolvedValue({ connections: [] }),
    updateModelSettings: vi.fn().mockResolvedValue(withLimits),
  });

  it("sends only the limits and efforts the user changed", async () => {
    const api = limitsApi();
    render(<ModelSettingsPage api={api as never} />);
    const context = (await screen.findByLabelText("Context window")) as HTMLInputElement;
    expect(context.value).toBe("");
    expect(context.placeholder).toBe("8192");
    expect(screen.queryByRole("button", { name: "Scan endpoint" })).toBeNull();
    expect(screen.getAllByText("Built-in default").length).toBeGreaterThan(0);
    expect(screen.queryByText("Thinking levels")).toBeNull();

    fireEvent.change(context, { target: { value: "16384" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(api.updateModelSettings).toHaveBeenCalledWith({
        fast: { model: "gpt-6-luna" },
        standard: { model: "gpt-6.1-sol" },
        capabilities: { "gpt-6.1-sol": { contextWindow: 16_384 } },
      }),
    );
  });

  it("refuses a limit that is not a whole number above zero before saving", async () => {
    const api = limitsApi();
    render(<ModelSettingsPage api={api as never} />);
    fireEvent.change(await screen.findByLabelText("Max output tokens"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Max output tokens for gpt-6.1-sol must be a whole number above 0.",
    );
    expect(api.updateModelSettings).not.toHaveBeenCalled();
  });

  it("scans a custom endpoint for its limits and shows them without a page reload", async () => {
    const settingsFor = (reported: boolean) => ({
      fast: { model: "custom-1/model-a", firstEventMs: 120_000, idleMs: 30_000, totalMs: 600_000 },
      standard: { model: "custom-1/model-a", firstEventMs: 120_000, idleMs: 30_000, totalMs: 600_000 },
      capabilities: [
        {
          id: "custom-1/model-a",
          contextWindow: reported ? { value: 32_768, source: "detected" } : { value: null, source: "unknown" },
          maxTokens: { value: null, source: "unknown" },
        },
      ],
    });
    const api = {
      getModelSettings: vi.fn().mockResolvedValueOnce(settingsFor(false)).mockResolvedValue(settingsFor(true)),
      getModels: vi.fn().mockResolvedValue({ default: "custom-1/model-a", models: ["custom-1/model-a"] }),
      getProviders: vi.fn().mockResolvedValue({
        connections: [
          {
            id: "custom-1",
            name: "Mine",
            kind: "openai-compatible",
            auth: "api_key",
            connected: true,
            baseUrl: "https://endpoint.example/v1",
            models: ["model-a"],
          },
        ],
      }),
      scanModelLimits: vi.fn().mockResolvedValue({
        id: "custom-1",
        name: "Mine",
        kind: "openai-compatible",
        auth: "api_key",
        connected: true,
        models: ["model-a"],
        modelInfo: { "model-a": { contextWindow: 32_768 } },
      }),
      updateModelSettings: vi.fn(),
    };
    render(<ModelSettingsPage api={api as never} />);
    fireEvent.click(await screen.findByRole("button", { name: "Scan endpoint" }));

    await waitFor(() => expect(api.scanModelLimits).toHaveBeenCalledWith("custom-1"));
    expect(await screen.findByText("The endpoint reported limits for 1 model.")).toBeTruthy();
    expect((screen.getByLabelText("Context window") as HTMLInputElement).placeholder).toBe("32768");
    expect(api.updateModelSettings).not.toHaveBeenCalled();
  });

  it("clears the limits the user entered for a model and saves them right away", async () => {
    const entered = {
      ...withLimits,
      capabilities: [
        {
          id: "gpt-6.1-sol",
          contextWindow: { value: 16_384, source: "custom" },
          maxTokens: { value: null, source: "unknown" },
        },
      ],
    };
    const api = {
      ...limitsApi(),
      getModelSettings: vi.fn().mockResolvedValue(entered),
      updateModelSettings: vi.fn().mockResolvedValue(withLimits),
    };
    render(<ModelSettingsPage api={api as never} />);
    fireEvent.click(await screen.findByRole("button", { name: "Clear entered values" }));

    await waitFor(() =>
      expect(api.updateModelSettings).toHaveBeenCalledWith({
        fast: { model: "gpt-6-luna" },
        standard: { model: "gpt-6.1-sol" },
        capabilities: { "gpt-6.1-sol": { contextWindow: null, maxTokens: null } },
      }),
    );
    expect((screen.getByLabelText("Context window") as HTMLInputElement).value).toBe("");
  });

  it("disables clearing when the model has no entered limits", async () => {
    const api = limitsApi();
    render(<ModelSettingsPage api={api as never} />);
    expect(((await screen.findByRole("button", { name: "Clear entered values" })) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
