import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { type BrowserServer, el, SCREENSHOT_JPEG, startBrowserServer } from "./helpers/browser.ts";
import { FakeMcpGateway, tool } from "./helpers/fake-mcp.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

/** A grey PNG `width` by `height`: the pixels are all alike, so it is small however large it is. */
function greyPng(width: number, height: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc(body));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header[8] = 8;
  const rows = new Uint8Array((width + 1) * height).fill(128);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunks = [chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())];
  return Buffer.from([...signature, ...chunks.flatMap((each) => [...each])]).toString("base64");
}

/** A PNG's width and height, from its header. */
function pngSize(data: string): string {
  const bytes = Buffer.from(data, "base64");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

interface Block {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** The content of the tool results in the newest model call of a session, as the model received it. */
function received(s: TestServer, sessionId: string): Block[] {
  const rows = s.host.plane.store.db.all<{ payload_blob: string | null }>(
    "SELECT payload_blob FROM steps WHERE session_id = ? AND type = 'llm.call' AND payload_blob IS NOT NULL ORDER BY started_at DESC, id DESC",
    sessionId,
  );
  for (const r of rows) {
    const hex = r.payload_blob!.slice("sha256:".length);
    const path = join(s.dir, "blobs", hex.slice(0, 2), hex);
    if (!existsSync(path)) continue;
    const payload = JSON.parse(readFileSync(path, "utf8")) as { messages: { role: string; content: unknown }[] };
    return payload.messages
      .filter((m) => m.role === "toolResult" && Array.isArray(m.content))
      .flatMap((m) => m.content as Block[]);
  }
  return [];
}

const images = (blocks: Block[]) => blocks.filter((b) => b.type === "image");
const text = (blocks: Block[]) => blocks.map((b) => b.text ?? "").join("");

/** A connector whose one tool answers with `media`. */
async function connectorServer(media: { type: "image"; mimeType: string; data: string }[]) {
  const gw = new FakeMcpGateway();
  gw.add("con_shots", "Shots", [tool("capture", "Capture the screen.", { readOnlyHint: true })]);
  gw.callReply = () => ({ json: { isError: false, text: "captured", structured: null, truncated: false, media } });
  server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
  await server.host.plane.mcp.setOverride("con_shots", "capture", "read_external");
  const c = (await server.host.plane.mcp.list()).find((x) => x.id === "con_shots")!;
  await server.host.plane.mcp.setProfile("con_shots", "read_only", c.providerIdentity!, c.mcpProfileRevision!, false);
  return server;
}

describe("images a tool returns are fitted to the model's limits", () => {
  it("resizes an MCP image that is over the width the model takes, and says so", async () => {
    const s = await connectorServer([{ type: "image", mimeType: "image/png", data: greyPng(3000, 1000) }]);
    const id = await chat(s);
    await callTool(s, id, "shots__capture", {});
    const got = received(s, id);
    const [image] = images(got);
    expect(images(got)).toHaveLength(1);
    expect(image!.mimeType).toBe("image/png");
    expect(pngSize(image!.data!)).toBe("2000x667");
  });

  it("leaves an MCP image within the limits as it was", async () => {
    const data = greyPng(800, 600);
    const s = await connectorServer([{ type: "image", mimeType: "image/png", data }]);
    const id = await chat(s);
    await callTool(s, id, "shots__capture", {});
    const [image] = images(received(s, id));
    expect(image!.data).toBe(data);
  });

  it("replaces an image that cannot be prepared with a note", async () => {
    const s = await connectorServer([
      { type: "image", mimeType: "image/png", data: Buffer.from("not an image at all").toString("base64") },
    ]);
    const id = await chat(s);
    await callTool(s, id, "shots__capture", {});
    const got = received(s, id);
    expect(images(got)).toHaveLength(0);
    expect(text(got)).toContain("captured");
    expect(text(got).toLowerCase()).toContain("image");
    expect(text(got)).not.toContain("bm90IGFuIGltYWdl");
  });

  it("passes a browser screenshot through unchanged", async () => {
    const b: BrowserServer = await startBrowserServer();
    server = b;
    b.fake.page("https://shop.example/cart", {
      title: "Cart",
      snapshot: '- button "Pay" [ref=e1]',
      elements: { e1: el("button", "Pay") },
    });
    const id = await chat(b);
    await callTool(b, id, "browser_open", { url: "https://shop.example/cart" });
    await callTool(b, id, "browser_screenshot", {});
    const [image] = images(received(b, id));
    expect(image).toMatchObject({ mimeType: "image/jpeg", data: SCREENSHOT_JPEG });
  });
});
