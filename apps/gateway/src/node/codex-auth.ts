import { setTimeout as delay } from "node:timers/promises";
import type { Credential } from "@earendil-works/pi-ai";
import { HttpError } from "../core/http.ts";
import type { Redactor } from "../core/redact.ts";
import type { FileCredentialStore } from "./credstore.ts";

export const CODEX_IMAGES = "codex-images";
const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_MARGIN_MS = 120_000;
type OAuth = Extract<Credential, { type: "oauth" }>;

export function codexClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) ?? {};
  } catch {
    return {};
  }
}

async function exchange(fetcher: typeof fetch, params: Record<string, string>, previous?: OAuth): Promise<OAuth> {
  const response = await fetcher(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (
      [400, 401, 403].includes(response.status) &&
      (response.status !== 400 || ["invalid_grant", "invalid_token", "refresh_token_reused"].includes(result?.error))
    )
      throw new HttpError(401, "codex_sign_in_required", "Sign in to Codex Images again in Settings → Providers.");
    throw new HttpError(
      response.status === 429 ? 429 : 502,
      "codex_auth_failed",
      "Codex authentication is temporarily unavailable.",
    );
  }
  const access = result?.access_token;
  const refresh = result?.refresh_token ?? previous?.refresh;
  const exp = typeof access === "string" ? codexClaims(access).exp : undefined;
  const expires = typeof exp === "number" ? exp * 1000 : Date.now() + Number(result?.expires_in) * 1000;
  if (
    typeof access !== "string" ||
    !access ||
    typeof refresh !== "string" ||
    !refresh ||
    !Number.isFinite(expires) ||
    expires <= Date.now()
  )
    throw new HttpError(502, "codex_auth_failed", "Codex returned an invalid credential.");
  return { type: "oauth", access, refresh, expires };
}

export function codexAccess(store: FileCredentialStore, redactor: Redactor, fetcher: typeof fetch = fetch) {
  let failure: { refresh: string; error: unknown; until: number } | undefined;
  return async (): Promise<string> => {
    const credential = await store.modify(CODEX_IMAGES, async (current) => {
      if (current?.type !== "oauth")
        throw new HttpError(401, "codex_sign_in_required", "Sign in to Codex Images in Settings → Providers.");
      redactor.add(current.access, current.refresh);
      if (current.expires > Date.now() + REFRESH_MARGIN_MS) return undefined;
      if (failure?.refresh === current.refresh && failure.until > Date.now()) throw failure.error;
      try {
        const next = await exchange(fetcher, { grant_type: "refresh_token", refresh_token: current.refresh }, current);
        redactor.add(next.access, next.refresh);
        failure = undefined;
        return next;
      } catch (error) {
        const terminal = error instanceof HttpError && error.code === "codex_sign_in_required";
        failure = { refresh: current.refresh, error, until: terminal ? Infinity : Date.now() + 5_000 };
        throw error;
      }
    });
    if (credential?.type !== "oauth") throw new Error("Codex credential is unavailable.");
    return credential.access;
  };
}

export const CODEX_DEVICE_URL = `${ISSUER}/codex/device`;

/** Device-code sign-in. `cancel` stops the wait; the code is valid for about 15 minutes. */
export async function loginCodexImages(
  store: FileCredentialStore,
  showCode: (code: string) => void,
  cancel?: AbortSignal,
): Promise<void> {
  const signal = cancel
    ? AbortSignal.any([cancel, AbortSignal.timeout(15 * 60_000)])
    : AbortSignal.timeout(15 * 60_000);
  const post = (path: string, body: Record<string, string>) =>
    fetch(`${ISSUER}/api/accounts/deviceauth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
  const started = await post("usercode", { client_id: CLIENT_ID });
  if (!started.ok) throw new Error(`Codex device sign-in could not start (HTTP ${started.status}).`);
  const { user_code, device_auth_id, interval } = await started.json();
  if (typeof user_code !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(user_code) || typeof device_auth_id !== "string")
    throw new Error("Codex returned an invalid device sign-in response.");
  showCode(user_code);
  const waitMs = Math.max(3, Number(interval) || 5) * 1000;
  for (;;) {
    await delay(waitMs, undefined, { signal });
    const result = await post("token", { device_auth_id, user_code });
    if (result.status === 403 || result.status === 404) {
      await result.body?.cancel();
      continue;
    }
    if (!result.ok) throw new Error(`Codex device approval failed (HTTP ${result.status}).`);
    const { authorization_code, code_verifier } = await result.json();
    if (typeof authorization_code !== "string" || typeof code_verifier !== "string")
      throw new Error("Codex did not complete device approval.");
    const credential = await exchange(fetch, {
      grant_type: "authorization_code",
      code: authorization_code,
      code_verifier,
      redirect_uri: `${ISSUER}/deviceauth/callback`,
    });
    await store.modify(CODEX_IMAGES, async () => credential);
    return;
  }
}
