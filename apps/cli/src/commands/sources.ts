// `rei sources ...`: event source administration, done by the control plane's own admin entry inside its container (it is
// the only holder of the key that encrypts the secrets). The arguments go through unchanged and its output comes straight
// to the terminal, so a new secret is shown once and is never held or logged here.
import type { Ctx } from "../ctx.ts";

export async function sources(ctx: Ctx, args: string[]): Promise<number> {
  const running = (await ctx.compose.ps().catch(() => [])).some(
    (r) => r.service === "control" && r.state === "running",
  );
  if (!running) {
    console.error(`rei: Rei is not running, so event sources cannot be changed. Run ${ctx.cli} start first.`);
    return 1;
  }
  return ctx.compose.interactive(["exec", "-T", "control", "node", "src/node/events-cli.ts", "sources", ...args]);
}
