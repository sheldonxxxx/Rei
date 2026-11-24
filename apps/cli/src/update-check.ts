// At most once a day an npm installation asks the registry whether a newer rei-ai exists, and says so. It never updates
// itself: a person upgrades with npm, then `rei upgrade`. Silent offline, on any error, and when switched off
// (REI_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER, or CI).
import { join } from "node:path";
import type { Ctx } from "./ctx.ts";
import { compareVersions, isVersion } from "./version.ts";

export const UPDATE_CACHE = ".update-check.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY = "https://registry.npmjs.org/rei-ai/latest";

/** The line to print, or undefined. Asks the registry only when the last check is a day old. */
export async function updateNotice(ctx: Ctx, timeoutMs = 1500): Promise<string | undefined> {
  if (ctx.mode !== "image") return undefined;
  const { env } = ctx;
  if (env.REI_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI) return undefined;
  const cache = join(ctx.containersDir, UPDATE_CACHE);
  const now = ctx.clock.now();
  try {
    const last = JSON.parse(ctx.host.readText(cache) ?? "{}") as { checkedAt?: unknown };
    if (typeof last.checkedAt === "number" && now - last.checkedAt < DAY_MS && last.checkedAt <= now) return undefined;
  } catch {
    // An unreadable cache is a stale one.
  }
  let latest: string | undefined;
  try {
    const response = await ctx.fetch(REGISTRY, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const version = ((await response.json()) as { version?: unknown }).version;
    latest = typeof version === "string" && isVersion(version) ? version : undefined;
  } catch {
    return undefined;
  }
  try {
    ctx.host.writeText(cache, `${JSON.stringify({ checkedAt: now, latest })}\n`, 0o644);
  } catch {
    // Then the next run asks again.
  }
  if (!latest || !isVersion(ctx.version) || compareVersions(latest, ctx.version) <= 0) return undefined;
  return `Rei ${latest} is available (this is ${ctx.version}). To upgrade: npm i -g rei-ai@latest, then rei upgrade.`;
}
