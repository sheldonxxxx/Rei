import { expect, it } from "vitest";
import { imageFileName } from "../src/images/tools.ts";
import { readConfig } from "../src/node/config.ts";
import { approve, askApproval, pending, setProfile, tool } from "./helpers/approvals.ts";
import { STANDIN, startSignedIn } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

const name = "image_generate";
const base = { REI_MODEL_MODE: "faux" };

it("uses the image route whenever a gateway is configured", () => {
  expect(readConfig(base).codexImageGateway).toBeUndefined();
  expect(readConfig({ ...base, GATEWAY_URL: "http://gateway:8780" }).codexImageGateway).toBe("http://gateway:8780");
});

it("names a saved image from its given name, else the prompt's first words", () => {
  expect(imageFileName("Hong Kong Night!", "ignored", "png")).toBe("hong-kong-night.png");
  expect(imageFileName(undefined, "A night view of Victoria Harbour, neon on the water", "jpg")).toBe(
    "a-night-view-of-victoria-harbour.jpg",
  );
  expect(imageFileName("香港夜景", "", "png")).toBe("香港夜景.png");
  expect(imageFileName("  ", "!!!", "webp")).toBe("codex-image.webp");
  expect(imageFileName("../../etc/passwd", "", "png")).toBe("etc-passwd.png");
});

it("publishes generations and edits automatically in Standard and asks in Strict", async () => {
  const off = await startSignedIn();
  try {
    const id = await chat(off);
    await say(off, id, "Hello");
    await settled(off, id);
    expect(off.host.plane.catalog.get(name)).toBeUndefined();
  } finally {
    await off.destroy();
  }

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+WZs8AAAAASUVORK5CYII=",
    "base64",
  );
  const calls: { path: string | undefined; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    expect(req.headers.get("authorization")).toBe(`Bearer ${STANDIN}`);
    calls.push({ path: new URL(req.url).pathname, body: await req.json() });
    return new Response(png);
  };
  const s = await startSignedIn({ codexImageGateway: "http://gateway", fetchImpl });
  try {
    const id = await chat(s);
    await say(s, id, tool(name, { prompt: "Draw a red circle" }));
    const generated = await settled(s, id);
    expect(generated.session.profile).toBe("standard");
    const source = generated.messages.find((m) => m.role === "assistant" && m.attachments?.length)?.attachments?.[0];
    expect(source).toMatchObject({ name: "draw-a-red-circle.png", mediaType: "image/png" });
    expect(source?.fileId).toBeTruthy();
    const editId = await chat(s);
    await say(
      s,
      editId,
      tool(name, {
        prompt: "Change the circle to blue",
        references: [{ type: "library", fileId: source?.fileId, versionId: source?.versionId }],
      }),
    );
    const done = await settled(s, editId);
    expect(done.messages.some((m) => m.role === "assistant" && m.attachments?.length === 1)).toBe(true);
    expect(await pending(s)).toEqual([]);
    expect(calls).toEqual([
      { path: "/codex-images", body: { prompt: "Draw a red circle", references: [] } },
      {
        path: "/codex-images",
        body: {
          prompt: "Change the circle to blue",
          references: [{ type: "image/png", base64: png.toString("base64") }],
        },
      },
    ]);
    const strictId = await chat(s);
    await setProfile(s, strictId, "strict");
    const approval = await askApproval(s, strictId, tool(name, { prompt: "Draw a green circle" }));
    expect(approval[0]).toMatchObject({ tool: name, destination: "chatgpt.com" });
    expect(calls).toHaveLength(2);
    await approve(s, strictId, { length: "once" });
    expect((await detail(s, strictId)).messages.some((m) => m.role === "assistant" && m.attachments?.length)).toBe(
      true,
    );
  } finally {
    await s.destroy();
  }
});

it("counts image requests in Usage, with failures by reason, and never stores prompts", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+WZs8AAAAASUVORK5CYII=",
    "base64",
  );
  let limited = false;
  const fetchImpl: typeof fetch = async () =>
    limited
      ? Response.json(
          { error: { code: "codex_image_failed", message: "Codex image request failed (HTTP 429)." } },
          { status: 429 },
        )
      : new Response(png);
  const s = await startSignedIn({ codexImageGateway: "http://gateway", fetchImpl });
  try {
    const id = await chat(s);
    await say(s, id, tool(name, { prompt: "Draw a secret-prompt circle" }));
    await settled(s, id);
    limited = true;
    const failedId = await chat(s);
    await say(s, failedId, tool(name, { prompt: "Draw another circle" }));
    await settled(s, failedId);
    const { body } = await s.client.get("/api/usage?period=30d");
    expect(body.images).toMatchObject({
      requests: 2,
      succeeded: 1,
      failed: 1,
      generated: 2,
      edited: 0,
      failures: [{ reason: "rate_limited", calls: 1 }],
    });
    expect(JSON.stringify(body)).not.toContain("secret-prompt");
  } finally {
    await s.destroy();
  }
});
