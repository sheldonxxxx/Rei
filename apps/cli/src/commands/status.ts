// `rei status [--json]`: a quick read-only summary: the containers, the app address and whether an account exists.
// Model, search and memory settings are configured in the web app, so they are not reported here.

import { authState } from "../checks/app.ts";
import { judge } from "../checks/stack.ts";
import type { PsRow } from "../compose.ts";
import type { Ctx } from "../ctx.ts";
import { appUrls, composeFor, ps } from "../ctx.ts";
import type { Row } from "../format.ts";
import { firstLine, ok, printRow, row, warn } from "../format.ts";

export interface StatusReport {
  services: { service: string; state: string; health: string | null; exitCode: number }[];
  app: { url: string; reachable: boolean; accountExists: boolean | null };
}

export async function status(ctx: Ctx, opts: { json: boolean }): Promise<number> {
  let rows: PsRow[];
  try {
    rows = await ps(ctx);
  } catch (cause) {
    const message = cause instanceof Error ? firstLine(cause.message, 160) : "unknown error";
    ctx.out.line(
      opts.json
        ? JSON.stringify({ error: `docker is not available: ${message}` })
        : `docker is not available: ${message}`,
    );
    return 1;
  }
  const auth = await authState(ctx);
  const { url } = appUrls(ctx);

  const report: StatusReport = {
    services: rows.map((r) => ({ service: r.service, state: r.state, health: r.health || null, exitCode: r.exitCode })),
    app: { url, reachable: auth !== null, accountExists: auth ? !auth.setupRequired : null },
  };
  if (opts.json) {
    ctx.out.line(JSON.stringify(report));
    return 0;
  }

  const out: Row[] = [];
  for (const r of [...rows].sort((a, b) => a.service.localeCompare(b.service)))
    out.push(
      row(
        `service:${r.service}`,
        r.service,
        judge(r.service, r, `see ${composeFor(ctx, r.service).command(`logs ${r.service}`)}`),
      ),
    );
  if (rows.length === 0) out.push(row("services", "containers", warn("none yet", "run ./rei setup")));
  out.push(
    row(
      "app",
      "app",
      auth === null
        ? warn(`${url} does not answer`, "is the stack up? run ./rei setup")
        : ok(
            auth.setupRequired
              ? `${url}  no account yet: ./rei setup-code shows the setup code`
              : `${url}  account exists`,
          ),
    ),
  );
  for (const r of out) printRow(ctx.out, r);
  return 0;
}
