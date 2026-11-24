import type { BehaviorSettings, BehaviorSettingsResponse } from "@rei/protocol";
import type { AppStore } from "../store/store.ts";

export const BEHAVIOR_KEY = "behavior_settings";
/** Hard safety ceilings: a saved value above one is clamped, and no limit can be zero. */
export const CEILINGS = { maxModelCalls: 500, maxRunMinutes: 24 * 60, maxRetries: 10 } as const;

export interface BehaviorDefaults {
  maxModelCalls: number;
  maxRunMs: number;
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number };
}

/** Defaults for callers that read only settings which do not depend on server config (memory, discovery). */
export const CONFIGLESS: BehaviorDefaults = {
  maxModelCalls: 50,
  maxRunMs: 30 * 60_000,
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 2_000 },
};

export const defaultBehavior = (d: BehaviorDefaults): BehaviorSettings => ({
  runLimits: {
    maxModelCalls: Math.min(Math.max(d.maxModelCalls, 1), CEILINGS.maxModelCalls),
    maxRunMinutes: Math.min(Math.max(Math.round(d.maxRunMs / 60_000), 1), CEILINGS.maxRunMinutes),
  },
  retry: {
    maxRetries: d.retry.enabled ? Math.min(d.retry.maxRetries, CEILINGS.maxRetries) : 0,
    baseDelaySeconds: Math.min(Math.max(Math.round(d.retry.baseDelayMs / 1000), 1), 60),
  },
  memory: { injectProfile: true, injectRecent: true, historyHits: 8 },
  generation: { maxOutputTokens: null },
  discovery: { maxConnectorTools: 5, maxSkills: 3 },
  search: { useOpenAiNativeSearch: false },
  codeMode: { enabled: false },
  chat: { whenBusy: "steer" },
});

const whole = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

/** Merges a partial over a base, throwing a user-facing message for any invalid value. */
export function applyBehavior(base: BehaviorSettings, raw: unknown): BehaviorSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Behavior settings must be an object.");
  const r = raw as Record<string, Record<string, unknown> | undefined>;
  const next: BehaviorSettings = structuredClone(base);
  const part = (name: string): Record<string, unknown> => {
    const v = r[name];
    if (v === undefined) return {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} must be an object.`);
    return v;
  };
  const num = (src: Record<string, unknown>, key: string, label: string, min: number, max: number) => {
    if (src[key] === undefined) return undefined;
    if (!whole(src[key], min, max)) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    return src[key] as number;
  };
  const flag = (src: Record<string, unknown>, key: string, label: string) => {
    if (src[key] === undefined) return undefined;
    if (typeof src[key] !== "boolean") throw new Error(`${label} must be on or off.`);
    return src[key] as boolean;
  };
  for (const name of Object.keys(r))
    if (!["runLimits", "retry", "memory", "generation", "discovery", "search", "codeMode", "chat"].includes(name))
      throw new Error(`Unknown setting group: ${name}.`);
  const rl = part("runLimits");
  next.runLimits.maxModelCalls =
    num(rl, "maxModelCalls", "Model calls per run", 1, CEILINGS.maxModelCalls) ?? next.runLimits.maxModelCalls;
  next.runLimits.maxRunMinutes =
    num(rl, "maxRunMinutes", "Run time limit (minutes)", 1, CEILINGS.maxRunMinutes) ?? next.runLimits.maxRunMinutes;
  const re = part("retry");
  next.retry.maxRetries = num(re, "maxRetries", "Retries", 0, CEILINGS.maxRetries) ?? next.retry.maxRetries;
  next.retry.baseDelaySeconds = num(re, "baseDelaySeconds", "Retry delay", 1, 60) ?? next.retry.baseDelaySeconds;
  const me = part("memory");
  next.memory.injectProfile = flag(me, "injectProfile", "Profile in context") ?? next.memory.injectProfile;
  next.memory.injectRecent = flag(me, "injectRecent", "Recent chats in context") ?? next.memory.injectRecent;
  next.memory.historyHits = num(me, "historyHits", "History hits", 1, 20) ?? next.memory.historyHits;
  const ge = part("generation");
  if (ge.maxOutputTokens !== undefined)
    next.generation.maxOutputTokens =
      ge.maxOutputTokens === null ? null : (num(ge, "maxOutputTokens", "Output tokens", 1, 10_000_000) ?? null);
  const di = part("discovery");
  next.discovery.maxConnectorTools =
    num(di, "maxConnectorTools", "Connector tools per search", 1, 20) ?? next.discovery.maxConnectorTools;
  next.discovery.maxSkills = num(di, "maxSkills", "Skills per search", 0, 10) ?? next.discovery.maxSkills;
  const se = part("search");
  next.search.useOpenAiNativeSearch =
    flag(se, "useOpenAiNativeSearch", "OpenAI built-in search") ?? next.search.useOpenAiNativeSearch;
  next.codeMode.enabled = flag(part("codeMode"), "enabled", "Code mode") ?? next.codeMode.enabled;
  const ch = part("chat");
  if (ch.whenBusy !== undefined) {
    if (ch.whenBusy !== "steer" && ch.whenBusy !== "queue")
      throw new Error("Sending while a reply runs must be steer or queue.");
    next.chat.whenBusy = ch.whenBusy;
  }
  return next;
}

/** What is saved, over the defaults; malformed or out-of-range stored values fall back to the default. */
export function behaviorSettings(store: AppStore, defaults: BehaviorDefaults): BehaviorSettings {
  const base = defaultBehavior(defaults);
  let stored: unknown;
  try {
    stored = JSON.parse(store.metaGet(BEHAVIOR_KEY) ?? "null");
  } catch {
    return base;
  }
  if (!stored || typeof stored !== "object") return base;
  let out = base;
  // Group by group, so one bad value costs only its group.
  for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
    try {
      out = applyBehavior(out, { [name]: value });
    } catch {
      /* Keep the default for this group. */
    }
  }
  return out;
}

export function updateBehavior(store: AppStore, defaults: BehaviorDefaults, req: unknown): BehaviorSettingsResponse {
  if (req === null) store.metaSet(BEHAVIOR_KEY, null);
  else store.metaSet(BEHAVIOR_KEY, JSON.stringify(applyBehavior(behaviorSettings(store, defaults), req)));
  return behaviorResponse(store, defaults);
}

export const behaviorResponse = (store: AppStore, defaults: BehaviorDefaults): BehaviorSettingsResponse => ({
  settings: behaviorSettings(store, defaults),
  defaults: defaultBehavior(defaults),
  ceilings: { ...CEILINGS },
});
