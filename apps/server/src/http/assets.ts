/** The built PWA, behind an interface so the app does not depend on how files are stored (Node folder today). */
export interface WebFile {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}
export interface WebAssets {
  /** `path` is URL-style and relative, e.g. "assets/index-abc.js" or "index.html". Undefined if there is no such file. */
  get(path: string): Promise<WebFile | undefined>;
}

/**
 * The policy of every page and file the server serves: the PWA loads scripts and styles from itself only, images from
 * itself, data: and blob: URLs (avatars, previews) and any https site (the images and map tiles of rich components), and
 * talks to its own origin only (API, streams and the browser screencast WebSocket). Nothing may frame it.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");
/** What an API response needs: it is data, never a document. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** The security headers common to the web and the API. */
export function securityHeaders(csp: string): Record<string, string> {
  return { "content-security-policy": csp, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
}

/** index.html and anything unhashed must be revalidated; files under /assets/ are content-hashed and never change. */
export function cacheControlFor(path: string): string {
  return path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

const hasExtension = (path: string): boolean => /\.[A-Za-z0-9]{1,8}$/.test(path.split("/").pop() ?? "");

/** Serves a GET for a non-API path: the file if it exists, otherwise index.html for app routes (SPA fallback). */
export async function serveWeb(assets: WebAssets | undefined, pathname: string, method: string): Promise<Response> {
  const notBuilt = () =>
    new Response("The web app has not been built into this server.", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        ...securityHeaders(WEB_CSP),
      },
    });
  if (!assets) return notBuilt();
  let path: string;
  try {
    path = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return new Response("Bad request", { status: 400, headers: securityHeaders(WEB_CSP) });
  }
  if (path.split("/").some((part) => part === ".." || part === "." || part.includes("\\") || part.includes("\0")))
    return new Response("Not found", { status: 404, headers: securityHeaders(WEB_CSP) });
  if (path === "") path = "index.html";
  let file = await assets.get(path);
  let served = path;
  if (!file) {
    if (path === "index.html") return notBuilt();
    if (hasExtension(path))
      return new Response("Not found", {
        status: 404,
        headers: { "cache-control": "no-store", ...securityHeaders(WEB_CSP) },
      });
    file = await assets.get("index.html");
    served = "index.html";
    if (!file) return notBuilt();
  }
  const headers = new Headers({
    "content-type": file.contentType,
    "cache-control": cacheControlFor(served),
    ...securityHeaders(WEB_CSP),
  });
  return new Response(method === "HEAD" ? null : file.bytes, { status: 200, headers });
}
