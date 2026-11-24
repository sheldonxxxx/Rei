import { type ImageReference, type ImageWorker, ImageWorkerError } from "../images/worker.ts";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export class CodexImages implements ImageWorker {
  readonly #url: URL;
  readonly #token: () => Promise<string | undefined>;
  readonly #fetch: typeof fetch;

  constructor(gatewayUrl: string, token: () => Promise<string | undefined>, fetcher: typeof fetch = fetch) {
    this.#url = new URL("/codex-images", gatewayUrl);
    this.#token = token;
    this.#fetch = fetcher;
  }

  async generate(prompt: string, references: ImageReference[], abort?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const timeout = AbortSignal.timeout(330_000);
    const token = await this.#token();
    if (!token) throw new Error("Rei's gateway credential is unavailable.");
    const res = await this.#fetch(this.#url, {
      method: "POST",
      signal: abort ? AbortSignal.any([abort, timeout]) : timeout,
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        references: references.map(({ type, bytes }) => ({
          type,
          base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
        })),
      }),
    });
    if (!res.ok) {
      const result = await res.json().catch(() => undefined);
      const code = result?.error?.code;
      throw new ImageWorkerError(
        result?.error?.message ?? `Codex Images failed (HTTP ${res.status}).`,
        code === "codex_sign_in_required"
          ? "sign_in_required"
          : code === "codex_images_busy"
            ? "busy"
            : res.status === 429
              ? "rate_limited"
              : "error",
      );
    }
    let length = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.body ?? []) {
      length += chunk.length;
      if (length > MAX_IMAGE_BYTES) throw new Error("The gateway returned too much image data.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
