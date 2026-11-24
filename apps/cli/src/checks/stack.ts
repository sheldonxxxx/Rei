// The compose services: running and healthy (exec-keys ran and exited 0), not restarting, and findable by name on every
// network they are on.
import type { Inspected, PsRow } from "../compose.ts";
import type { Ctx } from "../ctx.ts";
import { composeFor, expectedServices, ps } from "../ctx.ts";
import type { CheckResult, Row } from "../format.ts";
import { fail, ok, row, warn } from "../format.ts";

/** Services that do their job once and exit. */
export const ONE_SHOT = new Set(["exec-keys"]);

export function judge(service: string, r: PsRow | undefined, logs: string): CheckResult {
  if (!r) return fail("not created", "run ./rei setup");
  const gone = (detail: string) => fail(detail, logs);
  if (ONE_SHOT.has(service)) {
    if (r.state === "exited") return r.exitCode === 0 ? ok("ran, exited 0") : gone(`exited ${r.exitCode}`);
    return r.state === "running" ? ok("running") : gone(r.state);
  }
  if (r.state !== "running") return gone(r.state === "exited" ? `exited ${r.exitCode}` : r.state);
  if (r.health === "" || r.health === "healthy") return ok(r.health ? "running, healthy" : "running");
  return r.health === "starting" ? warn("running, health check still starting", logs) : gone(`running, ${r.health}`);
}

const logsFix = (ctx: Ctx, service: string) => `see ${composeFor(ctx, service).command(`logs ${service}`)}`;

export const inspectAll = (ctx: Ctx): Promise<Inspected[]> =>
  ctx.memo("inspect", async () =>
    ctx.compose.inspect((await ps(ctx)).filter((r) => r.state === "running").map((r) => r.id)),
  );

const byId = (list: Inspected[], id: string): Inspected | undefined =>
  list.find((c) => c.id.startsWith(id) || id.startsWith(c.id));

export async function serviceRows(ctx: Ctx): Promise<Row[]> {
  const rows = await ps(ctx);
  const inspected = await inspectAll(ctx).catch(() => []);
  const out: Row[] = [];
  for (const service of await expectedServices(ctx)) {
    const r = rows.find((x) => x.service === service);
    let result = judge(service, r, logsFix(ctx, service));
    const restarts = r ? (byId(inspected, r.id)?.restartCount ?? 0) : 0;
    if (result.status === "ok" && restarts > 0)
      result = warn(
        `${result.detail}; restarting (${restarts} restart${restarts === 1 ? "" : "s"})`,
        logsFix(ctx, service),
      );
    out.push(row(`service:${service}`, service, result));
  }
  return out;
}

export interface DnsGap {
  service: string;
  networks: string[];
}

/** Services missing their own DNS name on an attached network. */
export async function dnsGaps(ctx: Ctx): Promise<DnsGap[]> {
  const rows = (await ps(ctx)).filter((r) => r.state === "running");
  const inspected = await inspectAll(ctx);
  const gaps: DnsGap[] = [];
  for (const r of rows) {
    const c = byId(inspected, r.id);
    if (!c) continue;
    const networks = Object.entries(c.networks)
      .filter(
        ([name, n]) =>
          name !== "none" && name !== "host" && !n.aliases.includes(r.service) && !n.dnsNames.includes(r.service),
      )
      .map(([name]) => name);
    if (networks.length) gaps.push({ service: r.service, networks });
  }
  return gaps;
}

export async function dnsResult(ctx: Ctx): Promise<CheckResult> {
  const gaps = await dnsGaps(ctx);
  if (gaps.length === 0) return ok("every service answers to its own name on its networks");
  const names = gaps.map((g) => g.service);
  const recreate = [ctx.compose, ctx.shared].flatMap((project) => {
    const own = names.filter((name) => composeFor(ctx, name) === project);
    return own.length ? [project.command(`up -d --force-recreate --no-deps ${own.join(" ")}`)] : [];
  });
  return fail(
    `no network alias: ${gaps.map((g) => `${g.service} on ${g.networks.join(", ")}`).join("; ")}`,
    `recreate the affected services: ${recreate.join(" ; ")}`,
  );
}
