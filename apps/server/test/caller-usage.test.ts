import type { GatewayCaller, GatewayUsageResponse } from "@rei/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type GatewayUsageClient,
  readGatewayUsage,
  readReiGatewayServices,
  readUsageCallers,
} from "../src/usage/gateway.ts";
import { HttpError } from "../src/util/errors.ts";

const BUDGET = { providers: {}, defaultProvider: 1, search: 2, embeddings: 2, reads: 2 };

function caller(overrides: Partial<GatewayCaller> & { id: string }): GatewayCaller {
  return {
    note: "",
    scopes: ["models", "search", "embeddings", "read"],
    budget: BUDGET,
    source: "store",
    fingerprints: ["abcdef123456"],
    createdAt: Date.parse("2026-11-01T00:00:00Z"),
    rotatedAt: null,
    revokedAt: null,
    graceUntil: null,
    lastUsedAt: null,
    ...overrides,
  };
}

function gatewayUsageSample(overrides: Partial<GatewayUsageResponse> = {}): GatewayUsageResponse {
  return {
    trackingSince: "2026-11-05T00:00:00.000Z",
    from: "2026-11-05",
    to: "2026-11-24",
    caller: "reports",
    models: {
      summary: {
        inputTotal: 1000,
        inputCached: 200,
        inputUncached: 800,
        outputTotal: 250,
        totalProcessed: 1250,
        cacheHitPercent: 20,
        calls: 2,
        callsReported: 2,
        callsUnreported: 0,
        ok: 2,
        errors: 0,
        upstreamLimited: 0,
      },
      byModel: [
        {
          provider: "custom-1",
          model: "fast-model",
          inputTotal: 1000,
          inputCached: 200,
          inputUncached: 800,
          outputTotal: 250,
          totalProcessed: 1250,
          cacheHitPercent: 20,
          calls: 2,
          callsReported: 2,
          callsUnreported: 0,
          ok: 2,
          errors: 0,
          upstreamLimited: 0,
        },
      ],
    },
    byCaller: [],
    search: {
      calls: 3,
      ok: 2,
      errors: 1,
      averageMs: 310,
      byProvider: [{ provider: "codex-subscription", calls: 3, ok: 2, errors: 1, averageMs: 310 }],
    },
    embeddings: { calls: 1, ok: 1, errors: 0, inputTokens: 120, averageMs: 40 },
    reads: { calls: 2, ok: 2, errors: 0, averageMs: 450 },
    refusals: [{ code: "caller_concurrency", count: 1 }],
    errorBreakdown: [{ code: "rate_limited", count: 1 }],
    ...overrides,
  };
}

