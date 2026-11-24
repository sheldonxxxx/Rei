import {
  type Api,
  type Credential,
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider, type Models, type Provider } from "@earendil-works/pi-ai/models";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { CapabilitySource, ModelLimits, ProviderConnection, ThinkingLevel } from "@rei/protocol";
import { THINKING_LEVELS } from "@rei/protocol";
import { redact } from "../util/log.ts";
import { armFaux, createFaux, fauxFactory } from "./faux.ts";
import { KNOWN_MODELS, type ModelOverride } from "./model-config.ts";

/** Where the stand-in token lives; the host reads the file (Node) and hands the text in. */
export interface StandinSource {
  read(): Promise<string | undefined>;
}

/** One limit as it applies now, and where it came from. `value` is null when no limit is known. */
export interface LimitState {
  value: number | null;
  source: CapabilitySource;
}

export interface ModelRuntime {
  mode: "gateway" | "faux";
  selectableModels(): string[];
  /** Display text for connection-prefixed choices, keyed by the choice value. */
  selectableLabels(): Record<string, string>;
  /** Connection names by connection id: a provider is shown to people by its name, not its id. */
  providerNames(): Record<string, string>;
  /** Plain pi-ai `Models`, with each model resolved to its limits and efforts (the harness gets an instrumented wrapper). */
  models: Models;
  faux?: FauxProviderHandle;
  /** The model reference for a model id (an agent's choice, or the default from models.json). */
  ref(modelId: string): { provider: string; modelId: string };
  /** Re-reads the stand-in token; the gateway may have issued it after this server started. */
  refreshCredential(): Promise<boolean>;
  /** Faux mode: queue the next scripted reply. */
  arm(): void;
  /** Removes the stand-in (and anything shaped like a credential) from text headed for Pi's store or a log. */
  scrub(text: string): string;
  configureProviders(connections: ProviderConnection[]): Promise<void>;
  ensureProviders(): Promise<void>;
  /** The user's per-model limits and efforts (models.json `models`). Applies to the next call. */
  setModelOverrides(overrides: Record<string, ModelOverride>): void;
  /** Caps the output tokens each call requests (Settings > Behavior); null leaves each model's own limit. Applies to the next call. */
  setOutputCap(cap: number | null): void;
  /** Whether OpenAI models search with OpenAI's built-in tool (Settings > Behavior). Applies to the next call. */
  setNativeSearch(on: boolean): void;
  nativeSearch(): boolean;
  /**
   * Context and output limits for a model choice, each with its source. `own` stands in for the saved override, so a
   * change can be checked before it is saved; it defaults to the override that applies now.
   */
  limits(choice: string, own?: ModelOverride): { contextWindow: LimitState; maxTokens: LimitState };
  /** The efforts a model offers without the user's list: what the provider or the built-in catalog says. */
  defaultThinkingLevels(choice: string): ThinkingLevel[];
}

/** A `Models` whose `getModel` returns the resolved model (limits and efforts applied); everything else is unchanged. */
function withResolvedModels(
  inner: Models,
  resolve: (provider: string, modelId: string) => Model<Api> | undefined,
): Models {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "getModel") return (provider: string, modelId: string) => resolve(provider, modelId);
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Every effort is sent under its own name. Custom models offer all of them; the provider decides what it accepts. */
const ALL_EFFORTS_MAP = Object.fromEntries(
  THINKING_LEVELS.filter((level) => level !== "off").map((level) => [level, level]),
) as Model<Api>["thinkingLevelMap"];

const STANDIN_SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];

export interface ModelRuntimeOptions {
  mode: "gateway" | "faux";
  standin?: StandinSource;
  fauxTokensPerSecond?: number;
  providerConnections?: ProviderConnection[];
  providerLoader?: () => Promise<ProviderConnection[]>;
  onProviderLoadError?: (error: unknown) => void;
}

