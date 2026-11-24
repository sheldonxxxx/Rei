// The real credential: a pi-ai `Models` over the file store resolves it (and refreshes it under the store's lock), this
// class adds single-flight, failure back-off, token fingerprints for status output and registration of every token value
// with the redactor.
import { createHash } from "node:crypto";
import type { Credential } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { type Logger, nullLogger } from "@rei/logging";
import type { Redactor } from "../core/redact.ts";
import type { TokenSource } from "../core/types.ts";
import { TokenError } from "../core/types.ts";
import { PROVIDER_ID } from "./config.ts";
import type { FileCredentialStore } from "./credstore.ts";

export const fingerprint = (secret: string): string => createHash("sha256").update(secret).digest("hex").slice(0, 12);

export function createPiModels(store: FileCredentialStore): MutableModels {
  const models = createModels({ credentials: store });
  models.setProvider(openaiProvider());
  return models;
}

export interface PiTokenSourceOptions {
  /** After a failed refresh, answer from the failure for this long instead of calling the token endpoint again. */
  failureBackoffMs?: number;
  now?: () => number;
  log?: Logger;
}

export class PiTokenSource implements TokenSource {
  readonly #store: FileCredentialStore;
  readonly #models: MutableModels;
  readonly #redactor: Redactor;
  readonly #backoffMs: number;
  readonly #now: () => number;
  readonly #log: Logger;
  #inflight: Promise<string> | undefined;
  #failure: { at: number; error: TokenError } | undefined;

  constructor(store: FileCredentialStore, redactor: Redactor, options: PiTokenSourceOptions = {}) {
    this.#store = store;
    this.#redactor = redactor;
    this.#models = createPiModels(store);
    this.#backoffMs = options.failureBackoffMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? nullLogger;
    store.onWrite = ({ previous, next }) => {
      this.remember(next);
      if (previous?.type === "oauth" && next.type === "oauth" && previous.access !== next.access) {
        this.#log.info("credential.refreshed", {
          accessFrom: fingerprint(previous.access),
          accessTo: fingerprint(next.access),
          refreshRotated: previous.refresh !== next.refresh,
        });
      }
    };
  }

  /** Registers every secret in a credential with the redactor (also after rotation: old values stay registered). */
  remember(credential: Credential | undefined): void {
    if (credential?.type === "oauth") this.#redactor.add(credential.access, credential.refresh);
    else if (credential?.type === "api_key") this.#redactor.add(credential.key);
  }

  /** Loads the stored credential into the redactor; call at start-up. */
  async prime(): Promise<void> {
    this.remember(await this.#store.read(PROVIDER_ID));
  }

  accessToken(): Promise<string> {
    if (this.#inflight) return this.#inflight;
    const p = this.#resolve().finally(() => {
      if (this.#inflight === p) this.#inflight = undefined;
    });
    this.#inflight = p;
    return p;
  }

  async #resolve(): Promise<string> {
    const stored = await this.#store.read(PROVIDER_ID).catch((cause) => {
      throw new TokenError("credential_error", "The credential store could not be read.", { cause });
    });
    this.remember(stored);
    if (!stored) throw new TokenError("not_signed_in", "No credential is stored.");
    if (this.#failure && this.#now() - this.#failure.at < this.#backoffMs) throw this.#failure.error;
    let key: string | undefined;
    try {
      // Refreshes under the store lock when the token is within pi-ai's validity margin; stores the rotated pair.
      key = (await this.#models.getAuth(PROVIDER_ID))?.auth.apiKey;
    } catch (cause) {
      const error = new TokenError("credential_refresh_failed", "The credential could not be refreshed.", { cause });
      this.#failure = { at: this.#now(), error };
      throw error;
    }
    this.#failure = undefined;
    this.remember(await this.#store.read(PROVIDER_ID));
    if (!key) throw new TokenError("not_signed_in", "The stored credential has no usable token.");
    this.#redactor.add(key);
    return key;
  }

  async status(): Promise<{ signedIn: boolean; accessExpiresInS: number | null }> {
    const stored = await this.#store.read(PROVIDER_ID);
    if (!stored) return { signedIn: false, accessExpiresInS: null };
    if (stored.type === "oauth")
      return { signedIn: true, accessExpiresInS: Math.max(0, Math.round((stored.expires - this.#now()) / 1000)) };
    return { signedIn: true, accessExpiresInS: null };
  }
}
