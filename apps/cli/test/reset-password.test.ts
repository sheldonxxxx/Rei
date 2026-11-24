import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { verifyPassword } from "../../server/src/auth/password.ts";
import { RESET_SCRIPT, resetPassword } from "../src/commands/reset-password.ts";
import { makeRig } from "./fakes.ts";

describe("password recovery", () => {
  it("changes the password atomically, revokes sessions and preserves the authenticator and app data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rei-reset-"));
    const db = new DatabaseSync(join(dir, "app.sqlite"));
    try {
      db.exec(`CREATE TABLE account (id INTEGER PRIMARY KEY, password_hash TEXT, password_salt TEXT, iterations INTEGER, totp_secret TEXT);
        INSERT INTO account VALUES (1, 'old', 'old', 1, 'authenticator');
        CREATE TABLE auth_sessions (revoked_at INTEGER);
        INSERT INTO auth_sessions VALUES (NULL), (123);
        CREATE TABLE other_data (value TEXT);
        INSERT INTO other_data VALUES ('keep');`);
      const rig = makeRig();
      const password = "a sufficiently long password";
      rig.ctx.prompter = {
        interactive: true,
        askHidden: async () => password,
        ask: async () => "",
        confirm: async () => false,
      };
      rig.ctx.compose.exec = async (_service, _args, options) => {
        const child = spawnSync(process.execPath, ["-e", RESET_SCRIPT], {
          input: options?.input,
          env: { ...process.env, REI_DATA: dir },
          encoding: "utf8",
        });
        return { code: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
      };
      expect(await resetPassword(rig.ctx)).toBe(0);
      const account = db.prepare("SELECT * FROM account").get()!;
      expect(
        await verifyPassword(password, {
          hash: String(account.password_hash),
          salt: String(account.password_salt),
          iterations: Number(account.iterations),
        }),
      ).toBe(true);
      expect(account.totp_secret).toBe("authenticator");
      expect(db.prepare("SELECT revoked_at FROM auth_sessions WHERE revoked_at IS NULL").all()).toHaveLength(0);
      expect(db.prepare("SELECT value FROM other_data").get()?.value).toBe("keep");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not invoke Docker for a mismatch or noninteractive input", async () => {
    const rig = makeRig();
    let calls = 0;
    rig.ctx.compose.exec = async () => {
      calls++;
      return { code: 0, stdout: "", stderr: "" };
    };
    let count = 0;
    rig.ctx.prompter = {
      interactive: true,
      askHidden: async () => (++count === 1 ? "long password one" : "long password two"),
      ask: async () => "",
      confirm: async () => false,
    };
    expect(await resetPassword(rig.ctx)).toBe(1);
    rig.ctx.prompter = { ...rig.ctx.prompter, interactive: false };
    expect(await resetPassword(rig.ctx)).toBe(1);
    expect(calls).toBe(0);
  });
});
