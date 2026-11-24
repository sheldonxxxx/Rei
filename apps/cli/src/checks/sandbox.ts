// The sandbox wiring, by containers/smoke-exec.sh and smoke-browser.sh (they print PASS/FAIL lines only, never a key).
import { join } from "node:path";
import type { Ctx } from "../ctx.ts";
import { ps } from "../ctx.ts";
import type { CheckResult } from "../format.ts";
import { fail, firstLine, ok, skip } from "../format.ts";

async function smoke(ctx: Ctx, script: string, needs: string[]): Promise<CheckResult> {
  const rows = await ps(ctx).catch(() => []);
  if (!needs.every((s) => rows.some((r) => r.service === s && r.state === "running")))
    return skip(`${needs.join(", ")} not all running`);
  const r = await ctx.runner.run(join(ctx.containersDir, script), [], { timeoutMs: 240_000 });
  const lines = r.stdout.split(/\r?\n/);
  const passed = lines.filter((l) => l.startsWith("PASS")).length;
  const failed = lines.filter((l) => l.startsWith("FAIL")).map((l) => l.replace(/^FAIL\s+/, "").trim());
  if (r.code === 0 && failed.length === 0) return ok(`${passed} checks passed`);
  if (passed + failed.length === 0)
    return fail(
      `${script} did not run (${firstLine(r.stderr, 100) || `exit ${r.code}`})`,
      `run containers/${script} by hand to see why`,
    );
  return fail(
    `${failed.length} of ${passed + failed.length} failed: ${failed.join("; ")}`,
    `run containers/${script} for the details; ./rei setup recreates a stack with missing network names`,
  );
}

export const sandbox = (ctx: Ctx): Promise<CheckResult> => smoke(ctx, "smoke-exec.sh", ["control", "exec", "egress"]);
/** The agent computer's browser, by containers/smoke-browser.sh; a stack without the browser service is skipped. */
export const browserSmoke = (ctx: Ctx): Promise<CheckResult> =>
  smoke(ctx, "smoke-browser.sh", ["control", "browser", "egress"]);
