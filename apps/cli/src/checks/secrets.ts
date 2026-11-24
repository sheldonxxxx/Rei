// The files compose reads: present. Only stat: never read.
import { join } from "node:path";
import type { Ctx } from "../ctx.ts";
import { dotenvPath } from "../ctx.ts";
import type { Row } from "../format.ts";
import { fail, ok, row, warn } from "../format.ts";

export function secretRows(ctx: Ctx): Row[] {
  const secrets = join(ctx.envDir, ".secrets");
  const missing = ["secrets.env"].filter((name) => !(ctx.host.stat(join(secrets, name))?.size ?? 0));
  const rows: Row[] = [
    row(
      "secrets",
      "secret files",
      missing.length
        ? fail(`missing: ${missing.join(", ")}`, "run containers/init.sh (or ./rei setup)")
        : ok("secrets.env present"),
    ),
  ];
  rows.push(
    row(
      "env",
      "containers/.env",
      ctx.host.stat(dotenvPath(ctx))
        ? ok("present")
        : warn("missing: using default configuration", "run containers/init.sh (or ./rei setup)"),
    ),
  );
  return rows;
}
