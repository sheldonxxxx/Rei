// `rei backup snapshots|restore`: listing and restoring the backups Settings > Backups makes (docs/backup-user.md).
//
// Backups are written by the running app. A restore happens with the app stopped, so it is done from here, in steps, each
// in a one-off container of the control image (which has restic and the code that reads a bundle):
//   1. fetch the snapshot into a temporary volume and check every file against its manifest (nothing is stopped yet)
//   2. stop control and the gateway
//   3. copy what will be replaced into rollback volumes (<volume>-pre-restore-<time>)
//   4. write app.sqlite, the data files and the gateway's state
//   5. upload the objects the bucket lacks (--prune-bucket: delete the extra ones too)
//   6. delete the search index; Rei rebuilds it from its database
//   7. start the stack, then doctor and the storage smoke check
// Nothing here touches a volume that --only leaves out. Dodai's other services are never stopped.
import { join } from "node:path";
import type { Ctx } from "../ctx.ts";
import { psNow, volumeName } from "../ctx.ts";
import { parseDotenv } from "../dotenv.ts";
import { expandPath, projectPrefix } from "../stack.ts";
import { doctor } from "./doctor.ts";
import { lifecycle } from "./lifecycle.ts";

export const BACKUP_HELP = `./rei backup <command>

  snapshots [--repo DIR] [--json]     List the backups in the repository (default: the one Settings > Backups uses)
  restore [options]                   Put a backup back: replaces Rei's data and the gateway's state

restore options:
  --repo DIR          The repository folder (default: REI_BACKUP_DIR from the stack's .env)
  --snapshot ID       The backup to restore: an id from "snapshots", or "latest" (default)
  --only PARTS        Only some parts, comma-separated: db, files, gateway, objects (default: all)
  --prune-bucket      Also delete objects from the file bucket that the backup does not have
  --yes               Do not ask for confirmation

The repository password is read from REI_BACKUP_PASSWORD (RESTIC_PASSWORD also works), else asked for. A restore stops Rei while it runs and keeps copies of
what it replaces in Docker volumes named <volume>-pre-restore-<time>. See docs/backup-user.md.`;

const PARTS = ["db", "files", "gateway", "objects"] as const;
const CLI = "src/node/backup-cli.ts";
const HEALTHY_TIMEOUT_MS = 180_000;
const POLL_MS = 2000;

interface Options {
  repo: string | undefined;
  snapshot: string;
  only: string | undefined;
  pruneBucket: boolean;
  yes: boolean;
  json: boolean;
}

function parse(args: string[]): Options | string {
  const o: Options = {
    repo: undefined,
    snapshot: "latest",
    only: undefined,
    pruneBucket: false,
    yes: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (): string | undefined => {
      const v = args[++i];
      return v === undefined || v.startsWith("--") ? undefined : v;
    };
    if (a === "--repo" || a === "--snapshot" || a === "--only") {
      const v = value();
      if (v === undefined) return `${a} needs a value.`;
      if (a === "--repo") o.repo = v;
      else if (a === "--snapshot") o.snapshot = v;
      else o.only = v;
    } else if (a === "--prune-bucket") o.pruneBucket = true;
    else if (a === "--yes") o.yes = true;
    else if (a === "--json") o.json = true;
    else return `unknown option ${a}`;
  }
  if (o.only !== undefined) {
    for (const part of o.only.split(",")) {
      if (!(PARTS as readonly string[]).includes(part.trim()))
        return `--only takes ${PARTS.join(", ")}; "${part}" is none of them.`;
    }
  }
  return o;
}

const parts = (only: string | undefined): string[] =>
  only === undefined
    ? [...PARTS]
    : PARTS.filter((p) =>
        only
          .split(",")
          .map((s) => s.trim())
          .includes(p),
      );

/** The repository folder: --repo, else the stack's REI_BACKUP_DIR; expanded the way the stack's own paths are. */
function repoOf(ctx: Ctx, repo: string | undefined): string | undefined {
  const raw =
    repo ??
    ctx.env.REI_BACKUP_DIR?.trim() ??
    parseDotenv(ctx.host.readText(join(ctx.envDir, ".env")) ?? "")
      .get("REI_BACKUP_DIR")
      ?.trim();
  return raw ? expandPath(raw, process.cwd(), ctx.host.homeDir) : undefined;
}

async function passwordOf(ctx: Ctx): Promise<string | undefined> {
  const fromEnv = ctx.env.REI_BACKUP_PASSWORD || ctx.env.RESTIC_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!ctx.prompter.interactive) return undefined;
  return (await ctx.prompter.askHidden("Repository password: ")) || undefined;
}