describe("caller usage service", () => {
  it("degrades cleanly when the gateway is absent or unreachable", async () => {
    expect(await readUsageCallers(undefined)).toEqual({ available: false, callers: [] });
    const offline: GatewayUsageClient = {
      hasGateway: () => true,
      listCallers: async () => {
        throw new HttpError(502, "gateway_unavailable", "down");
      },
      gatewayUsage: async () => gatewayUsageSample(),
    };
    expect(await readUsageCallers(offline)).toEqual({ available: false, callers: [] });
  });

  it("lists outside callers without rei or token fingerprints, active before revoked", async () => {
    const client: GatewayUsageClient = {
      hasGateway: () => true,
      listCallers: async () => [
        caller({ id: "rei", source: "environment", fingerprints: [] }),
        caller({ id: "zeta", revokedAt: 1000, lastUsedAt: 900 }),
        caller({ id: "beta", note: "nightly", lastUsedAt: 2000 }),
        caller({ id: "alpha", lastUsedAt: null }),
      ],
      gatewayUsage: async () => gatewayUsageSample(),
    };
    const res = await readUsageCallers(client);
    expect(res.available).toBe(true);
    expect(res.callers.map((c) => c.id)).toEqual(["alpha", "beta", "zeta"]);
    expect(JSON.stringify(res)).not.toContain("abcdef123456");
    expect(res.callers[1]).toEqual({
      id: "beta",
      note: "nightly",
      scopes: ["models", "search", "embeddings", "read"],
      revokedAt: null,
      lastUsedAt: 2000,
    });
  });

  it("enriches provider and search provider names and clips custom windows to trackingSince", async () => {
    const gatewayUsage = vi.fn(async () => gatewayUsageSample());
    const client: GatewayUsageClient = {
      hasGateway: () => true,
      listCallers: async () => [
        caller({ id: "rei", source: "environment" }),
        caller({ id: "reports", note: "nightly reports" }),
      ],
      gatewayUsage,
    };
    const now = Date.parse("2026-11-24T12:00:00Z");
    const res = await readGatewayUsage(client, {
      caller: "reports",
      period: "30d",
      now,
      providerNames: { "custom-1": "Local Endpoint" },
    });
    expect(gatewayUsage).toHaveBeenCalledWith({ from: "2026-10-26", to: "2026-11-24", caller: "reports" });
    expect(res.from).toBe("2026-11-05");
    expect(res.to).toBe("2026-11-24");
    expect(res.caller?.note).toBe("nightly reports");
    expect(res.models.byModel[0]?.providerName).toBe("Local Endpoint");
    expect(res.search.byProvider[0]?.providerName).toBe("ChatGPT / Codex");
    expect(res.errorBreakdown).toEqual([{ code: "rate_limited", count: 1 }]);

    // Custom range ending before trackingSince is rejected.
    await expect(
      readGatewayUsage(client, {
        caller: "reports",
        period: "custom",
        now,
        range: { from: "2026-11-01", to: "2026-11-04" },
      }),
    ).rejects.toThrow(/tracking began/);
  });

  it("supports combined All view and rejects reserved or unknown caller ids", async () => {
    const sample = gatewayUsageSample({
      caller: null,
      byCaller: [
        {
          caller: "rei",
          inputTotal: 500,
          inputCached: 100,
          outputTotal: 50,
          modelCalls: 1,
          searchCalls: 0,
          embeddingCalls: 0,
          readCalls: 0,
          errors: 0,
          upstreamLimited: 0,
          refusals: 0,
        },
      ],
    });
    const listCallers = vi.fn(async () => [caller({ id: "rei", source: "environment" })]);
    const client: GatewayUsageClient = {
      hasGateway: () => true,
      listCallers,
      gatewayUsage: async () => sample,
    };
    const all = await readGatewayUsage(client, { period: "all", now: Date.parse("2026-11-24T12:00:00Z") });
    expect(all.caller).toBeNull();
    expect(all.byCaller).toHaveLength(1);
    expect(listCallers).not.toHaveBeenCalled();

    await expect(readGatewayUsage(client, { caller: "rei" })).rejects.toMatchObject({ status: 400 });
    await expect(readGatewayUsage(client, { caller: "all" })).rejects.toMatchObject({ status: 400 });
    await expect(readGatewayUsage(client, { caller: "ghost" })).rejects.toMatchObject({ status: 404 });
    await expect(readGatewayUsage(undefined, { period: "30d" })).rejects.toMatchObject({ status: 503 });
  });

  it("reads Rei's gateway embeddings and page reads, degrading cleanly when gateway is offline", async () => {
    const gatewayUsage = vi.fn(async () => gatewayUsageSample({ caller: "rei" }));
    const client: GatewayUsageClient = {
      hasGateway: () => true,
      listCallers: async () => [],
      gatewayUsage,
    };
    expect(await readReiGatewayServices(client, "2026-11-05", "2026-11-24")).toEqual({
      embeddings: { calls: 1, ok: 1, errors: 0, inputTokens: 120, averageMs: 40 },
      reads: { calls: 2, ok: 2, errors: 0, averageMs: 450 },
    });
    expect(gatewayUsage).toHaveBeenCalledWith({ from: "2026-11-05", to: "2026-11-24", caller: "rei" });
    expect(await readReiGatewayServices(undefined, "2026-11-05", "2026-11-24")).toBeUndefined();
    const broken: GatewayUsageClient = {
      hasGateway: () => true,
      listCallers: async () => [],
      gatewayUsage: async () => {
        throw new Error("boom");
      },
    };
    expect(await readReiGatewayServices(broken, "2026-11-05", "2026-11-24")).toBeUndefined();
  });
});
