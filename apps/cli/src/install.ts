// An npm installation's own files in REI_HOME: the compose files and scripts it carries in assets/, and the version it
// last set up or upgraded to. .env and .secrets/ are the installation's and are never written here.
import { dirname, join } from "node:path";
import { ASSET_FILES } from "./asset-files.ts";
import type { Ctx } from "./ctx.ts";

/** The release an installation runs, written after a setup or upgrade that finished. */
export const MARKER = ".installed-version";

/** The version REI_HOME was last set up with; undefined before the first setup. */
export function installedVersion(ctx: Ctx): string | undefined {
  return ctx.host.readText(join(ctx.containersDir, MARKER))?.trim() || undefined;
}

export function markInstalled(ctx: Ctx): void {
  ctx.host.writeText(join(ctx.containersDir, MARKER), `${ctx.version}\n`, 0o644);
}

/** Whether REI_HOME holds an installation at all (its compose file). */
export const isInstalled = (ctx: Ctx): boolean => ctx.host.stat(join(ctx.containersDir, "compose.yaml")) !== undefined;

/**
 * Writes the packaged files into REI_HOME, each beside its target and then moved into place, so a file is never half
 * written. A file that already matches is left alone. Returns the paths it wrote; throws when the package is incomplete.
 */
export function installAssets(ctx: Ctx): string[] {
  const from = ctx.assetsDir;
  if (!from) throw new Error("this CLI carries no installation files (it runs from a checkout)");
  const { host } = ctx;
  host.mkdirp(ctx.containersDir, 0o755);
  const written: string[] = [];
  for (const file of ASSET_FILES) {
    const text = host.readText(join(from, file.path));
    if (text === undefined) throw new Error(`the package is missing assets/${file.path}; reinstall rei-ai`);
    const target = join(ctx.containersDir, file.path);
    if (host.readText(target) === text && host.stat(target)?.mode === file.mode) continue;
    host.mkdirp(dirname(target), 0o755);
    host.writeText(`${target}.tmp`, text, file.mode);
    host.rename(`${target}.tmp`, target);
    written.push(target);
  }
  return written;
}
