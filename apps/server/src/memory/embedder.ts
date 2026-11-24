// The embeddings client: an OpenAI-compatible `POST {base}/v1/embeddings`. fetch only, so it runs on Workers. Vectors
// come back L2-normalised, so cosine similarity is a dot product.
import { estimateTokens } from "./text.ts";

/** Which prompts, size and pooling a model needs. Vectors are only comparable within one profile. */
export interface ModelProfile {
  id: string;
  repository?: string;
  revision?: string;
  /** Validated client clipping cap, including the prompt. */
  contextTokens?: number;
  dims: number;
  quant: string;
  pooling: "mean" | "cls" | "last" | "provider";
  /** `${t}` stands for the document text. */
  docTemplate: string;
  /** `${q}` stands for the query. */
  queryTemplate: string;
  /** What the model accepts per input, in tokens (the server's context window may be smaller; see CONTEXT_TOKENS). */
  maxInputTokens: number;
}

export const OMLX_MODEL = "mlx-community/embeddinggemma-2-6bit";
export const MODEL_PROFILES: Record<string, ModelProfile> = {
  [OMLX_MODEL]: {
    id: OMLX_MODEL,
    repository: OMLX_MODEL,
    revision: "a61f0b6dcee35cf68475e91b8b28ed830057d7c4",
    quant: "affine-6bit-g64-bf16",
    dims: 768,
    pooling: "mean",
    docTemplate: "title: none | text: ${t}",
    queryTemplate: "task: search result | query: ${q}",
    // Conservative client cap, not the architecture's max_position_embeddings.
    maxInputTokens: 2048,
    contextTokens: 2048,
  },
};

/** Custom profiles must explicitly identify their vector semantics. */
export function validateProfile(value: unknown): ModelProfile {
  if (!value || typeof value !== "object") throw new Error("Invalid embedding profile");
  const p = value as ModelProfile;
  for (const k of ["id", "repository", "revision", "quant"] as const)
    if (typeof p[k] !== "string" || !p[k]!.trim() || /[\r\n\0]/.test(p[k]!))
      throw new Error(`Embedding profile requires ${k}`);
  if (
    !Number.isInteger(p.dims) ||
    p.dims < 1 ||
    p.dims > 65536 ||
    !Number.isInteger(p.maxInputTokens) ||
    p.maxInputTokens < 1 ||
    !Number.isInteger(p.contextTokens) ||
    p.contextTokens! < 1 ||
    p.contextTokens! > p.maxInputTokens ||
    !["mean", "cls", "last", "provider"].includes(p.pooling) ||
    typeof p.docTemplate !== "string" ||
    p.docTemplate.split("${t}").length !== 2 ||
    typeof p.queryTemplate !== "string" ||
    p.queryTemplate.split("${q}").length !== 2
  )
    throw new Error("Invalid embedding profile dimensions, context, pooling or templates");
  return {
    id: p.id,
    repository: p.repository!,
    revision: p.revision!,
    quant: p.quant,
    dims: p.dims,
    pooling: p.pooling,
    docTemplate: p.docTemplate,
    queryTemplate: p.queryTemplate,
    maxInputTokens: p.maxInputTokens,
    contextTokens: p.contextTokens!,
  };
}

export function embeddingBase(raw: string): string {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Error("Embedding URL must be HTTP(S), without credentials, query or fragment");
  return u.href.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Legacy identity default; current provider profiles declare their own context limit. */
export const CONTEXT_TOKENS = 900;
export const EMBED_TIMEOUT_MS = 30_000;

export interface EmbedderConfig {
  url: string;
  model: string;
  provider?: "omlx" | "openai";
  apiModel?: string;
  profile?: ModelProfile;
  /** Actual upstream locality when the transport uses a gateway. */
  remote?: boolean;
  /** A file holding the bearer key of a remote endpoint (read by the host; never logged). */
  keyFile?: string;
}

/** What makes two vectors comparable: when any of it differs, they live in different vector sets. */
export interface EmbedderIdentity {
  model: string;
  endpoint: string;
  quant: string;
  dims: number;
  pooling: string;
  docTemplate: string;
  queryTemplate: string;
  build: string;
  repository?: string;
  revision?: string;
  contextTokens?: number;
}
export const semanticKey = (i: EmbedderIdentity): string =>
  JSON.stringify([
    i.model,
    i.repository ?? null,
    i.revision ?? null,
    i.quant,
    i.dims,
    i.pooling,
    i.docTemplate,
    i.queryTemplate,
    i.contextTokens ?? CONTEXT_TOKENS,
  ]);
export const identityKey = semanticKey;

/**
 * - network: no answer (down, refused, timed out)
 * - server: it answered with an error that may pass (5xx, 429) or with something that is not embeddings
 * - client: it refused this input (other 4xx); another input may work
 */
export class EmbedderError extends Error {
  readonly kind: "network" | "server" | "client";
  readonly status: number | undefined;
  constructor(kind: "network" | "server" | "client", message: string, status?: number) {
    super(message);
    this.name = "EmbedderError";
    this.kind = kind;
    this.status = status;
  }
}

/** Whether the endpoint is somewhere other than this box: not a compose service name, loopback or a private address. */
export function isRemoteUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
    return false;
  // A name without dots is a service on the compose network.
  if (!host.includes(".") && !host.includes(":")) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (host.includes(":"))
    return !(host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80"));
  return true;
}

export interface EmbedderDeps {
  fetch?: typeof fetch;
  /** The bearer key, when the endpoint needs one. Called for each request, so a rotated key is picked up. */
  readKey?: () => Promise<string | undefined>;
  timeoutMs?: number;
}

export function l2normalise(vector: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vector.length);
  let scale = 0;
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i]!;
    if (!Number.isFinite(x)) throw new EmbedderError("server", "The embedder returned a nonfinite vector.");
    scale = Math.max(scale, Math.abs(x));
  }
  if (!(scale > 0)) throw new EmbedderError("server", "The embedder returned a vector of no length.");
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += (vector[i]! / scale) ** 2;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < out.length; i++) out[i] = vector[i]! / scale / norm;
  return out;
}

