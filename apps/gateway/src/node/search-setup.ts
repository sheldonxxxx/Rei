import type { SaveSearchSetupSettings, SearchProviderId, SearchSetupSettings } from "@rei/protocol";
import { DEFAULT_SEARCH_MODEL, SEARCH_PROVIDER_IDS } from "@rei/protocol";
import { HttpError } from "../core/http.ts";
import type { SearchDeps } from "../core/search/service.ts";
import type { SecretStore } from "../core/secrets.ts";

// Older settings use exa for either authentication mode. Preserve the selected mode and its priority.
function migrateExa(ids: readonly SearchProviderId[], legacyAuth: SearchSetupSettings["exaAuth"]): SearchProviderId[] {
  return legacyAuth === "api_key" && !ids.includes("exa-api")
    ? ids.map((id) => (id === "exa" ? "exa-api" : id))
    : [...ids];
}

/** Gateway-owned, durable search settings. Inference reads the same mutable configuration. */
export class SearchSetup {
  readonly config: SearchDeps;
  readonly #secrets: SecretStore;
  readonly #defaults: SearchDeps;
  constructor(secrets: SecretStore, defaults: SearchDeps, saved?: SaveSearchSetupSettings) {
    this.#secrets = secrets;
    this.#defaults = defaults;
    // Migrate the retired bundled engine to Exa without changing explicit external services or Off.
    const bundled = saved?.searxngUrl === "http://searxng:8080";
    const providers = bundled && saved.providers.includes("searxng") ? ["exa" as const] : saved?.providers;
    const enabled =
      providers?.length === 0 && saved?.providers.length ? ["exa" as const] : (providers ?? defaults.providers);
    const active = migrateExa(enabled, bundled ? undefined : saved?.exaAuth);
    const order = [
      ...new Set([...migrateExa(saved?.providerOrder ?? enabled, saved?.exaAuth), ...SEARCH_PROVIDER_IDS]),
    ];
    this.config = {
      ...defaults,
      codexModel: saved?.codexModel ?? defaults.codexModel ?? DEFAULT_SEARCH_MODEL,
      providerOrder: order,
      providers: order.filter((id) => active.includes(id)),
      searxngUrl: bundled ? undefined : (saved?.searxngUrl ?? defaults.searxngUrl),
      keys: async (id) => {
        const current = await secrets.read<SaveSearchSetupSettings>("setup-search");
        if (current?.apiKeys?.[id]) return current.apiKeys[id]!;
        // Never send a saved host credential to a replacement SearXNG endpoint.
        if (id === "searxng" && current && current.searxngUrl !== (defaults.searxngUrl ?? "")) return null;
        return defaults.keys(id);
      },
    };
  }
  static async load(secrets: SecretStore, defaults: SearchDeps): Promise<SearchSetup> {
    return new SearchSetup(secrets, defaults, await secrets.read<SaveSearchSetupSettings>("setup-search"));
  }
  async read(): Promise<SearchSetupSettings> {
    return {
      providers: [...this.config.providers],
      providerOrder: [...(this.config.providerOrder ?? SEARCH_PROVIDER_IDS)],
      searxngUrl: this.config.searxngUrl ?? "",
      codexModel: this.config.codexModel ?? DEFAULT_SEARCH_MODEL,
    };
  }
  async save(input: SaveSearchSetupSettings): Promise<SearchSetupSettings> {
    const enabled = migrateExa(input.providers, input.exaAuth);
    let providerOrder = input.providerOrder
      ? migrateExa(input.providerOrder, input.exaAuth)
      : [...new Set([...enabled, ...(this.config.providerOrder ?? SEARCH_PROVIDER_IDS)])];
    // Older clients submit all five original rows.
    const missing = SEARCH_PROVIDER_IDS.filter((id) => !providerOrder.includes(id));
    if (
      providerOrder.length === SEARCH_PROVIDER_IDS.length - 1 &&
      missing.length === 1 &&
      (missing[0] === "exa-api" || (missing[0] === "exa" && input.exaAuth === "api_key"))
    ) {
      providerOrder = [...providerOrder, ...missing];
    }
    if (
      providerOrder.length !== SEARCH_PROVIDER_IDS.length ||
      new Set(providerOrder).size !== providerOrder.length ||
      providerOrder.some((id) => !SEARCH_PROVIDER_IDS.includes(id))
    )
      throw new HttpError(400, "search_order_invalid", "Include every search provider exactly once in the order.");
    const providers = providerOrder.filter((id) => enabled.includes(id));
    const codexModel = input.codexModel?.trim() ?? this.config.codexModel ?? DEFAULT_SEARCH_MODEL;
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(codexModel))
      throw new HttpError(
        400,
        "search_model_invalid",
        "Enter a valid search model ID (1–100 letters, numbers, dots, underscores or hyphens).",
      );
    const { exaAuth: _legacyAuth, ...settings } = input;
    await this.#secrets.modify<SaveSearchSetupSettings>("setup-search", (current) => {
      const keys = { ...current?.apiKeys };
      if (input.searxngUrl !== (current?.searxngUrl ?? this.#defaults.searxngUrl ?? "")) delete keys.searxng;
      return { ...settings, providers, providerOrder, codexModel, apiKeys: { ...keys, ...input.apiKeys } };
    });
    this.config.codexModel = codexModel;
    this.config.providerOrder = providerOrder;
    this.config.providers = providers;
    this.config.searxngUrl = input.searxngUrl;
    return this.read();
  }
}
