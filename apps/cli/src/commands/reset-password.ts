import { pbkdf2Sync, randomBytes } from "node:crypto";
import type { Ctx } from "../ctx.ts";

// Run inside the existing control image so recovery also works before rebuilding it. Only the derived password record
// travels over stdin; neither the password nor its hash appears in command arguments or the terminal.
export const RESET_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const path = join(process.env.REI_DATA || '/data', 'app.sqlite');
if (!existsSync(path)) throw new Error('Account database not found.');
const record = JSON.parse(readFileSync(0, 'utf8'));
const db = new DatabaseSync(path);
try {
  db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
  const result = db.prepare('UPDATE account SET password_hash = ?, password_salt = ?, iterations = ? WHERE id = 1').run(record.hash, record.salt, record.iterations);
  if (Number(result.changes) !== 1) throw new Error('No account exists. Complete initial setup first.');
  db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(Date.now());
  db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  throw error;
} finally { db.close(); }
`;

export async function resetPassword(ctx: Ctx): Promise<number> {
  if (!ctx.prompter.interactive) {
    ctx.out.line("Password reset requires an interactive terminal.");
    return 1;
  }
  ctx.out.line("Reset the Rei password. Your authenticator remains unchanged; existing sessions will be signed out.");
  const password = await ctx.prompter.askHidden("New password (at least 12 characters): ");
  if (password.length < 12) {
    ctx.out.line("Password must be at least 12 characters. Nothing was changed.");
    return 1;
  }
  const confirmation = await ctx.prompter.askHidden("Confirm new password: ");
  if (password !== confirmation) {
    ctx.out.line("Passwords do not match. Nothing was changed.");
    return 1;
  }
  const salt = randomBytes(16);
  const iterations = 100_000;
  const record = {
    hash: pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64url"),
    salt: salt.toString("base64url"),
    iterations,
  };
  const result = await ctx.compose.exec("control", ["node", "-e", RESET_SCRIPT], {
    input: JSON.stringify(record),
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    ctx.out.line(`Password reset failed: ${result.stderr.trim() || `control command exited ${result.code}`}`);
    return 1;
  }
  ctx.out.line("Password reset. Sign in with the new password and, if enabled, your authenticator code.");
  return 0;
}