/** A one-off of the control service in this stack: root, its own networks and secrets, nothing else started. */
function oneOff(ctx: Ctx, mounts: string[], tail: string[]): string[] {
  return ctx.compose.args([
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "--user",
    "0",
    "-e",
    "RESTIC_PASSWORD",
    ...mounts.flatMap((m) => ["-v", m]),
    "control-restore",
    "node",
    CLI,
    ...tail,
  ]);
}

async function runOneOff(ctx: Ctx, password: string | undefined, mounts: string[], tail: string[]): Promise<number> {
  return ctx.runner.interactive("docker", oneOff(ctx, mounts, tail), {
    env: { RESTIC_PASSWORD: password ?? "" },
  });
}

async function controlHealthy(ctx: Ctx): Promise<boolean> {
  const deadline = ctx.clock.now() + HEALTHY_TIMEOUT_MS;
  for (;;) {
    const rows = await psNow(ctx).catch(() => []);
    const control = rows.find((r) => r.service === "control");
    if (control?.state === "running" && (control.health === "healthy" || control.health === "")) return true;
    if (ctx.clock.now() >= deadline) return false;
    await ctx.clock.sleep(POLL_MS);
  }
}

async function snapshots(ctx: Ctx, o: Options): Promise<number> {
  const tail = ["snapshots", ...(o.json ? ["--json"] : [])];
  if (o.repo === undefined) {
    const running = (await ctx.compose.ps().catch(() => [])).some(
      (r) => r.service === "control" && r.state === "running",
    );
    if (!running) {
      console.error(
        `rei: Rei is not running, so its repository's password is not at hand. Run ${ctx.cli} start, or give --repo DIR and the password.`,
      );
      return 1;
    }
    return ctx.compose.interactive(["exec", "-T", "control", "node", CLI, ...tail]);
  }
  const repo = repoOf(ctx, o.repo)!;
  const password = await passwordOf(ctx);
  if (!password) {
    console.error("rei: the repository password is needed: set REI_BACKUP_PASSWORD, or run this in a terminal.");
    return 1;
  }
  return runOneOff(ctx, password, [`${repo}:/repo:ro`], [...tail, "--repo", "/repo"]);
}

