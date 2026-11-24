import type { ProviderConnection } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import { ModelCatalog } from "../src/pi/catalog.ts";
import type { ModelsConfig } from "../src/pi/model-config.ts";
import { createModelRuntime } from "../src/pi/models.ts";

const endpoint: ProviderConnection = {
  id: "custom-one",
  name: "Test endpoint",
  kind: "openai-compatible",
  auth: "api_key",
  connected: true,
  baseUrl: "https://llm.example/v1",
  models: ["model-a"],
  modelInfo: { "model-a": { contextWindow: 8_000 } },
};

async function catalog() {
  const runtime = await createModelRuntime({ mode: "gateway", providerConnections: [endpoint] });
  let saved: unknown;
  const modelsConfig = {
    read: async () => saved,
    // Saved the way models.json stores it: the user's limits under `models`.
    write: (value: ModelsConfig) => {
      saved = { fast: value.fast, standard: value.standard, models: value.overrides };
    },
  };
  return new ModelCatalog({ store: { modelsInUse: () => [] }, modelsConfig, runtime });
}

describe("per-model limit overrides", () => {
  it("checks a change against the limits that apply after it, not the saved override", async () => {
    const models = await catalog();
    await models.update({ capabilities: { "custom-one/model-a": { contextWindow: 100_000 } } });

    // Clearing the custom window falls back to the detected 8,000, which cannot hold 50,000 output tokens.
    await expect(
      models.update({ capabilities: { "custom-one/model-a": { contextWindow: null, maxTokens: 50_000 } } }),
    ).rejects.toMatchObject({ status: 400 });

    const cleared = await models.update({
      capabilities: { "custom-one/model-a": { contextWindow: null, maxTokens: 4_000 } },
    });
    expect(cleared.capabilities.find((c) => c.id === "custom-one/model-a")).toMatchObject({
      contextWindow: { value: 8_000, source: "detected" },
      maxTokens: { value: 4_000, source: "custom" },
    });
  });
});