export async function createModelRuntime(options: ModelRuntimeOptions): Promise<ModelRuntime> {
  if (options.mode === "faux") {
    const faux = createFaux(
      options.fauxTokensPerSecond === undefined ? {} : { tokensPerSecond: options.fauxTokensPerSecond },
    );
    const models = createModels();
    models.setProvider(faux.provider);
    const factory = fauxFactory();
    const model = faux.getModel();
    return {
      mode: "faux",
      selectableModels: () => [...KNOWN_MODELS],
      selectableLabels: () => ({}),
      providerNames: () => ({}),
      models,
      faux,
      ref: () => ({ provider: model.provider, modelId: model.id }),
      refreshCredential: async () => true,
      arm: () => armFaux(faux, factory),
      scrub: (text) => redact(text),
      configureProviders: async () => {},
      ensureProviders: async () => {},
      setModelOverrides: () => {},
      setOutputCap: () => {},
      setNativeSearch: () => {},
      nativeSearch: () => false,
      limits: () => ({
        contextWindow: { value: null, source: "unknown" },
        maxTokens: { value: null, source: "unknown" },
      }),
      defaultThinkingLevels: () => ["off"],
    };
  }
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  // pi-ai only knows the models it ships with; the gateway may reach others, and the user can name any model, so an id
  // it lacks is added here, shaped like a known model (the gateway is what says whether the id really exists).
  const base = openaiProvider();
  const extra = new Map<string, Model<"openai-responses">>();
  const provider: Provider<"openai-responses"> = {
    ...base,
    getModels: () => [...base.getModels(), ...extra.values()],
    getAllModels: () => [...(base.getAllModels?.() ?? base.getModels()), ...extra.values()],
  };
  models.setProvider(provider);
  const configured = new Set<string>();
  let selectable: string[] = [];
  let labels: Record<string, string> = {};
  let names: Record<string, string> = {};
  let current: string | undefined;
  let providerRevision = 0;
  let registrations: Promise<void> = Promise.resolve();
  // Per model choice: the limits the provider reported, and whether the model is served by a custom endpoint (whose
  // built-in limits are unknown, so nothing is inherited from a catalog model).
  const detected = new Map<string, ModelLimits>();
  const custom = new Set<string>();
  let overrides: Record<string, ModelOverride> = {};
  let outputCap: number | null = null;
  let nativeSearch = false;
  const choiceOf = (provider: string, modelId: string): string =>
    provider === "openai" ? modelId : `${provider}/${modelId}`;
  /** The model as it applies: the user's override, else what the provider reported, else the built-in value. */
  const build = (provider: string, modelId: string, useOverrides: boolean): Model<Api> | undefined => {
    const found = models.getModel(provider, modelId);
    if (!found) return undefined;
    const choice = choiceOf(provider, modelId);
    const own = useOverrides ? overrides[choice] : undefined;
    const reported = detected.get(choice);
    const isCustom = custom.has(choice);
    const contextWindow = own?.contextWindow ?? reported?.contextWindow ?? (isCustom ? 0 : found.contextWindow);
    const limit = own?.maxTokens ?? reported?.maxTokens ?? (isCustom ? undefined : found.maxTokens);
    // The cap is a request budget: it never raises what the model can produce.
    const maxTokens = useOverrides && outputCap !== null ? Math.min(limit ?? outputCap, outputCap) : limit;
    if (contextWindow === found.contextWindow && maxTokens === found.maxTokens) return found;
    return { ...found, contextWindow, maxTokens } as Model<Api>;
  };
  const applyConnections = async (connections: ProviderConnection[]) => {
    connections = connections.filter((connection) => connection.connected);
    const next = new Set(
      connections
        .filter((connection) => connection.kind === "openai-compatible" && connection.baseUrl)
        .map((connection) => connection.id),
    );
    for (const id of configured) {
      if (!next.has(id)) {
        models.deleteProvider(id);
        await credentials.delete(id);
      }
    }
    configured.clear();
    custom.clear();
    detected.clear();
    for (const connection of connections) {
      if (connection.kind !== "openai-compatible") continue;
      if (!connection.baseUrl) continue;
      const modelIds = connection.models.length ? connection.models : [];
      for (const id of modelIds) custom.add(choiceOf(connection.id, id));
      // Custom endpoints speak Chat Completions unless the connection says Responses.
      const wire = connection.api === "responses" ? "openai-responses" : "openai-completions";
      const endpoint: Provider<Api> = createProvider<Api>({
        id: connection.id,
        name: connection.name,
        baseUrl: connection.baseUrl,
        // The key is always the stored credential set below; there is no ambient (environment) source for a custom endpoint.
        auth: {
          apiKey: {
            name: "API key",
            resolve: async ({ credential }) =>
              credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined,
          },
        },
        models: modelIds.map((id) => {
          const template = base.getModels().find((m) => m.api === "openai-responses") ?? base.getModels()[0]!;
          return {
            ...template,
            id,
            name: id,
            provider: connection.id,
            api: wire,
            baseUrl: connection.baseUrl,
            reasoning: true,
            thinkingLevelMap: ALL_EFFORTS_MAP,
          } as unknown as Model<Api>;
        }),
        api: wire === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi(),
      });
      models.setProvider(endpoint);
      await credentials.modify(connection.id, async () => ({ type: "api_key", key: current ?? "gateway-managed" }));
      configured.add(connection.id);
    }
    const nextLabels: Record<string, string> = {};
    selectable = connections.flatMap((connection) => {
      const ids = connection.models.length ? connection.models : connection.kind === "openai" ? KNOWN_MODELS : [];
      return ids.map((id) => {
        if (connection.id === "openai") return id;
        // The value keeps the connection id so routing (`ref`) stays unambiguous; the label shows the name people chose.
        const value = `${connection.id}/${id}`;
        nextLabels[value] = `${connection.name}/${id}`;
        return value;
      });
    });
    labels = nextLabels;
    names = Object.fromEntries(connections.map((connection) => [connection.id, connection.name]));
    for (const connection of connections) {
      for (const [id, limits] of Object.entries(connection.modelInfo ?? {})) {
        detected.set(choiceOf(connection.id, id), limits);
      }
    }
  };
  const registerConnections = (connections: ProviderConnection[], revision: number): Promise<void> => {
    const update = registrations.then(async () => {
      if (revision === providerRevision) await applyConnections(connections);
    });
    registrations = update.catch(() => {});
    return update;
  };
  await registerConnections(options.providerConnections ?? [], providerRevision);
  let providerLoad: Promise<void> | undefined;
  let providersLoaded = options.providerConnections !== undefined;
  const ensureProviders = async () => {
    if (providersLoaded || !options.providerLoader) return;
    if (!providerLoad) {
      const revision = providerRevision;
      const load: Promise<void> = Promise.resolve()
        .then(() => options.providerLoader!())
        .then((connections) => registerConnections(connections, revision))
        .then(() => {
          if (revision === providerRevision) providersLoaded = true;
        })
        .catch((error) => {
          // Discovery augments the stock catalog. Keep known models usable during an outage and let their
          // instrumented transport record the actual auth/network failure. Retry discovery on the next call.
          if (revision === providerRevision) options.onProviderLoadError?.(error);
        })
        .finally(() => {
          if (providerLoad === load) providerLoad = undefined;
        });
      providerLoad = load;
    }
    await providerLoad;
  };
  const refreshCredential = async (): Promise<boolean> => {
    const token = (await options.standin?.read())?.trim();
    if (!token) return current !== undefined;
    if (token === current) return true;
    current = token;
    // OAuth-shaped (pi-ai treats a non-sk key on the stock base URL as "Sign in with ChatGPT"), never refreshed here.
    await credentials.modify(
      "openai",
      async (): Promise<Credential> => ({
        type: "oauth",
        access: token,
        refresh: "standin-no-refresh",
        expires: Date.now() + 10 * 365 * 24 * 3_600_000,
        clientId: "standin",
        scopes: STANDIN_SCOPES,
      }),
    );
    for (const id of configured) {
      await credentials.modify(id, async (): Promise<Credential> => ({ type: "api_key", key: token }));
    }
    return true;
  };
  await refreshCredential();
  const ref = (choice: string): { provider: string; modelId: string } => {
    const slash = choice.indexOf("/");
    const providerId = slash > 0 ? choice.slice(0, slash) : "openai";
    const modelId = slash > 0 ? choice.slice(slash + 1) : choice;
    if (providerId !== "openai") return { provider: providerId, modelId };
    if (!models.getModel("openai", modelId) && !extra.has(modelId)) {
      const template = [models.getModel("openai", "gpt-6.1-sol"), ...base.getModels()].find(
        (m): m is Model<"openai-responses"> => m?.api === "openai-responses",
      );
      if (template) extra.set(modelId, { ...template, id: modelId, name: modelId });
    }
    return { provider: providerId, modelId };
  };
  const limits = (
    choice: string,
    own: ModelOverride | undefined = overrides[choice],
  ): { contextWindow: LimitState; maxTokens: LimitState } => {
    const { provider, modelId } = ref(choice);
    const found = models.getModel(provider, modelId);
    const reported = detected.get(choice);
    const isCustom = custom.has(choice);
    const state = (
      ownValue: number | undefined,
      reportedValue: number | undefined,
      builtIn: number | undefined,
    ): LimitState => {
      if (ownValue !== undefined) return { value: ownValue, source: "custom" };
      if (reportedValue !== undefined) return { value: reportedValue, source: "detected" };
      if (!isCustom && builtIn !== undefined && builtIn > 0) return { value: builtIn, source: "built_in" };
      return { value: null, source: "unknown" };
    };
    return {
      contextWindow: state(own?.contextWindow, reported?.contextWindow, found?.contextWindow),
      maxTokens: state(own?.maxTokens, reported?.maxTokens, found?.maxTokens),
    };
  };
  return {
    mode: "gateway",
    selectableModels: () => [...selectable],
    selectableLabels: () => ({ ...labels }),
    providerNames: () => ({ ...names }),
    models: withResolvedModels(models, (provider, modelId) => build(provider, modelId, true)),
    ref,
    refreshCredential,
    configureProviders: async (connections) => {
      const revision = ++providerRevision;
      await registerConnections(connections, revision);
      if (revision === providerRevision) providersLoaded = true;
    },
    ensureProviders,
    arm: () => {},
    scrub: (text) => redact(current ? text.split(current).join("[redacted]") : text),
    setModelOverrides: (next) => {
      overrides = { ...next };
    },
    setOutputCap: (cap) => {
      outputCap = cap;
    },
    setNativeSearch: (on) => {
      nativeSearch = on;
    },
    nativeSearch: () => nativeSearch,
    limits,
    defaultThinkingLevels: (choice) => {
      const { provider, modelId } = ref(choice);
      const model = build(provider, modelId, false);
      return model ? getSupportedThinkingLevels(model) : ["off"];
    },
  };
}