/** Float32 little-endian bytes (the BLOB the index stores). */
export function vectorToBlob(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i]!, true);
  return out;
}
export function blobToVector(blob: Uint8Array): Float32Array {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(blob.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** The text cut to what the server's context window takes; a cut falls at a space when one is near. */
export function clipToContext(text: string, maxTokens = CONTEXT_TOKENS): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let end = Math.max(1, Math.floor(text.length * (maxTokens / estimateTokens(text))));
  while (end > 1 && estimateTokens(text.slice(0, end)) > maxTokens) end = Math.floor(end * 0.9);
  const space = text.lastIndexOf(" ", end);
  return text.slice(0, space > end * 0.8 ? space : end);
}

export class Embedder {
  readonly profile: ModelProfile;
  readonly provider: "omlx" | "openai";
  readonly apiModel: string;
  readonly endpoint: string;
  readonly remote: boolean;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #readKey: (() => Promise<string | undefined>) | undefined;
  readonly #timeoutMs: number;

  constructor(config: EmbedderConfig, deps: EmbedderDeps = {}) {
    const profile = config.profile ? validateProfile(config.profile) : MODEL_PROFILES[config.model];
    if (!profile)
      throw new Error(`Unknown embedder model "${config.model}". Known: ${Object.keys(MODEL_PROFILES).join(", ")}.`);
    this.provider = config.provider ?? "openai";
    this.apiModel = config.apiModel ?? profile.id;
    if (!this.apiModel.trim() || /[\r\n\0]/.test(this.apiModel))
      throw new Error("An explicit embedding API model is required");
    this.profile = { ...profile };
    this.#base = embeddingBase(config.url);
    this.endpoint = new URL(this.#base).origin;
    this.remote = config.remote ?? isRemoteUrl(this.#base);
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#readKey = deps.readKey;
    this.#timeoutMs = deps.timeoutMs ?? EMBED_TIMEOUT_MS;
  }

  async #request(path: string, init: { method: string; body?: string }): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const key = (await this.#readKey?.())?.trim();
    if (key && /[\r\n]/.test(key)) throw new EmbedderError("client", "Invalid embedding credential");
    if (key) headers.authorization = `Bearer ${key}`;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new EmbedderError(
        "network",
        timedOut ? "The embedder did not answer in time." : "The embedder cannot be reached.",
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const kind = res.status >= 500 || res.status === 429 || res.status === 408 ? "server" : "client";
      throw new EmbedderError(kind, `The embedder answered ${res.status}.`, res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new EmbedderError("server", "The embedder's answer was not JSON.");
    }
  }

  async #embed(inputs: string[]): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    const json = (await this.#request("/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({
        model: this.apiModel,
        input: inputs.map((t) => clipToContext(t, this.profile.contextTokens ?? CONTEXT_TOKENS)),
        encoding_format: "float",
      }),
    })) as { model?: unknown; data?: { index?: number; embedding?: unknown }[] };
    if (json?.model !== undefined && json.model !== this.apiModel)
      throw new EmbedderError("server", "The embedder returned another API model.");
    const data = json?.data;
    if (!Array.isArray(data) || data.length !== inputs.length)
      throw new EmbedderError("server", "The embedder returned the wrong number of vectors.");
    const indexes = new Set<number>();
    for (const d of data) {
      if (!d || !Number.isInteger(d.index) || d.index! < 0 || d.index! >= inputs.length || indexes.has(d.index!))
        throw new EmbedderError("server", "The embedder returned invalid or duplicate indexes.");
      indexes.add(d.index!);
    }
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d) => {
      const e = d.embedding;
      if (
        !Array.isArray(e) ||
        e.length !== this.profile.dims ||
        !e.every((x) => typeof x === "number" && Number.isFinite(x))
      ) {
        throw new EmbedderError("server", `The embedder returned a vector that is not ${this.profile.dims} numbers.`);
      }
      return l2normalise(e as number[]);
    });
  }

  /** Embeds documents (the profile's document prompt is applied). */
  embedDocuments(texts: string[], profile: Pick<ModelProfile, "docTemplate"> = this.profile): Promise<Float32Array[]> {
    return this.#embed(texts.map((t) => profile.docTemplate.replace("${t}", () => t)));
  }

  /** Embeds a query with a query prompt (the stored one of a vector set, or the profile's). */
  async embedQuery(text: string, template: string = this.profile.queryTemplate): Promise<Float32Array> {
    return (await this.#embed([template.replace("${q}", () => text)]))[0]!;
  }

  /** Verify actual inference; model discovery is optional in compatible APIs. */
  async probe(): Promise<{ build: string; quant: string }> {
    await this.embedQuery("embedding health check");
    return { build: this.provider, quant: this.profile.quant };
  }

  compatible(identity: EmbedderIdentity): boolean {
    return semanticKey(identity) === semanticKey(this.identity({ build: "", quant: this.profile.quant }));
  }

  identity(probed: { build: string; quant: string }): EmbedderIdentity {
    const p = this.profile;
    return {
      model: p.id,
      endpoint: this.endpoint,
      quant: probed.quant,
      dims: p.dims,
      pooling: p.pooling,
      docTemplate: p.docTemplate,
      queryTemplate: p.queryTemplate,
      build: probed.build,
      ...(p.revision
        ? { repository: p.repository!, revision: p.revision, contextTokens: p.contextTokens ?? CONTEXT_TOKENS }
        : {}),
    };
  }
}
