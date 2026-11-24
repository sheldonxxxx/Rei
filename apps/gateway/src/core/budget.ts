// Budgets: a cap on each caller's calls in flight, per provider (docs/adr/0018). It is the only rule, and it is the
// same for every caller: nobody has priority and nothing is remembered about an upstream. In memory; Web APIs only.

import type { Caller } from "./callers.ts";

export type BudgetKind = "models" | "search" | "embeddings" | "read";

export type Admission =
  | {
      ok: true /** Whether the call holds a slot. A call without a cap holds none. */;
      capped: boolean;
      release(): void;
    }
  | { ok: false; status: 403 | 429; code: string; message: string; retryAfterS?: number };

export interface Budgets {
  /** `provider` is the model provider id for `models`; it is ignored for the other kinds. */
  admit(caller: Caller, kind: BudgetKind, provider?: string): Admission;
  snapshot(): {
    inFlight: { caller: string; provider: string; count: number }[];
    refusals: { caller: string; code: string; count: number }[];
  };
}

const RETRY_AFTER_S = 2;
const SEP = "\n";

/** The cap that applies, or null for none. */
export function capFor(caller: Caller, kind: BudgetKind, provider = ""): number | null {
  const { budget } = caller;
  if (kind === "search") return budget.search;
  if (kind === "embeddings") return budget.embeddings;
  if (kind === "read") return budget.reads;
  return Object.hasOwn(budget.providers, provider) ? budget.providers[provider]! : budget.defaultProvider;
}

export function createBudgets(): Budgets {
  const inFlight = new Map<string, number>();
  const refusals = new Map<string, number>();
  const refuse = (caller: Caller, status: 403 | 429, code: string, message: string, retryAfterS?: number) => {
    const key = `${caller.id}${SEP}${code}`;
    refusals.set(key, (refusals.get(key) ?? 0) + 1);
    return { ok: false as const, status, code, message, ...(retryAfterS ? { retryAfterS } : {}) };
  };
  return {
    admit(caller, kind, provider = "") {
      const cap = capFor(caller, kind, provider);
      if (cap === null) return { ok: true, capped: false, release() {} };
      const slot = kind === "models" ? provider : kind === "search" ? "search" : kind === "read" ? "read" : "embedding";
      if (cap === 0)
        return kind === "models"
          ? refuse(caller, 403, "provider_not_allowed", "This caller may not use this provider.")
          : refuse(caller, 403, "route_not_allowed", "This caller's budget does not allow this route.");
      const key = `${caller.id}${SEP}${slot}`;
      const held = inFlight.get(key) ?? 0;
      if (held >= cap)
        return refuse(
          caller,
          429,
          "caller_concurrency",
          kind === "models"
            ? "This caller has its maximum calls to this provider in flight; try again shortly."
            : "This caller has its maximum calls of this kind in flight; try again shortly.",
          RETRY_AFTER_S,
        );
      inFlight.set(key, held + 1);
      let released = false;
      return {
        ok: true,
        capped: true,
        release() {
          if (released) return;
          released = true;
          const left = (inFlight.get(key) ?? 1) - 1;
          if (left > 0) inFlight.set(key, left);
          else inFlight.delete(key);
        },
      };
    },
    snapshot() {
      const split = (key: string) => key.split(SEP) as [string, string];
      return {
        inFlight: [...inFlight].map(([key, count]) => ({ caller: split(key)[0], provider: split(key)[1], count })),
        refusals: [...refusals].map(([key, count]) => ({ caller: split(key)[0], code: split(key)[1], count })),
      };
    },
  };
}

/** The answer to a refused call. `x-rei-refused-by` tells it apart from an upstream's own 429, which is passed through. */
export function refusalResponse(refusal: Extract<Admission, { ok: false }>): Response {
  const { code, message, retryAfterS } = refusal;
  return new Response(JSON.stringify({ error: { code, message, ...(retryAfterS ? { retryAfterS } : {}) } }), {
    status: refusal.status,
    headers: {
      "content-type": "application/json",
      "x-rei-refused-by": "gateway",
      ...(retryAfterS ? { "retry-after": String(Math.max(1, Math.ceil(retryAfterS))) } : {}),
    },
  });
}
