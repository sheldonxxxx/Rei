// The bundle: one directory that holds everything a restore needs, written while Rei keeps running. restic then backs up
// that directory, so unchanged files cost nothing and every snapshot is complete.
//
//   manifest.json   what is in it: versions, every file's size and SHA-256, counts
//   db/app.sqlite   an online, consistent copy of the database
//   files/          the data directory except the upload spool, the setup code and the database
//   gateway/        the gateway's state (provider sign-ins, keys, callers, models, its call log)
//   objects/<key>   a mirror of the file bucket
//
// The order keeps the database and the bucket consistent without stopping anything: mirror, dump the database, mirror
// again (add only), then write the manifest. An object uploaded and deleted in the seconds between the dump and the
// second mirror may be named by the dump and absent from the mirror; Rei reads a missing object as unavailable, never
// as an empty file, so that costs that one file.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { BACKUP_MANIFEST_FORMAT, type BackupManifest } from "@rei/protocol";
import type { BundleDeps, BundleResult, BundleRunner } from "../backup/bundle-types.ts";
import { parseObjectKey } from "../storage/file-object-store.ts";
import { mirrorTree, pruneEmptyDirs, sha256File, walkFiles, writeThrough } from "./backup-files.ts";

/** The data directory entries a bundle leaves out: the upload spool, the setup code and the database (it has its own part). */
export const DATA_SKIP: ReadonlySet<string> = new Set([
  "uploads",
  "setup-code.txt",
  "app.sqlite",
  "app.sqlite-wal",
  "app.sqlite-shm",
]);

/** The tables whose row counts the manifest records, when they exist. */
const COUNTED_TABLES = [
  "agents",
  "sessions",
  "messages",
  "history_entries",
  "attachments",
  "storage_objects",
  "knowledge_pages",
  "triggers",
  "event_sources",
];

const MIRROR_PARALLEL = 4;

/** A SQLite database file or the log and index beside it: copied by the database itself, never as a file. */
const isLiveDatabase = (name: string): boolean => /\.sqlite(-wal|-shm|-journal)?$/.test(name);

export class BundleWriter implements BundleRunner {
  readonly #d: BundleDeps;
  constructor(deps: BundleDeps) {
    this.#d = deps;
  }

  get #objectsDir(): string {
    return join(this.#d.dir, "objects");
  }

