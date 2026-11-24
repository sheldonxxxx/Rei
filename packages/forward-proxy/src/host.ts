// Destination parsing: what the proxy accepts as a host and port before it asks anyone anything.
import { isIP } from "node:net";

/** Lowercase, one trailing dot and IPv6 brackets removed. Null for anything that is not a plausible host name or IP. */
export function normalizeHost(raw: string): string | null {
  let host = raw.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    return isIP(host) === 6 ? host : null;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.length > 253) return null;
  if (isIP(host) === 6) return host;
  // Letters, digits, hyphen, underscore, dots between non-empty labels (punycode covers non-ASCII names).
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(host) ? host : null;
}

export function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** `host:port` or `[v6]:port`, as in a CONNECT request line. */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]*\]|[^:[\]]+):(\d+)$/.exec(target);
  if (!m) return null;
  const host = normalizeHost(m[1]!);
  const port = parsePort(m[2]!);
  return host && port ? { host, port } : null;
}

/** The destination of an absolute-URI request (`GET http://host[:port]/path`). Only plain http. */
export function parseProxyUrl(url: string): { host: string; port: number; path: string } | null {
  if (!/^http:\/\//i.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = normalizeHost(parsed.hostname);
  const port = parsed.port === "" ? 80 : parsePort(parsed.port);
  return host && port ? { host, port, path: parsed.pathname + parsed.search } : null;
}
