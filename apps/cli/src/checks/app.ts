// The app on its published address, from this machine.
import type { AuthStateResponse } from "@rei/protocol";
import type { Ctx } from "../ctx.ts";
import { appUrls } from "../ctx.ts";
import type { CheckResult } from "../format.ts";
import { fail, ok } from "../format.ts";

const TIMEOUT_MS = 5_000;

export async function appHealth(ctx: Ctx): Promise<CheckResult> {
  const { url, fetchBase } = appUrls(ctx);
  try {
    const res = await ctx.fetch(`${fetchBase}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await res.json()) as { ok?: boolean };
    return res.ok && body.ok === true
      ? ok(`${url} answers`)
      : fail(`${url} answered ${res.status}`, "see the docker compose logs of control and edge");
  } catch {
    return fail(
      `${url} does not answer`,
      "is the stack up? run ./rei setup; if REI_PUBLISH points elsewhere, check containers/.env",
    );
  }
}

/** Whether an account exists (GET /api/auth/state); null when the app does not answer. */
export async function authState(ctx: Ctx): Promise<AuthStateResponse | null> {
  try {
    const res = await ctx.fetch(`${appUrls(ctx).fetchBase}/api/auth/state`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json()) as Partial<AuthStateResponse>;
    return res.ok && typeof body.setupRequired === "boolean"
      ? { setupRequired: body.setupRequired, signedIn: body.signedIn === true, totpEnabled: body.totpEnabled === true }
      : null;
  } catch {
    return null;
  }
}
