// `rei upgrade`: moves an npm installation to the release of this CLI (npm i -g rei-ai@<version> first). It copies the
// configuration aside, writes the new compose files, pulls the new images and recreates what changed, then runs doctor.
// Data volumes stay where they are: the new release upgrades its databases when it starts (docs/versioning.md#database-upgrades).
// A checkout upgrades with git and ./rei redeploy instead.
import { dirname, join } from "node:path";
import { ASSET_FILES } from "../asset-files.ts";
import { composeVersion, dockerDaemon } from "../checks/preflight.ts";
import type { Ctx } from "../ctx.ts";
import { dropLegacyStorageNetwork, retireLegacyGateway, retireLegacyStorage } from "../ctx.ts";
import { initSecrets } from "../init.ts";
import { installAssets, installedVersion, isInstalled, MARKER, markInstalled } from "../install.ts";
import { restrictReiStorageKey } from "../storage/garage.ts";
import { compareVersions, isVersion } from "../version.ts";
import { doctor } from "./doctor.ts";
import { failed, runStep } from "./redeploy.ts";

export interface UpgradeOptions {
  force: boolean;
}

export async function upgrade(ctx: Ctx, o: UpgradeOptions): Promise<number> {
  const say = (text: string, kind?: "warn" | "error") =>
    ctx.guide ? ctx.guide.message(text, kind) : ctx.out.line(text);
  if (ctx.mode === "source") {
    ctx.out.line("./rei upgrade is for npm installations. In a checkout, update it with git, then run ./rei redeploy.");
    return 2;
  }
  if (!isInstalled(ctx) || !ctx.host.stat(join(ctx.containersDir, ".secrets", "secrets.env"))) {
    ctx.out.line(`Rei is not set up in ${ctx.containersDir} yet. Run rei setup.`);
    return 1;
  }
  const from = installedVersion(ctx);
  if (from && isVersion(from) && isVersion(ctx.version) && compareVersions(ctx.version, from) < 0 && !o.force) {
    ctx.out.line(
      `This installation runs Rei ${from}, newer than this CLI (${ctx.version}). Rei does not downgrade: the newer release may have upgraded its databases, and this one would refuse to open them. Install rei-ai@${from} or later, or, to go back, restore a backup (docs/storage.md#backup-and-recovery). --force writes the older files anyway.`,
    );
    return 1;
  }

  ctx.guide?.intro(`Upgrade Rei to ${ctx.version}`);
  say(
    from === ctx.version
      ? `Rei ${ctx.version} is already installed; its files and images are applied again.`
      : `Upgrading Rei from ${from ?? "an unknown version"} to ${ctx.version}. Containers restart; data volumes and secrets are kept.`,
  );
  for (const [name, check] of [
    ["docker daemon", dockerDaemon],
    ["docker compose", composeVersion],
  ] as const) {
    const result = await check(ctx);
    if (result.status === "fail") {
      say(`${name}: ${result.detail}${result.fix ? `\n${result.fix}` : ""}`, "error");
      return finish(ctx, "Nothing was changed.", 1);
    }
  }

  // 1. The configuration, copied aside. The data volumes are not: they can be large, and they are backed up their own way.
  const backup = backupConfig(ctx, from ?? "unknown");
  say(
    `Saved the configuration to ${backup}. Data volumes are not copied; back them up first if you want a way back (docs/storage.md#backup-and-recovery).`,
  );

  // 2. The new files and any secret a newer release needs. Values that exist are kept.
  try {
    installAssets(ctx);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "error");
    return finish(ctx, `The files were not all written. The previous ones are in ${backup}.`, 1);
  }
  const lines: string[] = [];
  if ((await initSecrets(ctx, (line) => lines.push(line))) !== 0) {
    say(lines.join("\n"), "error");
    return finish(ctx, "Could not create the storage volumes. Data volumes and secrets were not deleted.", 1);
  }

  // 3. The new images, then recreate: Dodai first, because Rei's control plane needs the gateway.
  for (const [project, name] of [
    [ctx.shared, "Dodai"],
    [ctx.compose, "Rei"],
  ] as const) {
    const code = await runStep(ctx, {
      title: `Pulling ${name}'s images…`,
      command: "docker",
      args: project.args(["pull"]),
    });
    if (code !== 0)
      return failed(
        ctx,
        `pull ${name}'s images`,
        "docker compose pull",
        code,
        "The running containers were not changed.",
      );
  }
  await retireLegacyGateway(ctx);
  await retireLegacyStorage(ctx);
  const sharedCode = await runStep(ctx, {
    title: "Starting Dodai…",
    command: "docker",
    args: ctx.shared.args(["up", "-d", "--no-build", "--wait"]),
  });
  if (sharedCode !== 0)
    return failed(ctx, "start Dodai", "docker compose up", sharedCode, "Some services may still be running.");
  const warning = await restrictReiStorageKey(ctx);
  if (warning) say(`Rei's storage key: ${warning}`, "warn");
  const reiCode = await runStep(ctx, {
    title: "Starting Rei…",
    command: "docker",
    args: ctx.compose.args(["up", "-d", "--no-build", "--wait", "--remove-orphans"]),
  });
  if (reiCode !== 0)
    return failed(ctx, "start Rei", "docker compose up", reiCode, "Some services may still be running.");
  await dropLegacyStorageNetwork(ctx);
  markInstalled(ctx);
  ctx.reset();

  // 4. The same checks doctor makes; its exit status is the upgrade's.
  ctx.guide?.outro(`Rei ${ctx.version} is running. Checking it…`);
  if (!ctx.guide) ctx.out.line(`Rei ${ctx.version} is running. Checking it…`);
  return doctor(ctx, { json: false });
}

function finish(ctx: Ctx, message: string, code: number): number {
  if (ctx.guide) ctx.guide.outro(message);
  else ctx.out.line(message);
  return code;
}

/** Copies the installation's files, .env, secrets.env and the version marker into backups/<time>-<version>/ (0700). */
function backupConfig(ctx: Ctx, from: string): string {
  const stamp = new Date(ctx.clock.now()).toISOString().replace(/[:.]/g, "-");
  const dir = join(ctx.containersDir, "backups", `${stamp}-${from.replace(/[^\w.-]/g, "_")}`);
  ctx.host.mkdirp(dir, 0o700);
  for (const path of [...ASSET_FILES.map((f) => f.path), ".env", ".secrets/secrets.env", MARKER]) {
    const source = join(ctx.containersDir, path);
    const text = ctx.host.readText(source);
    if (text === undefined) continue;
    const target = join(dir, path);
    ctx.host.mkdirp(dirname(target), 0o700);
    ctx.host.writeText(target, text, ctx.host.stat(source)?.mode ?? 0o600);
  }
  return dir;
}
