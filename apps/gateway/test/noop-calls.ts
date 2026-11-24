import type { GatewayUsageResponse } from "@rei/protocol";
import type { CallLog } from "../src/core/types.ts";

export function noopCallLog(overrides: Partial<CallLog> = {}): CallLog {
  return {
    insert() {},
    recordRefusal() {},
    byStep: () => [],
    recent: () => [],
    summary: () => [],
    trackingSince: () => new Date(0).toISOString(),
    usage: (from: string, to: string, caller?: string): GatewayUsageResponse => ({
      trackingSince: new Date(0).toISOString(),
      from,
      to,
      caller: caller ?? null,
      models: {
        summary: {
          inputTotal: 0,
          inputCached: 0,
          inputUncached: 0,
          outputTotal: 0,
          totalProcessed: 0,
          cacheHitPercent: null,
          calls: 0,
          callsReported: 0,
          callsUnreported: 0,
          ok: 0,
          errors: 0,
          upstreamLimited: 0,
        },
        byModel: [],
      },
      byCaller: [],
      search: { calls: 0, ok: 0, errors: 0, averageMs: null, byProvider: [] },
      embeddings: { calls: 0, ok: 0, errors: 0, inputTokens: 0, averageMs: null },
      reads: { calls: 0, ok: 0, errors: 0, averageMs: null },
      refusals: [],
      errorBreakdown: [],
    }),
    lastUsed: () => new Map(),
    ...overrides,
  };
}
