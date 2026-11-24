import { join } from "node:path";
import type { Ctx } from "../ctx.ts";
import { dropLegacyStorageNetwork, retireLegacyGateway, retireLegacyStorage } from "../ctx.ts";

interface Step {
  title: string;
  command: string;
  args: string[];
  cwd?: string;
}

async function runStep(ctx: Ctx, step: Step): Promise<number> {
  if (ctx.guide) {
    const result = await ctx.guide.task(step.title, () =>
      ctx.runner.run(step.command, step.args, { ...(step.cwd ? { cwd: step.cwd } : {}) }),
    );
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-4000);
      if (detail) ctx.guide.message(detail, "error");
    }
    return result.code;
  }

  ctx.out.line(step.title);
  return ctx.runner.interactive(step.command, step.args, step.cwd ? { cwd: step.cwd } : undefined);
}

/**
 * Rebuild the web app and every Compose image of both projects, then recreate services without deleting their data
 * volumes or secrets. Docker's build cache is reused, so unchanged layers are not rebuilt; --no-cache forces a full
 * rebuild. Dodai goes first, and Rei's are recreated once they are healthy.
 */
export async function redeploy(ctx: Ctx, opts: { noCache?: boolean } = {}): Promise<number> {
  ctx.guide?.intro("Rebuild and redeploy Rei");
  ctx.guide?.message(
    "This recreates Rei's containers and causes a short interruption. Data volumes and secrets are kept.",
  );
  if (!ctx.guide) ctx.out.line("Rebuilding Rei. Containers will restart; data volumes and secrets are kept.");

  if (!ctx.host.stat(join(ctx.root, "node_modules"))) {
    const code = await runStep(ctx, {
      title: "Installing locked dependencies…",
      command: "npm",
      args: ["ci"],
      cwd: ctx.root,
    });
    if (code !== 0) return failed(ctx, "install dependencies", "npm ci", code);
  }

  const webCode = await runStep(ctx, {
    title: "Building the web app…",
    command: "npm",
    args: ["run", "build", "-w", "@rei/web"],
    cwd: ctx.root,
  });
  if (webCode !== 0) return failed(ctx, "build the web app", "npm run build -w @rei/web", webCode);

  const cache = opts.noCache ? "without the build cache" : "with the build cache";
  const buildArgs = opts.noCache ? ["build", "--no-cache"] : ["build"];
  for (const [project, name] of [
    [ctx.shared, "Dodai's images"],
    [ctx.compose, "all Rei-built Compose images"],
  ] as const) {
    const imagesCode = await runStep(ctx, {
      title: `Rebuilding ${name} ${cache}…`,
      command: "docker",
      args: project.args(buildArgs),
      cwd: ctx.root,
    });
    if (imagesCode !== 0)
      return failed(ctx, "rebuild Rei's images", `docker compose ${buildArgs.join(" ")}`, imagesCode);
  }

  await retireLegacyGateway(ctx);
  await retireLegacyStorage(ctx);
  // Storage is not recreated: callers use Garage directly, so it gets a plain `up`, which only touches it when its
  // configuration changed. Dodai's Rei-built services are recreated.
  const storageCode = await runStep(ctx, {
    title: "Checking Dodai's storage…",
    command: "docker",
    args: ctx.shared.args(["up", "-d", "--wait", "garage", "qdrant"]),
    cwd: ctx.root,
  });
  if (storageCode !== 0)
    return failed(
      ctx,
      "start Dodai's storage",
      "docker compose up",
      storageCode,
      "Some services may still be running.",
    );
  const sharedCode = await runStep(ctx, {
    title: "Recreating Dodai…",
    command: "docker",
    args: ctx.shared.args(["up", "-d", "--force-recreate", "--wait", "gateway", "reader"]),
    cwd: ctx.root,
  });
  if (sharedCode !== 0)
    return failed(ctx, "redeploy Dodai", "docker compose up", sharedCode, "Some services may still be running.");

  const deployCode = await runStep(ctx, {
    title: "Recreating Rei services…",
    command: "docker",
    args: ctx.compose.args(["up", "-d", "--force-recreate", "--remove-orphans"]),
    cwd: ctx.root,
  });
  if (deployCode !== 0)
    return failed(ctx, "redeploy Rei", "docker compose up", deployCode, "Some services may still be running.");

  await dropLegacyStorageNetwork(ctx);
  ctx.reset();
  const done =
    "Rei was rebuilt and redeployed. Data volumes and secrets were kept. Run ./rei status to check services.";
  if (ctx.guide) ctx.guide.outro(done);
  else ctx.out.line(done);
  return 0;
}

function failed(ctx: Ctx, action: string, command: string, code: number, extra = ""): number {
  const message = `Could not ${action} (${command} exited ${code}).${extra ? ` ${extra}` : ""} Data volumes and secrets were not deleted.`;
  if (ctx.guide) ctx.guide.outro(message);
  else ctx.out.line(message);
  return code;
}
