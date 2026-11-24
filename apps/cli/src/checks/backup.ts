// Backups, seen from the control plane's own database: whether they are on and whether the last one worked. A warning, never
// a failure: Rei runs fine without them, but a stack nobody can restore is one disk away from losing everything.
import type { Ctx } from "../ctx.ts";
import type { CheckResult } from "../format.ts";
import { firstLine, ok, skip, warn } from "../format.ts";

interface Health {
  enabled: boolean;
  stale: boolean;
  lastSuccessAt: number | null;
  lastFailure: string | null;
}

const ago = (ms: number): string => {
  const hours = Math.round(ms / 3_600_000);
  return hours < 48 ? `${hours} hour${hours === 1 ? "" : "s"} ago` : `${Math.round(hours / 24)} days ago`;
};

export async function backupCheck(ctx: Ctx): Promise<CheckResult> {
  const read = await ctx.compose
    .exec("control", ["node", "src/node/backup-cli.ts", "status"], { timeoutMs: 30_000 })
    .catch(() => undefined);
  if (read?.code !== 0) return skip("the control plane could not be asked");
  let health: Health;
  try {
    health = JSON.parse(firstLine(read.stdout, 4000)) as Health;
  } catch {
    return skip("the control plane gave no answer");
  }
  const fix = "turn backups on in Settings > Backups (docs/backup-user.md)";
  if (!health.enabled) return warn("backups are off", fix);
  const now = ctx.clock.now();
  if (health.stale)
    return warn(
      health.lastSuccessAt
        ? `the last backup that worked was ${ago(now - health.lastSuccessAt)}`
        : "none has worked yet",
      "see the history in Settings > Backups",
    );
  if (health.lastFailure)
    return warn(`the last backup failed: ${firstLine(health.lastFailure, 120)}`, "see Settings > Backups");
  return ok(health.lastSuccessAt ? `last backup ${ago(now - health.lastSuccessAt)}` : "on, waiting for the first run");
}
