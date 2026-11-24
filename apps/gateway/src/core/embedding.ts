// A dedicated fixed-destination inference route. No admin routes, forwarding headers or arbitrary upstreams.
export interface EmbeddingRoute {
  baseUrl: string;
  apiModel: string;
  /** The inference key for this route, when one is saved. Keys are never read from files. */
  key?: () => Promise<string>;
}
export function embeddingTarget(raw: string): string {
  const u = new URL(raw);
  // The operator configures this origin, so plain HTTP is allowed; it carries the inference key and the
  // text being indexed unencrypted, which setup says out loud before it saves such an endpoint.
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("Embedding upstream must be an http(s) origin");
  if (u.username || u.password || u.search || u.hash || !["", "/", "/v1", "/v1/"].includes(u.pathname))
    throw new Error("Embedding upstream must be an origin, optionally ending in /v1");
  return u.origin;
}
const failure = (status: number) =>
  Response.json({ error: { message: "Embedding provider request failed", status } }, { status });
/** Why an upstream call failed, for the gateway log: never the key, the request text or the response body. */
export interface EmbeddingFailure {
  stage: "upstream_status" | "upstream_error" | "bad_response";
  status?: number;
  errorClass?: string;
}
export function embeddingHandler(
  config: EmbeddingRoute,
  fetchFn: typeof fetch,
  onFailure?: (failure: EmbeddingFailure) => void,
  /** The prompt tokens the provider reported for an embedding call, for the call record. */
  onUsage?: (promptTokens: number) => void,
) {
  const base = embeddingTarget(config.baseUrl);
  if (!config.apiModel.trim()) throw new Error("Embedding API model is required");
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const models = path === "/embedding/v1/models" && req.method === "GET";
    if (!models && !(path === "/embedding/v1/embeddings" && req.method === "POST")) return failure(404);
    if (new URL(req.url).search) return failure(400);
    let body: string | undefined;
    if (!models) {
      // Bound reads even for chunked requests.
      const reader = req.body?.getReader();
      if (!reader) return failure(400);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1024 * 1024) {
          await reader.cancel();
          return failure(413);
        }
        chunks.push(next.value);
      }
      try {
        const raw = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          raw.set(chunk, offset);
          offset += chunk.length;
        }
        const j = JSON.parse(new TextDecoder().decode(raw));
        if (
          j.model !== config.apiModel ||
          j.encoding_format !== "float" ||
          !Array.isArray(j.input) ||
          j.input.length < 1 ||
          j.input.length > 64 ||
          !j.input.every((x: unknown) => typeof x === "string")
        )
          return failure(400);
        body = JSON.stringify({ model: config.apiModel, input: j.input, encoding_format: "float" });
      } catch {
        return failure(400);
      }
    }
    try {
      const key = ((await config.key?.()) ?? "").trim();
      if (/[\r\n]/.test(key)) return failure(503);
      const up = await fetchFn(base + (models ? "/v1/models" : "/v1/embeddings"), {
        method: models ? "GET" : "POST",
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
        ...(body ? { body } : {}),
        redirect: "error",
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(30000)]),
      });
      if (!up.ok) {
        await up.body?.cancel();
        onFailure?.({ stage: "upstream_status", status: up.status });
        return failure(up.status >= 400 ? up.status : 502);
      }
      const j = (await up.json()) as { model?: unknown; data?: unknown; usage?: { prompt_tokens?: unknown } };
      if (!Array.isArray(j.data)) {
        onFailure?.({ stage: "bad_response", status: up.status });
        return failure(502);
      }
      const promptTokens = j.usage?.prompt_tokens;
      if (!models && typeof promptTokens === "number" && Number.isFinite(promptTokens) && promptTokens >= 0)
        onUsage?.(Math.round(promptTokens));
      // Return only inference fields; never forward headers, cookies, errors or arbitrary provider metadata.
      return models
        ? Response.json({ data: j.data.filter((m) => m?.id === config.apiModel).map((m) => ({ id: m.id })) })
        : Response.json({
            ...(j.model === undefined ? {} : { model: j.model }),
            data: j.data.map((d) => ({ index: d?.index, embedding: d?.embedding })),
          });
    } catch (error) {
      // The error name only: messages from fetch or JSON parsing can echo request or response text.
      onFailure?.({ stage: "upstream_error", errorClass: error instanceof Error ? error.name : "unknown" });
      return failure(502);
    }
  };
}
