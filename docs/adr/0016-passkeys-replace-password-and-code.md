# A passkey signs in on its own, in place of the password and the code

The account can register passkeys (WebAuthn discoverable credentials). Signing in with one creates a device exactly as the password does (ADR 0011): the browser gets the cookie, a native client the bearer token. The password sign-in stays; passkeys are an addition, not a replacement.

A passkey sign-in skips the TOTP code. Registration and sign-in both require user verification (screen lock, biometric or security-key PIN), so the passkey already proves two things: possession of the authenticator and the person's presence. Asking for an authenticator code on top would make passkeys no easier than a password.

Adding a passkey asks for the account password again, as turning on TOTP does, so a stolen browser session cannot plant a credential that outlives it. Removing, renaming and listing need only a signed-in device. Removal is not an escalation: the password still signs in.

## Decisions

- **Library:** `@simplewebauthn/server` verifies attestations and assertions (and `@simplewebauthn/browser` drives the browser API). Attestation is `none`: Rei does not ask which authenticator model it is, so any passkey provider works.
- **Behind an interface:** the control plane must stay portable to Cloudflare Workers, and the library's dependency tree (X.509 and ASN.1 parsers) was not shown to be free of Node APIs, so `auth/` talks to a `WebAuthnEngine` interface (`auth/webauthn.ts`) and the Node host injects the SimpleWebAuthn implementation (`node/webauthn.ts`). The portability test stays unchanged. A Workers host would supply its own engine.
- **Relying party:** the id is the host of `REI_PUBLIC_URL`, else the host the request came to (`x-forwarded-host` first). The expected origin is `REI_PUBLIC_URL`'s origin when set; otherwise the request's `Origin` header, accepted only if its host equals the relying-party id (any port, so the Vite dev proxy works). A passkey is bound to that host: changing the address people use to reach Rei makes existing passkeys unusable until the password is used to add new ones.
- **Challenges** are stored in SQLite (`passkey_challenges`), single-use, valid for five minutes, and capped at 20 pending per kind, since sign-in challenges are issued to callers who are not signed in.
- **Rate limit:** failed passkey sign-ins count in the same 5-per-15-minutes window as password sign-ins, so a guesser cannot switch methods to get more tries.
- **Counters:** the stored signature counter is updated on each sign-in. A counter that goes backwards is rejected as a possible cloned authenticator; synced passkeys that always report 0 are accepted.
- **Storage:** tables `passkeys` and `passkey_challenges` are created with `CREATE TABLE IF NOT EXISTS`, and the schema version is unchanged. A database that predates passkeys gains them on its next start; nothing is migrated or reset.

## Considered Options

- **Passkey as a second factor after the password:** rejected. It adds a step without adding strength over a verified passkey, and the account would still be only as safe as the password.
- **Passkeys only, password removed:** rejected. A lost device or a changed address would lock the owner out of a self-hosted server with no recovery service.
- **Hand-written WebAuthn verification on WebCrypto:** rejected. Attestation and authenticator-data parsing have many edge cases; a maintained library is the safer choice for credential code.
