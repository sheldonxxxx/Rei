// `rei setup`: one command from a fresh checkout to a running, checked stack. Every step is safe to repeat, so after a
// failure (the first one stops the run) fix what it says and run it again.

import { join } from "node:path";
import { composeVersion, disk, dockerDaemon, nodeVersion, publishPort } from "../checks/preflight.ts";
import { sandbox } from "../checks/sandbox.ts";
import { dnsResult, judge } from "../checks/stack.ts";
import type { Ctx } from "../ctx.ts";
import {
  composeFor,
  dotenvPath,
  dropLegacyStorageNetwork,
  expectedServices,
  psNow,
  retireLegacyGateway,
  retireLegacyStorage,
} from "../ctx.ts";
import { envKeys, parseDotenv, setDotenv } from "../dotenv.ts";
import { writeEnvText } from "../env-file.ts";
import type { CheckResult } from "../format.ts";
import { fail, ok, printRow, row, skip, warn } from "../format.ts";
import { initSecrets } from "../init.ts";
import { restrictReiStorageKey } from "../storage/garage.ts";
import { showSetupCode } from "./setup-code.ts";

export interface SetupOptions {
  nonInteractive: boolean;
  skipBuild: boolean;
}

const HEALTHY_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

export type Report = (id: string, title: string, result: CheckResult) => boolean;

export async function setup(ctx: Ctx, o: SetupOptions): Promise<number> {
  ctx.guide?.intro("Set up Rei");
  ctx.guide?.message("We’ll prepare Rei. Finish your settings in the Rei web app.");
  /** Prints the step; false when it failed (the caller stops). */
  const report: Report = (id, title, result) => {
    if (ctx.guide) {
      if (result.status === "warn" || result.status === "fail")
        ctx.guide.message(
          `${title}: ${result.detail}${result.fix ? `\n${result.fix}` : ""}`,
          result.status === "fail" ? "error" : "warn",
        );
    } else printRow(ctx.out, row(id, title, result));
    return result.status !== "fail";
  };
  const stop = (): number => {
    ctx.out.line();
    const message = "Setup stopped. Follow the guidance above, then run ./rei setup again. Completed steps are kept.";
    if (ctx.guide) ctx.guide.outro(message);
    else ctx.out.line(message);
    return 1;
  };

  ctx.guide?.message("1 of 3 · Checking your computer");
  // 1. Preflight
  if (!report("docker", "docker daemon", await dockerDaemon(ctx))) return stop();
  if (!report("compose", "docker compose", await composeVersion(ctx))) return stop();
  if (!report("node", "node", nodeVersion(ctx))) return stop();
  report("disk", "disk", disk(ctx));
  if (!report("port", "published port", await publishPort(ctx))) return stop();

  ctx.guide?.message("2 of 3 · Preparing Rei. The first run can take a few minutes.");
  // 2. Secrets
  if (!report("secrets", "secrets", await secrets(ctx))) return stop();

  report("tz", "time zone", timeZoneStep(ctx));

  // 3. Dependencies and the PWA
  if (ctx.host.stat(join(ctx.root, "node_modules"))) report("deps", "dependencies", ok("node_modules present"));
  else if (
    !report(
      "deps",
      "dependencies",
      await run(ctx, "npm", ["ci"], "npm ci failed", "read its output above; it needs network access", ctx.root),
    )
  )
    return stop();
  if (o.skipBuild) report("web", "web app", skip("--skip-build"));
  else if (
    !report(
      "web",
      "web app",
      await run(
        ctx,
        "npm",
        ["run", "build", "-w", "@rei/web"],
        "the web build failed",
        "read its output above",
        ctx.root,
      ),
    )
  )
    return stop();

  // 4. Start; the basic interface passes through build output. Dodai comes first and is waited for,
  // because Rei's control plane needs the gateway and compose cannot order services across two projects.
  await retireLegacyGateway(ctx);
  await retireLegacyStorage(ctx);
  let upCode = await setupCommand(ctx, "Starting Dodai…", "docker", ctx.shared.args(["up", "-d", "--build", "--wait"]));
  if (upCode === 0) {
    // Rei's own key may use rei-files and make no other bucket; callers' buckets are made by ./rei callers --storage.
    const warning = await restrictReiStorageKey(ctx);
    if (warning) report("storage-key", "Rei's storage key", warn(warning));
  }
  if (upCode === 0)
    upCode = await setupCommand(
      ctx,
      "Starting Rei…",
      "docker",
      ctx.compose.args(["up", "-d", "--build", "--remove-orphans"]),
    );
  if (upCode === 0) await dropLegacyStorageNetwork(ctx);
  ctx.reset();
  if (
    !report(
      "up",
      "start the stack",
      upCode === 0
        ? ok("docker compose up finished")
        : fail(`docker compose up exited ${upCode}`, "read its output above (a build error shows there)"),
    )
  )
    return stop();

  // 5 + 6. Healthy, and every service findable by name
  if (!(await ready(ctx, report))) return stop();

  ctx.guide?.message("3 of 3 · Open Rei in your browser to configure your services");

  if (!report("sandbox", "sandbox", await sandbox(ctx))) return stop();

  // Done: where to open Rei and the setup code, when the first account is still to be created.
  if (!(await finish(ctx))) return stop();
  ctx.guide?.outro("Complete setup and change settings in the Rei web app.");
  return 0;
}

