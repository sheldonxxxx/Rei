// `rei setup-code`: prints the one-time setup code a new Rei asks for when its first account is created. Read-only.

import { authState } from "../checks/app.ts";
import type { Ctx } from "../ctx.ts";
import { appUrls } from "../ctx.ts";
import { firstLine } from "../format.ts";

export type SetupCodeOutcome = "unreachable" | "signed-up" | "no-code" | "shown";

/** Prints where to open Rei and the setup code, when the first account is still to be created. */
export async function showSetupCode(ctx: Ctx): Promise<SetupCodeOutcome> {
  const { url } = appUrls(ctx);
  const state = await authState(ctx);
  if (state === null) {
    ctx.out.line(`${url} did not answer from here. Start Rei with ./rei start, then run ./rei setup-code again.`);
    return "unreachable";
  }
  if (!state.setupRequired) {
    ctx.out.line(`Rei already has an account. Sign in at ${url}`);
    return "signed-up";
  }
  const read = await ctx.compose.exec("control", ["cat", "/data/setup-code.txt"], { timeoutMs: 20_000 });
  const code = read.code === 0 ? firstLine(read.stdout, 80) : "";
  if (!code) {
    ctx.out.line(`Open ${url}. The setup code was not found; it is in the control log:`);
    ctx.out.line(`    ${ctx.compose.command("logs control")} | grep "setup code"`);
    return "no-code";
  }
  ctx.out.line(`Open ${url} and create your account with this setup code:`);
  ctx.out.line();
  ctx.out.line(`    ${code}`);
  return "shown";
}

/** The command: exit 0 when a code is shown or the account already exists; 1 when Rei cannot be reached or has no code. */
export async function setupCode(ctx: Ctx): Promise<number> {
  const outcome = await showSetupCode(ctx);
  return outcome === "shown" || outcome === "signed-up" ? 0 : 1;
}
