import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { totpCode } from "../src/auth/totp.ts";
import { PASSWORD, startTestServer, type TestServer } from "./helpers/server.ts";

let s: TestServer;
afterEach(async () => {
  await s?.destroy();
});
it("defaults to password-only, confirms enrollment, enforces codes, and disables with password and a fresh code", async () => {
  s = await startTestServer();
  const setupCode = readFileSync(join(s.dir, "setup-code.txt"), "utf8").trim();
  expect((await s.client.post("/api/auth/setup", { setupCode, password: PASSWORD })).status).toBe(200);
  expect((await s.client.get("/api/auth/state")).body.totpEnabled).toBe(false);
  await s.client.post("/api/auth/logout");
  expect((await s.client.post("/api/auth/login", { password: PASSWORD })).status).toBe(200);
  expect((await s.client.post("/api/auth/totp/start", { password: "wrong" })).status).toBe(401);
  const enrol = await s.client.post("/api/auth/totp/start", { password: PASSWORD });
  expect(enrol.body.totpUri).toMatch(/^otpauth:/);
  expect((await s.client.get("/api/auth/state")).body.totpEnabled).toBe(false);
  expect((await s.client.post("/api/auth/totp/confirm", { password: PASSWORD, totpCode: "bad" })).status).toBe(400);
  const code = () => totpCode(enrol.body.totpSecret, s.clock.now());
  expect((await s.client.post("/api/auth/totp/confirm", { password: PASSWORD, totpCode: await code() })).status).toBe(
    200,
  );
  await s.client.post("/api/auth/logout");
  expect((await s.client.post("/api/auth/login", { password: PASSWORD })).status).toBe(401);
  s.clock.advance(31_000);
  expect((await s.client.post("/api/auth/login", { password: PASSWORD, totpCode: await code() })).status).toBe(200);
  expect((await s.client.post("/api/auth/totp/disable", { password: PASSWORD, totpCode: await code() })).status).toBe(
    401,
  );
  s.clock.advance(31_000);
  expect((await s.client.post("/api/auth/totp/disable", { password: PASSWORD, totpCode: await code() })).status).toBe(
    200,
  );
  await s.client.post("/api/auth/logout");
  expect((await s.client.post("/api/auth/login", { password: PASSWORD })).status).toBe(200);
});
it("requires a signed-in session and expires unconfirmed enrollment", async () => {
  s = await startTestServer();
  await s.createAccount();
  s.host.plane.store.db.run("UPDATE account SET totp_secret = '', totp_last_step = 0");
  expect((await s.client.post("/api/auth/totp/start", { password: PASSWORD }, { csrf: false })).status).toBe(403);
  const enrol = await s.client.post("/api/auth/totp/start", { password: PASSWORD });
  s.clock.advance(601_000);
  expect(
    (
      await s.client.post("/api/auth/totp/confirm", {
        password: PASSWORD,
        totpCode: await totpCode(enrol.body.totpSecret, s.clock.now()),
      })
    ).body.error.code,
  ).toBe("totp_expired");
  await s.client.post("/api/auth/logout");
  expect((await s.client.post("/api/auth/totp/start", { password: PASSWORD })).status).toBe(401);
});
