import type {
  CallerUsageResponse,
  GatewayCaller,
  GatewayEmbeddingsUsage,
  GatewayReadsUsage,
  GatewayUsageResponse,
  UsageCallerSummary,
  UsageCallersResponse,
} from "@rei/protocol";
import { providerDisplayName } from "../providers/names.ts";
import { badRequest, HttpError, notFound } from "../util/errors.ts";
import { resolveRequestedWindow, type UsageRange } from "./read.ts";
import { searchProviderName } from "./search.ts";

export interface GatewayUsageClient {
  hasGateway(): boolean;
  listCallers(): Promise<GatewayCaller[]>;
  gatewayUsage(query: { from?: string; to?: string; caller?: string }): Promise<GatewayUsageResponse>;
}

const toSummary = (c: GatewayCaller): UsageCallerSummary => ({
  id: c.id,
  note: c.note,
  scopes: c.scopes,
  revokedAt: c.revokedAt,
  lastUsedAt: c.lastUsedAt,
});

/** Lists outside gateway callers (never `rei`, never tokens/fingerprints). Degrades cleanly when the gateway is absent. */
export async function readUsageCallers(client: GatewayUsageClient | undefined): Promise<UsageCallersResponse> {
  if (!client?.hasGateway()) return { available: false, callers: [] };
  try {
    const all = await client.listCallers();
    const callers = all
      .filter((c) => c.id !== "rei")
      .map(toSummary)
      .sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null) || a.id.localeCompare(b.id));
    return { available: true, callers };
  } catch (cause) {
    if (cause instanceof HttpError && (cause.code === "gateway_unavailable" || cause.code === "gateway_auth")) {
      return { available: false, callers: [] };
    }
    return { available: false, callers: [] };
  }
}

/** Reads gateway usage for one outside caller or all callers combined, enriched with display names. */
export async function readGatewayUsage(
  client: GatewayUsageClient | undefined,
  options: {
    caller?: string | undefined;
    period?: string | undefined;
    now?: number;
    providerNames?: Record<string, string>;
    range?: UsageRange;
  },
): Promise<CallerUsageResponse> {
  if (!client?.hasGateway()) {
    throw new HttpError(503, "gateway_unavailable", "Caller usage needs the gateway.");
  }
  const callerId = options.caller?.trim() || undefined;
  if (callerId === "rei" || callerId === "all") {
    throw badRequest("bad_request", "Use /api/usage for Rei or omit caller for all callers.");
  }
  const win = resolveRequestedWindow(options.period ?? "30d", options.now ?? Date.now(), options.range ?? {});
  const [usage, callers] = await Promise.all([
    client.gatewayUsage({
      ...(win.from ? { from: win.from } : {}),
      to: win.to,
      ...(callerId ? { caller: callerId } : {}),
    }),
    callerId ? client.listCallers() : Promise.resolve<GatewayCaller[] | null>(null),
  ]);

  let callerSummary: UsageCallerSummary | null = null;
  if (callerId) {
    const found = callers?.find((c) => c.id === callerId && c.id !== "rei");
    if (!found) throw notFound("Unknown caller.");
    callerSummary = toSummary(found);
  }

  const trackingDay = usage.trackingSince.slice(0, 10);
  let from = win.from ?? usage.from;
  if (from < trackingDay) from = trackingDay;
  if (from > win.to) {
    if (win.period === "custom") {
      throw badRequest(
        "bad_request",
        "A custom range must start on or before its end and include a day since tracking began.",
      );
    }
    from = win.to;
  }

  const names = options.providerNames ?? {};
  return {
    period: win.period,
    timezone: "UTC",
    trackingSince: usage.trackingSince,
    from,
    to: win.to,
    caller: callerSummary,
    models: {
      summary: usage.models.summary,
      byModel: usage.models.byModel.map((row) => ({
        ...row,
        providerName: providerDisplayName(names, row.provider),
      })),
    },
    byCaller: callerId ? [] : usage.byCaller,
    search: {
      calls: usage.search.calls,
      ok: usage.search.ok,
      errors: usage.search.errors,
      averageMs: usage.search.averageMs,
      byProvider: usage.search.byProvider.map((row) => ({
        ...row,
        providerName: searchProviderName(row.provider),
      })),
    },
    embeddings: usage.embeddings,
    reads: usage.reads,
    refusals: usage.refusals,
    errorBreakdown: usage.errorBreakdown,
  };
}

/** Reads gateway-recorded embedding and page read counters for Rei; returns undefined if the gateway is unavailable. */
export async function readReiGatewayServices(
  client: GatewayUsageClient | undefined,
  from: string,
  to: string,
): Promise<{ embeddings: GatewayEmbeddingsUsage; reads: GatewayReadsUsage } | undefined> {
  if (!client?.hasGateway()) return undefined;
  try {
    const usage = await client.gatewayUsage({ from, to, caller: "rei" });
    return { embeddings: usage.embeddings, reads: usage.reads };
  } catch {
    return undefined;
  }
}
