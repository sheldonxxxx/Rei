import type { Db } from "../db/db.ts";
import type { Clock } from "../util/clock.ts";
import { fromBase64Url, randomBytes, toBase64Url } from "../util/encoding.ts";
import { HttpError } from "../util/errors.ts";
import type { WebAuthnEngine } from "./webauthn.ts";

/** A challenge works once and for this long. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Unsigned-in callers can start sign-ins, so the pending challenges are capped. */
const MAX_PENDING = 20;
const MAX_LABEL = 60;

/** The WebAuthn relying-party host and its allowed web or app origins. */
export interface RelyingParty {
  id: string;
  origin: string | string[];
}

/** A challenge id and the options document to hand the browser. */
export interface PasskeyOptions {
  challengeId: string;
  options: Record<string, unknown>;
}

export interface PasskeyRecord {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
  synced: boolean;
}

interface PasskeyRow {
  id: string;
  public_key: string;
  counter: number;
  transports: string;
  label: string;
  synced: number;
  created_at: number;
  last_used_at: number | null;
}

const toRecord = (row: PasskeyRow): PasskeyRecord => ({
  id: row.id,
  label: row.label,
  createdAt: row.created_at,
  ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
  synced: row.synced === 1,
});

const expired = () => new HttpError(400, "passkey_expired", "The passkey request expired. Try again.");
const badPasskey = () => new HttpError(401, "bad_passkey", "That passkey was not accepted.");

/** The `webauthn` responses arrive as loose JSON; the library validates their shape, this checks only what it reads first. */
const credentialId = (response: Record<string, unknown>): string | undefined =>
  typeof response.id === "string" ? response.id : undefined;

/**
 * Passkey storage and WebAuthn verification (ADR 0016). Knows nothing about accounts or sign-in: `AuthService` decides
 * who may register or sign in, and calls here for the cryptography.
 */
export class Passkeys {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #rpName: string;
  readonly #engine: WebAuthnEngine;

  constructor(db: Db, clock: Clock, engine: WebAuthnEngine, rpName: string) {
    this.#db = db;
    this.#clock = clock;
    this.#engine = engine;
    this.#rpName = rpName;
  }

