import type { ProviderConnection } from "@rei/protocol";
import { describe, expect, it, vi } from "vitest";
import { createModelRuntime } from "../src/pi/models.ts";
import { ProviderService } from "../src/providers/service.ts";
import { startSignedIn } from "./helpers/server.ts";

const custom: ProviderConnection = {
  id: "custom-one",
  name: "Test endpoint",
  kind: "openai-compatible",
  auth: "api_key",
  connected: true,
  baseUrl: "https://llm.example/v1",
  models: ["model-a", "model-b"],
};

describe("provider settings", () => {
  it("uses and refreshes the server stand-in for custom model transports", async () => {
    let token = "first-standin";
    const runtime = await createModelRuntime({
      mode: "gateway",
      standin: { read: async () => token },
      providerConnections: [custom],
    });
    expect((await runtime.models.getAuth(custom.id))?.auth.apiKey).toBe(token);
    token = "rotated-standin";
    await runtime.refreshCredential();
    expect((await runtime.models.getAuth(custom.id))?.auth.apiKey).toBe(token);
    await runtime.configureProviders([custom, { ...custom, id: "later" }]);
    expect((await runtime.models.getAuth("later"))?.auth.apiKey).toBe(token);
  });

  it("offers only connected provider models and excludes the stock SDK catalog", async () => {
    const runtime = await createModelRuntime({ mode: "gateway" });
    expect(runtime.selectableModels()).toEqual([]);
    await runtime.configureProviders([{ ...custom, connected: false }]);
    expect(runtime.selectableModels()).toEqual([]);
    await runtime.configureProviders([custom]);
    expect(runtime.selectableModels()).toEqual(["custom-one/model-a", "custom-one/model-b"]);
    // Values keep the connection id for routing; labels show the connection's name instead.
    expect(runtime.selectableLabels()).toEqual({
      "custom-one/model-a": "Test endpoint/model-a",
      "custom-one/model-b": "Test endpoint/model-b",
    });
    await runtime.configureProviders([
      {
        id: "openai",
        name: "OpenAI",
        kind: "openai",
        auth: "oauth",
        connected: true,
        models: [],
      },
    ]);
    expect(runtime.selectableModels()).toContain("gpt-6.1-sol");
    expect(runtime.selectableModels()).not.toContain("gpt-4");
    runtime.ref("retired-model");
    expect(runtime.selectableModels()).not.toContain("retired-model");
    await runtime.configureProviders([]);
    expect(runtime.selectableModels()).toEqual([]);
  });

  it.each([401, 403])(
    "keeps gateway auth failures (%s) separate from browser session authentication",
    async (status) => {
      const fetchImpl = vi.fn(async () =>
        Response.json({ error: { code: "bad_token", message: "internal gateway detail" } }, { status }),
      );
      const server = await startSignedIn({ gatewayUrl: "http://gateway", fetchImpl });
      try {
        const result = await server.client.get("/api/providers");
        expect(result.status).toBe(502);
        expect(result.body.error).toEqual({
          code: "gateway_auth",
          message: "The gateway rejected this server's stand-in token.",
        });
        expect((await server.client.get("/api/auth/state")).body.signedIn).toBe(true);
      } finally {
        await server.destroy();
      }
    },
  );

  it("loads saved endpoints lazily and removes their models from the runtime when deleted", async () => {
    const loader = vi.fn(async () => [custom]);
    const runtime = await createModelRuntime({
      mode: "gateway",
      standin: { read: async () => "standin" },
      providerLoader: loader,
    });
    expect(loader).not.toHaveBeenCalled();

    await Promise.all([runtime.ensureProviders?.(), runtime.ensureProviders?.()]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(runtime.ref("custom-one/model-a")).toEqual({ provider: "custom-one", modelId: "model-a" });
    expect(runtime.models.getModel("custom-one", "model-a")).toMatchObject({
      api: "openai-completions",
      baseUrl: custom.baseUrl,
    });

    await runtime.configureProviders([]);
    expect(runtime.models.getProvider("custom-one")).toBeUndefined();
  });

  it("prevents deleting a connection while a configured model refers to it", async () => {
    const fetch = vi.fn();
    const service = new ProviderService({
      gatewayUrl: "http://gateway",
      token: async () => "standin",
      fetchImpl: fetch,
      isInUse: async (id) => id === "custom-one",
    });
    await expect(service.remove("custom-one")).rejects.toMatchObject({ status: 409, code: "provider_in_use" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps model IDs that configured agents or defaults still use", async () => {
    const fetch = vi.fn();
    const service = new ProviderService({
      gatewayUrl: "http://gateway",
      token: async () => "standin",
      fetchImpl: fetch,
      usedModels: async () => ["model-a"],
    });
    await expect(service.save({ ...custom, models: ["model-b"] })).rejects.toMatchObject({
      status: 409,
      code: "provider_model_in_use",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("switches agents and defaults to the first remaining model when an in-use model is dropped", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...custom, connections: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const replaceModels = vi.fn(async () => undefined);
    const service = new ProviderService({
      gatewayUrl: "http://gateway",
      token: async () => "standin",
      fetchImpl: fetch,
      usedModels: async () => ["model-a"],
      replaceModels,
    });
    const saved = await service.save({ ...custom, models: ["model-b", "model-c"] });
    expect(replaceModels).toHaveBeenCalledWith(custom.id, ["model-a"], "model-b");
    expect(saved.replacedModels).toEqual([{ from: "model-a", to: "model-b" }]);
  });

  it("updates the runtime after a provider is removed", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ connections: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
    const onChanged = vi.fn(async () => {});
    const service = new ProviderService({
      gatewayUrl: "http://gateway",
      token: async () => "standin",
      fetchImpl: fetch,
    });
    service.onChanged = onChanged;
    await service.remove("custom-one");
    expect(fetch.mock.calls.map((call) => String(call[0]).split("/providers")[1])).toEqual(["/custom-one", ""]);
    expect(onChanged).toHaveBeenCalledWith([]);
  });

  it("scans one custom endpoint for its limits and keeps its models unchanged", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("http://gateway", "");
      if (path === "/providers" && init?.method !== "POST") return Response.json({ connections: [custom] });
      if (path === "/providers/scan")
        return Response.json({ models: ["model-a"], modelInfo: { "model-a": { contextWindow: 32_768 } } });
      if (path === "/providers" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        saved.push(body);
        return Response.json({ ...custom, modelInfo: body.modelInfo });
      }
      return Response.json({ error: { code: "not_found", message: "not here" } }, { status: 404 });
    });
    const server = await startSignedIn({ gatewayUrl: "http://gateway", fetchImpl });
    try {
      const result = await server.client.call("POST", "/api/providers/custom-one/limits/scan");
      expect(result.status).toBe(200);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        id: "custom-one",
        kind: "openai-compatible",
        models: ["model-a", "model-b"],
        modelInfo: { "model-a": { contextWindow: 32_768 } },
      });
      const other = await server.client.call("POST", "/api/providers/not-a-connection/limits/scan");
      expect(other.status).toBe(400);
    } finally {
      await server.destroy();
    }
  });

  it("forwards a custom endpoint's Responses API choice on save and keeps it through a limits scan", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const responsesEndpoint: ProviderConnection = { ...custom, api: "responses" };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("http://gateway", "");
      if (path === "/providers" && init?.method !== "POST") return Response.json({ connections: [responsesEndpoint] });
      if (path === "/providers/scan") return Response.json({ models: ["model-a"], modelInfo: {} });
      if (path === "/providers" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        saved.push(body);
        return Response.json({ ...responsesEndpoint, ...body });
      }
      return Response.json({ error: { code: "not_found", message: "not here" } }, { status: 404 });
    });
    const server = await startSignedIn({ gatewayUrl: "http://gateway", fetchImpl });
    try {
      const created = await server.client.post("/api/providers", {
        kind: "openai-compatible",
        name: "Responses host",
        baseUrl: "https://llm.example/v1",
        api: "responses",
        models: ["model-a"],
      });
      expect(created.status).toBe(201);
      expect(saved[0]).toMatchObject({ api: "responses" });

      // The scan re-saves the endpoint; it must not reset the choice the user saved.
      const scanned = await server.client.call("POST", "/api/providers/custom-one/limits/scan");
      expect(scanned.status).toBe(200);
      expect(saved[1]).toMatchObject({ id: "custom-one", api: "responses" });
    } finally {
      await server.destroy();
    }
  });

  it("passes Codex Images sign-in through to the gateway without exposing any token", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("http://gateway", "");
      seen.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/setup/codex-images" && (init?.method ?? "GET") === "GET")
        return Response.json({ enabled: true, signedIn: false, pending: false });
      if (path === "/setup/codex-images/signin" && init?.method === "POST")
        return Response.json({ userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device" });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ error: { code: "not_found", message: "not here" } }, { status: 404 });
    });
    const server = await startSignedIn({ gatewayUrl: "http://gateway", fetchImpl });
    try {
      expect((await server.client.get("/api/providers/codex-images")).body).toEqual({
        enabled: true,
        signedIn: false,
        pending: false,
      });
      const started = await server.client.post("/api/providers/codex-images/signin", {});
      expect(started.body).toEqual({ userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device" });
      expect((await server.client.call("DELETE", "/api/providers/codex-images/signin")).status).toBe(204);
      expect((await server.client.call("DELETE", "/api/providers/codex-images/credential")).status).toBe(204);
      expect(seen).toEqual([
        "GET /setup/codex-images",
        "POST /setup/codex-images/signin",
        "DELETE /setup/codex-images/signin",
        "DELETE /setup/codex-images",
      ]);
    } finally {
      await server.destroy();
    }
  });

  it("reports Codex Images as off when the server has no gateway", async () => {
    const server = await startSignedIn();
    try {
      expect((await server.client.get("/api/providers/codex-images")).body).toEqual({
        enabled: false,
        signedIn: false,
        pending: false,
      });
    } finally {
      await server.destroy();
    }
  });
});
