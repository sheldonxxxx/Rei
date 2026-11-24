// What must be true of this machine before anything else: docker, compose, Node, disk, the published port.
import { parseComposeVersion } from "../compose.ts";
import type { Ctx } from "../ctx.ts";
import { ps, publishSetting } from "../ctx.ts";
import type { CheckResult } from "../format.ts";
import { fail, firstLine, ok, warn } from "../format.ts";
import { appAddress, parsePublish } from "../validate.ts";

export const MIN_COMPOSE: [number, number] = [2, 20];
const MIN_NODE = 24;
const MIN_FREE_BYTES = 5 * 1024 ** 3;

export async function dockerDaemon(ctx: Ctx): Promise<CheckResult> {
  const r = await ctx.runner.run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 20_000 });
  if (r.code === 0) return ok(`daemon ${firstLine(r.stdout, 40)}`);
  if (r.code === 127)
    return fail("docker was not found", "install Docker (OrbStack on a Mac) and put `docker` on PATH");
  return fail(
    `the docker daemon is not reachable (${firstLine(r.stderr, 100) || `exit ${r.code}`})`,
    "start Docker or OrbStack, then check `docker version`",
  );
}

export async function composeVersion(ctx: Ctx): Promise<CheckResult> {
  const r = await ctx.runner.run("docker", ["compose", "version", "--short"], { timeoutMs: 20_000 });
  const v = r.code === 0 ? parseComposeVersion(r.stdout) : null;
  if (!v)
    return fail(
      "docker compose (v2) was not found",
      `install the compose plugin, version ${MIN_COMPOSE.join(".")} or newer`,
    );
  if (v[0] < MIN_COMPOSE[0] || (v[0] === MIN_COMPOSE[0] && v[1] < MIN_COMPOSE[1]))
    return fail(`compose ${v.join(".")} is too old`, `update docker compose to ${MIN_COMPOSE.join(".")} or newer`);
  return ok(`compose ${v.join(".")}`);
}

export function nodeVersion(ctx: Ctx): CheckResult {
  const major = Number(ctx.host.nodeVersion.split(".")[0]);
  return major >= MIN_NODE
    ? ok(`node ${ctx.host.nodeVersion}`)
    : fail(`node ${ctx.host.nodeVersion} is too old`, `use Node ${MIN_NODE} or newer`);
}

export function disk(ctx: Ctx): CheckResult {
  const free = ctx.host.freeBytes(ctx.root);
  if (free === undefined) return warn("free disk space could not be read");
  const gb = (free / 1024 ** 3).toFixed(1);
  return free >= MIN_FREE_BYTES
    ? ok(`${gb} GB free`)
    : warn(
        `only ${gb} GB free (the images and volumes want about 5 GB)`,
        "free some space with `docker system prune` or on this disk",
      );
}

/** Free, or already ours (the edge container publishes it). */
export async function publishPort(ctx: Ctx): Promise<CheckResult> {
  const setting = publishSetting(ctx);
  const pub = parsePublish(setting);
  if (!pub) return fail(`REI_PUBLISH is not host:port or a port (${setting})`, "fix REI_PUBLISH in containers/.env");
  const where = appAddress(pub).url.replace("http://", "");
  if (await ctx.host.portFree(pub.host, pub.port)) return ok(`${where} is free`);
  const rows = await ps(ctx).catch(() => []);
  if (rows.some((r) => r.service === "edge" && r.publishers.some((p) => p.port === pub.port)))
    return ok(`${where} is held by this stack's edge`);
  return fail(
    `port ${pub.port} is in use by something else`,
    "stop it, or set REI_PUBLISH in containers/.env (for example 127.0.0.1:8788)",
  );
}
