import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ProviderConnection } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import { createModelRuntime } from "../src/pi/models.ts";

const base = {
  kind: "openai-compatible" as const,
  auth: "api_key" as const,
  connected: true,
  baseUrl: "https://llm.example/v1",
  models: ["model-a"],
};
const chat: ProviderConnection = { ...base, id: "chat-one", name: "Chat endpoint" };
const responses: ProviderConnection = { ...base, id: "resp-one", name: "Responses endpoint", api: "responses" };

describe("custom endpoint wire API", () => {
  it("calls Responses endpoints with the Responses API and everything else with Chat Completions", async () => {
    const runtime = await createModelRuntime({ mode: "gateway", providerConnections: [chat, responses] });
    await runtime.configureProviders([chat, responses]);

    expect(runtime.models.getModel("chat-one", "model-a")?.api).toBe("openai-completions");
    expect(runtime.models.getModel("resp-one", "model-a")?.api).toBe("openai-responses");
    expect(runtime.models.getModel("resp-one", "model-a")?.baseUrl).toBe("https://llm.example/v1");
  });

  it("offers every thinking level for custom endpoints, on either API", async () => {
    const all = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const runtime = await createModelRuntime({ mode: "gateway", providerConnections: [chat, responses] });
    await runtime.configureProviders([chat, responses]);

    for (const id of ["chat-one", "resp-one"]) {
      expect(runtime.models.getModel(id, "model-a")?.reasoning).toBe(true);
      expect(runtime.defaultThinkingLevels(`${id}/model-a`)).toEqual(all);
      expect(getSupportedThinkingLevels(runtime.models.getModel(id, "model-a")!)).toEqual(all);
    }
  });

  it("switches a connection between the two APIs when its saved choice changes", async () => {
    const runtime = await createModelRuntime({ mode: "gateway", providerConnections: [responses] });
    await runtime.configureProviders([responses]);
    expect(runtime.models.getModel("resp-one", "model-a")?.api).toBe("openai-responses");

    const switched = { ...responses, api: "chat" as const };
    await runtime.configureProviders([switched]);
    expect(runtime.models.getModel("resp-one", "model-a")?.api).toBe("openai-completions");
  });
});
