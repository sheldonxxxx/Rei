// Callers: the named clients of the gateway (docs/adr/0018). Rei is the caller `rei`, built from the token in the
// environment; outside callers are created at run time and kept in the secret store with their tokens hashed. Web APIs
// only, so this also runs in a Worker.

import type { CallerBudget, GatewayCaller, GatewayCallerScope } from "@rei/protocol";
import { b64u, HttpError } from "./http.ts";
import type { Redactor } from "./redact.ts";
import { constantTimeEqual } from "./redact.ts";
import type { SecretStore } from "./secrets.ts";

export type Scope = GatewayCallerScope;

export interface Caller {
  id: string;
  scopes: readonly Scope[];
  budget: CallerBudget;
  source: "environment" | "store";
}

export const REI_CALLER_ID = "rei";
const RESERVED_CALLER_IDS = new Set([REI_CALLER_ID, "all"]);
const OUTSIDE_SCOPES: readonly Scope[] = ["models", "search", "embeddings", "read", "read-local"];
/** What a new outside caller gets: everything but `read-local`, which lets a read reach the user's local network. */
const DEFAULT_SCOPES: readonly Scope[] = ["models", "search", "embeddings", "read"];
const ALL_SCOPES: readonly Scope[] = [...OUTSIDE_SCOPES, "admin"];
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const TOKEN = /^gw\.([a-z0-9][a-z0-9_-]{0,39})\.([A-Za-z0-9_-]{43})$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const STORE_KEY = "callers";
const DEFAULT_GRACE_S = 24 * 3600;
const MAX_GRACE_S = 30 * 24 * 3600;
const MAX_CAP = 16;

/** No caps at all: what Rei gets unless the operator sets some. */
export const UNCAPPED_BUDGET: CallerBudget = {
  providers: {},
  defaultProvider: null,
  search: null,
  embeddings: null,
  reads: null,
};
/** What a new outside caller gets. */
export const DEFAULT_OUTSIDE_BUDGET: CallerBudget = {
  providers: {},
  defaultProvider: 1,
  search: 2,
  embeddings: 2,
  reads: 2,
};

/** A budget stored before a field existed has the default for it: a caller made before `reads` gets 2 reads in flight. */
export const withBudgetDefaults = (budget: CallerBudget): CallerBudget => ({
  ...budget,
  reads: budget.reads === undefined ? DEFAULT_OUTSIDE_BUDGET.reads : budget.reads,
});

/** Which scope a request path needs. Anything that is not listed needs `admin`, so an unknown path is never open. */
export function scopeFor(path: string): Scope | "open" {
  if (path === "/healthz" || path === "/status") return "open";
  if (path.startsWith("/v1/")) return "models";
  if (path === "/search") return "search";
  if (path === "/read") return "read";
  if (path.startsWith("/embedding/")) return "embeddings";
  return "admin";
}

const bad = (message: string) => new HttpError(400, "bad_request", message);

const cap = (value: unknown, name: string): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_CAP)
    throw bad(`${name} must be a whole number from 0 to ${MAX_CAP}, or null for no cap.`);
  return value;
};

/** A budget from untrusted JSON, laid over `base`: fields that are absent keep the base value. */
export function parseBudget(input: unknown, base: CallerBudget): CallerBudget {
  if (input === undefined) return base;
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw bad("budget must be an object.");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!["providers", "defaultProvider", "search", "embeddings", "reads"].includes(key))
      throw bad(`budget has no field named ${key.slice(0, 40)}.`);
  const out: CallerBudget = { ...base, providers: { ...base.providers } };
  if (raw.providers !== undefined) {
    if (typeof raw.providers !== "object" || raw.providers === null || Array.isArray(raw.providers))
      throw bad("budget.providers must be an object of provider id to cap.");
    const entries = Object.entries(raw.providers as Record<string, unknown>);
    if (entries.length > 64) throw bad("budget.providers has too many entries.");
    out.providers = {};
    for (const [id, value] of entries) {
      if (!PROVIDER_ID.test(id)) throw bad("budget.providers has an invalid provider id.");
      out.providers[id] = cap(value, `budget.providers.${id}`);
    }
  }
  if (raw.defaultProvider !== undefined) out.defaultProvider = cap(raw.defaultProvider, "budget.defaultProvider");
  if (raw.search !== undefined) out.search = cap(raw.search, "budget.search");
  if (raw.embeddings !== undefined) out.embeddings = cap(raw.embeddings, "budget.embeddings");
  if (raw.reads !== undefined) out.reads = cap(raw.reads, "budget.reads");
  return out;
}

function parseScopes(input: unknown): Scope[] {
  if (!Array.isArray(input) || input.length === 0)
    throw bad("scopes must be a list of models, search, embeddings, read and read-local.");
  const out = [...new Set(input)];
  if (out.some((s) => !OUTSIDE_SCOPES.includes(s as Scope)))
    throw bad("scopes may hold models, search, embeddings, read and read-local only.");
  return out as Scope[];
}

