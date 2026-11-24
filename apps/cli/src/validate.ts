// Input shapes checked before anything is written, so a bad value is refused with a reason. Reasons never contain the value.

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface Publish {
  /** "" when REI_PUBLISH is only a port (all interfaces). */
  host: string;
  port: number;
}

/** REI_PUBLISH as compose reads it in `ports: ["${REI_PUBLISH}:8787"]`: `host:port`, `[v6]:port` or `port`. */
export function parsePublish(raw: string): Publish | null {
  const text = raw.trim();
  const port = (s: string) => (/^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 65535 ? Number(s) : null);
  const only = port(text);
  if (only !== null) return { host: "", port: only };
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(text);
  if (v6) return port(v6[2]!) === null ? null : { host: v6[1]!, port: Number(v6[2]) };
  const m = /^([^:]*):(\d+)$/.exec(text);
  return m && port(m[2]!) !== null ? { host: m[1]!, port: Number(m[2]) } : null;
}

const ANY = new Set(["", "0.0.0.0", "::"]);

/** The address to show people, and the one to connect to from this machine. */
export function appAddress(p: Publish): { url: string; fetchBase: string } {
  const bracket = (h: string) => (h.includes(":") ? `[${h}]` : h);
  const shown = ANY.has(p.host) || p.host === "127.0.0.1" ? "localhost" : bracket(p.host);
  const reach = ANY.has(p.host) ? "127.0.0.1" : bracket(p.host);
  return { url: `http://${shown}:${p.port}`, fetchBase: `http://${reach}:${p.port}` };
}