async function restore(ctx: Ctx, o: Options): Promise<number> {
  const say = (line = ""): void => ctx.out.line(line);
  const repo = repoOf(ctx, o.repo);
  if (!repo) {
    console.error("rei: say where the backups are with --repo DIR (or set REI_BACKUP_DIR in the stack's .env).");
    return 2;
  }
  const password = await passwordOf(ctx);
  if (!password) {
    console.error("rei: the repository password is needed: set REI_BACKUP_PASSWORD, or run this in a terminal.");
    return 1;
  }
  const chosen = parts(o.only);
  const only = chosen.join(",");
  const touchesControl = chosen.includes("db") || chosen.includes("files");
  const stamp = new Date(ctx.clock.now()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").toLowerCase();
  const prefix = projectPrefix(ctx.env);
  const controlData = `${prefix}_control-data`;
  const gatewayData = volumeName(ctx, "gateway-data");
  const tmp = `${prefix}_restore-${stamp}`;
  const docker = async (args: string[]): Promise<boolean> =>
    (await ctx.runner.run("docker", args, { timeoutMs: 120_000 })).code === 0;
  const dropTmp = async (): Promise<void> => void (await docker(["volume", "rm", tmp]));

  // 1. fetch and verify, with everything still running
  say(`Fetching ${o.snapshot === "latest" ? "the latest backup" : `backup ${o.snapshot}`} from ${repo} …`);
  if (!(await docker(["volume", "create", tmp]))) {
    console.error("rei: could not create a temporary Docker volume.");
    return 1;
  }
  const restoreMount = `${tmp}:/restore`;
  const code = await runOneOff(
    ctx,
    password,
    [`${repo}:/repo:ro`, restoreMount],
    ["fetch", "--snapshot", o.snapshot, "--only", only],
  );
  if (code !== 0) {
    await dropTmp();
    console.error("rei: nothing was changed.");
    return code;
  }

  // Confirmation: a restore replaces what is there.
  const replaced = [
    chosen.includes("db") ? "the database" : "",
    chosen.includes("files") ? "the data files" : "",
    chosen.includes("gateway") ? "the gateway's state (sign-ins, keys, callers)" : "",
    chosen.includes("objects")
      ? `the file bucket${o.pruneBucket ? " (extra objects are deleted)" : " (missing objects are added)"}`
      : "",
  ].filter(Boolean);
  say();
  say(`This replaces ${replaced.join(", ")}.`);
  say(
    `Rei${chosen.includes("gateway") ? " and the gateway are" : " is"} stopped while it runs; copies of what is replaced are kept in Docker volumes.`,
  );
  if (!o.yes) {
    if (!ctx.prompter.interactive || !(await ctx.prompter.confirm("Restore this backup now?", false))) {
      await dropTmp();
      say(
        ctx.prompter.interactive
          ? "Cancelled. Nothing was changed."
          : "Not restoring: pass --yes to confirm without a terminal.",
      );
      return ctx.prompter.interactive ? 0 : 1;
    }
  }

  const fail = (what: string, step: number): number => {
    console.error(`rei: ${what}. The restore stopped at step ${step}; Rei is left stopped.`);
    console.error(`     The temporary volume ${tmp} still holds the backup. Copies of the data it replaced:`);
    console.error(
      `     ${controlData}-pre-restore-${stamp}, ${gatewayData}-pre-restore-${stamp} (where they were made).`,
    );
    return 1;
  };

  // 2. stop
  say("Stopping Rei …");
  if (touchesControl && (await ctx.compose.interactive(["stop", "control"])) !== 0)
    return fail("could not stop control", 2);
  if (chosen.includes("gateway") && (await ctx.shared.interactive(["stop", "gateway"])) !== 0)
    return fail("could not stop the gateway", 2);

  // 3. rollback copies
  say("Keeping copies of what is replaced …");
  const rbControl = `${controlData}-pre-restore-${stamp}`;
  const rbGateway = `${gatewayData}-pre-restore-${stamp}`;
  const mounts = [
    `${tmp}:/restore:ro`,
    `${gatewayData}:/gateway-data`,
    `${rbControl}:/rollback/control`,
    `${rbGateway}:/rollback/gateway`,
  ];
  for (const v of [rbControl, rbGateway])
    if (!(await docker(["volume", "create", v]))) return fail(`could not create ${v}`, 3);
  if ((await runOneOff(ctx, undefined, mounts, ["rollback", "--only", only])) !== 0)
    return fail("could not copy the old data", 3);

  // 4. database, files, gateway state
  if ((await runOneOff(ctx, undefined, mounts, ["apply", "--only", only])) !== 0)
    return fail("could not write the restored data", 4);

  // 5. objects
  if (chosen.includes("objects")) {
    const args = ["objects", ...(o.pruneBucket ? ["--prune-bucket"] : [])];
    if ((await runOneOff(ctx, undefined, [`${tmp}:/restore:ro`], args)) !== 0)
      return fail("could not restore the file bucket", 5);
  }

  // 6. the search index is rebuilt from the database
  if (chosen.includes("db") && (await runOneOff(ctx, undefined, [`${tmp}:/restore:ro`], ["index"])) !== 0)
    return fail("could not reset the search index", 6);

  // 7. start, then check
  say("Starting Rei …");
  const started = await lifecycle(ctx, "start");
  if (started !== 0) return fail("could not start the stack", 7);
  if (!(await controlHealthy(ctx))) return fail("Rei did not become healthy in time", 7);
  const doctorCode = await doctor(ctx, { json: false });
  let smokeCode = 0;
  const smoke = join(ctx.containersDir, "smoke-storage.sh");
  if (ctx.host.stat(smoke)) {
    say();
    say("Storage check:");
    smokeCode = await ctx.runner.interactive("bash", [smoke]);
  }
  await dropTmp();
  say();
  say(doctorCode === 0 && smokeCode === 0 ? "Restored." : "Restored, but a check above failed.");
  say(
    `The data it replaced is kept in ${rbControl} and ${rbGateway}. Remove them with docker volume rm when you are sure.`,
  );
  return doctorCode === 0 && smokeCode === 0 ? 0 : 1;
}

export async function backupCommand(ctx: Ctx, args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    ctx.out.line(BACKUP_HELP);
    return command === undefined ? 2 : 0;
  }
  const o = parse(rest);
  if (typeof o === "string") {
    console.error(`rei backup ${command}: ${o}\n\n${BACKUP_HELP}`);
    return 2;
  }
  if (command === "snapshots") return snapshots(ctx, o);
  if (command === "restore") return restore(ctx, o);
  console.error(`rei backup: unknown command "${command}"\n\n${BACKUP_HELP}`);
  return 2;
}
