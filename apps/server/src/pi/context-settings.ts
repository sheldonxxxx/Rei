import type { CompactionPolicySettings, ContextSettings, HomeContextSettings } from "@rei/protocol";
import type { AppStore } from "../store/store.ts";
import { DEFAULT_HOME_CONTEXT } from "./home-context.ts";

/** Pi Durable 1.5's built-in compaction policy (DEFAULT_COMPACTION_POLICY). */
export const DEFAULT_COMPACTION: CompactionPolicySettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  backgroundTokens: 32_768,
};
export const DEFAULT_HOME: HomeContextSettings = {
  idleGapMinutes: DEFAULT_HOME_CONTEXT.idleGapMs / 60_000,
  recentMessages: 10, // Legacy clients still read this field.
  maxTokens: DEFAULT_HOME_CONTEXT.maxTokens,
};

export const COMPACTION_KEY = "compaction_settings";
const HOME_KEY = "home_context";
const MAX_TOKENS = 10_000_000;
const MAX_OVERRIDES = 50;

const whole = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

/** Validates a partial policy; throws a message fit to show the user. */
export function checkPolicy(raw: unknown, what = "Compaction"): Partial<CompactionPolicySettings> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${what} settings must be an object.`);
  const r = raw as Record<string, unknown>;
  const out: Partial<CompactionPolicySettings> = {};
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== "boolean") throw new Error(`${what}: enabled must be true or false.`);
    out.enabled = r.enabled;
  }
  const tokens: [keyof CompactionPolicySettings, number][] = [
    ["reserveTokens", 1],
    ["keepRecentTokens", 1],
    ["backgroundTokens", 0],
  ];
  for (const [key, min] of tokens) {
    if (r[key] === undefined) continue;
    if (!whole(r[key], min, MAX_TOKENS)) throw new Error(`${what}: ${key} must be a whole number from ${min}.`);
    (out as Record<string, unknown>)[key] = r[key];
  }
  return out;
}

export function checkHome(raw: unknown): Partial<HomeContextSettings> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Home chat settings must be an object.");
  const r = raw as Record<string, unknown>;
  const out: Partial<HomeContextSettings> = {};
  const fields: [keyof HomeContextSettings, number][] = [
    ["idleGapMinutes", 525_600],
    ["recentMessages", 1000],
    ["maxTokens", MAX_TOKENS],
  ];
  for (const [key, max] of fields) {
    if (r[key] === undefined) continue;
    if (!whole(r[key], 1, max)) throw new Error(`Home chat: ${key} must be a whole number from 1 to ${max}.`);
    out[key] = r[key];
  }
  return out;
}

interface StoredCompaction {
  policy: Partial<CompactionPolicySettings>;
  modelOverrides: Record<string, Partial<CompactionPolicySettings>>;
}

function readStored(store: AppStore): StoredCompaction {
  try {
    const raw = JSON.parse(store.metaGet(COMPACTION_KEY) ?? "{}") as Record<string, unknown>;
    const overrides: Record<string, Partial<CompactionPolicySettings>> = {};
    for (const [id, v] of Object.entries((raw.modelOverrides as object | undefined) ?? {})) {
      try {
        overrides[id] = checkPolicy(v);
      } catch {
        /* Drop an invalid entry; the rest stay usable. */
      }
    }
    let policy: Partial<CompactionPolicySettings> = {};
    try {
      policy = checkPolicy(raw.policy ?? {});
    } catch {
      /* Defaults remain. */
    }
    return { policy, modelOverrides: overrides };
  } catch {
    return { policy: {}, modelOverrides: {} };
  }
}

/** What Pi's `settings.compaction` should be right now. Read at each model call, so edits apply to open conversations. */
export function compactionSettings(store: AppStore) {
  const { policy, modelOverrides } = readStored(store);
  return { ...DEFAULT_COMPACTION, ...policy, modelOverrides };
}

export function readContextSettings(store: AppStore): ContextSettings {
  const { policy, modelOverrides } = readStored(store);
  let home: Partial<HomeContextSettings> = {};
  try {
    const raw = JSON.parse(store.metaGet(HOME_KEY) ?? "{}") as Record<string, unknown>;
    home = checkHome({
      ...(typeof raw.idleGapMs === "number" ? { idleGapMinutes: Math.round(raw.idleGapMs / 60_000) } : {}),
      recentMessages: raw.recentMessages,
      maxTokens: raw.maxTokens,
    });
  } catch {
    /* Defaults remain. */
  }
  return {
    compaction: { ...DEFAULT_COMPACTION, ...policy },
    modelOverrides,
    home: { ...DEFAULT_HOME, ...home },
    defaults: { compaction: DEFAULT_COMPACTION, home: DEFAULT_HOME },
  };
}

/** Applies a validated request; `null` resets a part. The reserve must leave room: keepRecent is not above reserve checks here. */
export function updateContextSettings(
  store: AppStore,
  req: {
    compaction?: unknown;
    modelOverrides?: unknown;
    home?: unknown;
  },
): ContextSettings {
  const current = readStored(store);
  let { policy, modelOverrides } = current;
  if (req.compaction === null) policy = {};
  else if (req.compaction !== undefined) policy = { ...policy, ...checkPolicy(req.compaction) };
  if (req.modelOverrides !== undefined) {
    const raw = req.modelOverrides;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("modelOverrides must be an object.");
    const entries = Object.entries(raw);
    if (entries.length > MAX_OVERRIDES) throw new Error(`At most ${MAX_OVERRIDES} model overrides.`);
    modelOverrides = {};
    for (const [id, v] of entries) {
      if (!id.trim() || id.length > 200) throw new Error("Model override names must be 1-200 characters.");
      const p = checkPolicy(v, `Model ${id}`);
      if (Object.keys(p).length > 0) modelOverrides[id] = p;
    }
  }
  store.metaSet(COMPACTION_KEY, JSON.stringify({ policy, modelOverrides }));
  if (req.home === null) store.metaSet(HOME_KEY, null);
  else if (req.home !== undefined) {
    const next = { ...readContextSettings(store).home, ...checkHome(req.home) };
    store.metaSet(
      HOME_KEY,
      JSON.stringify({
        idleGapMs: next.idleGapMinutes * 60_000,
        recentMessages: next.recentMessages,
        maxTokens: next.maxTokens,
      }),
    );
  }
  return readContextSettings(store);
}
