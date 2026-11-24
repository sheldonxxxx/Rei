// Sequential provider fallback. Only explicitly enabled providers receive queries.
import type { GatewayCallRecord, SearchAnswer, SearchAttemptSummary } from "@rei/protocol";
import { brave } from "./brave.ts";
import { type SubscriptionSearch, searchSubscription } from "./codex-subscription.ts";
import type { ProviderId, SearchProvider, SearchQuery, SearchResult } from "./common.ts";
import { PROVIDER_IDS, ProviderError } from "./common.ts";
import { exa } from "./exa.ts";
import { parseSearxngAuth, searxng } from "./searxng.ts";
import { tavily } from "./tavily.ts";

export type { Freshness, ProviderId, SearchQuery, SearchResult } from "./common.ts";
export { PROVIDER_IDS } from "./common.ts";

const PROVIDERS: Record<Exclude<ProviderId, "codex-subscription">, SearchProvider> = { brave, tavily, searxng, exa };
export const DEFAULT_PROVIDER_ORDER: readonly ProviderId[] = ["exa"];
export type KeyName = "brave" | "tavily" | "exa" | "searxng";
export interface SearchDeps {
  providers: readonly ProviderId[];
  providerOrder?: readonly ProviderId[];
  subscription?: SubscriptionSearch;
  codexModel?: string;
  exaAuth?: "keyless" | "api_key";
  keys: (name: KeyName) => Promise<string | null>;
  searxngUrl?: string | undefined;
  /** Per-attempt override for tests and deployments. */
  timeoutMs?: number;
  /** Entire chain, default 95 seconds (inside the server's 100-second request). */
  totalTimeoutMs?: number;
  endpoints?: Partial<Record<ProviderId, string>>;
}
export interface Attempt {
  provider: ProviderId;
  status: number;
  totalMs: number;
  results: number | null;
  usage?: GatewayCallRecord["usage"];
  error: { code: string; message: string; reason: string } | null;
}
type SearchTrace = { attempts: Attempt[]; trace: SearchAttemptSummary[] };
export type SearchOutcome = SearchTrace &
  (
    | { ok: true; provider: ProviderId; results: SearchResult[]; answer?: SearchAnswer }
    | { ok: false; status: 429 | 499 | 503; code: string; message: string; retryAfterS: number | null }
  );
