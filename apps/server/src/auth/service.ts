import type { ClientKind } from "@rei/protocol";
import type { Db } from "../db/db.ts";
import type { Clock } from "../util/clock.ts";
import { randomBase32, randomBytes, sha256, sha256Hex, timingSafeEqual, toBase64Url } from "../util/encoding.ts";
import { HttpError } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { type PasskeyRecord, Passkeys, type RelyingParty } from "./passkeys.ts";
import { hashPassword, MIN_PASSWORD_LENGTH, type PasswordRecord, verifyPassword } from "./password.ts";
import { newTotpSecret, otpauthUri, verifyTotp } from "./totp.ts";
import type { WebAuthnEngine } from "./webauthn.ts";

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const RATE_WINDOW_MS = 15 * 60 * 1000;
export const RATE_MAX_FAILURES = 5;
const SLIDE_AFTER_MS = 60 * 1000;

/** Reads a device credential carried by the Authorization header. */
export function bearerToken(authorization: string | undefined): string | undefined {
  return /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(authorization ?? "")?.[1];
}

/** Where the one-time setup code is kept while no account exists (a 0600 file in the data folder). */
export interface SetupCodeStore {
  read(): string | undefined;
  write(code: string): void;
  remove(): void;
}

interface AccountRow extends Record<string, unknown> {
  password_hash: string;
  password_salt: string;
  iterations: number;
  totp_secret: string;
  totp_last_step: number;
}

/** A signed-in device as the device list shows it (GLOSSARY: Device). */
export interface DeviceRecord {
  id: string;
  label: string;
  kind: ClientKind;
  createdAt: number;
  lastSeenAt: number;
}
/** What a new sign-in says about itself. */
export interface NewDevice {
  kind: ClientKind;
  label: string;
}
/** A fresh device credential: the token goes to the client once and only its hash is kept. */
export interface SignedIn {
  token: string;
  deviceId: string;
}
interface DeviceRow {
  id: string;
  token_hash: string;
  label: string;
  client_kind: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}
