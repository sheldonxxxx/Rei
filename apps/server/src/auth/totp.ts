import { base32Decode, base32Encode, randomBytes, timingSafeEqual, utf8 } from "../util/encoding.ts";

export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export const totpStepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_S);

/** The code an authenticator shows at `nowMs` (RFC 6238, SHA-1, 6 digits, 30 s). */
export async function totpCode(secretBase32: string, nowMs: number): Promise<string> {
  return hotp(base32Decode(secretBase32), totpStepAt(nowMs));
}

/**
 * Checks a code against the previous, current and next step. Returns the step that matched, or null. A step at or
 * below `lastUsedStep` is rejected, so a code can be used once.
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastUsedStep: number,
): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStepAt(nowMs);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = await hotp(secret, step);
    // Check every step (no early exit) so timing does not reveal which one matched.
    if (timingSafeEqual(utf8(expected), utf8(code)) && step > lastUsedStep && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`;
}