  count(): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM passkeys")?.n ?? 0;
  }

  list(): PasskeyRecord[] {
    return this.#db.all<PasskeyRow>("SELECT * FROM passkeys ORDER BY created_at ASC, id ASC").map(toRecord);
  }

  #row(id: string): PasskeyRow {
    const row = this.#db.get<PasskeyRow>("SELECT * FROM passkeys WHERE id = ?", id);
    if (!row) throw new HttpError(404, "not_found", "No such passkey.");
    return row;
  }

  rename(id: string, label: string): PasskeyRecord {
    const row = this.#row(id);
    row.label = label.trim().slice(0, MAX_LABEL);
    if (row.label === "") throw new HttpError(400, "bad_request", "Give the passkey a name.");
    this.#db.run("UPDATE passkeys SET label = ? WHERE id = ?", row.label, id);
    return toRecord(row);
  }

  remove(id: string): void {
    this.#row(id);
    this.#db.run("DELETE FROM passkeys WHERE id = ?", id);
  }

  // ---- challenges ----------------------------------------------------------------------------------------------------

  #issue(kind: "login" | "register", challenge: string): string {
    const now = this.#clock.now();
    const id = toBase64Url(randomBytes(16));
    this.#db.transaction(() => {
      this.#db.run("DELETE FROM passkey_challenges WHERE created_at < ?", now - CHALLENGE_TTL_MS);
      this.#db.run(
        "DELETE FROM passkey_challenges WHERE kind = ? AND id NOT IN (SELECT id FROM passkey_challenges WHERE kind = ? ORDER BY created_at DESC LIMIT ?)",
        kind,
        kind,
        MAX_PENDING - 1,
      );
      this.#db.run(
        "INSERT INTO passkey_challenges (id, challenge, kind, created_at) VALUES (?, ?, ?, ?)",
        id,
        challenge,
        kind,
        now,
      );
    });
    return id;
  }

  /** Takes a challenge out for good: a challenge that is wrong, spent or old is `passkey_expired`. */
  #consume(id: string, kind: "login" | "register"): string {
    return this.#db.transaction(() => {
      const row = this.#db.get<{ challenge: string; created_at: number }>(
        "SELECT challenge, created_at FROM passkey_challenges WHERE id = ? AND kind = ?",
        id,
        kind,
      );
      if (!row) throw expired();
      this.#db.run("DELETE FROM passkey_challenges WHERE id = ?", id);
      if (this.#clock.now() - row.created_at > CHALLENGE_TTL_MS) throw expired();
      return row.challenge;
    });
  }

  // ---- registering ---------------------------------------------------------------------------------------------------

  /** The one account's WebAuthn user handle: random, made once, and not derived from anything personal. */
  #userHandle(): Uint8Array<ArrayBuffer> {
    const existing = this.#db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'passkey_user_id'")?.value;
    if (existing) return fromBase64Url(existing);
    const handle = randomBytes(32);
    this.#db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('passkey_user_id', ?)", toBase64Url(handle));
    return fromBase64Url(
      this.#db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'passkey_user_id'")?.value ?? "",
    );
  }

  async registerOptions(rp: RelyingParty): Promise<PasskeyOptions> {
    const ceremony = await this.#engine.registrationOptions({
      rpName: this.#rpName,
      rpId: rp.id,
      userName: "owner",
      userDisplayName: this.#rpName,
      userId: this.#userHandle(),
      exclude: this.#db
        .all<PasskeyRow>("SELECT * FROM passkeys")
        .map((p) => ({ id: p.id, transports: p.transports ? p.transports.split(",") : [] })),
    });
    return { challengeId: this.#issue("register", ceremony.challenge), options: ceremony.options };
  }

  async register(
    rp: RelyingParty,
    challengeId: string,
    response: Record<string, unknown>,
    label: string,
  ): Promise<PasskeyRecord> {
    const challenge = this.#consume(challengeId, "register");
    const credential = await this.#engine.verifyRegistration({ response, challenge, origin: rp.origin, rpId: rp.id });
    if (!credential) throw badPasskey();
    const name = label.trim().slice(0, MAX_LABEL) || `Passkey ${this.count() + 1}`;
    try {
      this.#db.run(
        "INSERT INTO passkeys (id, public_key, counter, transports, label, synced, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        credential.id,
        toBase64Url(credential.publicKey),
        credential.counter,
        credential.transports.join(","),
        name,
        credential.synced ? 1 : 0,
        this.#clock.now(),
      );
    } catch {
      throw new HttpError(409, "passkey_exists", "That passkey is already registered.");
    }
    return toRecord(this.#row(credential.id));
  }

  // ---- signing in ----------------------------------------------------------------------------------------------------

  async loginOptions(rp: RelyingParty): Promise<PasskeyOptions> {
    const ceremony = await this.#engine.authenticationOptions({ rpId: rp.id });
    return { challengeId: this.#issue("login", ceremony.challenge), options: ceremony.options };
  }

  /** Checks a sign-in; true if the passkey is registered and proved itself, and records its use. */
  async verifyLogin(rp: RelyingParty, challengeId: string, response: Record<string, unknown>): Promise<boolean> {
    let challenge: string;
    try {
      challenge = this.#consume(challengeId, "login");
    } catch {
      return false;
    }
    const id = credentialId(response);
    const row = id ? this.#db.get<PasskeyRow>("SELECT * FROM passkeys WHERE id = ?", id) : undefined;
    if (!row) return false;
    const verified = await this.#engine.verifyAuthentication({
      response,
      challenge,
      origin: rp.origin,
      rpId: rp.id,
      credential: {
        id: row.id,
        publicKey: fromBase64Url(row.public_key),
        counter: row.counter,
        transports: row.transports ? row.transports.split(",") : [],
      },
    });
    if (!verified) return false;
    this.#db.run(
      "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?",
      verified.newCounter,
      this.#clock.now(),
      row.id,
    );
    return true;
  }
}
