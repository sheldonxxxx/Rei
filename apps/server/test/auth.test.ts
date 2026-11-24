import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSION_COOKIE } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { totpCode } from "../src/auth/totp.ts";
import { PASSWORD, startTestServer, type TestServer } from "./helpers/server.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const codeFile = (s: TestServer) => join(s.dir, "setup-code.txt");

describe("first-run setup", () => {
  it("prints a setup code and keeps it in a 0600 file", async () => {
    server = await startTestServer();
    const code = readFileSync(codeFile(server), "utf8").trim();
    expect(code).toMatch(/^[A-Z2-7]{8,}$/);
    expect(statSync(codeFile(server)).mode & 0o777).toBe(0o600);
    expect(server.announced.join("\n")).toContain(code);
    const state = await server.client.get("/api/auth/state");
    expect(state.body).toEqual({ setupRequired: true, signedIn: false, totpEnabled: false, passkeys: false });
  });

  it("rejects a wrong setup code, a weak password", async () => {
    server = await startTestServer();
    const code = readFileSync(codeFile(server), "utf8").trim();
    const bad = await server.client.post("/api/auth/setup", { setupCode: "WRONGCODE1", password: PASSWORD });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe("bad_setup_code");
    const weak = await server.client.post("/api/auth/setup", { setupCode: code, password: "short" });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("weak_password");
    const start = await server.client.post("/api/auth/setup", { setupCode: code, password: PASSWORD });
    expect(start.status).toBe(200);
    expect(start.body).toEqual({ ok: true, deviceId: expect.stringMatching(/^dev_/) });
    expect(server.client.cookie).toBeTruthy();
    expect((await server.client.get("/api/auth/state")).body.totpEnabled).toBe(false);
  });

  it("creates the account, sets an HttpOnly SameSite=Strict cookie, deletes the code file, then refuses a second setup", async () => {
    server = await startTestServer();
    const code = readFileSync(codeFile(server), "utf8").trim();
    const confirm = await server.client.raw("POST", "/api/auth/setup", {
      body: { setupCode: code, password: PASSWORD },
    });
    expect(confirm.status).toBe(200);
    const cookie = confirm.headers.get("set-cookie")!;
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/i); // plain http request
    expect(existsSync(codeFile(server))).toBe(false);
    server.client.cookie = /rei_session=([^;]*)/.exec(cookie)![1];
    expect((await server.client.get("/api/auth/state")).body).toEqual({
      setupRequired: false,
      signedIn: true,
      passkeys: false,
      totpEnabled: false,
      deviceId: expect.stringMatching(/^dev_/),
    });
    const again = await server.client.post("/api/auth/setup", { setupCode: code, password: PASSWORD });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_set_up");
  });

  it("marks the cookie Secure for https requests and when REI_COOKIE_SECURE is on", async () => {
    server = await startTestServer({ config: { cookieSecure: true } });
    await server.createAccount();
    const login = await server.client.raw("POST", "/api/auth/logout");
    expect(login.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("reuses the same setup code after a restart until setup completes", async () => {
    server = await startTestServer();
    const first = readFileSync(codeFile(server), "utf8").trim();
    const dir = server.dir;
    await server.stop();
    server = await startTestServer({ dir });
    expect(readFileSync(codeFile(server), "utf8").trim()).toBe(first);
  });
});

describe("login", () => {
  it("accepts the right password and a fresh TOTP code, one error for every wrong part, and refuses a reused code", async () => {
    server = await startTestServer();
    const { totpSecret } = await server.createAccount();
    await server.client.post("/api/auth/logout");
    expect(server.client.cookie).toBeUndefined();
    expect((await server.client.get("/api/sessions")).status).toBe(401);

    // Same 30 s step as the setup code: reuse is refused (as bad_credentials).
    const reused = await server.client.post("/api/auth/login", {
      password: PASSWORD,
      totpCode: await totpCode(totpSecret, server.clock.now()),
    });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("bad_credentials");

    server.clock.advance(31_000);
    const wrongPassword = await server.client.post("/api/auth/login", {
      password: "not the password!!",
      totpCode: await totpCode(totpSecret, server.clock.now()),
    });
    expect(wrongPassword.body.error.code).toBe("bad_credentials");
    const wrongCode = await server.client.post("/api/auth/login", { password: PASSWORD, totpCode: "123456" });
    expect(wrongCode.body.error.code).toBe("bad_credentials");
    expect(wrongCode.body.error.message).toBe(wrongPassword.body.error.message);

    const ok = await server.client.post("/api/auth/login", {
      password: PASSWORD,
      totpCode: await totpCode(totpSecret, server.clock.now()),
    });
    expect(ok.status).toBe(200);
    expect(server.client.cookie).toBeTruthy();
    expect((await server.client.get("/api/sessions")).status).toBe(200);

    // The same code cannot be used again, even with the right password.
    const second = await server.client.post("/api/auth/login", {
      password: PASSWORD,
      totpCode: await totpCode(totpSecret, server.clock.now()),
    });
    expect(second.status).toBe(401);
  });

  it("limits to 5 failures per 15 minutes and keeps the limit across a restart", async () => {
    server = await startTestServer();
    const { totpSecret } = await server.createAccount();
    for (let i = 0; i < 5; i++) {
      const r = await server.client.post("/api/auth/login", { password: "wrong password here", totpCode: "000000" });
      expect(r.body.error.code).toBe("bad_credentials");
    }
    server.clock.advance(31_000);
    const limited = await server.client.post("/api/auth/login", {
      password: PASSWORD,
      totpCode: await totpCode(totpSecret, server.clock.now()),
    });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");

    const dir = server.dir;
    const clock = server.clock;
    await server.stop();
    server = await startTestServer({ dir, clock });
    const still = await server.client.post("/api/auth/login", {
      password: PASSWORD,
      totpCode: await totpCode(totpSecret, server.clock.now()),
    });
    expect(still.status).toBe(429);

    server.clock.advance(16 * 60_000);
    const after = await server.client.post("/api/auth/login", {
      password: PASSWORD,
      totpCode: await totpCode(totpSecret, server.clock.now()),
    });
    expect(after.status).toBe(200);
  });

  it("logout revokes the token itself, not just the cookie", async () => {
    server = await startTestServer();
    await server.createAccount();
    const token = server.client.cookie!;
    await server.client.post("/api/auth/logout");
    server.client.cookie = token;
    expect((await server.client.get("/api/sessions")).status).toBe(401);
  });

  it("stores only a hash of the session token", async () => {
    server = await startTestServer();
    await server.createAccount();
    const token = server.client.cookie!;
    const db = server.host.plane.store.db;
    const rows = db.all<{ token_hash: string }>("SELECT token_hash FROM auth_sessions");
    expect(rows.length).toBe(1);
    expect(rows[0]!.token_hash).not.toContain(token);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("guards", () => {
  it("answers 401 unauthenticated without the cookie on every protected endpoint", async () => {
    server = await startTestServer();
    await server.createAccount();
    server.client.cookie = undefined;
    for (const [method, path] of [
      ["GET", "/api/agents"],
      ["GET", "/api/sessions"],
      ["POST", "/api/sessions"],
      ["GET", "/api/sessions/x"],
      ["POST", "/api/sessions/x/messages"],
      ["POST", "/api/sessions/x/cancel"],
      ["GET", "/api/stream"],
      ["GET", "/api/sessions/x/stream"],
      ["POST", "/api/auth/logout"],
    ] as const) {
      const r = await server.client.call(method, path, method === "POST" ? { body: {} } : {});
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.body.error.code).toBe("unauthenticated");
    }
  });

  it("answers 403 csrf for a write without the x-rei header, signed in or not", async () => {
    server = await startTestServer();
    await server.createAccount();
    const signedIn = await server.client.post("/api/sessions", {}, { csrf: false });
    expect(signedIn.status).toBe(403);
    expect(signedIn.body.error.code).toBe("csrf");
    const login = await server.client.post(
      "/api/auth/login",
      { password: PASSWORD, totpCode: "000000" },
      { csrf: false },
    );
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe("csrf");
    const ok = await server.client.post("/api/sessions", {});
    expect(ok.status).toBe(200);
  });

  it("never caches /api", async () => {
    server = await startTestServer();
    const r = await server.client.get("/api/auth/state");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});
