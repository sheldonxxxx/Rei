import type { ProviderConnection, SaveProviderConnectionRequest } from "@rei/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProvidersPage } from "./ProvidersPage.tsx";

const endpoint: ProviderConnection = {
  id: "custom-one",
  name: "Local AI",
  kind: "openai-compatible",
  auth: "api_key",
  connected: true,
  baseUrl: "https://llm.example/v1",
  models: ["model-a"],
};

function makeApi(initialRows: ProviderConnection[] = [endpoint]) {
  let rows = initialRows;
  return {
    scanProviderModels: vi.fn().mockResolvedValue({ models: ["tiny-chat"] }),
    getProviders: vi.fn(async () => ({ connections: rows })),
    saveProvider: vi.fn(async (input: SaveProviderConnectionRequest) => {
      rows = [{ ...endpoint, ...input, id: input.id ?? endpoint.id }];
      return rows[0]!;
    }),
    removeProvider: vi.fn(async () => {
      rows = [];
    }),
    startOpenAiOAuth: vi.fn().mockResolvedValue({ authorizationUrl: "https://auth.openai.com/authorize" }),
    getOpenAiOAuthStatus: vi.fn().mockResolvedValue({ pending: true }),
    submitOpenAiOAuthCallback: vi.fn().mockResolvedValue({ ok: true }),
    cancelOpenAiOAuth: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ProvidersPage", () => {
  it("scans a custom endpoint before saving and allows reviewing its model IDs", async () => {
    const api = makeApi([]);
    render(<ProvidersPage api={api as never} />);
    await screen.findByText("No providers connected yet.");
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai-compatible" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://host.docker.internal:18000/v1" } });
    fireEvent.change(screen.getByLabelText("API key (optional)"), { target: { value: "local-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Scan models" }));
    await screen.findByRole("status");
    expect(api.scanProviderModels).toHaveBeenCalledWith({
      baseUrl: "http://host.docker.internal:18000/v1",
      apiKey: "local-test-key",
    });
    expect(screen.getByRole("button", { name: "Remove tiny-chat" })).toBeTruthy();
    expect(api.saveProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() =>
      expect(api.saveProvider).toHaveBeenCalledWith(expect.objectContaining({ models: ["tiny-chat"] })),
    );
  });

  it("edits saved connections without sending the existing secret back to the browser", async () => {
    const api = makeApi();
    render(<ProvidersPage api={api as never} />);
    await screen.findByText("Local AI");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My local endpoint" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(api.saveProvider).toHaveBeenCalledWith({
        id: "custom-one",
        name: "My local endpoint",
        kind: "openai-compatible",
        baseUrl: endpoint.baseUrl,
        api: "chat",
        models: ["model-a"],
      }),
    );
  });

  it("saves a custom endpoint with the Responses API when the user chooses it", async () => {
    const api = makeApi([]);
    render(<ProvidersPage api={api as never} />);
    await screen.findByText("No providers connected yet.");
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai-compatible" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Responses host" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://llm.example/v1" } });
    expect((screen.getByLabelText("API") as HTMLSelectElement).value).toBe("chat");
    fireEvent.change(screen.getByLabelText("API"), { target: { value: "responses" } });
    fireEvent.change(screen.getByLabelText("Model IDs"), { target: { value: "model-a" } });
    fireEvent.keyDown(screen.getByLabelText("Model IDs"), { key: "Enter" });
    expect(screen.getByText(/Requests use Responses/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() =>
      expect(api.saveProvider).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "openai-compatible", api: "responses", models: ["model-a"] }),
      ),
    );
  });

  it("shows the saved API choice when editing a Responses endpoint", async () => {
    const api = makeApi([{ ...endpoint, api: "responses" }]);
    render(<ProvidersPage api={api as never} />);
    await screen.findByText("Local AI");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("API") as HTMLSelectElement).value).toBe("responses");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.saveProvider).toHaveBeenCalledWith(expect.objectContaining({ api: "responses" })));
  });

  it("offers OpenAI and custom OpenAI-compatible connections", async () => {
    render(<ProvidersPage api={makeApi() as never} />);
    const selector = await screen.findByLabelText("Provider");
    expect(selector.textContent).toContain("OpenAI");
    expect(selector.textContent).toContain("Custom OpenAI-compatible endpoint");
  });

  it("explains how to return the OAuth callback before opening ChatGPT", async () => {
    const api = makeApi([]);
    api.getOpenAiOAuthStatus.mockResolvedValue({ pending: false });
    const popup = {
      closed: false,
      opener: null,
      location: { href: "about:blank" },
      close: vi.fn(),
    } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    render(<ProvidersPage api={api as never} />);

    fireEvent.change(await screen.findByLabelText("Sign-in method"), { target: { value: "oauth" } });
    fireEvent.click(await screen.findByRole("button", { name: "Use ChatGPT subscription" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("list", { name: "ChatGPT sign-in steps" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Continue opens ChatGPT in a new tab. Sign in there.")).toBeTruthy();
    expect(screen.queryByText(/Keep this Rei page open/i)).toBeNull();
    expect(screen.getAllByRole("listitem")[1]?.textContent).toContain("copy its full URL from the address bar");
    expect(api.startOpenAiOAuth).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue to ChatGPT" }));
    await waitFor(() => expect(api.startOpenAiOAuth).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledOnce();
    expect(await screen.findByLabelText("Redirect URL")).toBeTruthy();
  });

  it("requires an API key when changing an existing ChatGPT connection to API-key auth", async () => {
    const openai: ProviderConnection = {
      id: "openai",
      name: "OpenAI",
      kind: "openai",
      auth: "oauth",
      connected: true,
      models: [],
    };
    const api = makeApi([openai]);
    render(<ProvidersPage api={api as never} />);
    await screen.findByText("OpenAI · ChatGPT");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Sign-in method"), { target: { value: "api_key" } });
    const key = screen.getByLabelText("OpenAI API key");
    expect((key as HTMLInputElement).required).toBe(true);
    fireEvent.change(key, { target: { value: "sk-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(api.saveProvider).toHaveBeenCalledWith({
        id: "openai",
        name: "OpenAI",
        kind: "openai",
        auth: "api_key",
        apiKey: "sk-new-key",
      }),
    );
  });
});

it("refreshes provider connections and notifies onboarding after a pasted OAuth callback completes", async () => {
  vi.useFakeTimers();
  try {
    const api = makeApi([]);
    const changed = vi.fn();
    api.getOpenAiOAuthStatus.mockResolvedValue({ pending: false });
    const popup = {
      closed: false,
      opener: null,
      location: { href: "about:blank" },
      close: vi.fn(),
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    render(<ProvidersPage api={api as never} onChanged={changed} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Sign-in method"), { target: { value: "oauth" } });
    fireEvent.click(screen.getByRole("button", { name: "Use ChatGPT subscription" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to ChatGPT" }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Redirect URL"), {
      target: { value: "http://127.0.0.1:1455/auth/callback?test" },
    });
    api.getProviders.mockResolvedValue({
      connections: [{ id: "openai", kind: "openai", name: "OpenAI", auth: "oauth", connected: true, models: [] }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    await act(async () => {});
    expect((screen.getByLabelText("Redirect URL") as HTMLInputElement).value).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("OpenAI · ChatGPT")).toBeTruthy();
    expect(changed).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Redirect URL")).toBeNull();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
