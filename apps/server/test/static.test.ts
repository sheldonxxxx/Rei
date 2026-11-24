import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers/server.ts";

let web: string;
let server: TestServer | undefined;
beforeEach(() => {
  web = mkdtempSync(join(tmpdir(), "rei-web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Rei</title><div id=app></div>");
  writeFileSync(join(web, "assets", "index-abc123.js"), "console.log('app')");
  writeFileSync(join(web, "assets", "index-abc123.css"), "body{}");
  writeFileSync(join(web, "manifest.webmanifest"), JSON.stringify({ name: "Rei" }));
  writeFileSync(join(web, "sw.js"), "self.addEventListener('fetch',()=>{})");
});
afterEach(async () => {
  await server?.destroy();
  server = undefined;
  rmSync(web, { recursive: true, force: true });
});

const get = (path: string, method = "GET") => server!.host.plane.app.request(path, { method });

describe("the PWA", () => {
  it("serves index.html at / and for app routes, revalidated every time", async () => {
    server = await startTestServer({ webDist: web });
    for (const path of ["/", "/chat/ses_123", "/settings/deep/link"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<div id=app>");
    }
  });

  it("serves hashed assets as immutable with the right types", async () => {
    server = await startTestServer({ webDist: web });
    const js = await get("/assets/index-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get("/assets/index-abc123.css")).headers.get("content-type")).toMatch(/text\/css/);
  });

  it("serves the manifest and the service worker without long caching", async () => {
    server = await startTestServer({ webDist: web });
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toMatch(/manifest\+json|application\/json/);
    expect(manifest.headers.get("cache-control")).toBe("no-cache");
    const sw = await get("/sw.js");
    expect(sw.headers.get("content-type")).toMatch(/javascript/);
    expect(sw.headers.get("cache-control")).toBe("no-cache");
  });

  it("404s a missing file with an extension, never falls back for it, and keeps /api JSON", async () => {
    server = await startTestServer({ webDist: web });
    expect((await get("/assets/missing.js")).status).toBe(404);
    expect((await get("/favicon.ico")).status).toBe(404);
    await server.createAccount();
    const api = await server.client.get("/api/nope");
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe("not_found");
  });

  it("cannot be tricked into reading outside the folder", async () => {
    server = await startTestServer({ webDist: web });
    writeFileSync(join(web, "..", "rei-secret.txt"), "top secret");
    try {
      for (const path of [
        "/../rei-secret.txt",
        "/%2e%2e/rei-secret.txt",
        "/assets/..%2f..%2frei-secret.txt",
        "/..%5crei-secret.txt",
      ]) {
        const res = await get(path);
        expect(await res.text(), path).not.toContain("top secret");
      }
    } finally {
      rmSync(join(web, "..", "rei-secret.txt"), { force: true });
    }
  });

  it("answers HEAD without a body, and explains itself when no web app is built in", async () => {
    server = await startTestServer({ webDist: web });
    const head = await get("/", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    await server.destroy();
    server = await startTestServer({ webDist: join(web, "does-not-exist") });
    const none = await get("/");
    expect(none.status).toBe(404);
    expect(await none.text()).toContain("has not been built");
  });

  it("sends the same Content-Security-Policy and hardening headers with the page, assets, 404s and the API", async () => {
    server = await startTestServer({ webDist: web });
    const csp = (await get("/")).headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*'(?:unsafe-inline|unsafe-eval)'/);
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("frame-src 'self' blob:");
    for (const path of [
      "/",
      "/chat/ses_1",
      "/assets/index-abc123.js",
      "/assets/missing.js",
      "/sw.js",
      "/manifest.webmanifest",
    ]) {
      const res = await get(path);
      expect(res.headers.get("content-security-policy"), path).toBe(csp);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
    }
    const api = await get("/api/health");
    expect(api.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
    // A server with no web build says so with the same headers.
    await server.destroy();
    server = await startTestServer();
    expect((await get("/")).headers.get("content-security-policy")).toBe(csp);
  });
});
