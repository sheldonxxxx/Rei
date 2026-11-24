import { AVATAR_IMAGE_MAX_CHARS } from "@rei/protocol";

/** Side of the stored picture, in pixels. */
export const AVATAR_SIZE = 128;

const QUALITIES = [0.9, 0.78, 0.66, 0.54, 0.42, 0.3];

/** `image/*` data URL of `canvas` at the best quality that fits `max` characters, webp first and jpeg where webp isn't encoded. */
export function encodeUnderLimit(canvas: HTMLCanvasElement, max = AVATAR_IMAGE_MAX_CHARS): string | null {
  for (const type of ["image/webp", "image/jpeg"]) {
    let source = canvas;
    if (type === "image/jpeg") {
      // jpeg has no transparency: put the picture on white rather than black
      const flat = document.createElement("canvas");
      flat.width = canvas.width;
      flat.height = canvas.height;
      const ctx = flat.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, flat.width, flat.height);
        ctx.drawImage(canvas, 0, 0);
        source = flat;
      }
    }
    for (const q of QUALITIES) {
      const url = source.toDataURL(type, q);
      if (!url.startsWith(`data:${type}`)) break; // this browser can't encode the type (it answered with png)
      if (url.length <= max) return url;
    }
  }
  return null;
}

async function decode(
  file: Blob,
): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // some browsers can't make a bitmap of every type (an SVG): try an <img>
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("decode"));
    img.src = url;
  }).catch((e) => {
    URL.revokeObjectURL(url);
    throw e;
  });
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

/**
 * A picture the user chose, cut to its centre square, scaled to 128 px and encoded small enough for an agent's avatar.
 * Rejects when the file isn't an image the browser can read.
 */
export async function resizeAvatar(file: Blob, max = AVATAR_IMAGE_MAX_CHARS): Promise<string> {
  const { source, width, height, release } = await decode(file);
  try {
    const side = Math.min(width, height);
    if (!(side > 0)) throw new Error("empty");
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    const url = encodeUnderLimit(canvas, max);
    if (!url) throw new Error("too big");
    return url;
  } finally {
    release();
  }
}
