import { afterEach, describe, expect, it } from "vitest";
import { totpCode } from "../src/auth/totp.ts";
import { SoftAuthenticator, strangerKey } from "./helpers/authenticator.ts";
import { Client } from "./helpers/client.ts";
import { PASSWORD, startTestServer, type TestServer } from "./helpers/server.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const RP_ID = "localhost";
const ORIGIN = "http://localhost";
const originHeader = { headers: { origin: ORIGIN } };

/** Registers `authenticator` through the API as the signed-in client. */
async function addPasskey(s: TestServer, authenticator: SoftAuthenticator, label?: string) {
  const start = await s.client.post("/api/auth/passkeys/register/options", { password: PASSWORD }, originHeader);
  expect(start.status).toBe(200);
  return s.client.post(
    "/api/auth/passkeys/register",
    {
      challengeId: start.body.challengeId,
      response: authenticator.register(start.body.options, RP_ID, ORIGIN),
      ...(label ? { label } : {}),
    },
    originHeader,
  );
}

/** A signed-out client's passkey sign-in; `tweak` changes what the authenticator sends. */
async function passkeyLogin(
  s: TestServer,
  authenticator: SoftAuthenticator,
  options: { origin?: string; counter?: number; signWith?: Parameters<SoftAuthenticator["assert"]>[3] } = {},
) {
  const client = new Client(s.client.fetcher);
  const start = await client.post("/api/auth/passkeys/login/options", undefined, originHeader);
  if (start.status !== 200) return { client, start, finish: start };
  const origin = options.origin ?? ORIGIN;
  const finish = await client.post(
    "/api/auth/passkeys/login",
    {
      challengeId: start.body.challengeId,
      response: authenticator.assert(start.body.options, RP_ID, origin, options.signWith ?? {}),
    },
    { headers: { origin } },
  );
  return { client, start, finish };
}

