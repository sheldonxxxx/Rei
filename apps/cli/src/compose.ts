// `docker compose` for one of the two compose projects, over a Runner: Rei's own stack (compose.yaml) and Dodai
// (compose.dodai.yaml). In a checkout each is loaded with its build overlay (compose.build.yaml, compose.dodai.build.yaml),
// which builds the images from source; an npm installation has the base files only, which name published images. The
// compose file decides the project name (rei, dodai); REI_PROJECT overrides Rei's like containers/smoke-exec.sh does, and
// the shared project is then <REI_PROJECT>-dodai (stack.ts). The env files live in the stack's env directory
// (REI_ENV_DIR, default the compose files' directory).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Runner, RunOptions, RunResult } from "./io.ts";

export interface PsRow {
  service: string;
  /** Short id: `docker inspect` takes it. */
  id: string;
  state: string;
  /** "" when the image has no healthcheck. */
  health: string;
  exitCode: number;
  publishers: { host: string; port: number; target: number }[];
}

export interface Inspected {
  id: string;
  restartCount: number;
  networks: Record<string, { aliases: string[]; dnsNames: string[] }>;
}

/** `ps --format json` prints one object per line since compose 2.21, and one array before that. */
export function parsePs(text: string): PsRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const objects: unknown[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown);
  return objects.flatMap((o) => {
    const r = o as Record<string, unknown>;
    if (typeof r.Service !== "string") return [];
    const publishers = (Array.isArray(r.Publishers) ? r.Publishers : []) as {
      URL?: string;
      TargetPort?: number;
      PublishedPort?: number;
    }[];
    return [
      {
        service: r.Service,
        id: String(r.ID ?? ""),
        state: String(r.State ?? ""),
        health: String(r.Health ?? ""),
        exitCode: Number(r.ExitCode ?? 0),
        publishers: publishers
          .filter((p) => (p.PublishedPort ?? 0) > 0)
          .map((p) => ({ host: p.URL ?? "", port: p.PublishedPort ?? 0, target: p.TargetPort ?? 0 })),
      },
    ];
  });
}

/** `docker compose version --short` prints 2.29.1, 5.6.1 or v2.29.1. */
export function parseComposeVersion(text: string): [number, number, number] | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function parseInspect(text: string): Inspected[] {
  const list = JSON.parse(text) as {
    Id?: string;
    RestartCount?: number;
    NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] | null; DNSNames?: string[] | null }> };
  }[];
  return list.map((c) => ({
    id: c.Id ?? "",
    restartCount: c.RestartCount ?? 0,
    networks: Object.fromEntries(
      Object.entries(c.NetworkSettings?.Networks ?? {}).map(([name, n]) => [
        name,
        { aliases: n.Aliases ?? [], dnsNames: n.DNSNames ?? [] },
      ]),
    ),
  }));
}

export interface ComposeOptions {
  /** The directory holding .env and .secrets/secrets.env; default the base file's directory. */
  envDir?: string;
  /** Whether a file exists (the env files are passed only when they do); default the real file system. */
  exists?: (path: string) => boolean;
}

export class Compose {
  readonly runner: Runner;
  /** The base compose file. */
  readonly file: string;
  /** Every file passed with -f, in order: the base file, then any overlay. */
  readonly files: readonly string[];
  readonly project: string | undefined;
  /** Where .env and .secrets/ are. */
  readonly envDir: string;
  private readonly exists: (path: string) => boolean;

  constructor(runner: Runner, files: string | readonly string[], project?: string, opts: ComposeOptions = {}) {
    this.runner = runner;
    this.files = typeof files === "string" ? [files] : [...files];
    if (this.files.length === 0) throw new Error("a compose project needs a file");
    this.file = this.files[0]!;
    this.project = project || undefined;
    this.envDir = opts.envDir ?? dirname(this.file);
    this.exists = opts.exists ?? existsSync;
  }

  private fileArgs(): string[] {
    return this.files.flatMap((file) => ["-f", file]);
  }

  /**
   * The env files compose interpolates: containers/.env, then .secrets/secrets.env, which hands each service only the
   * secrets it uses. Passing --env-file replaces compose's own .env lookup, so .env is named too. Only those that exist.
   */
  envFileArgs(): string[] {
    const dir = this.envDir;
    return [join(dir, ".env"), join(dir, ".secrets", "secrets.env")]
      .filter((path) => this.exists(path))
      .flatMap((path) => ["--env-file", path]);
  }

  args(rest: string[]): string[] {
    return [
      "compose",
      ...this.envFileArgs(),
      ...this.fileArgs(),
      ...(this.project ? ["-p", this.project] : []),
      ...rest,
    ];
  }

  /** The command as a user would type it, for a `fix` line. */
  command(rest: string): string {
    return `docker compose ${[...this.envFileArgs(), ...this.fileArgs()].join(" ")}${this.project ? ` -p ${this.project}` : ""} ${rest}`;
  }

  run(rest: string[], opts?: RunOptions): Promise<RunResult> {
    return this.runner.run("docker", this.args(rest), opts);
  }

  /** Output goes straight to the terminal. */
  interactive(rest: string[]): Promise<number> {
    return this.runner.interactive("docker", this.args(rest));
  }

  exec(service: string, argv: string[], opts?: RunOptions): Promise<RunResult> {
    return this.run(["exec", "-T", service, ...argv], opts);
  }

  /** Every container of the project, stopped ones included. Throws with compose's complaint when it fails. */
  async ps(): Promise<PsRow[]> {
    const r = await this.run(["ps", "--all", "--format", "json"], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/, 1)[0] || `docker compose ps exited ${r.code}`);
    return parsePs(r.stdout);
  }

  /** The services of the active profiles, from the compose file. */
  async services(): Promise<string[]> {
    const r = await this.run(["config", "--services"], { timeoutMs: 30_000 });
    return r.code === 0
      ? r.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }

  async inspect(ids: string[]): Promise<Inspected[]> {
    if (ids.length === 0) return [];
    const r = await this.runner.run("docker", ["inspect", ...ids], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/, 1)[0] || `docker inspect exited ${r.code}`);
    return parseInspect(r.stdout);
  }
}
