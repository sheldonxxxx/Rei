// restic, the one engine of Rei's backups: a thin client over the `restic` binary in the control image. The repository is
// a local folder (a bind mount), so nothing here uses a network. The password reaches the process only through its
// environment and never appears in an argument, a log line or an error message.
import { spawn } from "node:child_process";
import type { BackupRetention } from "@rei/protocol";
import { type ResticBackupResult, type ResticClient, ResticError, type ResticSnapshot } from "../backup/restic.ts";

export interface ResticOptions {
  repository: string;
  password: string;
  /** restic's cache; kept in the staging volume because the container's root file system is read-only. */
  cacheDir: string;
  /** The binary (default `restic`). */
  binary?: string;
  /** Extra environment, for tests. */
  env?: NodeJS.ProcessEnv;
  /** The host name snapshots are recorded under (default `rei`), so a changing container id never splits the retention groups. */
  host?: string;
  /** false adds --no-lock to the reads (snapshots, restore): for a repository mounted read-only, where restic could not write its lock. */
  lock?: boolean;
}

interface Finished {
  code: number;
  stdout: string;
  stderr: string;
}

/** The last lines of restic's complaint, with the password cut out of it. */
function describe(password: string, text: string): string {
  const clean = password ? text.split(password).join("***") : text;
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-6).join("\n").slice(0, 2000);
}

export class ProcessRestic implements ResticClient {
  readonly #o: ResticOptions;
  constructor(options: ResticOptions) {
    this.#o = options;
  }

  get #host(): string {
    return this.#o.host ?? "rei";
  }

  get #lockless(): string[] {
    return this.#o.lock === false ? ["--no-lock"] : [];
  }

  #exec(args: string[]): Promise<Finished> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#o.binary ?? "restic", args, {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "/tmp",
          ...this.#o.env,
          RESTIC_REPOSITORY: this.#o.repository,
          RESTIC_PASSWORD: this.#o.password,
          RESTIC_CACHE_DIR: this.#o.cacheDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.once("error", (error) =>
        reject(
          new ResticError(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "The restic program is not installed in this image."
              : describe(this.#o.password, error.message),
          ),
        ),
      );
      child.once("close", (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        }),
      );
    });
  }

  async #ok(what: string, args: string[]): Promise<Finished> {
    const done = await this.#exec(args);
    if (done.code !== 0) {
      const wrongPassword = /wrong password|no key found/i.test(done.stderr);
      throw new ResticError(
        wrongPassword
          ? "restic did not accept the password for this repository."
          : `restic ${what} failed (exit ${done.code}): ${describe(this.#o.password, done.stderr || done.stdout)}`,
      );
    }
    return done;
  }

  async init(): Promise<void> {
    await this.#ok("init", ["init", "--quiet"]);
  }

  async snapshots(): Promise<ResticSnapshot[]> {
    const done = await this.#ok("snapshots", ["snapshots", "--json", ...this.#lockless]);
    const list = JSON.parse(done.stdout || "[]") as {
      id: string;
      short_id: string;
      time: string;
      hostname: string;
      paths?: string[];
      tags?: string[];
    }[];
    return list.map((s) => ({
      id: s.id,
      shortId: s.short_id,
      time: s.time,
      hostname: s.hostname,
      paths: s.paths ?? [],
      tags: s.tags ?? [],
    }));
  }

  async backup(dir: string, tags: string[]): Promise<ResticBackupResult> {
    const done = await this.#ok("backup", [
      "backup",
      "--json",
      "--host",
      this.#host,
      ...tags.flatMap((tag) => ["--tag", tag]),
      dir,
    ]);
    // One JSON object per line; the last of message_type "summary" is the result.
    let summary: { snapshot_id?: string; data_added?: number; files_new?: number } | undefined;
    for (const line of done.stdout.split(/\r?\n/)) {
      if (!line.startsWith("{")) continue;
      try {
        const message = JSON.parse(line) as { message_type?: string };
        if (message.message_type === "summary") summary = message as typeof summary;
      } catch {
        // progress noise
      }
    }
    if (!summary?.snapshot_id) throw new ResticError("restic backup finished without reporting a snapshot.");
    return {
      snapshotId: summary.snapshot_id,
      bytesAdded: Number(summary.data_added ?? 0),
      filesNew: Number(summary.files_new ?? 0),
    };
  }

  async forget(retention: BackupRetention): Promise<void> {
    await this.#ok("forget", [
      "forget",
      "--host",
      this.#host,
      "--keep-daily",
      String(retention.daily),
      "--keep-weekly",
      String(retention.weekly),
      "--keep-monthly",
      String(retention.monthly),
      "--quiet",
    ]);
  }

  async prune(): Promise<void> {
    await this.#ok("prune", ["prune", "--quiet"]);
  }

  async check(readDataSubset: string): Promise<void> {
    await this.#ok("check", ["check", `--read-data-subset=${readDataSubset}`, "--quiet"]);
  }

  async restore(snapshot: string, subfolder: string, target: string, include: string[] = []): Promise<void> {
    await this.#ok("restore", [
      "restore",
      `${snapshot}:${subfolder}`,
      "--target",
      target,
      ...include.flatMap((path) => ["--include", path]),
      ...this.#lockless,
      "--quiet",
    ]);
  }
}
