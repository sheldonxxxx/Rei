// Where this CLI runs from, decided once at start. Run from an npm installation (rei-ai), the bundle has assets/ beside
// dist/, and the stack lives in REI_HOME (default ~/.rei): image mode. Run from a checkout (./rei), it is three levels
// under the repository and the stack lives in <repo>/containers: source mode. Ctx then confirms the mode by the build
// overlay next to the compose files.
import { isAbsolute, join, resolve } from "node:path";

export interface Layout {
  /** The repository, or REI_HOME. */
  root: string;
  /** Where the compose files, .env and .secrets/ are. */
  containersDir: string;
  /** The packaged compose files and scripts (image mode only). */
  assetsDir?: string;
}

/** REI_HOME as given: `~` and `~/…` mean the home directory, and a relative path is taken from here. */
export function reiHome(env: Record<string, string | undefined>, homeDir: string): string {
  const raw = env.REI_HOME?.trim();
  if (!raw) return join(homeDir, ".rei");
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/")) return join(homeDir, raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(raw);
}

/** `here` is the directory of the running script: apps/cli/src in a checkout, dist/ in the package. */
export function locate(
  here: string,
  env: Record<string, string | undefined>,
  homeDir: string,
  exists: (path: string) => boolean,
): Layout {
  const assetsDir = join(here, "..", "assets");
  if (exists(join(assetsDir, "compose.yaml"))) {
    const home = reiHome(env, homeDir);
    return { root: home, containersDir: home, assetsDir };
  }
  const root = resolve(here, "..", "..", "..");
  return { root, containersDir: join(root, "containers") };
}

/**
 * The CLI's messages are written for a checkout: `./rei setup`, `containers/.env`. In image mode they are said the way
 * that installation works: `rei setup`, `~/.rei/.env`, and `rei init` for containers/init.sh (which it does not have).
 */
export function phrase(text: string, mode: "source" | "image", home: string, homeDir: string): string {
  if (mode === "source") return text;
  const shown = home.startsWith(`${homeDir}/`) ? `~/${home.slice(homeDir.length + 1)}` : home;
  return text
    .replace(/(?<![\w/.-])(?:\.\/)?containers\/init\.sh/g, "rei init")
    .replace(/(?<![\w/.-])\.\/rei\b/g, "rei")
    .replace(/(?<![\w/.-])containers\//g, `${shown}/`);
}
