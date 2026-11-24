import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { type Api, ApiError } from "../api/client.ts";

/** The person closed the browser's passkey prompt, or it timed out: not an error to report as one. */
export class PasskeyCancelled extends Error {
  constructor() {
    super("Passkey request cancelled.");
    this.name = "PasskeyCancelled";
  }
}

export const passkeysSupported = (): boolean => {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
};

/** The browser's own dialog was dismissed (NotAllowedError), or a passkey for this site is already on the device. */
function translate(e: unknown): never {
  const name = e instanceof Error ? e.name : "";
  const code = (e as { code?: string } | null)?.code;
  if (name === "NotAllowedError" || name === "AbortError") throw new PasskeyCancelled();
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") throw new ApiError(409, "passkey_exists", "");
  throw e;
}

/** Asks the server for a challenge, has the browser sign it, and signs in with the answer. */
export async function signInWithPasskey(api: Api): Promise<void> {
  const { challengeId, options } = await api.passkeyLoginOptions();
  let response: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    response = await startAuthentication({
      optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"],
    });
  } catch (e) {
    translate(e);
  }
  await api.passkeyLogin({ challengeId, response: response as unknown as Record<string, unknown> });
}

/** Adds a passkey to the account: the password re-check, the browser's prompt, then the server's check. */
export async function addPasskey(api: Api, password: string, label: string): Promise<void> {
  const { challengeId, options } = await api.passkeyRegisterOptions(password);
  let response: Awaited<ReturnType<typeof startRegistration>>;
  try {
    response = await startRegistration({
      optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]["optionsJSON"],
    });
  } catch (e) {
    translate(e);
  }
  await api.passkeyRegister({
    challengeId,
    response: response as unknown as Record<string, unknown>,
    ...(label.trim() ? { label: label.trim() } : {}),
  });
}
