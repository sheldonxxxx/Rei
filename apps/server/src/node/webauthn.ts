import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { WebAuthnEngine } from "../auth/webauthn.ts";

/** The WebAuthn engine on SimpleWebAuthn (ADR 0016). Attestation is "none"; every ceremony requires user verification. */
export function createWebAuthnEngine(): WebAuthnEngine {
  return {
    async registrationOptions(input) {
      const options = await generateRegistrationOptions({
        rpName: input.rpName,
        rpID: input.rpId,
        userName: input.userName,
        userDisplayName: input.userDisplayName,
        userID: input.userId,
        attestationType: "none",
        excludeCredentials: input.exclude,
        // A discoverable credential that the person unlocked: with one account there is no username to type.
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
      return { challenge: options.challenge, options: { ...options } };
    },

    async verifyRegistration(input) {
      try {
        const verified = await verifyRegistrationResponse({
          response: input.response as unknown as RegistrationResponseJSON,
          expectedChallenge: input.challenge,
          expectedOrigin: input.origin,
          expectedRPID: input.rpId,
          requireUserVerification: true,
        });
        if (!verified.verified) return undefined;
        const { credential, credentialDeviceType } = verified.registrationInfo;
        return {
          id: credential.id,
          publicKey: new Uint8Array(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports ?? [],
          synced: credentialDeviceType === "multiDevice",
        };
      } catch {
        return undefined;
      }
    },

    async authenticationOptions(input) {
      // No allowCredentials: the browser offers whichever passkey it holds for this site.
      const options = await generateAuthenticationOptions({ rpID: input.rpId, userVerification: "required" });
      return { challenge: options.challenge, options: { ...options } };
    },

    async verifyAuthentication(input) {
      try {
        const verified = await verifyAuthenticationResponse({
          response: input.response as unknown as AuthenticationResponseJSON,
          expectedChallenge: input.challenge,
          expectedOrigin: input.origin,
          expectedRPID: input.rpId,
          requireUserVerification: true,
          credential: {
            id: input.credential.id,
            publicKey: input.credential.publicKey,
            counter: input.credential.counter,
            transports: input.credential.transports as never,
          },
        });
        // A counter that goes backwards means a cloned authenticator; the library throws for it. Counters stuck at 0
        // (synced passkeys) are allowed to stay there.
        return verified.verified ? { newCounter: verified.authenticationInfo.newCounter } : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
