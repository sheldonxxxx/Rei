import type {
  GatewayCallerScope,
  GatewayEmbeddingsUsage,
  GatewayModelUsage,
  GatewayReadsUsage,
  GatewayUsageCallerRow,
  GatewayUsageError,
  GatewayUsageRefusal,
  GatewayUsageServiceRow,
} from "./gateway.ts";

/** Usage contains counters only: no prompts, traces or credentials. Days and periods use UTC. */
export const USAGE_PURPOSES = ["chat", "memory", "title", "agent_task", "other"] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];
/** `custom` reads an inclusive UTC date range given by `from` and `to` (YYYY-MM-DD). */
export const USAGE_PERIODS = ["today", "7d", "30d", "month", "year", "all", "custom"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export const USAGE_METRICS = [
  "inputTotal",
  "inputCached",
  "inputUncached",
  "outputTotal",
  "totalProcessed",
  "reasoningOutput",
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];
export interface UsageTotals {
  /** Sums of reliable reports. Null if calls exist but none report the field; zero for an empty bucket. */
  tokens: Record<UsageMetric, number | null>;
  /** Calls missing each field. Nonzero with a numeric sum means that sum is a lower bound. */
  unknown: Record<UsageMetric, number>;
  modelCalls: number;
  callsReported: number;
  callsUnreported: number;
  /** Cached share of input over calls that reported both input and cached tokens, not counting the first model call of each run. Null when none counted. */
  cacheHitPercent: number | null;
}
export interface UsageResponse {
  period: UsagePeriod;
  timezone: "UTC";
  trackingSince: string;
  from: string;
  to: string;
  summary: UsageTotals;
  byPurpose: { purpose: UsagePurpose; usage: UsageTotals }[];
  byModel: { provider: string; providerName: string; model: string; usage: UsageTotals }[];
  byAgent: { agentId: string | null; usage: UsageTotals }[];
  daily: { day: string; usage: UsageTotals }[];
  search: SearchUsageResponse;
  images: ImageUsageResponse;
  /** Gateway-recorded embedding and page read counters for Rei; omitted when the gateway is unavailable. */
  embeddings?: GatewayEmbeddingsUsage;
  reads?: GatewayReadsUsage;
}

/** Why an image request failed, as the server records it. */
export type ImageFailureReason = "rate_limited" | "busy" | "sign_in_required" | "error";
export interface ImageUsageResponse {
  requests: number;
  succeeded: number;
  failed: number;
  /** Requests without reference images, and requests that edit them. */
  generated: number;
  edited: number;
  /** Mean time of successful requests; null if none. */
  averageMs: number | null;
  failures: { reason: ImageFailureReason; calls: number }[];
}

/** How one provider attempt ended; mirrors the gateway's attempt status. */
export type SearchAttemptOutcome = "succeeded" | "empty" | "failed" | "skipped";
/** How a whole web search ended after every provider that was tried. */
export type SearchRequestOutcome = "answered" | "empty" | "failed";
export interface SearchUsageDetail {
  outcome: SearchAttemptOutcome;
  /** Gateway reason code (for example `search_timeout`); null when none was given. */
  reason: string | null;
  /** True when an earlier provider had already been asked and did not answer. */
  fallback: boolean;
  calls: number;
}
export interface SearchUsageProvider {
  provider: string;
  providerName: string;
  succeeded: number;
  empty: number;
  failed: number;
  skipped: number;
  /** Attempts made after an earlier provider failed or returned nothing. */
  fallback: number;
  /** Fallback attempts that succeeded. */
  answeredAfterFallback: number;
  /** Mean time over attempts that reached the provider (not skipped); null if none. */
  averageMs: number | null;
  details: SearchUsageDetail[];
}
export interface SearchUsageResponse {
  searches: number;
  answered: number;
  empty: number;
  failed: number;
  searchesWithFallback: number;
  byProvider: SearchUsageProvider[];
}

/** Safe summary of an outside gateway caller for the Usage page (no tokens or fingerprints). */
export interface UsageCallerSummary {
  id: string;
  note: string;
  scopes: GatewayCallerScope[];
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface UsageCallersResponse {
  /** False when the gateway is not configured or could not be reached. */
  available: boolean;
  callers: UsageCallerSummary[];
}

export interface CallerUsageModelRow extends GatewayModelUsage {
  provider: string;
  providerName: string;
  model: string;
}

export interface CallerUsageSearchProvider extends GatewayUsageServiceRow {
  providerName: string;
}

/** Gateway-sourced usage for one outside caller or all callers combined (UTC). */
export interface CallerUsageResponse {
  period: UsagePeriod;
  timezone: "UTC";
  trackingSince: string;
  from: string;
  to: string;
  /** Null for the combined All callers view. */
  caller: UsageCallerSummary | null;
  models: {
    summary: GatewayModelUsage;
    byModel: CallerUsageModelRow[];
  };
  /** Populated only for the combined All view; empty for a single caller. */
  byCaller: GatewayUsageCallerRow[];
  search: {
    calls: number;
    ok: number;
    errors: number;
    averageMs: number | null;
    byProvider: CallerUsageSearchProvider[];
  };
  embeddings: GatewayEmbeddingsUsage;
  reads: GatewayReadsUsage;
  refusals: GatewayUsageRefusal[];
  errorBreakdown: GatewayUsageError[];
}

/** Latest completed chat model call, rather than cumulative billing usage. */
export interface ContextUsageResponse {
  model: string | null;
  maxTokens: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  updatedAt: number | null;
  breakdown?: ContextBreakdown | null;
}

export type ContextTokenCategory =
  | "prompt"
  | "capabilities"
  | "skills"
  | "tools"
  | "loaded_tools"
  | "conversation"
  | "tool_calls"
  | "tool_results"
  | "mcp_calls"
  | "mcp_results"
  | "other";
export interface ContextBreakdown {
  /** Visible text tokenized with o200k_base; estimates need not reconcile to provider input. */
  method: "o200k_base";
  estimatedTokens: number;
  hasOpaqueContent: boolean;
  categories: {
    id: ContextTokenCategory;
    label: string;
    estimatedTokens: number;
    details: { label: string; estimatedTokens: number }[];
  }[];
}
