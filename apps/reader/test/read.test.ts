import { describe, expect, it } from "vitest";
import { performRead, type ReadDeps } from "../src/core/read.ts";
import { parseReadRequest } from "../src/core/request.ts";
import { type FetchResponse, ProxyRefused } from "../src/core/types.ts";
import { createReaderApp } from "../src/node/app.ts";

const html = (body: string) =>
  new TextEncoder().encode(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`);
const article = `<main><article><h1>Hello</h1><p>${"A readable paragraph about nothing in particular. ".repeat(12)}</p></article></main>`;
const ok = (body: Uint8Array, type = "text/html"): FetchResponse => ({
  status: 200,
  headers: { "content-type": type },
  body,
  truncated: false,
});
const redirect = (to: string, status = 302): FetchResponse => ({
  status,
  headers: { location: to },
  body: new Uint8Array(),
  truncated: false,
});

function rig(responses: Record<string, FetchResponse | Error>) {
  const calls: { url: string; token: string }[] = [];
  const revoked: string[] = [];
  const deps: ReadDeps = {
    fetch: async (url, token) => {
      calls.push({ url, token });
      const r = responses[url];
      if (r === undefined) throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
      if (r instanceof Error) throw r;
      return r;
    },
    openFetchJob: () => ({ token: "tok", revoke: () => revoked.push("tok") }),
  };
  return { deps, calls, revoked };
}
const req = (url: string, extra: Record<string, unknown> = {}, allow = [new URL(url).hostname]) =>
  parseReadRequest({ url, allowHosts: allow, ...extra });

describe("performRead", () => {
  it("reads a page and revokes the job", async () => {
    const { deps, revoked } = rig({ "https://a.test/x": ok(html(article)) });
    const out = await performRead(req("https://a.test/x"), deps);
    expect(out.outcome).toBe("page");
    if (out.outcome !== "page") return;
    expect(out.text).toContain("readable paragraph");
    expect(out.finalUrl).toBe("https://a.test/x");
    expect(out.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.details).toMatchObject({ method: "http", status: 200, redirects: 0 });
    expect(revoked).toEqual(["tok"]);
  });

  it("follows a redirect inside allowHosts and counts it", async () => {
    const { deps } = rig({
      "https://a.test/x": redirect("/y"),
      "https://a.test/y": ok(html(article)),
    });
    const out = await performRead(req("https://a.test/x"), deps);
    expect(out).toMatchObject({ outcome: "page", finalUrl: "https://a.test/y", details: { redirects: 1 } });
  });

  it("hands back a redirect to a host that is not allowed", async () => {
    const { deps, calls } = rig({
      "https://a.test/x": redirect("/y"),
      "https://a.test/y": redirect("https://b.test/z"),
    });
    const out = await performRead(req("https://a.test/x"), deps);
    expect(out).toEqual({ outcome: "redirect", location: "https://b.test/z", hops: 2 });
    expect(calls).toHaveLength(2);
  });

  it("stops after maxRedirects", async () => {
    const { deps } = rig({ "https://a.test/x": redirect("/x") });
    const out = await performRead(req("https://a.test/x", { maxRedirects: 2 }), deps);
    expect(out).toMatchObject({ outcome: "failed", message: "Too many redirects (more than 2)." });
  });

  it("reports an unusable redirect target", async () => {
    const { deps } = rig({ "https://a.test/x": redirect("ftp://a.test/") });
    const out = await performRead(req("https://a.test/x"), deps);
    expect(out).toMatchObject({ outcome: "failed" });
  });

  it("explains HTTP errors, and marks 403 as blocked", async () => {
    const { deps } = rig({
      "https://a.test/404": { ...ok(html("")), status: 404 },
      "https://a.test/403": { ...ok(html("")), status: 403 },
    });
    expect(await performRead(req("https://a.test/404"), deps)).toMatchObject({
      outcome: "failed",
      message: "a.test answered HTTP 404, so there is no page to read.",
      details: { status: 404 },
    });
    expect(await performRead(req("https://a.test/403"), deps)).toMatchObject({ outcome: "failed", quality: "blocked" });
  });

  it("turns proxy refusals and network errors into messages", async () => {
    const { deps } = rig({
      "https://a.test/p": new ProxyRefused("This read is not for that site."),
      "https://a.test/n": new Error("x"),
    });
    expect(await performRead(req("https://a.test/p"), deps)).toMatchObject({
      message: "Could not reach a.test: This read is not for that site.",
    });
    expect(await performRead(req("https://c.test/q"), deps)).toMatchObject({
      message: "Could not fetch the page from c.test (ENOTFOUND).",
    });
  });

  it("refuses a body over the limit and unreadable types", async () => {
    const { deps } = rig({
      "https://a.test/big": { ...ok(html(article)), truncated: true },
      "https://a.test/pdf": ok(new Uint8Array([1, 2]), "application/pdf"),
    });
    expect(await performRead(req("https://a.test/big"), deps)).toMatchObject({ outcome: "failed" });
    expect(await performRead(req("https://a.test/pdf"), deps)).toMatchObject({
      outcome: "failed",
      quality: "unsupported_mime",
    });
  });

  it("says a script-only page needs JavaScript", async () => {
    const { deps } = rig({ "https://a.test/app": ok(html('<div id="root"></div><script src="/app.js"></script>')) });
    expect(await performRead(req("https://a.test/app"), deps)).toMatchObject({
      outcome: "failed",
      quality: "requires_js",
    });
  });

  it("returns JSON and text as pages", async () => {
    const { deps } = rig({
      "https://a.test/j": ok(new TextEncoder().encode('{"a":1}'), "application/json"),
      "https://a.test/t": ok(new TextEncoder().encode("# Title\n\nbody"), "text/plain"),
    });
    expect(await performRead(req("https://a.test/j"), deps)).toMatchObject({ outcome: "page", extractor: "json" });
    expect(await performRead(req("https://a.test/t"), deps)).toMatchObject({
      outcome: "page",
      extractor: "text",
      title: "Title",
    });
  });
});

describe("parseReadRequest", () => {
  const bad = (input: unknown) => () => parseReadRequest(input);
  it("accepts a plain request and fills defaults", () => {
    const p = parseReadRequest({ url: "https://A.test/x#frag", allowHosts: ["A.test."] });
    expect(p).toMatchObject({ render: "auto", localNetworks: "none", maxRedirects: 5 });
    expect(p.url.href).toBe("https://a.test/x");
    expect([...p.allowHosts]).toEqual(["a.test"]);
  });
  it("rejects malformed requests", () => {
    expect(bad(null)).toThrow();
    expect(bad({ url: "ftp://a.test", allowHosts: ["a.test"] })).toThrow(/http/);
    expect(bad({ url: "https://u:p@a.test", allowHosts: ["a.test"] })).toThrow(/user name/);
    expect(bad({ url: "https://a.test:8080", allowHosts: ["a.test"] })).toThrow(/ports/);
    expect(bad({ url: "https://a.test", allowHosts: ["b.test"] })).toThrow(/include the host/);
    expect(bad({ url: "https://a.test", allowHosts: "a.test" })).toThrow(/allowHosts/);
    expect(bad({ url: "https://a.test", allowHosts: ["a.test", 3] })).toThrow(/allowHosts/);
    expect(bad({ url: "https://a.test", allowHosts: ["a.test"], render: "x" })).toThrow(/render/);
    expect(bad({ url: "https://a.test", allowHosts: ["a.test"], localNetworks: 3 })).toThrow(/localNetworks/);
    expect(bad({ url: "https://a.test", allowHosts: ["a.test"], maxRedirects: 9 })).toThrow(/maxRedirects/);
    expect(bad({ url: "x".repeat(3000), allowHosts: ["a.test"] })).toThrow();
  });
  it("keeps a valid step id from the body or header only", () => {
    const base = { url: "https://a.test", allowHosts: ["a.test"] };
    expect(parseReadRequest({ ...base, stepId: "s_1" }).stepId).toBe("s_1");
    expect(parseReadRequest(base, "h-2").stepId).toBe("h-2");
    expect(parseReadRequest({ ...base, stepId: "bad id!" }).stepId).toBeUndefined();
  });
  it("accepts local network lists", () => {
    expect(
      parseReadRequest({ url: "https://a.test", allowHosts: ["a.test"], localNetworks: ["10.0.0.0/8"] }).localNetworks,
    ).toEqual(["10.0.0.0/8"]);
  });
});

describe("the HTTP app", () => {
  const log = { debug() {}, info() {}, warn() {}, error() {} } as never;
  it("answers /healthz and /read", async () => {
    const { deps } = rig({ "https://a.test/x": ok(html(article)) });
    const app = createReaderApp({ ...deps, log });
    expect((await app.request("/healthz")).status).toBe(200);
    const res = await app.request("/read", {
      method: "POST",
      body: JSON.stringify({ url: "https://a.test/x", allowHosts: ["a.test"] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("page");
  });
  it("answers 400 to bad bodies", async () => {
    const app = createReaderApp({ ...rig({}).deps, log });
    for (const body of ["nope", JSON.stringify({ url: "https://a.test" }), "x".repeat(20_000)]) {
      const res = await app.request("/read", { method: "POST", body });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
  });
});
