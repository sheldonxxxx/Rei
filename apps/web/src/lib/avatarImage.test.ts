import { AVATAR_IMAGE_MAX_CHARS } from "@rei/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AVATAR_SIZE, encodeUnderLimit, resizeAvatar } from "./avatarImage.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A canvas whose encoder answers by type and quality. */
function stubCanvas(encode: (type: string, quality: number) => string) {
  const drawImage = vi.fn();
  const ctx = { drawImage, fillRect: vi.fn(), fillStyle: "" };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(((type: string, q: number) =>
    encode(type, q)) as never);
  return drawImage;
}

const url = (type: string, chars: number) =>
  `data:${type};base64,${"A".repeat(Math.max(0, chars - `data:${type};base64,`.length))}`;

describe("encodeUnderLimit", () => {
  it("lowers the quality until the picture fits", () => {
    stubCanvas((type, q) => url(type, q > 0.7 ? AVATAR_IMAGE_MAX_CHARS + 500 : 20_000));
    const out = encodeUnderLimit(document.createElement("canvas"));
    expect(out?.startsWith("data:image/webp")).toBe(true);
    expect(out!.length).toBeLessThanOrEqual(AVATAR_IMAGE_MAX_CHARS);
  });

  it("falls back to jpeg where the browser cannot encode webp", () => {
    stubCanvas((type) => (type === "image/webp" ? url("image/png", 90_000) : url(type, 12_000)));
    const out = encodeUnderLimit(document.createElement("canvas"));
    expect(out?.startsWith("data:image/jpeg")).toBe(true);
  });

  it("gives up (null) when nothing fits", () => {
    stubCanvas((type) => url(type, AVATAR_IMAGE_MAX_CHARS + 1));
    expect(encodeUnderLimit(document.createElement("canvas"))).toBeNull();
  });
});

describe("resizeAvatar", () => {
  it("cuts the centre square of a wide picture, scales it to 128 px and keeps it under the limit", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 400, height: 200, close }));
    const drawImage = stubCanvas((type, q) => url(type, q > 0.6 ? 90_000 : 30_000));
    const out = await resizeAvatar(new Blob(["x"], { type: "image/png" }));
    expect(out.length).toBeLessThanOrEqual(AVATAR_IMAGE_MAX_CHARS);
    expect(out.startsWith("data:image/webp")).toBe(true);
    // 400x200: a 200 px square starting at x = 100
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 100, 0, 200, 200, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    expect(close).toHaveBeenCalled();
  });

  it("rejects a file the browser cannot read", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("nope")));
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = () => "blob:x";
        static revokeObjectURL = () => {};
      },
    );
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", BrokenImage);
    await expect(resizeAvatar(new Blob(["x"]))).rejects.toThrow();
  });
});