/**
 * .env, secrets.env and the external volumes (rei init). The basic interface prints what it made; the guided one keeps
 * those lines unless something failed.
 */
async function secrets(ctx: Ctx): Promise<CheckResult> {
  const lines: string[] = [];
  const log = ctx.guide ? (line: string) => lines.push(line) : (line: string) => ctx.out.line(line);
  const work = () => initSecrets(ctx, log);
  const code = ctx.guide ? await ctx.guide.task("Preparing local settings…", work) : await work();
  if (code === 0) return ok("done");
  if (lines.length) ctx.guide?.message(lines.join("\n"), "error");
  return fail("the storage volumes could not all be created", "read the lines above; check `docker volume ls`");
}

/** The server dates what it writes (forget markers, dates in the agent's memory) in REI_TZ: this machine's zone unless one is set. */
function timeZoneStep(ctx: Ctx): CheckResult {
  const envFile = dotenvPath(ctx);
  const text = ctx.host.readText(envFile) ?? "";
  const set = parseDotenv(text).get("REI_TZ");
  if (set) return ok(`${set} (REI_TZ in containers/.env)`);
  writeEnvText(ctx, envFile, setDotenv(text, "REI_TZ", ctx.host.timeZone), envKeys(text));
  return ok(`${ctx.host.timeZone} set in containers/.env`);
}

/** Runs a program with the terminal handed over; ok when it exits 0. */
async function run(
  ctx: Ctx,
  cmd: string,
  args: string[],
  failure: string,
  fix: string,
  cwd?: string,
): Promise<CheckResult> {
  const code = await setupCommand(ctx, "Preparing the app…", cmd, args, cwd);
  return code === 0 ? ok("done") : fail(`${failure} (exit ${code})`, fix);
}

/** Steps 5 and 6. */
async function ready(ctx: Ctx, report: Report): Promise<boolean> {
  const healthy = ctx.guide
    ? await ctx.guide.task("Waiting for Rei to be ready…", () => waitHealthy(ctx))
    : await waitHealthy(ctx);
  if (!report("healthy", "services healthy", healthy)) return false;
  return report("dns", "service names", await dnsResult(ctx));
}

/** Every service healthy (or running without a health check), the one-shot ones exited 0. */
async function waitHealthy(ctx: Ctx): Promise<CheckResult> {
  const deadline = ctx.clock.now() + HEALTHY_TIMEOUT_MS;
  const expected = await expectedServices(ctx);
  let waiting: { service: string; detail: string }[] = [];
  for (;;) {
    const rows = await psNow(ctx).catch(() => []);
    waiting = expected.flatMap((service) => {
      const j = judge(
        service,
        rows.find((r) => r.service === service),
        "",
      );
      return j.status === "ok" ? [] : [{ service, detail: j.detail }];
    });
    if (waiting.length === 0) return ok(`${expected.length} services`);
    if (ctx.clock.now() >= deadline) break;
    await ctx.clock.sleep(POLL_MS);
  }
  return fail(
    `not healthy after ${HEALTHY_TIMEOUT_MS / 1000} s: ${waiting.map((w) => `${w.service} (${w.detail})`).join(", ")}`,
    `see ${composeFor(ctx, waiting[0]?.service ?? "").command(`logs ${waiting[0]?.service ?? ""}`)}`,
  );
}

/** The last step: where to open Rei, and the setup code when the first account is still to be created. */
async function finish(ctx: Ctx): Promise<boolean> {
  ctx.out.line();
  return (await showSetupCode(ctx)) !== "unreachable";
}

/** Hide successful build output in the guide; failures reveal only the relevant command output. Login keeps its terminal. */
async function setupCommand(ctx: Ctx, title: string, cmd: string, args: string[], cwd?: string): Promise<number> {
  if (!ctx.guide) return ctx.runner.interactive(cmd, args, cwd ? { cwd } : undefined);
  const result = await ctx.guide.task(title, () => ctx.runner.run(cmd, args, { cwd }));
  if (result.code !== 0)
    ctx.guide.message((result.stderr || result.stdout).slice(-4000) || `Command exited ${result.code}`, "error");
  return result.code;
}
