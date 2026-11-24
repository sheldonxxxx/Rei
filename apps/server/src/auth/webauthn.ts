// The WebAuthn cryptography the control plane needs, as an interface: the control plane must stay portable (the
// portability test), and the library that implements this one reaches for Node APIs, so the Node host injects it from
// src/node/webauthn.ts. A Workers host supplies its own.

export interface CredentialDescriptor {
  /** The credential id (base64url). */
  id: string;
  transports: string[];
}

/** A registered credential as the engine needs it to check a sign-in. */
export interface StoredCredential extends CredentialDescriptor {
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
}

/** What a browser must be shown to run a ceremony, and the challenge to remember until its answer comes back. */
export interface Ceremony {
  challenge: string;
  /** The `PublicKeyCredential*OptionsJSON` document, passed to the browser unchanged. */
  options: Record<string, unknown>;
}

export interface WebAuthnEngine {
  registrationOptions(input: {
    rpName: string;
    rpId: string;
    userName: string;
    userDisplayName: string;
    userId: Uint8Array<ArrayBuffer>;
    exclude: CredentialDescriptor[];
  }): Promise<Ceremony>;
  /** The new credential when the answer is a valid, user-verified registration for this challenge, origin and host; else undefined. */
  verifyRegistration(input: {
    response: Record<string, unknown>;
    challenge: string;
    origin: string | string[];
    rpId: string;
  }): Promise<(StoredCredential & { synced: boolean }) | undefined>;
  authenticationOptions(input: { rpId: string }): Promise<Ceremony>;
  /** The credential's new counter when the answer is a valid, user-verified sign-in with it; else undefined. */
  verifyAuthentication(input: {
    response: Record<string, unknown>;
    challenge: string;
    origin: string | string[];
    rpId: string;
    credential: StoredCredential;
  }): Promise<{ newCounter: number } | undefined>;
}
