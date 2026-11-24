import { CSRF_HEADER, SESSION_COOKIE } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { deviceLabel } from "../src/auth/device-label.ts";
import { totpCode } from "../src/auth/totp.ts";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { ACTIVE_MS, PRESENCE_MS } from "../src/notify/service.ts";
import { Client } from "./helpers/client.ts";
import { PASSWORD, startSignedIn, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const PUSH = {
  endpoint: "https://fcm.googleapis.com/fcm/send/dev1",
  keys: {
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  },
};

/** A second client of the same server, signed in as its own browser. */
async function browser(s: TestServer & { totpSecret: string }, userAgent: string): Promise<Client> {
  const client = new Client((path, init) => Promise.resolve(s.host.plane.app.request(path, init)));
  s.clock.advance(31_000); // a fresh TOTP step: each step signs in once
  const res = await client.post(
    "/api/auth/login",
    { password: PASSWORD, totpCode: await totpCode(s.totpSecret, s.clock.now()) },
    { headers: { "user-agent": userAgent } },
  );
  expect(res.status).toBe(200);
  return client;
}

/** A native app: it names itself, and keeps its credential from the answer. */
async function nativeLogin(s: TestServer & { totpSecret: string }, label?: string) {
  s.clock.advance(31_000);
  const res = await s.host.plane.app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-rei-client": "ios/1" },
    body: JSON.stringify({
      password: PASSWORD,
      totpCode: await totpCode(s.totpSecret, s.clock.now()),
      ...(label ? { deviceLabel: label } : {}),
    }),
  });
  return { res, body: (await res.json()) as { ok: boolean; deviceId: string; token?: string } };
}

const withBearer = (s: TestServer, token: string, path: string, init: RequestInit = {}) =>
  s.host.plane.app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "x-rei-client": "ios/1", ...(init.headers ?? {}) },
  });