const WEB_DEVICE: NewDevice = { kind: "web", label: "" };
const toDevice = (row: DeviceRow): DeviceRecord => ({
  id: row.id,
  label: row.label,
  kind: row.client_kind as ClientKind,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

const rateLimited = () => new HttpError(429, "rate_limited", "Too many failed attempts. Try again in 15 minutes.");
const badCredentials = () => new HttpError(401, "bad_credentials", "The password or code is wrong.");
const alreadySetUp = () => new HttpError(409, "already_set_up", "This server already has an account.");
const badSetupCode = () => new HttpError(403, "bad_setup_code", "The setup code is wrong.");

export class AuthService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #codes: SetupCodeStore;
  readonly #log: Logger;
  #setupCode: string | undefined;
  readonly #issuer: string;
  readonly #passkeys: Passkeys;
  readonly #revocationListeners = new Map<string, Set<() => void>>();

  constructor(db: Db, clock: Clock, codes: SetupCodeStore, log: Logger, webauthn: WebAuthnEngine, issuer = "Rei") {
    this.#passkeys = new Passkeys(db, clock, webauthn, issuer);
    this.#db = db;
    this.#clock = clock;
    this.#codes = codes;
    this.#log = log;
    this.#issuer = issuer;
  }

  hasAccount(): boolean {
    return this.#db.get<{ id: number }>("SELECT id FROM account WHERE id = 1") !== undefined;
  }

  /**
   * On start: with no account, make sure a setup code exists (reuse the file's, else generate and write it) and return
   * it for the caller to print. With an account, delete any leftover code file and return undefined.
   */
  prepareSetupCode(): string | undefined {
    if (this.hasAccount()) {
      this.#codes.remove();
      this.#setupCode = undefined;
      return undefined;
    }
    let code = this.#codes.read()?.trim();
    if (!code || code.length < 8) {
      code = randomBase32(12);
      this.#codes.write(code);
    }
    this.#setupCode = code;
    return code;
  }

  // ---- rate limit ----------------------------------------------------------------------------------------------------

  #failures(kind: string): number {
    const since = this.#clock.now() - RATE_WINDOW_MS;
    return (
      this.#db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM login_attempts WHERE kind = ? AND ok = 0 AND at > ?",
        kind,
        since,
      )?.n ?? 0
    );
  }
  #record(kind: string, ok: boolean): void {
    const now = this.#clock.now();
    this.#db.run("INSERT INTO login_attempts (kind, at, ok) VALUES (?, ?, ?)", kind, now, ok ? 1 : 0);
    // Old rows are only needed for the window.
    this.#db.run("DELETE FROM login_attempts WHERE at < ?", now - 24 * RATE_WINDOW_MS);
  }

  // ---- setup -----------------------------------------------------------------------------------------------------------

  async #checkSetupCode(code: string): Promise<void> {
    if (this.#failures("setup") >= RATE_MAX_FAILURES) throw rateLimited();
    const expected = this.#setupCode;
    const ok = expected !== undefined && timingSafeEqual(await sha256(code), await sha256(expected));
    if (!ok) {
      this.#record("setup", false);
      throw badSetupCode();
    }
  }

  totpEnabled(): boolean {
    return Boolean(this.#db.get<AccountRow>("SELECT * FROM account WHERE id = 1")?.totp_secret);
  }

  async setupStart(setupCode: string, password: string, device: NewDevice = WEB_DEVICE): Promise<SignedIn> {
    if (this.hasAccount()) throw alreadySetUp();
    await this.#checkSetupCode(setupCode);
    if (password.length < MIN_PASSWORD_LENGTH)
      throw new HttpError(400, "weak_password", `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    const record = await hashPassword(password);
    this.#db.run(
      "INSERT INTO account (id, password_hash, password_salt, iterations, totp_secret, created_at) VALUES (1, ?, ?, ?, '', ?)",
      record.hash,
      record.salt,
      record.iterations,
      this.#clock.now(),
    );
    this.#codes.remove();
    this.#setupCode = undefined;
    this.#log.info("auth.account_created");
    return this.#newDevice(device);
  }

  async #checkPassword(password: string): Promise<AccountRow> {
    if (this.#failures("security") >= RATE_MAX_FAILURES) throw rateLimited();
    const account = this.#db.get<AccountRow>("SELECT * FROM account WHERE id = 1");
    if (
      !account ||
      !(await verifyPassword(password, {
        hash: account.password_hash,
        salt: account.password_salt,
        iterations: account.iterations,
      }))
    ) {
      this.#record("security", false);
      throw badCredentials();
    }
    return account;
  }

  async startTotp(password: string): Promise<{ totpUri: string; totpSecret: string }> {
    await this.#checkPassword(password);
    if (this.totpEnabled()) throw new HttpError(409, "totp_enabled", "Two-factor authentication is already enabled.");
    const secret = newTotpSecret();
    this.#db.run(
      "INSERT OR REPLACE INTO setup_pending (id, password_hash, password_salt, iterations, totp_secret, created_at) VALUES (1, '', '', 0, ?, ?)",
      secret,
      this.#clock.now(),
    );
    return { totpUri: otpauthUri(secret, "owner", this.#issuer), totpSecret: secret };
  }

  async confirmTotp(password: string, code: string): Promise<void> {
    await this.#checkPassword(password);
    const pending = this.#db.get<AccountRow & { created_at: number }>("SELECT * FROM setup_pending WHERE id = 1");
    if (!pending || this.#clock.now() - pending.created_at > 10 * 60_000)
      throw new HttpError(400, "totp_expired", "Authenticator setup expired. Start again.");
    const step = await verifyTotp(pending.totp_secret, code, this.#clock.now(), 0);
    if (step === null) {
      this.#record("security", false);
      throw new HttpError(400, "bad_totp", "The authenticator code is wrong.");
    }
    this.#db.transaction(() => {
      if (this.totpEnabled()) throw new HttpError(409, "totp_enabled", "Two-factor authentication is already enabled.");
      this.#db.run("UPDATE account SET totp_secret = ?, totp_last_step = ? WHERE id = 1", pending.totp_secret, step);
      this.#db.run("DELETE FROM setup_pending");
    });
    this.#log.info("auth.totp_enabled");
  }

  async disableTotp(password: string, code: string): Promise<void> {
    const account = await this.#checkPassword(password);
    if (!account.totp_secret) throw new HttpError(409, "totp_disabled", "Two-factor authentication is already off.");
    const step = await verifyTotp(account.totp_secret, code, this.#clock.now(), account.totp_last_step);
    if (!account.totp_secret || step === null) {
      this.#record("security", false);
      throw badCredentials();
    }
    this.#db.transaction(() => {
      const changed = this.#db.run(
        "UPDATE account SET totp_secret = '', totp_last_step = 0 WHERE id = 1 AND totp_secret = ? AND totp_last_step < ?",
        account.totp_secret,
        step,
      ).changes;
      if (!changed) throw badCredentials();
      this.#db.run("DELETE FROM setup_pending");
    });
    this.#log.info("auth.totp_disabled");
  }

  // ---- login -----------------------------------------------------------------------------------------------------------

  /** Signs in as a new device. One error, `bad_credentials`, whichever part is wrong. */
  async login(password: string, totpCode = "", device: NewDevice = WEB_DEVICE): Promise<SignedIn> {
    if (this.#failures("login") >= RATE_MAX_FAILURES) {
      this.#log.warn("auth.rate_limited");
      throw rateLimited();
    }
    const account = this.#db.get<AccountRow>("SELECT * FROM account WHERE id = 1");
    const record: PasswordRecord | undefined = account
      ? { hash: account.password_hash, salt: account.password_salt, iterations: account.iterations }
      : undefined;
    // Always run both checks so the response time does not say which part was wrong.
    const passwordOk = record ? await verifyPassword(typeof password === "string" ? password : "", record) : false;
    const step = account?.totp_secret
      ? await verifyTotp(
          account.totp_secret,
          typeof totpCode === "string" ? totpCode : "",
          this.#clock.now(),
          account.totp_last_step,
        )
      : null;
    if (!account || !passwordOk || (account.totp_secret && step === null)) {
      this.#record("login", false);
      this.#log.warn("auth.login_failed");
      throw badCredentials();
    }
    // Burn the step; a concurrent login with the same code loses.
    const burned = !account.totp_secret
      ? 1
      : this.#db.run("UPDATE account SET totp_last_step = ? WHERE id = 1 AND totp_last_step < ?", step, step).changes;
    if (burned === 0) {
      this.#record("login", false);
      throw badCredentials();
    }
    this.#record("login", true);
    this.#log.info("auth.login", { clientKind: device.kind });
    return this.#newDevice(device);
  }

  // ---- passkeys (ADR 0016) -------------------------------------------------------------------------------------------

  hasPasskeys(): boolean {
    return this.#passkeys.count() > 0;
  }

  passkeys(): PasskeyRecord[] {
    return this.#passkeys.list();
  }

  /** Adding a passkey asks for the password again, like turning on TOTP does. */
  async passkeyRegisterOptions(password: string, rp: RelyingParty) {
    await this.#checkPassword(password);
    return this.#passkeys.registerOptions(rp);
  }

  async passkeyRegister(rp: RelyingParty, challengeId: string, response: Record<string, unknown>, label = "") {
    const passkey = await this.#passkeys.register(rp, challengeId, response, label);
    this.#log.info("auth.passkey_added");
    return passkey;
  }

  renamePasskey(id: string, label: string): PasskeyRecord {
    return this.#passkeys.rename(id, label);
  }

  removePasskey(id: string): void {
    this.#passkeys.remove(id);
    this.#log.info("auth.passkey_removed");
  }

  async passkeyLoginOptions(rp: RelyingParty) {
    if (!this.hasPasskeys()) throw new HttpError(404, "no_passkeys", "No passkey is registered yet.");
    return this.#passkeys.loginOptions(rp);
  }

  /**
   * Signs in as a new device with a passkey. The passkey is a possession factor the person unlocked (user verification
   * is required), so it stands in for the password and the TOTP code. Failures share the password sign-in's limit.
   */
  async passkeyLogin(
    rp: RelyingParty,
    challengeId: string,
    response: Record<string, unknown>,
    device: NewDevice = WEB_DEVICE,
  ): Promise<SignedIn> {
    if (this.#failures("login") >= RATE_MAX_FAILURES) {
      this.#log.warn("auth.rate_limited");
      throw rateLimited();
    }
    const ok = await this.#passkeys.verifyLogin(rp, challengeId, response);
    if (!ok) {
      this.#record("login", false);
      this.#log.warn("auth.passkey_login_failed");
      throw new HttpError(401, "bad_passkey", "That passkey was not accepted.");
    }
    this.#record("login", true);
    this.#log.info("auth.passkey_login", { clientKind: device.kind });
    return this.#newDevice(device);
  }

  // ---- devices -------------------------------------------------------------------------------------------------------

  async #newDevice(device: NewDevice): Promise<SignedIn> {
    const token = toBase64Url(randomBytes(32));
    const hash = await sha256Hex(token);
    const id = `dev_${toBase64Url(randomBytes(10))
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")}`;
    const now = this.#clock.now();
    this.#db.run(
      "INSERT INTO auth_sessions (token_hash, id, label, client_kind, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      hash,
      id,
      device.label.trim().slice(0, 60),
      device.kind,
      now,
      now,
      now + SESSION_TTL_MS,
    );
    return { token, deviceId: id };
  }

  /**
   * The live device a credential belongs to, or undefined; slides its 30-day expiry. `label` names a device that has
   * none yet (a sign-in from before devices existed, or a browser that sent no label), once.
   */
  async device(token: string | undefined, label?: string): Promise<DeviceRecord | undefined> {
    if (!token) return undefined;
    const hash = await sha256Hex(token);
    const row = this.#db.get<DeviceRow>("SELECT * FROM auth_sessions WHERE token_hash = ?", hash);
    const now = this.#clock.now();
    if (!row || row.revoked_at !== null || row.expires_at <= now) return undefined;
    if (now - row.last_seen_at > SLIDE_AFTER_MS) {
      this.#db.run(
        "UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
        now,
        now + SESSION_TTL_MS,
        hash,
      );
      row.last_seen_at = now;
    }
    if (row.label === "" && label) {
      row.label = label.slice(0, 60);
      this.#db.run("UPDATE auth_sessions SET label = ? WHERE token_hash = ?", row.label, hash);
    }
    return toDevice(row);
  }

  /** Every live device, most recently seen first. */
  devices(): DeviceRecord[] {
    return this.#db
      .all<DeviceRow>(
        "SELECT * FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC, created_at DESC",
        this.#clock.now(),
      )
      .map(toDevice);
  }

  #findLive(id: string): DeviceRow | undefined {
    return this.#db.get<DeviceRow>(
      "SELECT * FROM auth_sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?",
      id,
      this.#clock.now(),
    );
  }

  #live(id: string): DeviceRow {
    const row = this.#findLive(id);
    if (!row) throw new HttpError(404, "not_found", "No such device.");
    return row;
  }

  renameDevice(id: string, label: string): DeviceRecord {
    const row = this.#live(id);
    row.label = label.trim().slice(0, 60);
    if (row.label === "") throw new HttpError(400, "bad_request", "Give the device a name.");
    this.#db.run("UPDATE auth_sessions SET label = ? WHERE id = ?", row.label, id);
    return toDevice(row);
  }

  /** Revokes a device: its credential stops working at once. */
  revokeDevice(id: string): void {
    this.#live(id);
    this.#db.run("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", this.#clock.now(), id);
    this.#deviceRevoked(id);
    this.#log.info("auth.device_revoked");
  }

  /** Subscribes to revocation while the device is still live. Returns a function to unsubscribe. */
  watchDeviceRevocation(id: string, listener: () => void): (() => void) | undefined {
    // Recheck synchronously in case revocation raced the async credential lookup.
    if (!this.#findLive(id)) return undefined;
    const listeners = this.#revocationListeners.get(id) ?? new Set<() => void>();
    this.#revocationListeners.set(id, listeners);
    listeners.add(listener);
    return () => {
      if (listeners.delete(listener) && listeners.size === 0) this.#revocationListeners.delete(id);
    };
  }

  #deviceRevoked(id: string): void {
    const listeners = this.#revocationListeners.get(id);
    this.#revocationListeners.delete(id);
    for (const listener of listeners ?? []) listener();
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const revoked = this.#db.get<{ id: string }>(
      "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL RETURNING id",
      this.#clock.now(),
      await sha256Hex(token),
    );
    if (revoked) this.#deviceRevoked(revoked.id);
  }
}
