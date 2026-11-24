// Vitest setup file: nothing in a gateway test may reach the internet. Global fetch and the socket entry points refuse
// every host except loopback; the OAuth token URL, which pi-ai hardcodes (https://auth.openai.com/api/accounts/oauth/token),
// is redirected to GATEWAY_TEST_TOKEN_URL (set by the test that owns a fake token endpoint).
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";

export const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "auth.openai.com") {
    const tokenUrl = process.env.GATEWAY_TEST_TOKEN_URL;
    if (!tokenUrl) throw new Error("offline guard: auth.openai.com requested but no GATEWAY_TEST_TOKEN_URL is set");
    return realFetch(tokenUrl, init);
  }
  if (!isLoopback(url.hostname)) throw new Error(`offline guard: refusing ${url.hostname}`);
  return realFetch(input, init);
}) as typeof fetch;

/** The host a socket call targets: options object, (port, host) or a unix path. */
function targetHost(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const o = first as { path?: string; host?: string; hostname?: string; servername?: string };
    return o.path ? "localhost" : (o.host ?? o.hostname ?? "localhost");
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first)))
    return typeof args[1] === "string" ? args[1] : "localhost";
  return "localhost";
}
const refusal = (host: string) => new Error(`offline guard: refusing socket to ${host}`);

type AnyFn = (...args: unknown[]) => unknown;
function guardConnect(owner: Record<string, unknown>, name: string): void {
  const real = owner[name] as AnyFn;
  owner[name] = function (this: unknown, ...args: unknown[]) {
    const host = targetHost(args);
    if (!isLoopback(host)) {
      const socket = new net.Socket();
      setImmediate(() => socket.destroy(refusal(host)));
      return socket;
    }
    return real.apply(this, args);
  };
}
guardConnect(net as unknown as Record<string, unknown>, "connect");
guardConnect(net as unknown as Record<string, unknown>, "createConnection");
guardConnect(tls as unknown as Record<string, unknown>, "connect");

// Name resolution is the other way out (http.Agent, undici's default connector).
const realLookup = dns.lookup as unknown as AnyFn;
(dns as unknown as Record<string, unknown>).lookup = function (this: unknown, hostname: string, ...rest: unknown[]) {
  if (isLoopback(hostname)) return realLookup.call(this, hostname, ...rest);
  const callback = rest.at(-1) as (error: Error) => void;
  setImmediate(() => callback(refusal(hostname)));
  return {};
};
