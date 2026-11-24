import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import { EmbeddingSettings } from "./EmbeddingSettings.tsx";

const saveButton = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

it("tests the entered oMLX values before Save is allowed, then saves and clears the key", async () => {
  const save = vi.fn().mockImplementation(async ({ apiKey: _key, ...value }) => value);
  const check = vi.fn().mockResolvedValue({ ok: true, dims: 768 });
  const changed = vi.fn();
  render(
    <EmbeddingSettings
      api={{ getEmbeddingSetup: async () => null, saveEmbeddingSetup: save, checkEmbeddingSetup: check } as never}
      onSaved={changed}
    />,
  );
  await waitFor(() => expect(saveButton().disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Embedding provider"), { target: { value: "omlx" } });
  expect(saveButton().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Embedding API key (optional)"), { target: { value: "private-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("Connection verified");
  expect(screen.getByText("768 dimensions detected")).toBeTruthy();
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "omlx",
      baseUrl: "http://host.docker.internal:18000",
      apiKey: "private-test-key",
      profile: expect.objectContaining({ dims: 768 }),
    }),
  );
  expect(save).not.toHaveBeenCalled();
  expect(saveButton().disabled).toBe(false);

  // Changing any value after a passing test withdraws the verification.
  fireEvent.change(screen.getByLabelText("Embedding model ID"), { target: { value: "other-model" } });
  expect(screen.queryByText("Connection verified")).toBeNull();
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("Connection verified");

  fireEvent.click(saveButton());
  await screen.findByText("Saved");
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "omlx", apiModel: "other-model", apiKey: "private-test-key" }),
  );
  expect((screen.getByLabelText("Embedding API key (optional)") as HTMLInputElement).value).toBe("");
  expect(changed).toHaveBeenCalledOnce();
});

it("keeps a failed test visible, blocks Save, then detects dimensions for an OpenAI-compatible API", async () => {
  const save = vi
    .fn()
    .mockImplementation(async ({ apiKey: _key, ...value }) => ({ ...value, profile: { dims: 1536 } }));
  const check = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(400, "embedding_failed", "Connection test failed"))
    .mockResolvedValue({ ok: true, dims: 1536 });
  render(
    <EmbeddingSettings
      api={{ getEmbeddingSetup: async () => null, saveEmbeddingSetup: save, checkEmbeddingSetup: check } as never}
      onSaved={() => {}}
    />,
  );
  await waitFor(() => expect(saveButton().disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Embedding provider"), { target: { value: "openai" } });
  fireEvent.change(screen.getByLabelText("Embedding URL"), { target: { value: "https://embedding.test" } });
  fireEvent.change(screen.getByLabelText("Embedding model ID"), { target: { value: "text-embedding" } });
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("Connection test failed");
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("1536 dimensions detected");
  fireEvent.click(saveButton());
  await screen.findByText("Saved");
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ profile: null, advanced: expect.objectContaining({ contextTokens: 512 }) }),
  );
});
