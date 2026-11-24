import { createHash, createSign, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

type Cbor = Parameters<typeof isoCBOR.encode>[0];
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();

/** A software authenticator for tests: an ES256 passkey that signs what a browser would send (attestation "none"). */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  counter: number;
  #privateKey: KeyObject;
  readonly #x: Buffer;
  readonly #y: Buffer;
  /** Multi-device (synced) passkeys set the backup-eligible flag. */
  readonly synced: boolean;
  /** False simulates an authenticator that did not check the person (no PIN, no biometric). */
  userVerified = true;

  constructor(options: { synced?: boolean; counter?: number } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.#x = Buffer.from(jwk.x ?? "", "base64url");
    this.#y = Buffer.from(jwk.y ?? "", "base64url");
    this.synced = options.synced ?? false;
    this.counter = options.counter ?? 0;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  #flags(attested: boolean): number {
    return 0x01 | (this.userVerified ? 0x04 : 0) | (this.synced ? 0x08 | 0x10 : 0) | (attested ? 0x40 : 0);
  }

  #clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** The answer to `navigator.credentials.create` for `options` (the server's options document). */
  register(options: { challenge: string }, rpId: string, origin: string): Record<string, unknown> {
    const cose = isoCBOR.encode(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, this.#x],
        [-3, this.#y],
      ]),
    );
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.#flags(true)]),
      counter,
      Buffer.alloc(16), // the all-zero AAGUID of an authenticator that does not identify its model
      idLength,
      this.credentialId,
      cose,
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(this.#clientData("webauthn.create", options.challenge, origin)),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** The answer to `navigator.credentials.get`. */
  assert(
    options: { challenge: string },
    rpId: string,
    origin: string,
    overrides: { counter?: number; signWith?: KeyObject } = {},
  ): Record<string, unknown> {
    if (overrides.counter !== undefined) this.counter = overrides.counter;
    else if (!this.synced) this.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.#flags(false)]), counter]);
    const clientData = this.#clientData("webauthn.get", options.challenge, origin);
    const signature = createSign("sha256")
      .update(Buffer.concat([authData, sha256(clientData)]))
      .sign(overrides.signWith ?? this.#privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

/** A key that is not any authenticator's: for a forged signature. */
export const strangerKey = (): KeyObject => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