describe("registering a passkey", () => {
  it("needs the password, then stores a passkey that the list and the auth state show", async () => {
    server = await startTestServer();
    await server.createAccount();
    expect((await server.client.get("/api/auth/state")).body.passkeys).toBe(false);

    const wrong = await server.client.post("/api/auth/passkeys/register/options", { password: "not the password!!" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("bad_credentials");

    const key = new SoftAuthenticator({ synced: true });
    const added = await addPasskey(server, key, "Laptop");
    expect(added.status).toBe(200);
    expect(added.body).toEqual({ id: key.id, label: "Laptop", createdAt: expect.any(Number), synced: true });

    expect((await server.client.get("/api/auth/passkeys")).body.passkeys).toHaveLength(1);
    expect((await server.client.get("/api/auth/state")).body.passkeys).toBe(true);
    // A key already registered is excluded from the next registration, and registering it again is refused.
    const again = await server.client.post("/api/auth/passkeys/register/options", { password: PASSWORD }, originHeader);
    expect(again.body.options.excludeCredentials).toEqual([expect.objectContaining({ id: key.id })]);
  });

  it("refuses an authenticator that did not verify the person, a wrong origin, and a replayed challenge", async () => {
    server = await startTestServer();
    await server.createAccount();

    const unverified = new SoftAuthenticator();
    unverified.userVerified = false;
    const noUv = await addPasskey(server, unverified);
    expect(noUv.status).toBe(401);
    expect(noUv.body.error.code).toBe("bad_passkey");

    const start = await server.client.post("/api/auth/passkeys/register/options", { password: PASSWORD }, originHeader);
    const key = new SoftAuthenticator();
    const wrongOrigin = await server.client.post(
      "/api/auth/passkeys/register",
      { challengeId: start.body.challengeId, response: key.register(start.body.options, RP_ID, "http://evil.example") },
      originHeader,
    );
    expect(wrongOrigin.body.error.code).toBe("bad_passkey");
    // The challenge was spent by the failed attempt.
    const replay = await server.client.post(
      "/api/auth/passkeys/register",
      { challengeId: start.body.challengeId, response: key.register(start.body.options, RP_ID, ORIGIN) },
      originHeader,
    );
    expect(replay.body.error.code).toBe("passkey_expired");
    expect((await server.client.get("/api/auth/passkeys")).body.passkeys).toEqual([]);
  });

  it("answers 401 to every passkey management endpoint when signed out", async () => {
    server = await startTestServer();
    await server.createAccount();
    await server.client.post("/api/auth/logout");
    for (const [method, path] of [
      ["POST", "/api/auth/passkeys/register/options"],
      ["POST", "/api/auth/passkeys/register"],
      ["GET", "/api/auth/passkeys"],
      ["PATCH", "/api/auth/passkeys/x"],
      ["DELETE", "/api/auth/passkeys/x"],
    ] as const) {
      const res = await server.client.call(method, path, method === "GET" ? {} : { body: {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("renames and removes a passkey", async () => {
    server = await startTestServer();
    await server.createAccount();
    const key = new SoftAuthenticator();
    await addPasskey(server, key);
    const renamed = await server.client.call("PATCH", `/api/auth/passkeys/${key.id}`, { body: { label: "Phone" } });
    expect(renamed.body.label).toBe("Phone");
    expect((await server.client.call("PATCH", "/api/auth/passkeys/nope", { body: { label: "x" } })).status).toBe(404);
    expect((await server.client.call("DELETE", `/api/auth/passkeys/${key.id}`)).status).toBe(200);
    expect((await server.client.get("/api/auth/passkeys")).body.passkeys).toEqual([]);
    expect((await server.client.call("DELETE", `/api/auth/passkeys/${key.id}`)).status).toBe(404);
  });
});

describe("signing in with a passkey", () => {
  it("signs in as a new device without the password or the TOTP code, and remembers the counter", async () => {
    server = await startTestServer();
    await server.createAccount(); // TOTP is on
    const key = new SoftAuthenticator();
    await addPasskey(server, key);
    await server.client.post("/api/auth/logout");

    const { client, finish } = await passkeyLogin(server, key);
    expect(finish.status).toBe(200);
    expect(finish.body).toEqual({ ok: true, deviceId: expect.stringMatching(/^dev_/) });
    expect(client.cookie).toBeTruthy();
    expect((await client.get("/api/sessions")).status).toBe(200);
    const list = await client.get("/api/auth/passkeys");
    expect(list.body.passkeys[0].lastUsedAt).toEqual(expect.any(Number));
    // Two sign-ins are two devices.
    await passkeyLogin(server, key);
    expect((await client.get("/api/devices")).body.devices.length).toBeGreaterThanOrEqual(2);
  });

  it("gives a native client the token instead of the cookie", async () => {
    server = await startTestServer();
    await server.createAccount();
    const key = new SoftAuthenticator();
    await addPasskey(server, key);
    const client = new Client(server.client.fetcher);
    const start = await client.post("/api/auth/passkeys/login/options", undefined, originHeader);
    const finish = await client.post(
      "/api/auth/passkeys/login",
      { challengeId: start.body.challengeId, response: key.assert(start.body.options, RP_ID, ORIGIN) },
      { headers: { origin: ORIGIN, "x-rei-client": "ios/1" } },
    );
    expect(finish.status).toBe(200);
    expect(finish.body.token).toEqual(expect.any(String));
    expect(client.cookie).toBeUndefined();
  });

  it("refuses with one error: a stranger's signature, a foreign origin, an unknown key, a cloned counter", async () => {
    server = await startTestServer();
    await server.createAccount();
    const key = new SoftAuthenticator();
    await addPasskey(server, key);
    await server.client.post("/api/auth/logout");

    expect((await passkeyLogin(server, key, { signWith: { signWith: strangerKey() } })).finish.body.error.code).toBe(
      "bad_passkey",
    );
    expect((await passkeyLogin(server, key, { origin: "http://evil.example" })).finish.body.error.code).toBe(
      "bad_passkey",
    );
    expect((await passkeyLogin(server, new SoftAuthenticator())).finish.body.error.code).toBe("bad_passkey");
    // A good sign-in moves the counter to 1; one that arrives with an older counter is a clone.
    expect((await passkeyLogin(server, key, { signWith: { counter: 10 } })).finish.status).toBe(200);
    expect((await passkeyLogin(server, key, { signWith: { counter: 4 } })).finish.body.error.code).toBe("bad_passkey");
  });

  it("works once per challenge and not after five minutes", async () => {
    server = await startTestServer();
    await server.createAccount();
    const key = new SoftAuthenticator();
    await addPasskey(server, key);

    const client = new Client(server.client.fetcher);
    const start = await client.post("/api/auth/passkeys/login/options", undefined, originHeader);
    const body = { challengeId: start.body.challengeId, response: key.assert(start.body.options, RP_ID, ORIGIN) };
    expect((await client.post("/api/auth/passkeys/login", body, originHeader)).status).toBe(200);
    expect((await client.post("/api/auth/passkeys/login", body, originHeader)).status).toBe(401);

    const slow = await client.post("/api/auth/passkeys/login/options", undefined, originHeader);
    server.clock.advance(5 * 60_000 + 1000);
    const late = await client.post(
      "/api/auth/passkeys/login",
      { challengeId: slow.body.challengeId, response: key.assert(slow.body.options, RP_ID, ORIGIN) },
      originHeader,
    );
    expect(late.status).toBe(401);
    expect(late.body.error.code).toBe("bad_passkey");
  });

  it("shares the sign-in failure limit with the password", async () => {
    server = await startTestServer();
    await server.createAccount();
    const key = new SoftAuthenticator();
    await addPasskey(server, key);
    const stranger = new SoftAuthenticator();
    for (let i = 0; i < 5; i++)
      expect((await passkeyLogin(server, stranger)).finish.body.error.code).toBe("bad_passkey");
    expect((await passkeyLogin(server, key)).finish.status).toBe(429);
    const password = await new Client(server.client.fetcher).post("/api/auth/login", { password: PASSWORD });
    expect(password.status).toBe(429);
  });

  it("offers nothing until a passkey exists, and a removed passkey stops working", async () => {
    server = await startTestServer();
    await server.createAccount();
    const none = await new Client(server.client.fetcher).post(
      "/api/auth/passkeys/login/options",
      undefined,
      originHeader,
    );
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe("no_passkeys");

    const key = new SoftAuthenticator();
    const spare = new SoftAuthenticator();
    await addPasskey(server, key);
    await addPasskey(server, spare);
    await server.client.call("DELETE", `/api/auth/passkeys/${key.id}`);
    expect((await passkeyLogin(server, key)).finish.body.error.code).toBe("bad_passkey");
    expect((await passkeyLogin(server, spare)).finish.status).toBe(200);
  });

  it("builds the relying party from REI_PUBLIC_URL when it is set", async () => {
    server = await startTestServer({ config: { publicUrl: "https://rei.example.com" } });
    await server.createAccount();
    const start = await server.client.post("/api/auth/passkeys/register/options", { password: PASSWORD });
    expect(start.body.options.rp.id).toBe("rei.example.com");
    const key = new SoftAuthenticator();
    const added = await server.client.post(
      "/api/auth/passkeys/register",
      {
        challengeId: start.body.challengeId,
        response: key.register(start.body.options, "rei.example.com", "https://rei.example.com"),
      },
      { headers: { origin: "https://rei.example.com" } },
    );
    expect(added.status).toBe(200);
  });
});

describe("Android passkeys", () => {
  const RP = "rei.example.com";
  const APP_ORIGIN = `android:apk-key-hash:${"A".repeat(43)}`;
  const OTHER_ORIGIN = `android:apk-key-hash:${"E".repeat(43)}`;
  const headers = { "x-rei-client": "android/1" };

  it("requires explicit Android configuration even when a web passkey exists", async () => {
    server = await startTestServer();
    await server.createAccount();
    await addPasskey(server, new SoftAuthenticator());

    expect((await server.client.get("/api/auth/state", { headers })).body.passkeys).toBe(false);
    const login = await server.client.post("/api/auth/passkeys/login/options", undefined, { headers });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe("android_passkeys_disabled");
  });

  it("registers and verifies an Android passkey against its configured signing origin", async () => {
    server = await startTestServer({
      config: { publicUrl: `https://${RP}`, androidPasskeyOrigins: [APP_ORIGIN] },
    });
    const { totpSecret } = await server.createAccount();
    server.clock.advance(31_000);
    const client = new Client(server.client.fetcher);
    const auth = await client.post(
      "/api/auth/login",
      { password: PASSWORD, totpCode: await totpCode(totpSecret, server.clock.now()) },
      { headers },
    );
    expect(auth.status).toBe(200);
    const signedIn = { headers: { ...headers, authorization: `Bearer ${auth.body.token}` } };
    const key = new SoftAuthenticator();
    const start = await client.post("/api/auth/passkeys/register/options", { password: PASSWORD }, signedIn);
    expect(start.body.options.rp.id).toBe(RP);
    const registration = await client.post(
      "/api/auth/passkeys/register",
      { challengeId: start.body.challengeId, response: key.register(start.body.options, RP, APP_ORIGIN) },
      signedIn,
    );
    expect(registration.status).toBe(200);

    async function authenticate(origin: string, clientHeaders: Record<string, string>) {
      const options = await client.post("/api/auth/passkeys/login/options", undefined, { headers: clientHeaders });
      expect(options.status).toBe(200);
      return client.post(
        "/api/auth/passkeys/login",
        { challengeId: options.body.challengeId, response: key.assert(options.body.options, RP, origin) },
        { headers: clientHeaders },
      );
    }

    expect((await authenticate(OTHER_ORIGIN, headers)).body.error.code).toBe("bad_passkey");
    expect((await authenticate(APP_ORIGIN, {})).body.error.code).toBe("bad_passkey");
    const signedInByPasskey = await authenticate(APP_ORIGIN, headers);
    expect(signedInByPasskey.status).toBe(200);
    expect(signedInByPasskey.body.token).toEqual(expect.any(String));
  });
});
