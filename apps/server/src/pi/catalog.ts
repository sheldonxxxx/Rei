import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelCapability, ModelSettingsResponse, ModelsResponse, UpdateModelSettingsRequest } from "@rei/protocol";
import type { AppStore } from "../store/store.ts";
import { HttpError } from "../util/errors.ts";
import {
  type ModelOverride,
  type ModelsConfig,
  type ModelsConfigSource,
  parseModelsConfig,
  validLimit,
} from "./model-config.ts";
import type { ModelRuntime } from "./models.ts";

export interface ModelCatalogDeps {
  store: Pick<AppStore, "modelsInUse">;
  modelsConfig: ModelsConfigSource;
  runtime: ModelRuntime;
}

/** The models an agent can be set to (GET /api/models). */
export class ModelCatalog {
  readonly #d: ModelCatalogDeps;
  constructor(deps: ModelCatalogDeps) {
    this.#d = deps;
  }

  /** Connection names by id, for showing a provider in the trace and usage. */
  providerNames(): Record<string, string> {
    return this.#d.runtime.providerNames();
  }

  async list(): Promise<ModelsResponse> {
    await this.#d.runtime.ensureProviders?.().catch(() => undefined);
    const config = parseModelsConfig(await this.#d.modelsConfig.read().catch(() => undefined));
    // Only connected providers supply choices. Defaults and saved agent selections are not evidence of availability.
    const available = new Set(this.#d.runtime.selectableModels());
    const models = [...available];
    if (available.has(config.standard.model)) {
      models.splice(models.indexOf(config.standard.model), 1);
      models.unshift(config.standard.model);
    }
    // The runtime resolves each model with the user's efforts, so this list is what an agent can pick.
    const thinkingLevels = Object.fromEntries(
      models.map((id) => {
        const ref = this.#d.runtime.ref(id);
        const model = this.#d.runtime.models.getModel(ref.provider, ref.modelId);
        return [id, model ? getSupportedThinkingLevels(model) : []];
      }),
    );
    const allLabels = this.#d.runtime.selectableLabels();
    const labels = Object.fromEntries(models.filter((id) => allLabels[id]).map((id) => [id, allLabels[id]!]));
    return { default: config.standard.model, models, labels, thinkingLevels };
  }

  async settings(): Promise<ModelSettingsResponse> {
    return this.#settings(parseModelsConfig(await this.#d.modelsConfig.read().catch(() => undefined)));
  }

  async update(input: UpdateModelSettingsRequest): Promise<ModelSettingsResponse> {
    if (!this.#d.modelsConfig.write)
      throw new HttpError(503, "settings_read_only", "Model settings cannot be changed on this host.");
    const current = parseModelsConfig(await this.#d.modelsConfig.read().catch(() => undefined));
    const next = {
      fast: { ...current.fast, deadlines: { ...current.fast.deadlines } },
      standard: { ...current.standard, deadlines: { ...current.standard.deadlines } },
      overrides: this.#overridesWith(current.overrides, input.capabilities ?? {}),
    } satisfies ModelsConfig;
    for (const tier of ["fast", "standard"] as const) {
      const patch = input[tier];
      if (!patch) continue;
      if (patch.model !== undefined) next[tier].model = patch.model;
      for (const field of ["firstEventMs", "idleMs", "totalMs"] as const) {
        if (patch[field] !== undefined) next[tier].deadlines[field] = patch[field]!;
      }
    }
    await this.#d.modelsConfig.write(next);
    this.#d.runtime.setModelOverrides(next.overrides);
    return this.#settings(next);
  }

  /** Applies a PUT's per-model patches to the saved overrides, refusing values the model cannot use. */
  #overridesWith(
    saved: Record<string, ModelOverride>,
    patches: NonNullable<UpdateModelSettingsRequest["capabilities"]>,
  ): Record<string, ModelOverride> {
    const out = { ...saved };
    for (const [id, patch] of Object.entries(patches)) {
      const own: ModelOverride = { ...out[id] };
      if (patch.contextWindow !== undefined) {
        if (patch.contextWindow === null) delete own.contextWindow;
        else if (validLimit(patch.contextWindow)) own.contextWindow = patch.contextWindow;
        else throw new HttpError(400, "bad_request", "Context window must be a whole number of tokens.");
      }
      if (patch.maxTokens !== undefined) {
        if (patch.maxTokens === null) delete own.maxTokens;
        else if (validLimit(patch.maxTokens)) own.maxTokens = patch.maxTokens;
        else throw new HttpError(400, "bad_request", "Max output tokens must be a whole number of tokens.");
      }
      // Both limits are checked against what applies after this change: a value the user did not set falls back to the
      // detected or built-in limit.
      const applied = this.#d.runtime.limits(id, own);
      const window = own.contextWindow ?? applied.contextWindow.value;
      const maxTokens = own.maxTokens ?? applied.maxTokens.value;
      if (window !== null && maxTokens !== null && maxTokens > window)
        throw new HttpError(400, "bad_request", "Max output tokens cannot be larger than the context window.");
      if (Object.keys(own).length > 0) out[id] = own;
      else delete out[id];
    }
    return out;
  }

  #settings(config: ModelsConfig): ModelSettingsResponse {
    // Offered models and any model with a saved override, so a model that is no longer offered can still be cleared.
    const ids = [...new Set([...this.#d.runtime.selectableModels(), ...Object.keys(config.overrides)])];
    return {
      fast: { model: config.fast.model, ...config.fast.deadlines },
      standard: { model: config.standard.model, ...config.standard.deadlines },
      capabilities: ids.map((id) => this.#capability(id)),
    };
  }

  #capability(id: string): ModelCapability {
    const applied = this.#d.runtime.limits(id);
    return {
      id,
      contextWindow: applied.contextWindow,
      maxTokens: applied.maxTokens,
    };
  }
}
