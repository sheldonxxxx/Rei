// What every command and check works with: the injected edges plus the stack's paths, with `memo` so one `doctor` run asks
// docker each question once (setup calls `reset` after it changes the stack).
import { join } from "node:path";
import type { PsRow } from "./compose.ts";
import { Compose } from "./compose.ts";
import { parseDotenv } from "./dotenv.ts";
import type { Clock, Guide, Host, Out, Prompter, Runner } from "./io.ts";
import { phrase } from "./layout.ts";
import { dodaiProject, projectPrefix, reiProject, STACK_VARS, withStackVars } from "./stack.ts";
import type { Publish } from "./validate.ts";
import { appAddress, parsePublish } from "./validate.ts";

/**
 * source: a checkout, run as ./rei; images are built from the repository (the build overlays sit next to the compose files).
 * image: an npm installation (rei-ai), run as rei; the compose files live in REI_HOME and name published images.
 */
export type Mode = "source" | "image";

export interface Ctx {
  guide?: Guide;
  /** The repository in source mode; REI_HOME in image mode. */
  root: string;
  /** Where the compose files are: <repo>/containers, or REI_HOME. */
  containersDir: string;
  /** Where .env and .secrets/ are: REI_ENV_DIR, else containersDir. */
  envDir: string;
  /** REI_ENV_DIR, and REI_PROJECT and REI_NET as this CLI resolved them: every process it starts gets them (`runner`), so
   * compose's interpolation and the smoke scripts mean the same stack as the CLI. */
  stackEnv: Record<string, string>;
  mode: Mode;
  /** How a person runs this CLI, for messages: ./rei or rei. */
  cli: string;
  /** The packaged compose files and scripts that image mode writes into REI_HOME. */
  assetsDir?: string;
  /** This CLI's version: the release whose images an npm installation runs. */
  version: string;
  composeFile: string;
  /** Rei's own stack (compose.yaml). */
  compose: Compose;
  /** Dodai (compose.dodai.yaml): the gateway and the reader. Other callers use it, so it outlives a stop of Rei. */
  shared: Compose;
  runner: Runner;
  out: Out;
  clock: Clock;
  host: Host;
  prompter: Prompter;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  memo<T>(key: string, fn: () => Promise<T>): Promise<T>;
  reset(): void;
}

export interface CtxParts {
  guide?: Guide;
  root: string;
  /** REI_HOME in an npm installation; <root>/containers when it is not given. */
  containersDir?: string;
  /** REI_ENV_DIR, already expanded; containersDir when it is not given. */
  envDir?: string;
  assetsDir?: string;
  version?: string;
  runner: Runner;
  out: Out;
  clock: Clock;
  host: Host;
  prompter: Prompter;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
}

/** The file whose presence next to the compose files makes a checkout (source mode). */
export const BUILD_OVERLAY = "compose.build.yaml";