describe("devices", () => {
  it("names a browser from its user agent", () => {
    expect(
      deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"),
    ).toBe("Safari on macOS");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(deviceLabel(undefined)).toBe("Browser");
    expect(deviceLabel("anything", "android")).toBe("Android device");
  });

  it("lists every signed-in device, marks the current one, renames and revokes", async () => {
    server = await startSignedIn();
    const other = await browser(server, "Mozilla/5.0 (Windows NT 10.0) Firefox/131.0");
    const list = await server.client.get("/api/devices");
    expect(list.status).toBe(200);
    expect(list.body.devices).toHaveLength(2);
    const mine = list.body.devices.find((d: { current: boolean }) => d.current);
    const theirs = list.body.devices.find((d: { current: boolean }) => !d.current);
    expect(theirs).toMatchObject({ label: "Firefox on Windows", kind: "web", active: false, channels: [] });

    const renamed = await server.client.call("PATCH", `/api/devices/${theirs.id}`, { body: { label: "Work PC" } });
    expect(renamed.body).toMatchObject({ id: theirs.id, label: "Work PC", current: false });
    expect((await server.client.call("PATCH", `/api/devices/${theirs.id}`, { body: { label: "" } })).status).toBe(400);
    expect((await server.client.call("PATCH", "/api/devices/dev_nope", { body: { label: "x" } })).status).toBe(404);

    expect((await other.get("/api/auth/state")).body.signedIn).toBe(true);
    expect((await server.client.call("DELETE", `/api/devices/${theirs.id}`)).body).toEqual({ ok: true });
    expect((await other.get("/api/auth/state")).body.signedIn).toBe(false);
    expect((await other.get("/api/devices")).status).toBe(401);
    expect((await server.client.get("/api/devices")).body.devices.map((d: { id: string }) => d.id)).toEqual([mine.id]);

    // Revoking the device you are on signs you out.
    const self = await server.client.raw("DELETE", `/api/devices/${mine.id}`);
    expect(self.headers.get("set-cookie")).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
    expect((await server.client.get("/api/auth/state")).body.signedIn).toBe(false);
  });

  it("rejects pre-device databases without migrating credentials", () => {
    const db = openSqliteDb(":memory:");
    try {
      db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, network_mode TEXT);
        CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
        INSERT INTO auth_sessions VALUES ('h1', 1, 1, 9999999999999, NULL), ('h2', 1, 1, 9999999999999, NULL);
        CREATE TABLE push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL, last_ok_at INTEGER, failures INTEGER NOT NULL DEFAULT 0);
        INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at) VALUES ('https://push.example/1', 'k', 'a', 'Phone', 1);
        PRAGMA user_version = 14`);
      expect(() => initializeDatabase(db)).toThrow(/schema 14, older than this release upgrades.*Nothing was changed/);
      expect(db.all("SELECT token_hash FROM auth_sessions ORDER BY token_hash")).toEqual([
        { token_hash: "h1" },
        { token_hash: "h2" },
      ]);
      expect(db.get("SELECT name FROM sqlite_master WHERE name='read_markers'")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("native sign-in", () => {
  it("answers a native client's credential in the body and sets no cookie", async () => {
    server = await startSignedIn();
    const { res, body } = await nativeLogin(server, "Alex's phone");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(body).toEqual({ ok: true, deviceId: expect.stringMatching(/^dev_/), token: expect.any(String) });
    const devices = (await server.client.get("/api/devices")).body.devices;
    expect(devices.find((d: { id: string }) => d.id === body.deviceId)).toMatchObject({
      label: "Alex's phone",
      kind: "ios",
    });
  });

  it("accepts the bearer credential without the CSRF header, and keeps the header for cookies", async () => {
    server = await startSignedIn();
    const { body } = await nativeLogin(server);
    const token = body.token!;
    const state = await withBearer(server, token, "/api/auth/state");
    expect(await state.json()).toMatchObject({ signedIn: true, deviceId: body.deviceId });
    const write = await withBearer(server, token, "/api/devices/current/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visible: true }),
    });
    expect(write.status).toBe(200);
    // A cookie request without the header is still refused.
    expect(
      (await server.client.raw("POST", "/api/devices/current/presence", { body: { visible: true }, csrf: false }))
        .status,
    ).toBe(403);
    // A malformed bearer is no credential at all.
    expect((await withBearer(server, "short", "/api/devices")).status).toBe(401);
  });

  it("signs out by revoking the device, and refuses the credential afterwards", async () => {
    server = await startSignedIn();
    const { body } = await nativeLogin(server);
    const out = await withBearer(server, body.token!, "/api/auth/logout", { method: "POST" });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toBeNull();
    expect((await withBearer(server, body.token!, "/api/devices")).status).toBe(401);
    expect((await server.client.get("/api/devices")).body.devices).toHaveLength(1);
  });

  it("needs the TOTP code like the web, and expires after 30 days unused", async () => {
    server = await startSignedIn();
    const wrong = await server.host.plane.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rei-client": "android/1" },
      body: JSON.stringify({ password: PASSWORD, totpCode: "000000" }),
    });
    expect(wrong.status).toBe(401);
    const { body } = await nativeLogin(server);
    server.clock.advance(31 * 24 * 3600 * 1000);
    expect((await withBearer(server, body.token!, "/api/devices")).status).toBe(401);
  });

  it("validates the sign-in body against the contract", async () => {
    server = await startSignedIn();
    const res = await server.client.post("/api/auth/login", { password: 12, extra: true });
    expect(res.status).toBe(400);
    expect(res.body.error.issues.map((i: { path: string }) => i.path).sort()).toEqual(["/extra", "/password"]);
  });
});

describe("delivery channels", () => {
  it("registers channels per device; native kinds wait as not configured", async () => {
    server = await startSignedIn();
    const web = await server.client.post("/api/devices/current/channels", { kind: "webpush", subscription: PUSH });
    expect(web.status).toBe(200);
    expect(web.body.channel).toMatchObject({ kind: "webpush", state: "active", id: expect.stringMatching(/^ch_/) });
    const apns = await server.client.post("/api/devices/current/channels", { kind: "apns", token: "a1b2c3" });
    expect(apns.body.channel).toMatchObject({ kind: "apns", state: "not_configured" });
    // Registering again refreshes the same channel.
    const again = await server.client.post("/api/devices/current/channels", { kind: "apns", token: "a1b2c3" });
    expect(again.body.channel.id).toBe(apns.body.channel.id);

    const [device] = (await server.client.get("/api/devices")).body.devices;
    expect(device.channels.map((c: { kind: string }) => c.kind)).toEqual(["webpush", "apns"]);

    expect((await server.client.call("DELETE", `/api/devices/current/channels/${apns.body.channel.id}`)).body).toEqual({
      ok: true,
    });
    expect((await server.client.call("DELETE", "/api/devices/current/channels/ch_999")).status).toBe(404);
    expect((await server.client.get("/api/devices")).body.devices[0].channels).toHaveLength(1);
  });

  it("refuses a push endpoint that is not https, and removes a revoked device's channels", async () => {
    server = await startSignedIn();
    const bad = await server.client.post("/api/devices/current/channels", {
      kind: "webpush",
      subscription: { ...PUSH, endpoint: "http://push.example/1" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.issues[0].path).toBe("/subscription/endpoint");
    const { body } = await nativeLogin(server);
    await withBearer(server, body.token!, "/api/devices/current/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "fcm", token: "fcm-token" }),
    });
    expect(server.host.plane.store.db.all("SELECT id FROM push_subscriptions")).toHaveLength(1);
    await server.client.call("DELETE", `/api/devices/${body.deviceId}`);
    expect(server.host.plane.store.db.all("SELECT id FROM push_subscriptions")).toHaveLength(0);
  });
});

describe("per-device presence", () => {
  it("counts a device as active only while visible and recently touched", async () => {
    server = await startSignedIn();
    const notify = server.host.plane.notifications;
    const [me] = (await server.client.get("/api/devices")).body.devices;
    const post = (body: unknown) => server!.client.post("/api/devices/current/presence", body);

    await post({ visible: true, idleMs: ACTIVE_MS + 1 });
    expect(notify.active(me.id)).toBe(false);
    await post({ visible: true, idleMs: 0 });
    expect(notify.active(me.id)).toBe(true);
    expect((await server.client.get("/api/devices")).body.devices[0].active).toBe(true);
    // Idle time keeps counting on the server's clock after the report.
    server.clock.advance(ACTIVE_MS);
    expect(notify.active(me.id)).toBe(false);
    // A report that is not renewed lapses.
    await post({ visible: true, idleMs: 0 });
    server.clock.advance(PRESENCE_MS);
    expect(notify.active(me.id)).toBe(false);
    await post({ visible: false });
    expect(notify.active(me.id)).toBe(false);
    expect((await post({ visible: "yes" })).status).toBe(400);
  });

  it("keeps a hidden idle browser from holding push for the other devices", async () => {
    server = await startSignedIn();
    const other = await browser(server, "Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36");
    const notify = server.host.plane.notifications;
    await other.post("/api/devices/current/presence", { visible: true, idleMs: 10 * 60_000 });
    await server.client.post("/api/devices/current/presence", { visible: false });
    const ids = (await server.client.get("/api/devices")).body.devices.map((d: { id: string }) => d.id);
    expect(ids.some((id: string) => notify.active(id))).toBe(false);
    await other.post("/api/devices/current/presence", { visible: true, idleMs: 0 });
    expect(ids.some((id: string) => notify.active(id))).toBe(true);
    expect(CSRF_HEADER).toBe("x-rei");
  });
});
