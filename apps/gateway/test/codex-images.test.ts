import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createRedactor } from "../src/core/redact.ts";
import { CODEX_IMAGES, codexAccess } from "../src/node/codex-auth.ts";
import { codexImages } from "../src/node/codex-images.ts";
import { FileCredentialStore } from "../src/node/credstore.ts";

it("rotates an expiring credential once across file-store instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rei-img-auth-"));
  try {
    const path = join(dir, "images.json");
    const store = new FileCredentialStore(path);
    await store.modify(CODEX_IMAGES, async () => ({
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() + 60_000,
    }));
    const exchange = vi.fn(async (_url, init) => {
      expect(String(_url)).toBe("https://auth.openai.com/oauth/token");
      expect(init.body.get("refresh_token")).toBe("old-refresh");
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    });
    const redactor = createRedactor();
    const a = codexAccess(store, redactor, exchange as unknown as typeof fetch);
    const b = codexAccess(new FileCredentialStore(path), redactor, exchange as unknown as typeof fetch);
    expect(await Promise.all([a(), b()])).toEqual(["new-access", "new-access"]);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(await store.read(CODEX_IMAGES)).toMatchObject({ refresh: "new-refresh" });
    expect(redactor.redact("new-refresh")).not.toContain("new-refresh");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("sends generation and edits directly to the fixed Codex endpoints", async () => {
  const upstream = vi.fn(async (_url, _request) => Response.json({ data: [{ b64_json: "AQID" }] }));
  const render = codexImages(async () => "fixture-token", upstream as unknown as typeof fetch);
  const signal = new AbortController().signal;
  await expect(render("draw", [], signal)).resolves.toEqual(Buffer.from([1, 2, 3]));
  await expect(render("recolor", ["data:image/png;base64,AQID"], signal)).resolves.toEqual(Buffer.from([1, 2, 3]));
  expect(upstream.mock.calls.map(([url]) => url)).toEqual([
    "https://chatgpt.com/backend-api/codex/images/generations",
    "https://chatgpt.com/backend-api/codex/images/edits",
  ]);
  expect(JSON.parse(upstream.mock.calls[1]![1].body)).toMatchObject({
    images: [{ image_url: "data:image/png;base64,AQID" }],
  });
});
