// Firebase HTTP v1. A short-lived access token is shared by sends until it is near expiry.
import { b64u } from "../http.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const encoder = new TextEncoder();
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
const jwtPart = (value: unknown) => b64u.encode(encoder.encode(JSON.stringify(value)));

export interface FcmContent {
  token: string;
  data: Record<string, string>;
  ttl: number;
  urgent: boolean;
}

export type FcmResult = { ok: true } | { ok: false; status: number; gone?: boolean; retryAfterMs?: number };
export type FcmSender = (content: FcmContent) => Promise<FcmResult>;

export interface FcmAccount {
  projectId: string;
  email: string;
  key: CryptoKey;
}

export async function readFcmAccount(raw: string): Promise<FcmAccount> {
  try {
    const data = object(JSON.parse(raw));
    const projectId = data?.project_id;
    const email = data?.client_email;
    const pem = data?.private_key;
    if (
      typeof projectId !== "string" ||
      !/^[a-z0-9-]{1,100}$/.test(projectId) ||
      typeof email !== "string" ||
      !email.includes("@") ||
      typeof pem !== "string"
    )
      throw new Error();
    const pkcs8 = atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ""));
    const key = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(pkcs8, (ch) => ch.charCodeAt(0)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return { projectId, email, key };
  } catch {
    throw new Error("REI_FCM_SERVICE_ACCOUNT_JSON is not a valid Firebase service account.");
  }
}

export function createFcmSender(account: FcmAccount, fetchImpl: typeof fetch, now: () => number): FcmSender {
  let cached: { token: string; expiresAt: number } | undefined;
  let exchange: Promise<string> | undefined;

  async function mint(): Promise<string> {
    const issuedAt = Math.floor(now() / 1000);
    const unsigned = `${jwtPart({ alg: "RS256", typ: "JWT" })}.${jwtPart({
      iss: account.email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", account.key, encoder.encode(unsigned));
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${b64u.encode(new Uint8Array(sig))}`,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(6_000),
    });
    const data = object(await response.json());
    if (!response.ok || typeof data?.access_token !== "string" || typeof data.expires_in !== "number")
      throw new Error("FCM OAuth exchange failed.");
    cached = { token: data.access_token, expiresAt: now() + data.expires_in * 1000 };
    return cached.token;
  }

  return async ({ token, data, ttl, urgent }) => {
    try {
      if (!cached || cached.expiresAt - now() <= 60_000) {
        exchange ??= mint().finally(() => {
          exchange = undefined;
        });
        await exchange;
      }
      const accessToken = cached!.token;
      const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: { token, data, android: { ttl: `${ttl}s`, priority: urgent ? "high" : "normal" } },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(7_000),
      });
      if (res.ok) {
        await res.body?.cancel();
        return { ok: true };
      }
      if (res.status === 401 && cached?.token === accessToken) cached = undefined;
      const retry = res.headers.get("retry-after");
      const delay = retry === null ? 0 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now();
      const error = object(object(await res.json().catch(() => undefined))?.error);
      const gone =
        Array.isArray(error?.details) &&
        error.details.some((value) => {
          const detail = object(value);
          return (
            detail?.["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
            detail.errorCode === "UNREGISTERED"
          );
        });
      return { ok: false, status: res.status, gone, ...(delay > 0 ? { retryAfterMs: delay } : {}) };
    } catch {
      return { ok: false, status: 0 };
    }
  };
}
