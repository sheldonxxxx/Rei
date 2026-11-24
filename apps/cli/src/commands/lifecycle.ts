import type { Compose } from "../compose.ts";
import type { Ctx } from "../ctx.ts";
import { dropLegacyStorageNetwork, missingVolumes, retireLegacyGateway, retireLegacyStorage } from "../ctx.ts";

export type LifecycleAction = "start" | "stop" | "restart";

export interface LifecycleOptions {
  /** Stop or restart Dodai too. Without it Dodai keeps running, because other callers use them. */
  all?: boolean;
}

interface Step {
  project: Compose;
  args: string[];
}

const TEXT: Record<LifecycleAction, { title: string; progress: string; done: string }> = {
  start: { title: "Start Rei", progress: "Starting Rei…", done: "Rei services started." },
  stop: { title: "Stop Rei", progress: "Stopping Rei…", done: "Rei services stopped. Its data is preserved." },
  restart: { title: "Restart Rei", progress: "Restarting Rei…", done: "Rei services restarted." },
};

/** Dodai first on the way up (Rei needs the gateway), last on the way down. */
function steps(ctx: Ctx, action: LifecycleAction, all: boolean): Step[] {
  switch (action) {
    case "start":
      return [
        { project: ctx.shared, args: ["up", "-d", "--wait"] },
        { project: ctx.compose, args: ["up", "-d"] },
      ];
    case "stop":
      return [{ project: ctx.compose, args: ["stop"] }, ...(all ? [{ project: ctx.shared, args: ["stop"] }] : [])];
    case "restart":
      return [
        ...(all ? [{ project: ctx.shared, args: ["restart"] }] : []),
        { project: ctx.compose, args: ["restart"] },
      ];
  }
}

/** Start, stop or restart the existing Compose stack without running setup again. */
export async function lifecycle(ctx: Ctx, action: LifecycleAction, opts: LifecycleOptions = {}): Promise<number> {
  const item = TEXT[action];
  const all = opts.all ?? false;
  ctx.guide?.intro(item.title);
  if (action === "start") {
    const missing = await missingVolumes(ctx);
    if (missing.length > 0) {
      const message = `Storage volumes are missing (${missing.join(", ")}). Run ./rei setup, which creates them.`;
      if (ctx.guide) ctx.guide.outro(message);
      else ctx.out.line(message);
      return 1;
    }
    await retireLegacyGateway(ctx);
    await retireLegacyStorage(ctx);
  }

  let code = 0;
  if (!ctx.guide) ctx.out.line(item.progress);
  for (const step of steps(ctx, action, all)) {
    if (ctx.guide) {
      const result = await ctx.guide.task(item.progress, () => step.project.run(step.args));
      code = result.code;
      if (code !== 0) {
        const detail = (result.stderr || result.stdout).trim().slice(-4000);
        if (detail) ctx.guide.message(detail, "error");
      }
    } else code = await step.project.interactive(step.args);
    if (code !== 0) break;
  }

  if (code === 0 && action === "start") await dropLegacyStorageNetwork(ctx);
  ctx.reset();
  if (code === 0) {
    const kept =
      action !== "start" && !all
        ? ` Dodai (gateway, reader) was left running; ./rei ${action} --all includes them.`
        : "";
    if (ctx.guide) ctx.guide.outro(item.done + kept);
    else ctx.out.line(item.done + kept);
    return 0;
  }

  const failure = `Could not ${action} Rei (docker compose exited ${code}).`;
  if (ctx.guide) ctx.guide.outro(failure);
  else ctx.out.line(failure);
  return code;
}