export function makeCtx(p: CtxParts): Ctx {
  const containersDir = p.containersDir ?? join(p.root, "containers");
  const mode: Mode = p.host.stat(join(containersDir, BUILD_OVERLAY)) ? "source" : "image";
  // A base file, then in a checkout its build overlay: compose.yaml + compose.build.yaml, compose.dodai.yaml + compose.dodai.build.yaml.
  const files = (base: string): string[] =>
    mode === "source"
      ? [join(containersDir, `${base}.yaml`), join(containersDir, `${base}.build.yaml`)]
      : [join(containersDir, `${base}.yaml`)];
  const composeFile = join(containersDir, "compose.yaml");
  const cache = new Map<string, Promise<unknown>>();
  // REI_PROJECT and REI_NET: the environment, else the stack's .env. Compose is handed the same values, so
  // its interpolation and this CLI always mean the same stack.
  const envDir = p.envDir ?? containersDir;
  const env = withStackVars(p.env, parseDotenv(p.host.readText(join(envDir, ".env")) ?? ""));
  const vars = Object.fromEntries(STACK_VARS.flatMap((name) => (env[name] ? [[name, env[name]]] : [])));
  const stackEnv: Record<string, string> = { REI_ENV_DIR: envDir, ...vars };
  const runner = withEnv(p.runner, stackEnv);
  const composeOptions = { envDir, exists: (path: string) => p.host.stat(path) !== undefined };
  const compose = new Compose(runner, files("compose"), reiProject(env), composeOptions);
  const shared = new Compose(runner, files("compose.dodai"), dodaiProject(env), composeOptions);
  // Messages are written for a checkout (./rei, containers/…); an npm installation says them its own way.
  const say = (text: string): string => phrase(text, mode, containersDir, p.host.homeDir, envDir);
  const plain = mode === "source" && envDir === containersDir;
  const out: Out = plain ? p.out : { line: (text?: string) => p.out.line(text && say(text)), color: p.out.color };
  const guide: Guide | undefined =
    plain || !p.guide
      ? p.guide
      : {
          intro: (title) => p.guide?.intro(say(title)),
          outro: (message) => p.guide?.outro(say(message)),
          message: (message, kind) => p.guide?.message(say(message), kind),
          task: (message, work) => (p.guide as Guide).task(say(message), work),
        };
  return {
    ...p,
    ...(guide ? { guide } : {}),
    env,
    runner,
    out,
    version: p.version ?? "0.0.0",
    containersDir,
    envDir,
    stackEnv,
    mode,
    cli: mode === "source" ? "./rei" : "rei",
    composeFile,
    compose,
    shared,
    memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
      let hit = cache.get(key) as Promise<T> | undefined;
      if (!hit) cache.set(key, (hit = fn()));
      return hit;
    },
    reset: () => cache.clear(),
  };
}

/** A Runner whose processes also get `vars`, over whatever the caller passes. */
function withEnv(runner: Runner, vars: Record<string, string>): Runner {
  return {
    run: (cmd, args, opts) => runner.run(cmd, args, { ...opts, env: { ...opts?.env, ...vars } }),
    interactive: (cmd, args, opts) => runner.interactive(cmd, args, { ...opts, env: { ...opts?.env, ...vars } }),
  };
}

/** The services of Dodai: the gateway, the reader, and storage. */
export const SHARED_SERVICES: ReadonlySet<string> = new Set(["gateway", "reader", "garage", "qdrant"]);

/** The Docker volumes Dodai and Rei keep their data in. They are external, so init.sh makes them and no `down -v` reaches them. */
export const EXTERNAL_VOLUMES = [
  "gateway-data",
  "reader-data",
  "garage-meta",
  "garage-data",
  "qdrant-data",
  "qdrant-snapshots",
] as const;

/** The volume's real name: <REI_PROJECT or rei>_<name>, the prefix Rei's own project gave them. */
export const volumeName = (ctx: Ctx, name: string): string => `${projectPrefix(ctx.env)}_${name}`;

/** One of Dodai's named networks: <REI_PROJECT or rei>-<name> (gateway-shared, storage-shared, …). */
export const networkName = (ctx: Ctx, name: string): string => `${projectPrefix(ctx.env)}-${name}`;

/** The external volumes that do not exist yet (init.sh makes them). */
export async function missingVolumes(ctx: Ctx): Promise<string[]> {
  const found = await Promise.all(
    EXTERNAL_VOLUMES.map(async (name) => {
      const r = await ctx.runner.run("docker", ["volume", "inspect", volumeName(ctx, name)], { timeoutMs: 30_000 });
      return r.code === 0 ? undefined : volumeName(ctx, name);
    }),
  );
  return found.filter((v): v is string => v !== undefined);
}

/** The compose project a service belongs to. */
export const composeFor = (ctx: Ctx, service: string): Compose =>
  SHARED_SERVICES.has(service) ? ctx.shared : ctx.compose;

/** The stack as it is *right now*, both projects, for a loop that waits for a change: `ps` is memoized for a run, so a
 * poll that uses it re-reads one snapshot and can never see a container turn healthy. A gateway container still in
 * Rei's project is one from before the split; the shared project's row wins. */
