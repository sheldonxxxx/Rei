// `rei doctor [--json]`: what is wrong and how to fix it. Read-only: it never starts, stops, restarts or recreates anything.
import { appHealth } from "../checks/app.ts";
import { backupCheck } from "../checks/backup.ts";
import { networkRows } from "../checks/network.ts";
import { composeVersion, disk, dockerDaemon, nodeVersion } from "../checks/preflight.ts";
import { browserSmoke, sandbox } from "../checks/sandbox.ts";
import { secretRows } from "../checks/secrets.ts";
import { dnsResult, serviceRows } from "../checks/stack.ts";
import { storageReach, storageRows, storageTargets } from "../checks/storage.ts";
import { subnetCheck } from "../checks/subnets.ts";
import type { Ctx } from "../ctx.ts";
import type { CheckResult, Row } from "../format.ts";
import { printRow, row, skip } from "../format.ts";

export async function doctor(ctx: Ctx, opts: { json: boolean }): Promise<number> {
  const rows: Row[] = [];
  const add = (r: Row | Row[]) => {
    for (const x of Array.isArray(r) ? r : [r]) {
      rows.push(x);
      if (!opts.json) printRow(ctx.out, x);
    }
  };
  /** A check that throws is a failed check, not a crashed doctor. */
  const guard = async (id: string, title: string, fn: () => Promise<CheckResult> | CheckResult): Promise<Row> => {
    try {
      return row(id, title, await fn());
    } catch (cause) {
      return row(id, title, {
        status: "fail",
        detail: `could not run (${cause instanceof Error ? cause.message : String(cause)})`,
      });
    }
  };

  const docker = await guard("docker", "docker daemon", () => dockerDaemon(ctx));
  add(docker);
  add(await guard("compose", "docker compose", () => composeVersion(ctx)));
  add(row("node", "node", nodeVersion(ctx)));
  add(row("disk", "disk", disk(ctx)));
  add(secretRows(ctx));

  if (docker.status === "fail") {
    add(row("stack", "the stack", skip("docker is not available, so the stack was not checked")));
  } else {
    add(await guard("subnets", "subnets", () => subnetCheck(ctx)));
    try {
      add(await serviceRows(ctx));
      add(await guard("dns", "service names", () => dnsResult(ctx)));
      // The two services Rei stores things in, seen from the only container allowed to reach them.
      for (const target of storageTargets)
        add(await guard(`storage:${target.service}`, target.service, () => storageReach(ctx, target)));
      add(await storageRows(ctx));
    } catch (cause) {
      add(
        row("services", "services", {
          status: "fail",
          detail: `could not list them (${cause instanceof Error ? cause.message : String(cause)})`,
          fix: "run ./rei setup",
        }),
      );
    }
    add(await guard("sandbox", "sandbox", () => sandbox(ctx)));
    add(await guard("browser", "browser", () => browserSmoke(ctx)));
    add(await networkRows(ctx));
    add(await guard("app", "app", () => appHealth(ctx)));
    add(await guard("backup", "backups", () => backupCheck(ctx)));
  }

  const failed = rows.filter((r) => r.status === "fail").length;
  const warned = rows.filter((r) => r.status === "warn").length;
  if (opts.json) ctx.out.line(JSON.stringify({ checks: rows }));
  else {
    ctx.out.line();
    ctx.out.line(
      failed
        ? `${failed} check${failed === 1 ? "" : "s"} failed${warned ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}.`
        : warned
          ? `No failures, ${warned} warning${warned === 1 ? "" : "s"}.`
          : "All checks passed.",
    );
  }
  return failed ? 1 : 0;
}
