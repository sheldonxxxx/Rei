import { buffer } from "node:stream/consumers";
import type { RenderCodexImage } from "../core/codex-images.ts";
import { HttpError } from "../core/http.ts";
import { codexClaims } from "./codex-auth.ts";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;

export function codexImages(access: () => Promise<string>, fetcher: typeof fetch = fetch): RenderCodexImage {
  let busy = false;
  return async (prompt, images, signal) => {
    if (busy) throw new HttpError(429, "codex_images_busy", "Codex Images is working on another image.");
    busy = true;
    try {
      const token = await access();
      const account = codexClaims(token)["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
      const headers = new Headers({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codex-image-turn-id": crypto.randomUUID(),
        originator: "rei",
        "user-agent": "Rei Codex Images",
      });
      if (typeof account?.chatgpt_account_id === "string")
        headers.set("ChatGPT-Account-ID", account.chatgpt_account_id);
      const residency = account?.chatgpt_data_residency ?? account?.chatgpt_compute_residency;
      if (typeof residency === "string") headers.set("x-openai-internal-codex-residency", residency);
      const route = images.length ? "edits" : "generations";
      const response = await fetcher(`https://chatgpt.com/backend-api/codex/images/${route}`, {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        body: JSON.stringify({
          prompt,
          model: "gpt-image-2",
          n: 1,
          size: "1024x1024",
          quality: "auto",
          background: "opaque",
          ...(images.length ? { images: images.map((image_url) => ({ image_url })) } : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(
          response.status === 429 ? 429 : 502,
          "codex_image_failed",
          `Codex image request failed (HTTP ${response.status}).`,
        );
      }
      let length = 0;
      const stream = response.body?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            length += chunk.length;
            if (length > MAX_RESPONSE_BYTES)
              throw new HttpError(502, "codex_image_size", "Codex returned too much data.");
            controller.enqueue(chunk);
          },
        }),
      );
      const encoded = stream && JSON.parse((await buffer(stream)).toString("utf8"))?.data?.[0]?.b64_json;
      if (typeof encoded !== "string")
        throw new HttpError(502, "codex_image_missing", "Codex did not return an image.");
      const image = Buffer.from(encoded, "base64");
      if (!image.length || image.length > MAX_IMAGE_BYTES)
        throw new HttpError(502, "codex_image_size", "Codex returned an invalid image size.");
      return image;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "codex_image_failed", "The Codex image request could not be completed.");
    } finally {
      busy = false;
    }
  };
}
