import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import type {
  ModelLimits,
  ProviderConnection,
  SaveProviderConnectionRequest,
  ScanProviderModelsRequest,
} from "@rei/protocol";
import type { ProviderManager } from "../core/types.ts";
import type { UpstreamRule } from "../core/upstream.ts";
import { createPiModels } from "./auth.ts";
import { ensureSecretDir, type FileCredentialStore, getDeviceId } from "./credstore.ts";

interface SavedProvider extends Omit<ProviderConnection, "connected"> {
  connected: boolean;
}
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A whole token count we accept as a limit; anything else (fractions, zero, huge numbers) is not a limit. */
const MAX_LIMIT = 10_000_000;
function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_LIMIT ? value : undefined;
}

/** Field names OpenAI-compatible servers use for a model's context window and output cap, most specific first. */
const CONTEXT_FIELDS = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_model_len",
  "max_context_tokens",
  "input_token_limit",
  "inputTokenLimit",
  "max_input_tokens",
] as const;
const OUTPUT_FIELDS = [
  "max_output_tokens",
  "max_completion_tokens",
  "output_token_limit",
  "outputTokenLimit",
  "max_output_length",
] as const;

/** The limits one entry of a provider's model list reports, or undefined when it reports neither. */
function reportedLimits(entry: Record<string, unknown>): ModelLimits | undefined {
  const pick = (fields: readonly string[]): number | undefined => {
    for (const field of fields) {
      const value = whole(entry[field]);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const contextWindow = pick(CONTEXT_FIELDS);
  const maxTokens = pick(OUTPUT_FIELDS);
  if (contextWindow === undefined && maxTokens === undefined) return undefined;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

/** Keeps limits only for models in the list, and only the whole-number fields. */
function keepLimits(raw: Record<string, ModelLimits>, models: string[]): Record<string, ModelLimits> {
  const out: Record<string, ModelLimits> = {};
  for (const id of models) {
    const limits = raw[id];
    if (!limits) continue;
    const contextWindow = whole(limits.contextWindow);
    const maxTokens = whole(limits.maxTokens);
    if (contextWindow === undefined && maxTokens === undefined) continue;
    out[id] = {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };
  }
  return out;
}

/** Plain HTTP is allowed only for local inference, including the container-to-host bridge. */
function endpointUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(url.hostname))
      ) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new Error(
      "Use HTTPS, or HTTP on localhost or host.docker.internal, without credentials, query parameters or fragments.",
    );
  }
}

interface OpenAiOAuthAttempt {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
  clientId?: string;
  subject?: string;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
  exchanging: boolean;
}

