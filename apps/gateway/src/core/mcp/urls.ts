// Which URLs the MCP connector code may fetch. Connector URLs come from the user, and the OAuth endpoints from the server
// behind them, so both must be https on a public-looking host. Hosts in the dev allowlist (tests, a local MCP server) are
// exempt from both rules.
import { HttpError } from "../http.ts";

const PRIVATE_V4 =
  /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function publicLooking(host: string): boolean {
  if (host.startsWith("[")) return false; // IPv6 literals: no way to tell cheaply, and no MCP server needs one
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !PRIVATE_V4.test(host);
  if (!host.includes(".")) return false; // single label: a name on the internal networks
  return !/(?:^|\.)(?:localhost|local|internal|lan|home|corp|intranet)$/.test(host);
}

/** The parsed URL when the gateway may fetch it, else null. */
export function checkFetchableUrl(raw: string, devHosts: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (devHosts.includes(host)) return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  return url.protocol === "https:" && publicLooking(host) ? url : null;
}

export function requireFetchableUrl(raw: string, devHosts: readonly string[], what: string): URL {
  const url = checkFetchableUrl(raw, devHosts);
  if (!url) throw new HttpError(400, "bad_url", `${what} must be an https URL of a public host.`);
  return url;
}

/** A redirect target for the browser: any http(s) URL (the app's own origin, which may be a LAN address). */
export function parseRedirectUri(raw: unknown): string {
  if (typeof raw === "string") {
    try {
      const url = new URL(raw);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.hash)
        return url.href;
    } catch {
      // fall through
    }
  }
  throw new HttpError(400, "bad_request", "redirectUri must be an http(s) URL without credentials or fragment.");
}
