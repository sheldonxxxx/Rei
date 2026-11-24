// The protocol version handshake (ADR 0009). The contract only grows; PROTOCOL_VERSION goes up when it grows in a way
// a client may want to detect, and MIN_CLIENT_PROTOCOL goes up only at the end of a breaking change's deprecation
// window.

/** The contract this server speaks. */
export const PROTOCOL_VERSION = 1;
/** The oldest client protocol this server still serves; older clients get `client_outdated`. */
export const MIN_CLIENT_PROTOCOL = 1;

/** Every client names itself and its protocol on every request: `x-rei-client: ios/1`. */
export const CLIENT_HEADER = "x-rei-client";
/** The same, as a query parameter, where a request cannot carry headers (an EventSource). */
export const CLIENT_QUERY = "client";

export const CLIENT_KINDS = ["web", "ios", "android", "macos", "windows", "linux", "cli"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];
/** Kinds that receive their device credential in the response body rather than a cookie. */
export const NATIVE_CLIENT_KINDS: readonly ClientKind[] = ["ios", "android", "macos", "windows", "linux", "cli"];

export interface ClientId {
  kind: ClientKind;
  protocol: number;
}

/** Reads `kind/protocol`; undefined for anything else (a missing header is the oldest supported web client). */
export function parseClientId(value: string | undefined | null): ClientId | undefined {
  const match = /^([a-z]+)\/([0-9]{1,6})$/.exec((value ?? "").trim());
  if (!match) return undefined;
  const kind = match[1] as ClientKind;
  if (!CLIENT_KINDS.includes(kind)) return undefined;
  return { kind, protocol: Number(match[2]) };
}

export function clientIdHeader(kind: ClientKind, protocol = PROTOCOL_VERSION): string {
  return `${kind}/${protocol}`;
}