/** Gateway-owned provider metadata and keys. Metadata and credentials are both private files under /data/secret. */
export class FileProviderManager implements ProviderManager {
  readonly #file: string;
  readonly #credentials: FileCredentialStore;
  readonly #models;
  #mutations: Promise<void> = Promise.resolve();
  #oauth: OpenAiOAuthAttempt | undefined;
  #oauthError: string | undefined;
  constructor(file: string, credentials: FileCredentialStore) {
    this.#file = file;
    this.#credentials = credentials;
    this.#models = createPiModels(credentials);
    ensureSecretDir(dirname(file));
  }
  #all(): SavedProvider[] {
    if (!existsSync(this.#file)) return [];
    try {
      return JSON.parse(readFileSync(this.#file, "utf8")) as SavedProvider[];
    } catch {
      return [];
    }
  }
  #write(rows: SavedProvider[]): void {
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
  }
  async list(): Promise<ProviderConnection[]> {
    return Promise.all(
      this.#all().map(async (row) => ({
        ...row,
        connected: row.kind === "openai-compatible" || !!(await this.#credentials.read(row.id)),
      })),
    );
  }
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const update = this.#mutations.then(task);
    this.#mutations = update.then(
      () => {},
      () => {},
    );
    return update;
  }
  save(input: SaveProviderConnectionRequest): Promise<ProviderConnection> {
    return this.#enqueue(() => this.#save(input));
  }
  async #save(input: SaveProviderConnectionRequest): Promise<ProviderConnection> {
    const reservedId = input.kind === "openai" ? "openai" : undefined;
    const id = input.id?.trim() || reservedId || crypto.randomUUID().slice(0, 12);
    if (!ID.test(id)) throw new Error("Connection id must use letters, numbers, dashes or underscores.");
    if (reservedId ? id !== reservedId : id === "openai")
      throw new Error("That connection ID is reserved for a built-in provider.");
    const name = input.name.trim();
    if (!name || name.length > 80) throw new Error("Connection name must contain 1 to 80 characters.");
    const models = [...new Set((input.models ?? []).map((m) => m.trim()).filter(Boolean))];
    if (models.length > 200 || models.some((m) => m.length > 100 || /[\r\n\0]/.test(m)))
      throw new Error("Enter up to 200 valid model ids.");
    if (input.kind === "openai-compatible" && models.length === 0)
      throw new Error("Enter at least one model ID for this endpoint.");
    let baseUrl: string | undefined;
    if (input.kind === "openai-compatible") baseUrl = endpointUrl(input.baseUrl ?? "");
    if (input.api !== undefined && input.api !== "chat" && input.api !== "responses")
      throw new Error("Choose Chat Completions or Responses for this endpoint.");
    const api = input.kind === "openai-compatible" && input.api === "responses" ? "responses" : undefined;
    const auth = input.kind === "openai" && input.auth === "oauth" ? "oauth" : "api_key";
    const rows = this.#all();
    const previous = rows.find((row) => row.id === id);
    if (previous && previous.kind !== input.kind)
      throw new Error("A connection cannot change provider type. Remove it and add a new connection instead.");
    const key = input.apiKey?.trim();
    const old = await this.#credentials.read(id);
    if (auth === "oauth") {
      if (!old || old.type !== "oauth") throw new Error("Sign in with ChatGPT to create this connection.");
    } else if (key) {
      await this.#credentials.modify(id, async () => ({ type: "api_key", key }) satisfies Credential);
    } else if (old?.type !== "api_key" && input.kind !== "openai-compatible") {
      throw new Error("An API key is required for this connection.");
    }
    // Limits from the last scan are kept while their models are listed; a save that sends new ones replaces them.
    const modelInfo = keepLimits(input.modelInfo ?? previous?.modelInfo ?? {}, models);
    const row: SavedProvider = {
      id,
      name,
      kind: input.kind,
      auth,
      connected: true,
      ...(baseUrl ? { baseUrl } : {}),
      ...(api ? { api } : {}),
      models,
      ...(Object.keys(modelInfo).length > 0 ? { modelInfo } : {}),
    };
    this.#write([...rows.filter((r) => r.id !== id), row]);
    return row;
  }
  async scanModels(
    input: ScanProviderModelsRequest,
  ): Promise<{ models: string[]; modelInfo?: Record<string, ModelLimits> }> {
    const baseUrl = endpointUrl(input.baseUrl);
    const saved = input.id ? this.#all().find((row) => row.id === input.id) : undefined;
    // Never send a saved key to a changed endpoint or to a redirect destination.
    const key = input.apiKey?.trim() || (saved?.baseUrl === baseUrl ? await this.token(saved.id) : "");
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Could not reach the model endpoint. Check its URL and connection.");
    }
    if (!response.ok) throw new Error(`Model scan failed (HTTP ${response.status}). Check the endpoint and API key.`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("The endpoint returned an empty model list response.");
    let body = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1_048_576) throw new Error("The model list response is too large.");
        body += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    let data: unknown;
    try {
      data = JSON.parse(body + decoder.decode());
    } catch {
      throw new Error("The endpoint returned an invalid model list.");
    }
    const entries = data && typeof data === "object" && "data" in data ? data.data : undefined;
    if (!Array.isArray(entries)) throw new Error("The endpoint must return an OpenAI-compatible model list.");
    const modelInfo: Record<string, ModelLimits> = {};
    const models = [
      ...new Set(
        entries.flatMap((entry: unknown) => {
          const id = entry && typeof entry === "object" && "id" in entry ? entry.id : undefined;
          if (typeof id !== "string" || !id.trim() || id.length > 100 || /[\r\n\0]/.test(id)) return [];
          const limits = reportedLimits(entry as Record<string, unknown>);
          if (limits) modelInfo[id.trim()] = limits;
          return [id.trim()];
        }),
      ),
    ];
    if (models.length > 200) throw new Error("The endpoint returned more than 200 models. Enter model IDs manually.");
    return Object.keys(modelInfo).length > 0 ? { models, modelInfo } : { models };
  }
  remove(id: string): Promise<void> {
    return this.#enqueue(async () => {
      await this.#credentials.delete(id);
      this.#write(this.#all().filter((r) => r.id !== id));
    });
  }
  async token(id: string): Promise<string> {
    const row = this.#all().find((r) => r.id === id);
    if (!row) throw new Error("Provider connection not found.");
    const credential = await this.#credentials.read(id);
    if (!credential)
      return row.kind === "openai-compatible"
        ? ""
        : (() => {
            throw new Error("Provider is not connected.");
          })();
    if (credential.type === "api_key") return (credential as { key?: string }).key ?? "";
    return (await this.#models.getAuth(id))?.auth.apiKey ?? "";
  }
  async upstreams(): Promise<UpstreamRule[]> {
    return [
      ...this.#all().flatMap((r) => {
        if (!r.baseUrl) return [];
        const u = new URL(r.baseUrl);
        return [
          {
            protocol: u.protocol as "http:" | "https:",
            host: u.hostname,
            port: u.port,
            pathPrefix: `${u.pathname.replace(/\/+$/, "")}/`,
          },
        ];
      }),
    ];
  }
  async startOpenAiOAuth(): Promise<{ authorizationUrl: string }> {
    if (this.#oauth) throw new Error("An OpenAI sign-in is already in progress.");
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const flow: OpenAiOAuthAttempt = {
      url: "",
      state,
      nonce,
      verifier,
      controller: new AbortController(),
      exchanging: false,
      timer: setTimeout(() => {
        if (this.#oauth === flow) this.cancelOpenAiOAuth();
      }, 10 * 60_000),
    };
    // Reserve before the first await: another start or cancel must observe this attempt.
    this.#oauth = flow;
    this.#oauthError = undefined;
    try {
      const existing = await this.#credentials.read("openai", { signal: flow.controller.signal });
      this.#requireOAuth(flow);
      const existingOAuth =
        existing?.type === "oauth"
          ? (existing as Credential & { clientId?: string; idToken?: string; subject?: string })
          : undefined;
      const clientId = existingOAuth?.clientId;
      if (clientId) flow.clientId = clientId;
      if (existingOAuth?.subject) flow.subject = existingOAuth.subject;
      const authorization = new URL("https://auth.openai.com/api/accounts/authorize");
      const params = new URLSearchParams({
        client_id: clientId ?? "dynamic_agent_client",
        ext_agent_host_id: `urn:uuid:${getDeviceId(dirname(this.#file))}`,
        response_type: "code",
        redirect_uri: "http://127.0.0.1:1455/auth/callback",
        resource: "https://api.openai.com/v1",
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      if (clientId) {
        const idToken = existingOAuth?.idToken;
        if (idToken) params.set("id_token_hint", idToken);
      } else {
        params.set("agent_name_hint", "Rei");
      }
      authorization.search = params.toString();
      flow.url = authorization.toString();
      return { authorizationUrl: flow.url };
    } catch (error) {
      if (this.#oauth === flow) this.cancelOpenAiOAuth();
      throw error;
    }
  }
  async submitOpenAiOAuthCallback(url: string): Promise<void> {
    if (!this.#oauth) throw new Error("No OpenAI sign-in is waiting for a callback.");
    const flow = this.#oauth;
    if (flow.exchanging) throw new Error("This OpenAI sign-in callback is already being processed.");
    flow.exchanging = true;
    try {
      const callback = new URL(url);
      if (callback.origin !== "http://127.0.0.1:1455" || callback.pathname !== "/auth/callback")
        throw new Error("Paste the full OpenAI redirect URL from the browser.");
      if (callback.searchParams.get("state") !== flow.state)
        throw new Error("The OpenAI sign-in state did not match. Start again.");
      const oauthError = callback.searchParams.get("error");
      if (oauthError) throw new Error(`OpenAI sign-in was not approved (${oauthError}).`);
      const code = callback.searchParams.get("code");
      const returnedClientId = callback.searchParams.get("client_id");
      const clientId = flow.clientId ?? returnedClientId;
      if (
        !code ||
        !clientId ||
        clientId === "dynamic_agent_client" ||
        (flow.clientId !== undefined && returnedClientId !== null && returnedClientId !== flow.clientId)
      )
        throw new Error("The OpenAI redirect did not include a valid authorization code and issued client ID.");
      const response = await fetch("https://auth.openai.com/api/accounts/oauth/token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: flow.verifier,
          redirect_uri: "http://127.0.0.1:1455/auth/callback",
          resource: "https://api.openai.com/v1",
        }),
        signal: AbortSignal.any([flow.controller.signal, AbortSignal.timeout(30_000)]),
      });
      this.#requireOAuth(flow);
      const token = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error("OpenAI could not complete sign-in. Start a fresh sign-in and try again.");
      const access = typeof token.access_token === "string" ? token.access_token : "";
      const refresh = typeof token.refresh_token === "string" ? token.refresh_token : "";
      const idToken = typeof token.id_token === "string" ? token.id_token : "";
      const scopes = typeof token.scope === "string" ? token.scope.split(/\s+/).filter(Boolean) : [];
      if (
        !access ||
        !refresh ||
        !idToken ||
        !scopes.includes("chatgpt.tokens.use.direct") ||
        typeof token.expires_in !== "number" ||
        !Number.isFinite(token.expires_in) ||
        token.expires_in <= 0
      )
        throw new Error(
          "OpenAI did not grant the required ChatGPT model access. Review the requested permissions and reconnect.",
        );
      const subject = await verifyOpenAiIdToken(idToken, clientId, flow.nonce, flow.controller.signal);
      this.#requireOAuth(flow);
      if (flow.subject && subject !== flow.subject)
        throw new Error("OpenAI returned a different ChatGPT account. Disconnect it before switching accounts.");
      const credential: Credential = {
        type: "oauth",
        access,
        refresh,
        expires: Date.now() + token.expires_in * 1000 - 180_000,
        clientId,
        scopes,
        idToken,
        subject,
      };
      await this.#enqueue(async () => {
        this.#requireOAuth(flow);
        await this.#credentials.modify(
          "openai",
          async () => {
            this.#requireOAuth(flow);
            return credential;
          },
          { signal: flow.controller.signal },
        );
        this.#write([
          ...this.#all().filter((r) => r.id !== "openai"),
          { id: "openai", name: "OpenAI", kind: "openai", auth: "oauth", connected: true, models: [] },
        ]);
      });
      if (this.#oauth === flow) {
        clearTimeout(flow.timer);
        this.#oauth = undefined;
      }
    } catch (error) {
      if (this.#oauth === flow) this.#oauthError = error instanceof Error ? error.message : "OpenAI sign-in failed.";
      throw error;
    } finally {
      flow.exchanging = false;
    }
  }
  #requireOAuth(flow: OpenAiOAuthAttempt): void {
    if (this.#oauth !== flow) throw new Error("This OpenAI sign-in is no longer active. Start again.");
    flow.controller.signal.throwIfAborted();
  }
  openAiOAuthStatus(): { pending: boolean; authorizationUrl?: string; error?: string } {
    return this.#oauth
      ? { pending: true, ...(this.#oauth.url ? { authorizationUrl: this.#oauth.url } : {}) }
      : { pending: false, ...(this.#oauthError ? { error: this.#oauthError } : {}) };
  }
  cancelOpenAiOAuth(): void {
    if (this.#oauth) {
      const flow = this.#oauth;
      this.#oauth = undefined;
      clearTimeout(flow.timer);
      flow.controller.abort();
    }
    this.#oauthError = undefined;
  }
}

let jwksCache: { keys: JsonWebKey[]; expiresAt: number } | undefined;
async function verifyOpenAiIdToken(
  token: string,
  audience: string,
  nonce: string,
  signal: AbortSignal,
): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("OpenAI returned an invalid ID token.");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { kid?: string; alg?: string };
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    iat?: number;
    nonce?: string;
    sub?: string;
  };
  const now = Date.now() / 1000;
  if (
    payload.iss !== "https://auth.openai.com" ||
    !(payload.aud === audience || (Array.isArray(payload.aud) && payload.aud.includes(audience))) ||
    !payload.exp ||
    payload.exp < now - 5 ||
    typeof payload.iat !== "number" ||
    payload.iat > now + 5 ||
    payload.nonce !== nonce ||
    !payload.sub
  )
    throw new Error("OpenAI returned identity claims that do not match this sign-in.");
  if (!jwksCache || jwksCache.expiresAt < Date.now()) {
    const response = await fetch("https://auth.openai.com/.well-known/jwks.json", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error("OpenAI signing keys could not be checked.");
    const data = (await response.json()) as { keys?: JsonWebKey[] };
    jwksCache = { keys: data.keys ?? [], expiresAt: Date.now() + 3_600_000 };
  }
  const jwk = jwksCache.keys.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk || !header.alg || !["RS256", "ES256"].includes(header.alg))
    throw new Error("OpenAI ID token uses an unknown signing key.");
  const key = createPublicKey({ key: jwk as any, format: "jwk" });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2]!, "base64url");
  const valid =
    header.alg === "RS256"
      ? verifySignature("RSA-SHA256", data, key, signature)
      : verifySignature("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
  if (!valid) throw new Error("OpenAI ID token signature is invalid.");
  return payload.sub;
}