export async function psNow(ctx: Ctx): Promise<PsRow[]> {
  const [own, shared] = await Promise.all([ctx.compose.ps(), ctx.shared.ps()]);
  return [...own.filter((r) => !shared.some((s) => s.service === r.service)), ...shared].sort((a, b) =>
    a.service.localeCompare(b.service),
  );
}

export const ps = (ctx: Ctx): Promise<PsRow[]> => ctx.memo("ps", () => psNow(ctx));

/** The ids of containers of Rei's own project for one of these services (stopped ones included). */
async function legacyContainers(ctx: Ctx, services: string[]): Promise<string[]> {
  const project = ctx.compose.project ?? "rei";
  const ids: string[] = [];
  for (const service of services) {
    const found = await ctx.runner.run(
      "docker",
      [
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ],
      { timeoutMs: 30_000 },
    );
    if (found.code === 0) ids.push(...found.stdout.split(/\s+/).filter(Boolean));
  }
  return ids;
}

/** Garage or Qdrant containers still in Rei's own project: from before storage moved to Dodai. */
export const legacyStorageContainers = (ctx: Ctx): Promise<string[]> => legacyContainers(ctx, ["garage", "qdrant"]);

/**
 * Removes the Garage and Qdrant containers that Rei's own project ran before storage moved to Dodai, so two Garages never
 * open one volume. The volumes stay. Nothing to do on a stack that never had them. Run it before Dodai starts.
 */
export async function retireLegacyStorage(ctx: Ctx): Promise<void> {
  const ids = await legacyStorageContainers(ctx);
  if (ids.length > 0) await ctx.runner.run("docker", ["rm", "-f", ...ids], { timeoutMs: 60_000 });
}

/**
 * Removes Rei's old private storage network (<project>_storage, <REI_NET>.233.0/24) once nothing is attached to it. Control
 * leaves it when Rei's stack is recreated on rei-storage, so run it after that. A failure (still attached, or already
 * gone) is fine: it is only housekeeping.
 */
export async function dropLegacyStorageNetwork(ctx: Ctx): Promise<void> {
  await ctx.runner.run("docker", ["network", "rm", `${ctx.compose.project ?? "rei"}_storage`], { timeoutMs: 30_000 });
}

/**
 * Removes the gateway container that Rei's own project ran before the gateway moved to the shared project, so two
 * gateways never write one data volume. The volume stays. Nothing to do on a stack that never had one.
 */
export async function retireLegacyGateway(ctx: Ctx): Promise<void> {
  const ids = await legacyContainers(ctx, ["gateway"]);
  if (ids.length > 0) await ctx.runner.run("docker", ["rm", "-f", ...ids], { timeoutMs: 60_000 });
}

export const dotenvPath = (ctx: Ctx): string => join(ctx.envDir, ".env");

/** The stack's shared secrets: .secrets/secrets.env in the env directory. */
export const secretsPath = (ctx: Ctx): string => join(ctx.envDir, ".secrets", "secrets.env");

/** The service names to check: the compose file's (active profiles), else whatever docker lists. */
export const expectedServices = (ctx: Ctx): Promise<string[]> =>
  ctx.memo("services", async () => {
    const fromFile = [...(await ctx.compose.services()), ...(await ctx.shared.services())];
    return fromFile.length > 0 ? fromFile : [...new Set((await ps(ctx)).map((r) => r.service))];
  });

/** REI_PUBLISH the way compose resolves it: the environment, else containers/.env (read now: setup may have just written
 * it), else the default. */
export function publishSetting(ctx: Ctx): string {
  return (
    ctx.env.REI_PUBLISH?.trim() ||
    parseDotenv(ctx.host.readText(dotenvPath(ctx)) ?? "").get("REI_PUBLISH") ||
    "127.0.0.1:8787"
  );
}

export const publish = (ctx: Ctx): Publish | null => parsePublish(publishSetting(ctx));

/** Where the app is (for people, and to connect to from here). */
export function appUrls(ctx: Ctx): { url: string; fetchBase: string } {
  return appAddress(publish(ctx) ?? { host: "127.0.0.1", port: 8787 });
}

export const running = (rows: PsRow[], service: string): boolean =>
  rows.some((r) => r.service === service && r.state === "running");