export function parseProviderList(list: string): ProviderId[] {
  const out: ProviderId[] = [];
  for (const name of list
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)) {
    if (!(PROVIDER_IDS as readonly string[]).includes(name))
      throw new Error(`GATEWAY_SEARCH_PROVIDERS: unknown provider "${name}" (known: ${PROVIDER_IDS.join(", ")})`);
    if (!out.includes(name as ProviderId)) out.push(name as ProviderId);
  }
  return out;
}
export interface ProviderStatus {
  id: ProviderId;
  configured: boolean;
  limitedUntil: number | null;
  lastError?: string;
}
export interface SearchService {
  /** `exclude` leaves providers out of this one search, as if they were not enabled. */
  run(query: SearchQuery, signal: AbortSignal, options?: { exclude?: readonly ProviderId[] }): Promise<SearchOutcome>;
  status(all?: boolean): Promise<ProviderStatus[]>;
}
/** Enforce cancellation even when credential preparation or a test transport stalls. */
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error("aborted"));
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener("abort", cancel);
        reject(cause);
      },
    );
  });
}
export function createSearchService(
  deps: SearchDeps,
  env: { fetch: typeof fetch; now: () => number; addSecret: (...secrets: string[]) => void },
): SearchService {
  const limitedUntil = new Map<ProviderId, number>();
  const lastError = new Map<ProviderId, string>();
  async function ready(id: ProviderId, config: SearchDeps) {
    if (id === "codex-subscription")
      return (await config.subscription?.configured()) ? { key: null, baseUrl: "" } : null;
    const provider = PROVIDERS[id];
    const baseUrl = config.endpoints?.[id] ?? (id === "searxng" ? config.searxngUrl : provider.defaultBaseUrl);
    if (!baseUrl) return null;
    const key = id === "exa" && config.exaAuth !== "api_key" ? null : await config.keys(id);
    if (key) env.addSecret(...(id === "searxng" ? (parseSearxngAuth(key)?.secrets ?? [key]) : [key]));
    if (!key && (provider.needsKey || (id === "exa" && config.exaAuth === "api_key"))) return null;
    return { key, baseUrl };
  }
  return {
    async status(all = false) {
      const out: ProviderStatus[] = [];
      for (const id of all ? (deps.providerOrder ?? PROVIDER_IDS) : deps.providers) {
        let configured = false;
        try {
          configured = (await ready(id, deps)) !== null;
        } catch {
          /* unreadable credentials remain unavailable */
        }
        const until = limitedUntil.get(id) ?? 0;
        out.push({
          id,
          configured,
          limitedUntil: until > env.now() ? until : null,
          ...(lastError.has(id) ? { lastError: lastError.get(id)! } : {}),
        });
      }
      return out;
    },
    async run(query, signal, options) {
      const exclude = options?.exclude ?? [];
      const config = { ...deps, providers: deps.providers.filter((id) => !exclude.includes(id)) };
      const attempts: Attempt[] = [];
      const trace: SearchAttemptSummary[] = [];
      const budgetMs = config.totalTimeoutMs ?? 95_000;
      const started = performance.now();
      const deadline = AbortSignal.timeout(budgetMs);
      const fail = (
        status: 429 | 499 | 503,
        code: string,
        message: string,
        retryAfterS: number | null = null,
      ): SearchOutcome => ({ ok: false, status, code, message, retryAfterS, attempts, trace });
      let configured = 0;
      let limited = 0;
      let soonest = Number.POSITIVE_INFINITY;
      let empty: ProviderId | null = null;
      for (const id of config.providers) {
        if (signal.aborted) return fail(499, "client_aborted", "The client closed the request.");
        if (deadline.aborted || performance.now() - started >= budgetMs)
          return fail(503, "search_timeout", "The search deadline was reached.");
        const t0 = performance.now();
        const remaining = budgetMs - (t0 - started);
        const timeout = AbortSignal.timeout(
          Math.max(
            1,
            Math.ceil(Math.min(remaining, config.timeoutMs ?? (id === "codex-subscription" ? 60_000 : 10_000))),
          ),
        );
        const attemptSignal = AbortSignal.any([signal, deadline, timeout]);
        let target: Awaited<ReturnType<typeof ready>>;
        let results: SearchResult[] = [];
        let answer: SearchAnswer | undefined;
        let usage: GatewayCallRecord["usage"] = null;
        try {
          // Availability and credential preparation share the attempt deadline too.
          target = await within(ready(id, config), attemptSignal);
          if (!target) {
            trace.push({ provider: id, status: "skipped", reason: "not_configured", totalMs: 0 });
            continue;
          }
          configured++;
          const until = limitedUntil.get(id) ?? 0;
          if (until > env.now()) {
            limited++;
            soonest = Math.min(soonest, until);
            trace.push({ provider: id, status: "skipped", reason: "rate_limited", totalMs: 0 });
            continue;
          }
          if (id === "codex-subscription") {
            const reply = await within(
              searchSubscription(query, config.subscription, {
                fetch: env.fetch,
                signal: attemptSignal,
                addSecret: env.addSecret,
                model: config.codexModel,
              }),
              attemptSignal,
            );
            answer = reply.answer;
            usage = reply.usage;
          } else
            results = await within(
              PROVIDERS[id].search(query, { fetch: env.fetch, signal: attemptSignal, ...target }),
              attemptSignal,
            );
          if (signal.aborted) return fail(499, "client_aborted", "The client closed the request.");
          const count = answer?.sources.length ?? results.length;
          const totalMs = Math.round(performance.now() - t0);
          attempts.push({
            provider: id,
            status: 200,
            totalMs,
            results: count,
            ...(usage ? { usage } : {}),
            error: null,
          });
          lastError.delete(id);
          limitedUntil.delete(id);
          trace.push({ provider: id, status: count ? "succeeded" : "empty", totalMs });
          if (count) return { ok: true, provider: id, results, ...(answer ? { answer } : {}), attempts, trace };
          empty ??= id;
        } catch (cause) {
          if (signal.aborted) return fail(499, "client_aborted", "The client closed the request.");
          const timedOut = timeout.aborted || deadline.aborted;
          const rateLimited = cause instanceof ProviderError && cause.kind === "rate_limited";
          const reason = timedOut ? "timeout" : cause instanceof ProviderError ? cause.reason : "fetch_failed";
          const code = timedOut
            ? "search_timeout"
            : rateLimited
              ? "search_rate_limited"
              : id === "codex-subscription"
                ? reason
                : "search_failed";
          const message = timedOut
            ? `${id} did not answer in time.`
            : cause instanceof ProviderError
              ? cause.message
              : `${id} could not be reached.`;
          if (rateLimited) {
            const until = env.now() + cause.retryAfterS * 1000;
            limitedUntil.set(id, until);
            limited++;
            soonest = Math.min(soonest, until);
          }
          lastError.set(id, code);
          const totalMs = Math.round(performance.now() - t0);
          attempts.push({
            provider: id,
            status: timedOut ? 504 : rateLimited ? 429 : 502,
            totalMs,
            results: null,
            error: { code, message, reason },
          });
          trace.push({ provider: id, status: "failed", reason: code, totalMs });
        }
      }
      if (signal.aborted) return fail(499, "client_aborted", "The client closed the request.");
      if (empty) return { ok: true, provider: empty, results: [], attempts, trace };
      if (configured > 0 && limited === configured) {
        const retryAfterS = Math.max(1, Math.ceil((soonest - env.now()) / 1000));
        return fail(
          429,
          "search_rate_limited",
          `Every search provider is rate limited. Try again in about ${retryAfterS} seconds.`,
          retryAfterS,
        );
      }
      if (config.providers.length === 1 && config.providers[0] === "codex-subscription") {
        const error = attempts[0]?.error;
        return fail(
          503,
          error?.code ?? "subscription_required",
          error?.message ?? "Connect OpenAI using Sign in with ChatGPT to use subscription search.",
        );
      }
      return fail(
        503,
        "search_unavailable",
        configured === 0 && !attempts.length
          ? "No search provider is configured."
          : "Web search is unavailable right now: no provider answered.",
      );
    },
  };
}
