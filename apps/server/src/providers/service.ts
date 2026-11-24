import type {
  CodexImagesStatus,
  GatewayCaller,
  GatewayStatus,
  GatewayUsageResponse,
  ProviderConnection,
  ProviderConnectionsResponse,
  SaveProviderConnectionRequest,
  ScanProviderModelsRequest,
  ScanProviderModelsResponse,
  WebSearchSetupStatus,
} from "@rei/protocol";
import { Embedder, isRemoteUrl } from "../memory/embedder.ts";
import { HttpError } from "../util/errors.ts";

export class ProviderService {
  readonly #options: {
    gatewayUrl?: string;
    token: () => Promise<string | undefined>;
    fetchImpl?: typeof fetch;
    isInUse?: (id: string) => Promise<boolean>;
    usedModels?: (id: string) => Promise<string[]>;
    replaceModels?: (id: string, from: string[], to: string) => Promise<void>;
  };
  onChanged: ((connections: ProviderConnection[]) => Promise<void>) | undefined;
  constructor(options: {
    gatewayUrl?: string;
    token: () => Promise<string | undefined>;
    fetchImpl?: typeof fetch;
    isInUse?: (id: string) => Promise<boolean>;
    usedModels?: (id: string) => Promise<string[]>;
    /** Points agents and defaults that use the removed model IDs at `to`. */
    replaceModels?: (id: string, from: string[], to: string) => Promise<void>;
  }) {
    this.#options = options;
  }
  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.#options.gatewayUrl)
      throw new HttpError(503, "gateway_unavailable", "Provider settings need the gateway.");
    const token = await this.#options.token();
    let response: Response;
    try {
      response = await (this.#options.fetchImpl ?? fetch)(`${this.#options.gatewayUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new HttpError(502, "gateway_unavailable", "The gateway could not be reached.");
    }
    if (response.status === 204) return undefined as T;
    const data = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
    // A rejected server-to-gateway credential does not invalidate the browser's Rei session.
    if (response.status === 401 || response.status === 403)
      throw new HttpError(502, "gateway_auth", "The gateway rejected this server's stand-in token.");
    if (!response.ok)
      throw new HttpError(
        response.status,
        data.error?.code ?? "provider_error",
        data.error?.message ?? "Provider settings could not be saved.",
      );
    return data;
  }
  async #readList(): Promise<ProviderConnectionsResponse> {
    return this.#call("GET", "/providers");
  }
  async read(): Promise<ProviderConnectionsResponse> {
    return this.#readList();
  }
  async list(): Promise<ProviderConnectionsResponse> {
    const result = await this.#readList();
    await this.onChanged?.(result.connections);
    return result;
  }
  async embeddingSettings(): Promise<import("@rei/protocol").EmbeddingSetupSettings | null> {
    return this.#call("GET", "/setup/embedding");
  }
  async saveEmbeddingSettings(
    input: import("@rei/protocol").SaveEmbeddingSetupSettings,
  ): Promise<import("@rei/protocol").EmbeddingSetupSettings> {
    return this.#call("POST", "/setup/embedding", input);
  }
  async detectEmbedding(input: import("@rei/protocol").SaveEmbeddingSetupSettings): Promise<{ dims: number }> {
    return this.#call("POST", "/setup/embedding/detect", input);
  }
  embeddingClient(settings: import("@rei/protocol").EmbeddingSetupSettings): Embedder | undefined {
    if (settings.provider === "off" || !settings.profile) return undefined;
    return new Embedder(
      {
        url: `${this.#options.gatewayUrl}/embedding`,
        model: settings.profile.id,
        provider: settings.provider,
        apiModel: settings.apiModel,
        profile: settings.profile,
        remote: isRemoteUrl(settings.baseUrl),
      },
      { readKey: this.#options.token, ...(this.#options.fetchImpl ? { fetch: this.#options.fetchImpl } : {}) },
    );
  }
  async searchSettings(): Promise<import("@rei/protocol").SearchSetupSettings> {
    return this.#call("GET", "/setup/search");
  }
  async saveSearchSettings(
    input: import("@rei/protocol").SaveSearchSetupSettings,
  ): Promise<import("@rei/protocol").SearchSetupSettings> {
    return this.#call("POST", "/setup/search", input);
  }
  async searchStatus(): Promise<WebSearchSetupStatus> {
    const status = await this.#call<GatewayStatus>("GET", "/status");
    return { providers: status.search.providers.map(({ id, configured }) => ({ id, configured })) };
  }
  async scanModels(input: ScanProviderModelsRequest): Promise<ScanProviderModelsResponse> {
    return this.#call("POST", "/providers/scan", input);
  }
  async save(input: SaveProviderConnectionRequest): Promise<ProviderConnection> {
    let removed: string[] = [];
    if (input.id && input.kind === "openai-compatible" && input.models) {
      const used = (await this.#options.usedModels?.(input.id)) ?? [];
      const updated = new Set(input.models);
      removed = used.filter((model) => !updated.has(model));
      // Without a model to switch to (or a way to switch), the references would be left dangling.
      if (removed.length && (!this.#options.replaceModels || !input.models[0])) {
        throw new HttpError(
          409,
          "provider_model_in_use",
          "Keep the model IDs used by agents and defaults, or change those settings before updating this connection.",
        );
      }
    }
    const row = await this.#call<ProviderConnection>("POST", "/providers", input);
    const replacement = input.models?.[0];
    if (input.id && removed.length && replacement && this.#options.replaceModels) {
      await this.#options.replaceModels(input.id, removed, replacement);
      row.replacedModels = removed.map((from) => ({ from, to: replacement }));
    }
    await this.onChanged?.((await this.#readList()).connections);
    return row;
  }
  async remove(id: string): Promise<void> {
    if (await this.#options.isInUse?.(id)) {
      throw new HttpError(409, "provider_in_use", "Change the models using this connection before removing it.");
    }
    await this.#call("DELETE", `/providers/${encodeURIComponent(id)}`);
    await this.onChanged?.((await this.#readList()).connections);
  }
  async startOpenAiOAuth(): Promise<{ authorizationUrl: string }> {
    return this.#call("POST", "/providers/openai/oauth/start");
  }
  async submitOpenAiOAuthCallback(url: string): Promise<void> {
    return this.#call("POST", "/providers/openai/oauth/callback", { url });
  }
  async openAiOAuthStatus(): Promise<{ pending: boolean; authorizationUrl?: string }> {
    return this.#call("GET", "/providers/openai/oauth/status");
  }
  async cancelOpenAiOAuth(): Promise<void> {
    return this.#call("DELETE", "/providers/openai/oauth");
  }
  async codexImagesStatus(): Promise<CodexImagesStatus> {
    if (!this.#options.gatewayUrl) return { enabled: false, signedIn: false, pending: false };
    return this.#call("GET", "/setup/codex-images");
  }
  async startCodexImagesSignIn(): Promise<{ userCode: string; verificationUrl: string }> {
    return this.#call("POST", "/setup/codex-images/signin");
  }
  async cancelCodexImagesSignIn(): Promise<void> {
    return this.#call("DELETE", "/setup/codex-images/signin");
  }
  async signOutCodexImages(): Promise<void> {
    return this.#call("DELETE", "/setup/codex-images");
  }
  hasGateway(): boolean {
    return Boolean(this.#options.gatewayUrl);
  }
  async listCallers(): Promise<GatewayCaller[]> {
    const res = await this.#call<{ callers: GatewayCaller[] }>("GET", "/callers");
    return res.callers;
  }
  async gatewayUsage(query: { from?: string; to?: string; caller?: string }): Promise<GatewayUsageResponse> {
    const params = new URLSearchParams();
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    if (query.caller) params.set("caller", query.caller);
    const qs = params.toString();
    return this.#call("GET", `/usage${qs ? `?${qs}` : ""}`);
  }
}
