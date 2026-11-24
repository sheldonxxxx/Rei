// Which stack this CLI acts on. One machine can run more than one Rei, each with its own Dodai: the stack is chosen by the
// directory holding its .env and .secrets/ (REI_ENV_DIR, default the compose files' directory) and by three variables,
// read from the environment first and from that .env otherwise, the way compose itself resolves them:
//   REI_PROJECT  Rei's compose project (default rei). Dodai's is <REI_PROJECT>-dodai, and its named networks, volumes and
//                source-built images carry the same prefix.
//   REI_NET      the first two octets of every fixed subnet and address (default 10.89: 10.89.231.0/24 … 10.89.238.0/24).
//   REI_PUBLISH  where the app is published (default 127.0.0.1:8787).
// A second stack must change all three, so a project other than rei with the default REI_NET is refused before compose runs.
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_PROJECT = "rei";
export const DEFAULT_NET = "10.89";

/** The variables that pick the stack, which a stack's .env sets for the CLI as well as for compose. REI_PUBLISH is read
 * from the same .env too, but when it is needed (publishSetting in ctx.ts), since setup may write it. */
export const STACK_VARS = ["REI_PROJECT", "REI_NET"] as const;

/** The third octets of the stack's fixed /24 subnets, by network (233 is Rei's old private storage network). */
export const SUBNETS: readonly { octet: number; network: (project: string) => string }[] = [
  { octet: 231, network: (p) => `${p}_internal` },
  { octet: 232, network: (p) => `${p}_browser-net` },
  { octet: 233, network: (p) => `${p}_storage` },
  { octet: 234, network: (p) => `${p}-gateway-shared` },
  { octet: 235, network: (p) => `${p}-gateway-admin` },
  { octet: 236, network: (p) => `${p}-reader-internal` },
  { octet: 237, network: (p) => `${p}-storage` },
  { octet: 238, network: (p) => `${p}-storage-shared` },
];

/** A path as a person writes it: `~` and `~/…` mean the home directory, and a relative path is taken from `cwd`. */
export function expandPath(raw: string, cwd: string, homeDir: string): string {
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/")) return join(homeDir, raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** REI_ENV_DIR, expanded; `fallback` (the compose files' directory) when it is not set. */
export function envDir(
  env: Record<string, string | undefined>,
  fallback: string,
  cwd: string,
  homeDir: string,
): string {
  const raw = env.REI_ENV_DIR?.trim();
  return raw ? expandPath(raw, cwd, homeDir) : fallback;
}

/**
 * The environment with REI_PROJECT and REI_NET filled in from the stack's .env where the environment does not
 * set them (an empty value counts as not set). The environment wins, as it does for compose's interpolation.
 */
export function withStackVars(
  env: Record<string, string | undefined>,
  dotenv: ReadonlyMap<string, string>,
): Record<string, string | undefined> {
  const merged = { ...env };
  for (const name of STACK_VARS) {
    const value = env[name]?.trim() || dotenv.get(name)?.trim();
    if (value) merged[name] = value;
  }
  return merged;
}

/** Rei's compose project: REI_PROJECT, or undefined for the default (the compose file's own name, rei). */
export function reiProject(env: Record<string, string | undefined>): string | undefined {
  const project = env.REI_PROJECT?.trim();
  return project && project !== DEFAULT_PROJECT ? project : undefined;
}

/** Dodai's compose project: <REI_PROJECT>-dodai, or undefined for the default (the compose file's own name, dodai). */
export function dodaiProject(env: Record<string, string | undefined>): string | undefined {
  const project = reiProject(env);
  return project ? `${project}-dodai` : undefined;
}

/** The prefix of the stack's volumes, named networks and source-built images. */
export const projectPrefix = (env: Record<string, string | undefined>): string => reiProject(env) ?? DEFAULT_PROJECT;

/** REI_NET, or the default. */
export const stackNet = (env: Record<string, string | undefined>): string => env.REI_NET?.trim() || DEFAULT_NET;

const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;

/** Why this stack must not be started, or undefined. Checked before any compose call. */
export function stackProblem(env: Record<string, string | undefined>): string | undefined {
  const project = env.REI_PROJECT?.trim();
  const net = env.REI_NET?.trim();
  if (project && !PROJECT.test(project))
    return `REI_PROJECT must be lowercase letters, digits, - and _ and start with a letter or digit (got "${project}")`;
  if (net) {
    const parts = net.split(".");
    if (parts.length !== 2 || !parts.every((p) => OCTET.test(p)))
      return `REI_NET must be two octets such as 10.90 (got "${net}")`;
  }
  if (reiProject(env) && (!net || net === DEFAULT_NET))
    return `REI_PROJECT is ${project} but REI_NET is ${net ? "the default" : "not set"} (${DEFAULT_NET}), which the first stack uses: set REI_NET to two octets of its own (for example 10.90) and REI_PUBLISH to a port of its own in the same .env`;
  return undefined;
}
