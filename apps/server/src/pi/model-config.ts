import { DEFAULT_MODEL_DEADLINES } from "@rei/protocol";

/** Default chat and automatic-title model configuration. Agents may override the chat model. */
/** Model-call deadlines: no first event in 120 s, 30 s without an event, 10 minutes per call including retries. */
export interface Deadlines {
  firstEventMs: number;
  idleMs: number;
  totalMs: number;
}
export const DEFAULT_DEADLINES: Deadlines = DEFAULT_MODEL_DEADLINES;

export interface ModelConfig {
  model: string;
  deadlines: Deadlines;
}

/** A user's limits for one model choice. A missing field means "use the detected or built-in value". */
export interface ModelOverride {
  contextWindow?: number;
  maxTokens?: number;
}

export const MAX_MODEL_LIMIT = 10_000_000;

export type ModelsConfig = Record<"fast" | "standard", ModelConfig> & {
  /** Keyed by model choice (`connectionId/model`, or a bare OpenAI id). */
  overrides: Record<string, ModelOverride>;
};

/** A limit a user or provider can give: a whole number of tokens within the range we store. */
export function validLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_MODEL_LIMIT;
}

/** What `${REI_DATA}/models.json` holds when nobody has edited it. */
export const DEFAULT_MODELS_JSON = { fast: "gpt-6-luna", standard: "gpt-6.1-sol" } as const;

/**
 * Maintained OpenAI chat choices, newest first. Used only for a connected OpenAI provider without explicit model IDs;
 * the SDK catalog also contains legacy models and is not a selectable-provider catalog.
 */
export const KNOWN_MODELS: readonly string[] = [
  "gpt-6.2-sol",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

/** The model a call uses: the agent's own choice, else the default (the "standard" entry). */
export const modelFor = (config: ModelsConfig, agentModel: string | null): string =>
  agentModel ?? config.standard.model;

/** Reads the file the host gives us (see `ModelsConfigSource`). */
export interface ModelsConfigSource {
  read(): Promise<unknown>;
  write?(value: ModelsConfig): Promise<void> | void;
}

const MODELS = ["fast", "standard"] as const;

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * A default is either a model id (`"gpt-6.1-sol"`) or an object `{ "model": "...", "firstEventMs": 120000, "idleMs": 30000,
 * "totalMs": 600000 }`. Anything missing or invalid falls back to the default.
 */
export function parseModelsConfig(raw: unknown): ModelsConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as ModelsConfig;
  for (const tier of MODELS) {
    const entry = obj[tier];
    const fallbackModel = DEFAULT_MODELS_JSON[tier];
    if (typeof entry === "string" && entry.trim() !== "") {
      out[tier] = { model: entry.trim(), deadlines: { ...DEFAULT_DEADLINES } };
    } else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      out[tier] = {
        model: typeof e.model === "string" && e.model.trim() !== "" ? e.model.trim() : fallbackModel,
        deadlines: {
          firstEventMs: positive(e.firstEventMs, DEFAULT_DEADLINES.firstEventMs),
          idleMs: positive(e.idleMs, DEFAULT_DEADLINES.idleMs),
          totalMs: positive(e.totalMs, DEFAULT_DEADLINES.totalMs),
        },
      };
    } else {
      out[tier] = { model: fallbackModel, deadlines: { ...DEFAULT_DEADLINES } };
    }
  }
  out.overrides = parseModelOverrides(obj.models);
  return out;
}

/** The `models` object of models.json: `{ "<choice>": { "contextWindow", "maxTokens" } }`. Invalid entries are dropped. */
export function parseModelOverrides(raw: unknown): Record<string, ModelOverride> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ModelOverride> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id.trim() || id.length > 200 || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const e = value as Record<string, unknown>;
    const override: ModelOverride = {};
    if (validLimit(e.contextWindow)) override.contextWindow = e.contextWindow;
    if (validLimit(e.maxTokens)) override.maxTokens = e.maxTokens;
    if (Object.keys(override).length > 0) out[id] = override;
  }
  return out;
}