function parseNote(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string" || input.length > 200 || /[\r\n\0]/.test(input))
    throw bad("note must be one line of at most 200 characters.");
  return input;
}

interface StoredToken {
  sha256: string;
  fingerprint: string;
  createdAt: number;
  /** When this token stops working; null for the current one. */
  graceUntil: number | null;
}

interface StoredCaller {
  id: string;
  note: string;
  scopes: Scope[];
  budget: CallerBudget | null;
  /** At most two: the current token and, during a rotation's grace, the one before it. */
  tokens: StoredToken[];
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface CallerRegistryOptions {
  /** Rei's own token, from the environment. */
  reiToken: string;
  reiBudget?: CallerBudget;
  /** Where outside callers are kept. Without it there are none, and they cannot be created. */
  secrets?: SecretStore;
  redactor: Redactor;
  now?: () => number;
}

export class CallerRegistry {
  readonly #reiToken: string;
  readonly #rei: Caller;
  readonly #secrets: SecretStore | undefined;
  readonly #redactor: Redactor;
  readonly #now: () => number;
  /** In memory after the first load: no request reads the store, and every change goes through `#change`. */
  readonly #callers = new Map<string, StoredCaller>();
  #loaded: Promise<void> | null = null;

  constructor(options: CallerRegistryOptions) {
    this.#reiToken = options.reiToken;
    this.#rei = {
      id: REI_CALLER_ID,
      scopes: ALL_SCOPES,
      budget: options.reiBudget ?? UNCAPPED_BUDGET,
      source: "environment",
    };
    this.#secrets = options.secrets;
    this.#redactor = options.redactor;
    this.#now = options.now ?? Date.now;
  }

  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      const stored = (await this.#secrets?.read<StoredCaller[]>(STORE_KEY)) ?? [];
      for (const caller of stored) this.#callers.set(caller.id, caller);
    })().catch((cause) => {
      this.#loaded = null;
      throw cause;
    });
    return this.#loaded;
  }

  #live(caller: StoredCaller): StoredToken[] {
    if (caller.revokedAt !== null) return [];
    const now = this.#now();
    return caller.tokens.filter((t) => t.graceUntil === null || t.graceUntil > now);
  }

  #asCaller(stored: StoredCaller): Caller {
    return {
      id: stored.id,
      scopes: stored.scopes,
      budget: withBudgetDefaults(stored.budget ?? DEFAULT_OUTSIDE_BUDGET),
      source: "store",
    };
  }

  /** The caller this bearer token belongs to, or null. */
  async authenticate(token: string): Promise<Caller | null> {
    if (!token) return null;
    await this.#load();
    const match = TOKEN.exec(token);
    const stored = match ? this.#callers.get(match[1]!) : undefined;
    if (stored) {
      const hash = await sha256Hex(token);
      let found = false;
      // Every live hash is compared, so the time taken does not say which one matched.
      for (const t of this.#live(stored)) if (sameHex(t.sha256, hash)) found = true;
      if (found) {
        this.#redactor.add(token);
        return this.#asCaller(stored);
      }
    }
    return (await constantTimeEqual(token, this.#reiToken)) ? this.#rei : null;
  }

  #view(stored: StoredCaller, lastUsedAt: number | null): GatewayCaller {
    const live = this.#live(stored);
    return {
      id: stored.id,
      note: stored.note,
      scopes: [...stored.scopes],
      budget: withBudgetDefaults(stored.budget ?? DEFAULT_OUTSIDE_BUDGET),
      source: "store",
      fingerprints: live.map((t) => t.fingerprint),
      createdAt: stored.createdAt,
      rotatedAt: stored.rotatedAt,
      revokedAt: stored.revokedAt,
      graceUntil: live.find((t) => t.graceUntil !== null)?.graceUntil ?? null,
      lastUsedAt,
    };
  }

  /** Rei first, then outside callers in the order they were created. Never a hash or a token. */
  async list(lastUsed: Map<string, number> = new Map()): Promise<GatewayCaller[]> {
    await this.#load();
    const rei: GatewayCaller = {
      id: REI_CALLER_ID,
      note: "",
      scopes: [...ALL_SCOPES],
      budget: this.#rei.budget,
      source: "environment",
      fingerprints: [],
      createdAt: null,
      rotatedAt: null,
      revokedAt: null,
      graceUntil: null,
      lastUsedAt: lastUsed.get(REI_CALLER_ID) ?? null,
    };
    return [rei, ...[...this.#callers.values()].map((c) => this.#view(c, lastUsed.get(c.id) ?? null))];
  }

  /** One serialized read-modify-write of the stored list; memory is updated from what was written. */
  async #change(fn: (all: StoredCaller[]) => StoredCaller[]): Promise<void> {
    if (!this.#secrets)
      throw new HttpError(503, "callers_unavailable", "Outside callers are not configured on the gateway.");
    await this.#load();
    const next = await this.#secrets.modify<StoredCaller[]>(STORE_KEY, (current) => fn(current ?? []));
    this.#callers.clear();
    for (const caller of next ?? []) this.#callers.set(caller.id, caller);
  }

  async #mint(id: string): Promise<{ token: string; stored: StoredToken }> {
    const token = `gw.${id}.${b64u.encode(crypto.getRandomValues(new Uint8Array(32)))}`;
    this.#redactor.add(token);
    const sha256 = await sha256Hex(token);
    return {
      token,
      stored: { sha256, fingerprint: sha256.slice(0, 12), createdAt: this.#now(), graceUntil: null },
    };
  }

  #managed(id: string): void {
    if (id === REI_CALLER_ID)
      throw new HttpError(
        400,
        "caller_managed_by_environment",
        "This caller's token comes from the environment; change it there.",
      );
  }

  #missing(): HttpError {
    return new HttpError(404, "caller_not_found", "No caller has this id.");
  }

  async create(input: Record<string, unknown>): Promise<{ caller: GatewayCaller; token: string }> {
    const id = input.id;
    if (typeof id !== "string" || !ID.test(id))
      throw bad("id must be 1 to 40 characters: a to z, 0 to 9, - and _, starting with a letter or digit.");
    const note = parseNote(input.note);
    const scopes = input.scopes === undefined ? [...DEFAULT_SCOPES] : parseScopes(input.scopes);
    const budget = parseBudget(input.budget, DEFAULT_OUTSIDE_BUDGET);
    const exists = () =>
      new HttpError(409, "caller_exists", "A caller with this id exists or existed; ids are not reused.");
    if (RESERVED_CALLER_IDS.has(id)) throw exists();
    const minted = await this.#mint(id);
    const fresh: StoredCaller = {
      id,
      note,
      scopes,
      budget,
      tokens: [minted.stored],
      createdAt: this.#now(),
      rotatedAt: null,
      revokedAt: null,
    };
    await this.#change((all) => {
      if (all.some((c) => c.id === id)) throw exists();
      return [...all, fresh];
    });
    return { caller: this.#view(fresh, null), token: minted.token };
  }

  async patch(id: string, input: Record<string, unknown>): Promise<GatewayCaller> {
    this.#managed(id);
    let out: StoredCaller | undefined;
    await this.#change((all) =>
      all.map((c) => {
        if (c.id !== id) return c;
        if (c.revokedAt !== null) throw new HttpError(409, "caller_revoked", "This caller was revoked.");
        out = {
          ...c,
          ...(input.note === undefined ? {} : { note: parseNote(input.note) }),
          ...(input.scopes === undefined ? {} : { scopes: parseScopes(input.scopes) }),
          ...(input.budget === undefined
            ? {}
            : { budget: parseBudget(input.budget, withBudgetDefaults(c.budget ?? DEFAULT_OUTSIDE_BUDGET)) }),
        };
        return out;
      }),
    );
    if (!out) throw this.#missing();
    return this.#view(out, null);
  }

  /** A new token; the one before it keeps working for `graceSeconds` (default 24 hours, 0 ends it at once). */
  async rotate(id: string, graceSeconds: unknown): Promise<{ caller: GatewayCaller; token: string }> {
    this.#managed(id);
    if (
      graceSeconds !== undefined &&
      (typeof graceSeconds !== "number" ||
        !Number.isInteger(graceSeconds) ||
        graceSeconds < 0 ||
        graceSeconds > MAX_GRACE_S)
    )
      throw bad(`graceSeconds must be a whole number from 0 to ${MAX_GRACE_S}.`);
    const grace = (graceSeconds as number | undefined) ?? DEFAULT_GRACE_S;
    const minted = await this.#mint(id);
    let out: StoredCaller | undefined;
    await this.#change((all) =>
      all.map((c) => {
        if (c.id !== id) return c;
        if (c.revokedAt !== null) throw new HttpError(409, "caller_revoked", "This caller was revoked.");
        const now = this.#now();
        const previous = c.tokens.find((t) => t.graceUntil === null);
        out = {
          ...c,
          tokens: [minted.stored, ...(previous && grace > 0 ? [{ ...previous, graceUntil: now + grace * 1000 }] : [])],
          rotatedAt: now,
        };
        return out;
      }),
    );
    if (!out) throw this.#missing();
    return { caller: this.#view(out, null), token: minted.token };
  }

  /** Takes effect at once. The record stays, without a token, so the id is never reused. */
  async revoke(id: string): Promise<GatewayCaller> {
    this.#managed(id);
    let out: StoredCaller | undefined;
    await this.#change((all) =>
      all.map((c) => {
        if (c.id !== id) return c;
        out = c.revokedAt === null ? { ...c, tokens: [], revokedAt: this.#now() } : c;
        return out;
      }),
    );
    if (!out) throw this.#missing();
    return this.#view(out, null);
  }
}
