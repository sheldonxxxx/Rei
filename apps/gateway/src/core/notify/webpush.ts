// Web Push without a library: message encryption (RFC 8291 on RFC 8188 aes128gcm) and VAPID (RFC 8292, ES256 JWT), Web
// Crypto only so it runs in Node and in a Worker. The only seam is `Options.sender`/`salt`, which the RFC 8291 Appendix A
// test uses to inject its fixed key pair and salt; production leaves both to the random defaults.
import { b64u } from "../http.ts";

const enc = new TextEncoder();
const RECORD_SIZE = 4096;
/** Plaintext limit the gateway accepts (the contract's 3 KB); a single 4096-byte record holds 4078. */
export const MAX_PAYLOAD_BYTES = 3 * 1024;
const MAX_TTL_S = 28 * 86_400;
const VAPID_LIFETIME_S = 12 * 3600; // RFC 8292 allows at most 24 h

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url: what the browser's `applicationServerKey` takes. */
  publicKey: string;
  /** Private key as a JWK (`d` is the secret). */
  privateJwk: JsonWebKey;
}

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface EncryptOptions {
  /** Test seam: the application server's key pair, base64url (private 32 bytes, public 65 bytes). */
  sender?: { privateKey: string; publicKey: string };
  /** Test seam: the 16-byte salt. */
  salt?: Uint8Array;
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A P-256 public key given as the 65-byte uncompressed point. */
const publicKeyFromRaw = (raw: Uint8Array, usages: KeyUsage[], algorithm: "ECDH" | "ECDSA" = "ECDH") =>
  crypto.subtle.importKey("raw", raw as BufferSource, { name: algorithm, namedCurve: "P-256" }, true, usages);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
      key,
      bytes * 8,
    ),
  );
}

/** The request body (aes128gcm: header with salt, record size and our public key, then one record) for `payload`. */
export async function encryptWebPush(
  subscription: Subscription,
  payload: Uint8Array,
  options: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64u.decode(subscription.keys.p256dh);
  const authSecret = b64u.decode(subscription.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh is not an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("auth secret must be 16 bytes");
  if (payload.length > RECORD_SIZE - 17 - 1) throw new Error("payload does not fit one record");

  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (options.sender) {
    asPublic = b64u.decode(options.sender.publicKey);
    const jwk: JsonWebKey = {
      kty: "EC",
      crv: "P-256",
      d: options.sender.privateKey,
      x: b64u.encode(asPublic.slice(1, 33)),
      y: b64u.encode(asPublic.slice(33, 65)),
      ext: true,
    };
    asPrivate = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: await publicKeyFromRaw(uaPublic, []) }, asPrivate, 256),
  );
  // RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" 0x00 ua_public as_public, 32)
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  // RFC 8188 §2.2 and §2.3
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      concat(payload, new Uint8Array([0x02])) as BufferSource,
    ),
  ); // 0x02: last record, no padding
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, record);
}

/** A fresh VAPID key pair. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    publicKey: b64u.encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

/** The `Authorization` header value for a push service at `audience` (the endpoint's origin). */
export async function vapidAuthorization(
  keys: VapidKeys,
  audience: string,
  subject: string,
  nowMs: number,
): Promise<string> {
  const part = (value: unknown) => b64u.encode(enc.encode(JSON.stringify(value)));
  const signingInput = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: Math.floor(nowMs / 1000) + VAPID_LIFETIME_S, sub: subject })}`;
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)),
  ); // IEEE P1363 r||s, what JWS wants
  return `vapid t=${signingInput}.${b64u.encode(signature)}, k=${keys.publicKey}`;
}

/** Push services we deliver to. Anything else is refused: the endpoint comes from the client and is fetched from here. */
export function isAllowedPushEndpoint(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const ok =
    host === "fcm.googleapis.com" ||
    host === "updates.push.services.mozilla.com" ||
    host.endsWith(".push.apple.com") ||
    host.endsWith(".notify.windows.com");
  return ok ? url : null;
}

export interface PushRequestInput {
  subscription: Subscription;
  payload: string;
  ttl?: number;
  urgency?: "normal" | "high";
  topic?: string;
}

/** Builds the request (URL, headers, encrypted body) for a push service. */
export async function buildPushRequest(
  input: PushRequestInput,
  vapid: VapidKeys,
  subject: string,
  nowMs: number,
  options: EncryptOptions = {},
): Promise<{ url: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> }> {
  const url = isAllowedPushEndpoint(input.subscription.endpoint);
  if (!url) throw new Error("endpoint is not a known push service");
  const payload = enc.encode(input.payload);
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error("payload is too large");
  const headers: Record<string, string> = {
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(Math.min(Math.max(0, Math.floor(input.ttl ?? 86_400)), MAX_TTL_S)),
    authorization: await vapidAuthorization(vapid, url.origin, subject, nowMs),
  };
  if (input.urgency) headers.urgency = input.urgency;
  if (input.topic) headers.topic = input.topic;
  return { url: url.href, headers, body: await encryptWebPush(input.subscription, payload, options) };
}