  /** Brings `objects/` in line with the bucket. Returns the number of objects mirrored. `pruneRemoved`: also deletes what the bucket no longer has. */
  async #mirror(pruneRemoved: boolean): Promise<number> {
    const store = this.#d.objects;
    const keys = (await store.list("", Number.MAX_SAFE_INTEGER)).filter((key) => {
      try {
        parseObjectKey(key);
        return true;
      } catch {
        return false; // not an object Rei wrote
      }
    });
    const local = new Set(walkFiles(this.#objectsDir));
    if (pruneRemoved && keys.length === 0 && local.size > 0 && this.#d.expectedObjects() > 0)
      throw new Error(
        `The bucket lists no objects but Rei's database expects ${this.#d.expectedObjects()}, and the mirror holds ${local.size}. The mirror was kept as it is. If the bucket was lost, restore its objects with the restore command (--only objects); then run the backup again.`,
      );
    const wanted = new Set(keys);
    const missing = keys.filter((key) => !local.has(key));
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let key = missing[next++]; key !== undefined; key = missing[next++]) {
        const stream = await store.open(key);
        if (!stream) continue; // deleted since the listing
        await writeThrough(
          join(this.#objectsDir, key),
          Readable.fromWeb(stream.body as NodeReadableStream<Uint8Array>),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(MIRROR_PARALLEL, missing.length) }, worker));
    if (pruneRemoved) {
      for (const key of local) if (!wanted.has(key)) rmSync(join(this.#objectsDir, key), { force: true });
      pruneEmptyDirs(this.#objectsDir);
    }
    return keys.length;
  }

  async #dumpDatabase(): Promise<void> {
    const target = join(this.#d.dir, "db", "app.sqlite");
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    const db = this.#d.db;
    if (!db.backupTo) throw new Error("This database cannot be backed up online.");
    await db.backupTo(`${target}.partial`);
    // The copy is a database of its own now: make it independent of any write-ahead log.
    const copy = new DatabaseSync(`${target}.partial`);
    try {
      copy.exec("PRAGMA journal_mode = DELETE");
      // The run that is writing this copy is not finished and never will be in it: left in, a restored stack would start
      // by reporting it as a backup that failed.
      copy.exec("DELETE FROM backup_runs WHERE status = 'running'");
    } finally {
      copy.close();
    }
    rmSync(`${target}.partial-wal`, { force: true });
    rmSync(`${target}.partial-shm`, { force: true });
    renameSync(`${target}.partial`, target);
  }

  async #writeGatewayState(): Promise<string | null> {
    const fetchState = this.#d.gatewayState;
    const dir = join(this.#d.dir, "gateway");
    if (!fetchState) {
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
    const state = await fetchState();
    const keep = new Set<string>();
    for (const file of state.files) {
      if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(file.path) || file.path.includes(".."))
        throw new Error("The gateway answered with a file name that is not safe to write.");
      const bytes = Buffer.from(file.data, "base64");
      if (bytes.byteLength !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw new Error(`The gateway's ${file.path} did not arrive intact.`);
      const path = join(dir, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { mode: 0o600 });
      keep.add(file.path);
    }
    for (const existing of walkFiles(dir)) if (!keep.has(existing)) rmSync(join(dir, existing), { force: true });
    pruneEmptyDirs(dir);
    return state.version;
  }

  /**
   * The SQLite databases in the data directory (the agent session trees) are in write-ahead mode and in use: copying
   * the file, its log and its index one by one can give a set that never existed. Each gets a consistent copy of its own
   * instead, with no log, and a copy of one that is gone is removed.
   */
  async #copyDatabases(skip: ReadonlySet<string>): Promise<void> {
    const target = join(this.#d.dir, "files");
    const wanted = new Set<string>();
    for (const path of walkFiles(this.#d.dataDir)) {
      if (skip.has(path.split("/")[0] ?? "") || !isLiveDatabase(path) || !path.endsWith(".sqlite")) continue;
      const out = join(target, path);
      mkdirSync(dirname(out), { recursive: true });
      rmSync(`${out}.partial`, { force: true });
      try {
        const source = new DatabaseSync(join(this.#d.dataDir, path), { readOnly: true });
        try {
          source.exec(`VACUUM INTO '${`${out}.partial`.replaceAll("'", "''")}'`);
        } finally {
          source.close();
        }
        renameSync(`${out}.partial`, out);
        wanted.add(path);
      } catch (error) {
        rmSync(`${out}.partial`, { force: true });
        this.#d.log.warn("backup.database_copy_failed", {});
        throw new Error(`Could not copy the database ${path} for the backup.`, { cause: error });
      }
    }
    for (const path of walkFiles(target))
      if (isLiveDatabase(path) && !wanted.has(path)) rmSync(join(target, path), { force: true });
    pruneEmptyDirs(target);
  }

  /** Row counts from the copy of the database (never from the live one, which has moved on). */
  #counts(objects: number): { counts: Record<string, number>; schemaVersion: number } {
    const counts: Record<string, number> = { objects };
    const copy = new DatabaseSync(join(this.#d.dir, "db", "app.sqlite"), { readOnly: true });
    try {
      const schemaVersion = (copy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      for (const table of COUNTED_TABLES) {
        try {
          counts[table] = Number((copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
        } catch {
          // a table this schema does not have
        }
      }
      return { counts, schemaVersion };
    } finally {
      copy.close();
    }
  }

  /** Writes the whole bundle and its manifest. */
  async write(trigger: "schedule" | "manual"): Promise<BundleResult> {
    const d = this.#d;
    mkdirSync(d.dir, { recursive: true });
    rmSync(join(d.dir, "manifest.json"), { force: true });
    // 1. the bucket, with deletions
    await this.#mirror(true);
    // 2. the database, the data files and the gateway's state
    await this.#dumpDatabase();
    const gatewayVersion = await this.#writeGatewayState();
    const skip = new Set([...DATA_SKIP, ...(d.extraSkip ?? [])]);
    await mirrorTree(d.dataDir, join(d.dir, "files"), { skip, deleteExtra: true, exclude: isLiveDatabase });
    await this.#copyDatabases(skip);
    // 3. the bucket again, add only
    const objects = await this.#mirror(false);
    // 4. the manifest
    const files: BackupManifest["files"] = [];
    for (const path of walkFiles(d.dir)) {
      if (path === "manifest.json") continue;
      const full = join(d.dir, path);
      const size = statSync(full).size;
      // An object's key already carries its hash, and the mirror verified it as it downloaded.
      const sha256 = path.startsWith("objects/")
        ? (path.slice(path.lastIndexOf("/") + 1).match(/^[0-9a-f]{64}$/)?.[0] ?? (await sha256File(full)))
        : await sha256File(full);
      files.push({ path, size, sha256 });
    }
    const { counts, schemaVersion } = this.#counts(objects);
    const manifest: BackupManifest = {
      format: BACKUP_MANIFEST_FORMAT,
      app: "rei",
      appVersion: d.appVersion,
      schemaVersion,
      gatewayVersion,
      createdAt: new Date(d.now()).toISOString(),
      host: d.host,
      trigger,
      files,
      counts,
    };
    writeFileSync(join(d.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest };
  }
}
