// `rei reader ...`: the shared reader's own CLI inside its container (it owns the attempt store). `stats` shows how the
// rendering engines have done, the numbers behind the decision whether the Chromium fallback is still needed.
import type { Ctx } from "../ctx.ts";

export function reader(ctx: Ctx, args: string[]): Promise<number> {
  return ctx.shared.interactive(["exec", "-T", "reader", "node", "src/cli.ts", ...args]);
}
