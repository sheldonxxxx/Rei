// What the onboarding CLI asks the gateway to check about itself (`node src/cli.ts ping | search-check`). Both write nothing.
import { createRedactor } from "../core/redact.ts";
import type { ProviderId, SearchDeps } from "../core/search/service.ts";
import { createSearchService } from "../core/search/service.ts";
import { createPiModels } from "./auth.ts";
import { PROVIDER_ID } from "./config.ts";
import type { FileCredentialStore } from "./credstore.ts";
import { readProbe } from "./modelsfile.ts";

/** Without a probe: the control plane's default "standard" tier (apps/server/src/pi/model-config.ts). pi-ai's first catalogue
 * model is not one a ChatGPT sign-in can use. */
export const DEFAULT_PING_MODEL = "gpt-6.1-sol";

export interface PingOptions {
  store: FileCredentialStore;
  /** Asked for by name (`ping <model-id>`); else the first model of the last probe, else DEFAULT_PING_MODEL. */
  model?: string | undefined;
  modelsFile: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** One tiny completion (see PingOptions.model for which model). Not `probe-models`: that rewrites the models file. */
export async function pingModel(o: PingOptions): Promise<{ ok: boolean; line: string }> {
  const redactor = createRedactor();
  const failed = (message: string) => ({
    ok: false,
    line: `failed: ${redactor.redact(message).replace(/\s+/g, " ").slice(0, 300)}`,
  });
  try {
    const stored = await o.store.read(PROVIDER_ID);
    if (!stored) return failed("not signed in; run login first");
    if (stored.type === "oauth") redactor.add(stored.access, stored.refresh);
    const models = createPiModels(o.store);
    const id = o.model ?? readProbe(o.modelsFile)?.accepted[0] ?? DEFAULT_PING_MODEL;
    // The catalogue may not list the id; the request only needs it, so clone a catalogue model (as probe-models does).
    const template = models.getModels(PROVIDER_ID)[0];
    const model = models.getModel(PROVIDER_ID, id) ?? (template ? { ...template, id, name: id } : undefined);
    if (!model) return failed("pi-ai has no openai models to use as a request template");
    const t0 = performance.now();
    const reply = await models.completeSimple(
      model,
      { messages: [{ role: "user", content: "PING. Reply with exactly one word: PONG.", timestamp: Date.now() }] },
      { signal: AbortSignal.timeout(o.timeoutMs ?? 60_000), ...(o.fetch ? { fetch: o.fetch } : {}) },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted")
      return failed(reply.errorMessage ?? reply.stopReason);
    return { ok: true, line: `ok ${model.id} ${Math.round(performance.now() - t0)}ms` };
  } catch (cause) {
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
}

export interface SearchCheckLine {
  provider: ProviderId;
  status: "ok" | "skipped" | "rate_limited" | "failed";
  results: number | null;
  message: string | null;
}

/** Each provider on its own (a service with just that provider), one fixed harmless query. Messages are the providers' own, key-free. */
export async function searchCheck(
  deps: SearchDeps,
  env: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<SearchCheckLine[]> {
  const redactor = createRedactor();
  const out: SearchCheckLine[] = [];
  for (const provider of deps.providers) {
    const service = createSearchService(
      { ...deps, providers: [provider] },
      { fetch: env.fetch ?? fetch, now: env.now ?? Date.now, addSecret: (...secrets) => redactor.add(...secrets) },
    );
    const outcome = await service.run({ query: "wikipedia", count: 1 }, AbortSignal.timeout(30_000));
    const attempt = outcome.attempts[0];
    const line = (
      status: SearchCheckLine["status"],
      results: number | null,
      message: string | null,
    ): SearchCheckLine => ({ provider, status, results, message: message && redactor.redact(message) });
    if (outcome.ok)
      out.push(
        (outcome.answer?.sources.length ?? outcome.results.length) > 0
          ? line("ok", outcome.answer?.sources.length ?? outcome.results.length, null)
          : line("failed", 0, "answered with no results"),
      );
    else if (!attempt) out.push(line("skipped", null, null));
    else if (outcome.status === 429) out.push(line("rate_limited", null, attempt.error?.message ?? null));
    else out.push(line("failed", null, attempt.error?.message ?? outcome.message));
  }
  return out;
}
