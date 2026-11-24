import type { ProviderConnection } from "@rei/protocol";
import { describe, expect, it, vi } from "vitest";
import { createModelRuntime } from "../src/pi/models.ts";

describe("provider discovery recovery", () => {
  const connection: ProviderConnection = {
    id: "custom",
    name: "Custom",
    kind: "openai-compatible",
    auth: "api_key",
    connected: true,
    baseUrl: "https://old.example/v1",
    models: ["model-a"],
  };

  it.each([
    { action: "deletion", connections: [] },
    { action: "update", connections: [{ ...connection, baseUrl: "https://new.example/v1" }] },
  ])("does not overwrite a newer $action with an old discovery result", async ({ connections }) => {
    const discovery = Promise.withResolvers<ProviderConnection[]>();
    const runtime = await createModelRuntime({ mode: "gateway", providerLoader: () => discovery.promise });
    const loading = runtime.ensureProviders();
    await runtime.configureProviders(connections);
    discovery.resolve([connection]);
    await loading;
    expect(runtime.models.getModel("custom", "model-a")?.baseUrl).toBe(connections[0]?.baseUrl);
    if (!connections.length) expect(runtime.models.getProvider("custom")).toBeUndefined();
  });

  it("applies concurrent settings snapshots in order without leaving models from an older update", async () => {
    const runtime = await createModelRuntime({ mode: "gateway" });
    const first = runtime.configureProviders([connection, { ...connection, id: "second" }]);
    const last = runtime.configureProviders([{ ...connection, id: "latest" }]);
    await Promise.all([first, last]);
    expect(runtime.models.getProvider("custom")).toBeUndefined();
    expect(runtime.models.getProvider("second")).toBeUndefined();
    expect(runtime.models.getModel("latest", "model-a")).toBeDefined();
  });

  it("keeps known models available after a discovery failure and retries without duplicating concurrent loads", async () => {
    const outage = new Error("discovery unavailable");
    const loader = vi.fn().mockRejectedValueOnce(outage).mockResolvedValue([]);
    const onProviderLoadError = vi.fn();
    const runtime = await createModelRuntime({ mode: "gateway", providerLoader: loader, onProviderLoadError });
    await Promise.all([runtime.ensureProviders(), runtime.ensureProviders()]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(onProviderLoadError).toHaveBeenCalledWith(outage);
    const ref = runtime.ref("gpt-6.1-sol");
    expect(runtime.models.getModel(ref.provider, ref.modelId)).toBeDefined();
    await runtime.ensureProviders();
    expect(loader).toHaveBeenCalledTimes(2);
    await runtime.ensureProviders();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(onProviderLoadError).toHaveBeenCalledTimes(1);
  });

  it("recovers when discovery throws before returning a promise", async () => {
    const loader = vi
      .fn<() => Promise<ProviderConnection[]>>()
      .mockImplementationOnce(() => {
        throw new Error("discovery failed");
      })
      .mockResolvedValue([]);
    const runtime = await createModelRuntime({ mode: "gateway", providerLoader: loader });
    await expect(runtime.ensureProviders()).resolves.toBeUndefined();
    await runtime.ensureProviders();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
