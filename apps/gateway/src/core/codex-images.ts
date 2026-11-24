import { HttpError, readJsonObject } from "./http.ts";

const MAX_REFERENCES = 5;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_REQUEST_BYTES = Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 64 * 1024;

export type RenderCodexImage = (
  prompt: string,
  images: string[],
  signal: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

export async function renderCodexImage(request: Request, render: RenderCodexImage): Promise<Response> {
  const { prompt, references } = await readJsonObject(request, MAX_IMAGE_REQUEST_BYTES);
  if (
    typeof prompt !== "string" ||
    !prompt.trim() ||
    prompt.length > 4000 ||
    !Array.isArray(references) ||
    references.length > MAX_REFERENCES
  )
    throw new HttpError(400, "bad_image_request", "Provide an image prompt and up to five reference images.");
  let total = 0;
  const images = references.map((reference: unknown) => {
    const entry = reference as { type?: unknown; base64?: unknown } | null;
    if (
      !entry ||
      typeof entry.type !== "string" ||
      !/^image\/(png|jpeg|webp|gif)$/.test(entry.type) ||
      typeof entry.base64 !== "string" ||
      !entry.base64 ||
      entry.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.base64)
    )
      throw new HttpError(400, "bad_image_request", "Provide PNG, JPEG, WebP or GIF reference images.");
    total += entry.base64.length * 0.75 - (entry.base64.endsWith("==") ? 2 : entry.base64.endsWith("=") ? 1 : 0);
    if (total > MAX_REFERENCE_BYTES)
      throw new HttpError(400, "bad_image_request", "Reference images can total at most 20 MiB.");
    return `data:${entry.type};base64,${entry.base64}`;
  });
  return new Response(await render(prompt.trim(), images, request.signal), {
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
  });
}
