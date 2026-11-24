import { fromBase64Url, randomBytes, timingSafeEqual, toBase64Url, utf8 } from "../util/encoding.ts";

/** 100,000 is the most Cloudflare Workers allows for PBKDF2. */
export const PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordRecord {
  hash: string;
  salt: string;
  iterations: number;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations: number = PBKDF2_ITERATIONS): Promise<PasswordRecord> {
  const salt = randomBytes(16);
  return { hash: toBase64Url(await derive(password, salt, iterations)), salt: toBase64Url(salt), iterations };
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const actual = await derive(password, fromBase64Url(record.salt), record.iterations);
  return timingSafeEqual(actual, fromBase64Url(record.hash));
}
