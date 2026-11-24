// Sign-in and devices (ADR 0011). Every sign-in creates a device; browsers carry its credential as the session cookie,
// native clients as a bearer token returned in the sign-in answer.

import { arr, bool, int, lit, map, obj, oneOf, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { defineRoute, named } from "./define.ts";
import { CLIENT_KINDS } from "./version.ts";

export const OkSchema = obj({ ok: lit(true) });
export type OkResponse = Static<typeof OkSchema>;

const deviceLabel = str({ minLength: 1, maxLength: 60, description: "What the user calls this device." });

export const AuthStateResponseSchema = obj({
  /** True until the account exists. While true, only the setup endpoints work. */
  setupRequired: bool(),
  signedIn: bool(),
  totpEnabled: bool(),
  /** True when at least one passkey is registered, so the sign-in page can offer it. */
  passkeys: opt(bool()),
  deviceId: opt(str({ description: "The device this request signed in as, when signed in." })),
});
export type AuthStateResponse = Static<typeof AuthStateResponseSchema>;

export const SetupStartRequestSchema = obj({
  setupCode: str(),
  /** At least 12 characters. */
  password: str(),
  deviceLabel: opt(deviceLabel),
});
export type SetupStartRequest = Static<typeof SetupStartRequestSchema>;

export const LoginRequestSchema = obj({
  password: str(),
  totpCode: opt(str()),
  deviceLabel: opt(deviceLabel),
});
export type LoginRequest = Static<typeof LoginRequestSchema>;

export const SignedInResponseSchema = obj({
  ok: lit(true),
  deviceId: str(),
  token: opt(
    str({
      description:
        "The device credential, for native clients only (send it as `Authorization: Bearer`). Browsers get the cookie instead.",
    }),
  ),
});
export type SignedInResponse = Static<typeof SignedInResponseSchema>;
/** @deprecated Kept for the web client's typing; the answer is SignedInResponse. */
export type SetupStartResponse = SignedInResponse;

export const PasswordRequestSchema = obj({ password: str() });
export const PasswordCodeRequestSchema = obj({ password: str(), totpCode: str() });

export const TotpSetupResponseSchema = obj({ totpUri: str(), totpSecret: str() });
export type TotpSetupResponse = Static<typeof TotpSetupResponseSchema>;

// ---- passkeys ----------------------------------------------------------------------------------------------------------

/** A WebAuthn options or response document: the browser's JSON form, passed through unchanged. */
const WebAuthnJsonSchema = map(unknown());

export const PasskeySchema = named(
  "Passkey",
  obj({
    id: str({ description: "The credential id (base64url)." }),
    label: str(),
    createdAt: int(),
    lastUsedAt: opt(int()),
    /** True for a passkey the platform syncs between the user's devices. */
    synced: bool(),
  }),
);
export type Passkey = Static<typeof PasskeySchema>;
export const PasskeysResponseSchema = obj({ passkeys: arr(PasskeySchema) });
export type PasskeysResponse = Static<typeof PasskeysResponseSchema>;

export const PasskeyOptionsResponseSchema = obj({
  challengeId: str({
    description: "Send this back with the browser's answer; the challenge works once, for 5 minutes.",
  }),
  options: WebAuthnJsonSchema,
});
export type PasskeyOptionsResponse = Static<typeof PasskeyOptionsResponseSchema>;

export const PasskeyLoginRequestSchema = obj({
  challengeId: str(),
  /** `AuthenticationResponseJSON` from `navigator.credentials.get`. */
  response: WebAuthnJsonSchema,
  deviceLabel: opt(deviceLabel),
});
export type PasskeyLoginRequest = Static<typeof PasskeyLoginRequestSchema>;

export const PasskeyRegisterRequestSchema = obj({
  challengeId: str(),
  /** `RegistrationResponseJSON` from `navigator.credentials.create`. */
  response: WebAuthnJsonSchema,
  label: opt(str({ minLength: 1, maxLength: 60, description: "What the user calls this passkey." })),
});
export type PasskeyRegisterRequest = Static<typeof PasskeyRegisterRequestSchema>;

export const RenamePasskeyRequestSchema = obj({
  label: str({ minLength: 1, maxLength: 60 }),
});

// ---- devices -----------------------------------------------------------------------------------------------------------

export const CHANNEL_KINDS = ["webpush", "apns", "fcm"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const DeliveryChannelSchema = named(
  "DeliveryChannel",
  obj({
    id: str(),
    kind: oneOf(CHANNEL_KINDS),
    /** active: notifications go out; not_configured: this server has no adapter or credentials for the kind yet;
     * failing: the last attempts did not get through. */
    state: oneOf(["active", "not_configured", "failing"]),
    createdAt: int(),
    lastOkAt: opt(int()),
  }),
);
export type DeliveryChannel = Static<typeof DeliveryChannelSchema>;

export const DeviceSchema = named(
  "Device",
  obj({
    id: str(),
    label: str(),
    kind: oneOf(CLIENT_KINDS),
    createdAt: int(),
    lastSeenAt: int(),
    /** The device this request came from. */
    current: bool(),
    /** Visible and used recently (holds push notifications for every device). */
    active: bool(),
    channels: arr(DeliveryChannelSchema),
  }),
);
export type Device = Static<typeof DeviceSchema>;

export const DevicesResponseSchema = obj({ devices: arr(DeviceSchema) });
export type DevicesResponse = Static<typeof DevicesResponseSchema>;

export const RenameDeviceRequestSchema = obj({ label: deviceLabel });
export type RenameDeviceRequest = Static<typeof RenameDeviceRequestSchema>;

const BASE64URL = "^[A-Za-z0-9_-]+={0,2}$";
/** A browser's push subscription as `PushSubscription.toJSON()` gives it (other fields it may add are ignored). */
const webPushSubscription = obj(
  {
    endpoint: str({ minLength: 9, maxLength: 2000, pattern: "^https://" }),
    keys: obj(
      {
        p256dh: str({ minLength: 1, maxLength: 200, pattern: BASE64URL }),
        auth: str({ minLength: 1, maxLength: 100, pattern: BASE64URL }),
      },
      { open: true },
    ),
  },
  { open: true },
);

export const RegisterChannelRequestSchema = union([
  obj({ kind: lit("webpush"), subscription: webPushSubscription }),
  obj({ kind: lit("apns"), token: str({ minLength: 1, maxLength: 512 }) }),
  obj({ kind: lit("fcm"), token: str({ minLength: 1, maxLength: 4096 }) }),
]);
export type RegisterChannelRequest = Static<typeof RegisterChannelRequestSchema>;

export const ChannelResponseSchema = obj({ channel: DeliveryChannelSchema });
export type ChannelResponse = Static<typeof ChannelResponseSchema>;

export const DevicePresenceRequestSchema = obj({
  visible: bool(),
  /** How long ago the user last touched this device, in milliseconds (the client's own clock never travels). */
  idleMs: opt(int({ minimum: 0 })),
});
export type DevicePresenceRequest = Static<typeof DevicePresenceRequestSchema>;

// ---- routes ------------------------------------------------------------------------------------------------------------

export const authStateRoute = defineRoute({
  method: "GET",
  path: "/api/auth/state",
  tag: "auth",
  summary: "Whether the server needs setup, whether this request is signed in, and whether TOTP is on.",
  auth: "open",
  response: AuthStateResponseSchema,
});
export const setupRoute = defineRoute({
  method: "POST",
  path: "/api/auth/setup",
  tag: "auth",
  summary: "Create the one account with the printed setup code, and sign in as a new device.",
  description: "Errors: bad_setup_code, weak_password, already_set_up, rate_limited.",
  auth: "open",
  body: SetupStartRequestSchema,
  response: SignedInResponseSchema,
});
export const loginRoute = defineRoute({
  method: "POST",
  path: "/api/auth/login",
  tag: "auth",
  summary: "Sign in with the password (and TOTP code when on) as a new device.",
  description:
    "A native client (x-rei-client names a native kind) gets the device credential in `token`; a browser gets the cookie. Errors: bad_credentials (whichever part is wrong), rate_limited.",
  auth: "open",
  body: LoginRequestSchema,
  response: SignedInResponseSchema,
});
export const passkeyLoginOptionsRoute = defineRoute({
  method: "POST",
  path: "/api/auth/passkeys/login/options",
  tag: "auth",
  summary: "Start a passkey sign-in; answers the options for `navigator.credentials.get`.",
  description: "Errors: no_passkeys, rate_limited.",
  auth: "open",
  response: PasskeyOptionsResponseSchema,
});
export const passkeyLoginRoute = defineRoute({
  method: "POST",
  path: "/api/auth/passkeys/login",
  tag: "auth",
  summary: "Finish a passkey sign-in as a new device. The passkey replaces the password and the TOTP code.",
  description:
    "Answers like the password sign-in: a native client gets the credential in `token`, a browser the cookie. Errors: bad_passkey, passkey_expired, rate_limited.",
  auth: "open",
  body: PasskeyLoginRequestSchema,
  response: SignedInResponseSchema,
});
export const passkeyRegisterOptionsRoute = defineRoute({
  method: "POST",
  path: "/api/auth/passkeys/register/options",
  tag: "auth",
  summary: "Start adding a passkey; answers the options for `navigator.credentials.create`.",
  description: "Needs the account password. Errors: bad_credentials, rate_limited.",
  body: PasswordRequestSchema,
  response: PasskeyOptionsResponseSchema,
});
export const passkeyRegisterRoute = defineRoute({
  method: "POST",
  path: "/api/auth/passkeys/register",
  tag: "auth",
  summary: "Finish adding a passkey with the browser's answer.",
  description: "Errors: bad_passkey, passkey_expired.",
  body: PasskeyRegisterRequestSchema,
  response: PasskeySchema,
});
export const listPasskeysRoute = defineRoute({
  method: "GET",
  path: "/api/auth/passkeys",
  tag: "auth",
  summary: "Every registered passkey, oldest first.",
  response: PasskeysResponseSchema,
});
export const renamePasskeyRoute = defineRoute({
  method: "PATCH",
  path: "/api/auth/passkeys/:id",
  tag: "auth",
  summary: "Rename a passkey.",
  body: RenamePasskeyRequestSchema,
  response: PasskeySchema,
});
export const removePasskeyRoute = defineRoute({
  method: "DELETE",
  path: "/api/auth/passkeys/:id",
  tag: "auth",
  summary: "Remove a passkey; it can no longer sign in.",
  response: OkSchema,
});
export const logoutRoute = defineRoute({
  method: "POST",
  path: "/api/auth/logout",
  tag: "auth",
  summary: "Sign out: revoke this device.",
  response: OkSchema,
});
export const totpStartRoute = defineRoute({
  method: "POST",
  path: "/api/auth/totp/start",
  tag: "auth",
  summary: "Start turning on TOTP; answers the secret to enrol.",
  body: PasswordRequestSchema,
  response: TotpSetupResponseSchema,
});
export const totpConfirmRoute = defineRoute({
  method: "POST",
  path: "/api/auth/totp/confirm",
  tag: "auth",
  summary: "Finish turning on TOTP with a first code.",
  body: PasswordCodeRequestSchema,
  response: OkSchema,
});
export const totpDisableRoute = defineRoute({
  method: "POST",
  path: "/api/auth/totp/disable",
  tag: "auth",
  summary: "Turn TOTP off.",
  body: PasswordCodeRequestSchema,
  response: OkSchema,
});

export const listDevicesRoute = defineRoute({
  method: "GET",
  path: "/api/devices",
  tag: "devices",
  summary: "Every signed-in device, most recently seen first.",
  response: DevicesResponseSchema,
});
export const renameDeviceRoute = defineRoute({
  method: "PATCH",
  path: "/api/devices/:id",
  tag: "devices",
  summary: "Rename a device.",
  body: RenameDeviceRequestSchema,
  response: DeviceSchema,
});
export const revokeDeviceRoute = defineRoute({
  method: "DELETE",
  path: "/api/devices/:id",
  tag: "devices",
  summary: "Revoke a device: its credential stops working and its delivery channels are removed.",
  response: OkSchema,
});
export const registerChannelRoute = defineRoute({
  method: "POST",
  path: "/api/devices/current/channels",
  tag: "devices",
  summary: "Register a delivery channel for this device (Web Push, APNs or FCM). Registering again updates it.",
  description:
    "An APNs or FCM channel is accepted and stored, and reported as not_configured until this server can send to it.",
  body: RegisterChannelRequestSchema,
  response: ChannelResponseSchema,
});
export const removeChannelRoute = defineRoute({
  method: "DELETE",
  path: "/api/devices/current/channels/:channelId",
  tag: "devices",
  summary: "Remove one of this device's delivery channels.",
  response: OkSchema,
});
export const presenceRoute = defineRoute({
  method: "POST",
  path: "/api/devices/current/presence",
  tag: "devices",
  summary: "Report whether this device is visible and how long it has been idle.",
  description:
    "A device is active while visible and touched within the last 2 minutes; while any device is active, push notifications are held on every device.",
  body: DevicePresenceRequestSchema,
  response: OkSchema,
});

export const authRoutes = [
  authStateRoute,
  setupRoute,
  loginRoute,
  passkeyLoginOptionsRoute,
  passkeyLoginRoute,
  passkeyRegisterOptionsRoute,
  passkeyRegisterRoute,
  listPasskeysRoute,
  renamePasskeyRoute,
  removePasskeyRoute,
  logoutRoute,
  totpStartRoute,
  totpConfirmRoute,
  totpDisableRoute,
  listDevicesRoute,
  renameDeviceRoute,
  revokeDeviceRoute,
  registerChannelRoute,
  removeChannelRoute,
  presenceRoute,
];
