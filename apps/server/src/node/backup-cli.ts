// `node src/node/backup-cli.ts <command>`: the container side of `./rei backup`. The host CLI runs it in the control image,
// either inside the running control container (`snapshots`, which uses the stored password) or in one-off containers for a
// restore (`fetch`, `rollback`, `apply`, `objects`, `index`), each with what it needs mounted. Output is for a terminal.
//
//   snapshots [--repo DIR] [--json]            the snapshots of the repository (password: RESTIC_PASSWORD, else the stored one)
//   fetch --snapshot ID|latest [--only a,b]    restic restore into /restore, then check every file against the manifest
//   rollback --only a,b                        copy what apply would replace into /rollback/control and /rollback/gateway
//   apply --only a,b                           write /restore into /data (db, files) and /gateway-data (gateway); run as root
//   objects [--prune-bucket]                   upload the objects /restore holds that the bucket lacks (and delete extras)
//   index                                      delete the history search collections; Rei rebuilds them from its database
//
// Parts (--only): db, files, gateway, objects. Default: all.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BACKUP_MANIFEST_FORMAT, type BackupManifest } from "@rei/protocol";
import type { ResticSnapshot } from "../backup/restic.ts";
import { backupHealth } from "../backup/service.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { parseEventsKey, SecretBox } from "../events/sources.ts";
import { COLLECTION_PREFIX } from "../retrieval/retrieval-store.ts";
import { parseObjectKey } from "../storage/file-object-store.ts";
import { DATA_SKIP } from "./backup-bundle.ts";
import { mirrorTree, sha256File, walkFiles } from "./backup-files.ts";
import { readConfig } from "./config.ts";
import { GarageFileObjectStore } from "./garage-object-store.ts";
import { QdrantStore } from "./qdrant-store.ts";
import { ProcessRestic } from "./restic.ts";
import { openSqliteDb } from "./sqlite-db.ts";

const RESTORE = "/restore";
const PARTS = ["db", "files", "gateway", "objects"] as const;
type Part = (typeof PARTS)[number];

const CONTROL_UID = 1000;
const GATEWAY_UID = 1100;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

export function parseParts(text: string | undefined): Part[] {
  if (!text) return [...PARTS];
  const parts = text.split(",").map((p) => p.trim());
  for (const part of parts)
    if (!(PARTS as readonly string[]).includes(part))
      throw new Error(`--only takes ${PARTS.join(", ")} (comma-separated); "${part}" is none of them.`);
  return PARTS.filter((p) => parts.includes(p));
}

/** The snapshot an id, a short id or "latest" names. */
export function pickSnapshot(snapshots: ResticSnapshot[], wanted: string): ResticSnapshot {
  if (snapshots.length === 0) throw new Error("The repository holds no snapshots.");
  if (wanted === "latest") return [...snapshots].sort((a, b) => b.time.localeCompare(a.time))[0]!;
  const found = snapshots.filter((s) => s.id.startsWith(wanted) || s.shortId === wanted);
  if (found.length === 0) throw new Error(`No snapshot "${wanted}". Run ./rei backup snapshots to see them.`);
  if (found.length > 1) throw new Error(`"${wanted}" names more than one snapshot; give more of its id.`);
  return found[0]!;
}

/** What `--only` needs restic to bring out of the snapshot (the manifest always comes with it). */
export function includesFor(parts: readonly Part[]): string[] | undefined {
  if (parts.length === PARTS.length) return undefined;
  const dirs: Record<Part, string> = { db: "/db", files: "/files", gateway: "/gateway", objects: "/objects" };
  return ["/manifest.json", ...parts.map((p) => dirs[p])];
}

/** Every file the manifest names is there with its size and hash; the manifest is of a format and schema this code reads. */
export async function verifyBundle(dir: string, parts: readonly Part[]): Promise<BackupManifest> {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("The snapshot has no manifest.json: it is not a Rei backup.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  if (manifest.app !== "rei" || manifest.format !== BACKUP_MANIFEST_FORMAT)
    throw new Error("The snapshot is not a Rei backup this version can read.");
  if (manifest.schemaVersion > SCHEMA_VERSION)
    throw new Error(
      `The backup's database is schema ${manifest.schemaVersion}, newer than this release reads (${SCHEMA_VERSION}). Install the release that wrote it (${manifest.appVersion}) first.`,
    );
  const wanted = (path: string) => parts.some((p) => path === p || path.startsWith(`${p === "db" ? "db" : p}/`));
  const problems: string[] = [];
  for (const file of manifest.files) {
    if (!wanted(file.path)) continue;
    const full = join(dir, file.path);
    if (!existsSync(full) || statSync(full).size !== file.size) {
      problems.push(`${file.path} is missing or has the wrong size`);
      continue;
    }
    if ((await sha256File(full)) !== file.sha256) problems.push(`${file.path} does not match its checksum`);
    if (problems.length >= 5) break;
  }
  if (problems.length > 0) throw new Error(`The restored bundle is damaged: ${problems.join("; ")}.`);
  return manifest;
}

function chownTree(root: string, uid: number): void {
  const walk = (path: string): void => {
    chownSync(path, uid, uid);
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(root);
}

function resticFor(env: NodeJS.ProcessEnv, repo: string, password: string): ProcessRestic {
  // Everything the CLI does with a repository is a read, and the restore's copy is mounted read-only: no lock to take.
  return new ProcessRestic({
    repository: repo,
    password,
    cacheDir: env.RESTIC_CACHE_DIR || "/tmp/restic-cache",
    lock: false,
  });
}

/** The repository's password: RESTIC_PASSWORD, else the one the running Rei stored (sealed under its events key). */
async function passwordOf(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.RESTIC_PASSWORD) return env.RESTIC_PASSWORD;
  const key = parseEventsKey(env.REI_EVENTS_KEY);
  if (!key) throw new Error("No repository password: set RESTIC_PASSWORD, or turn backups on in Settings first.");
  const db = openSqliteDb(join(env.REI_DATA || "/data", "app.sqlite"));
  try {
    const sealed = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'backup_password'")?.value;
    if (!sealed)
      throw new Error(
        "Backups have no repository yet. Create one in Settings > Backups, or pass --repo and a password.",
      );
    return await new SecretBox(key).open(sealed, "backup-repository");
  } finally {
    db.close();
  }
}

const when = (iso: string): string => iso.replace(/\.\d+/, "").replace("T", " ").replace(/Z$/, "Z");

export async function run(argv: string[], env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "snapshots": {
        const repo = flag(rest, "--repo") ?? env.REI_BACKUP_PATH ?? "/backups";
        const snapshots = await resticFor(env, repo, await passwordOf(env)).snapshots();
        snapshots.sort((a, b) => b.time.localeCompare(a.time));
        if (rest.includes("--json")) out(JSON.stringify(snapshots));
        else if (snapshots.length === 0) out("The repository holds no snapshots yet.");
        else {
          out("ID        TIME (UTC)            DETAILS");
          for (const s of snapshots) out(`${s.shortId}  ${when(s.time).padEnd(20)}  ${s.tags.join(" ")}`);
        }
        return 0;
      }
      case "fetch": {
        const repo = flag(rest, "--repo") ?? "/repo";
        const parts = parseParts(flag(rest, "--only"));
        const restic = resticFor(env, repo, await passwordOf(env));
        const snapshot = pickSnapshot(await restic.snapshots(), flag(rest, "--snapshot") ?? "latest");
        const subfolder = snapshot.paths[0];
        if (!subfolder) throw new Error("The snapshot records no path.");
        for (const name of readdirSync(RESTORE)) rmSync(join(RESTORE, name), { recursive: true, force: true });
        await restic.restore(snapshot.id, subfolder, RESTORE, includesFor(parts));
        const manifest = await verifyBundle(RESTORE, parts);
        out(`snapshot ${snapshot.shortId}, taken ${when(snapshot.time)}, Rei ${manifest.appVersion}`);
        out(
          `verified ${manifest.files.length} files (${Object.entries(manifest.counts)
            .map(([k, v]) => `${v} ${k}`)
            .join(", ")})`,
        );
        return 0;
      }
      case "rollback": {
        const parts = parseParts(flag(rest, "--only"));
        const copy = (from: string, to: string): void => {
          mkdirSync(to, { recursive: true });
          execFileSync("cp", ["-a", `${from}/.`, to]);
        };
        if (parts.includes("db") || parts.includes("files")) copy("/data", "/rollback/control");
        if (parts.includes("gateway")) copy("/gateway-data", "/rollback/gateway");
        out("rollback copies written");
        return 0;
      }
      case "apply": {
        const parts = parseParts(flag(rest, "--only"));
        if (parts.includes("db")) {
          const from = join(RESTORE, "db", "app.sqlite");
          if (!existsSync(from)) throw new Error("The restored bundle has no database.");
          for (const suffix of ["-wal", "-shm"]) rmSync(`/data/app.sqlite${suffix}`, { force: true });
          rmSync("/data/app.sqlite", { force: true });
          execFileSync("cp", [from, "/data/app.sqlite"]);
          chownSync("/data/app.sqlite", CONTROL_UID, CONTROL_UID);
          chmodSync("/data/app.sqlite", 0o600);
          out("database written");
        }
        if (parts.includes("files")) {
          const stats = await mirrorTree(join(RESTORE, "files"), "/data", { skip: DATA_SKIP, deleteExtra: true });
          chownTree("/data", CONTROL_UID);
          out(`data files written (${stats.copied} copied, ${stats.removed} removed)`);
        }
        if (parts.includes("gateway")) {
          const dir = join(RESTORE, "gateway");
          let written = 0;
          for (const path of walkFiles(dir)) {
            const target = join("/gateway-data", path);
            mkdirSync(join(target, ".."), { recursive: true });
            if (path === "calls.sqlite")
              for (const suffix of ["-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
            writeFileSync(target, readFileSync(join(dir, path)), { mode: 0o600 });
            written++;
          }
          if (written > 0) {
            for (const top of readdirSync("/gateway-data")) {
              const path = join("/gateway-data", top);
              if (top === "secret" || top === "models.json" || top.startsWith("calls.sqlite"))
                chownTree(path, GATEWAY_UID);
            }
          }
          out(`gateway state written (${written} files)`);
        }
        return 0;
      }
      case "objects": {
        const config = readConfig(env);
        const store = config.garage ? new GarageFileObjectStore(config.garage) : undefined;
        if (!store) throw new Error("This stack has no object store configured.");
        const root = join(RESTORE, "objects");
        const local = existsSync(root) ? walkFiles(root).filter((k) => safeKey(k)) : [];
        const have = new Set(await store.list("", Number.MAX_SAFE_INTEGER));
        let uploaded = 0;
        for (const key of local) {
          if (have.has(key)) continue;
          const file = join(root, key);
          const sha256 = parseObjectKey(key).sha256;
          const size = statSync(file).size;
          await store.put({
            key,
            sha256,
            byteLength: size,
            stream: () => Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
          });
          uploaded++;
        }
        let deleted = 0;
        if (rest.includes("--prune-bucket")) {
          const wanted = new Set(local);
          for (const key of have)
            if (safeKey(key) && !wanted.has(key)) {
              await store.delete(key);
              deleted++;
            }
        }
        out(
          `objects: ${uploaded} uploaded, ${local.length - uploaded} already there${rest.includes("--prune-bucket") ? `, ${deleted} extra deleted` : ""}`,
        );
        return 0;
      }
      case "index": {
        const config = readConfig(env);
        if (!config.qdrant) throw new Error("This stack has no search index configured.");
        const qdrant = new QdrantStore(config.qdrant);
        let dropped = 0;
        for (const collection of await qdrant.collections())
          if (collection.startsWith(COLLECTION_PREFIX)) {
            await qdrant.dropCollection(collection);
            dropped++;
          }
        out(
          `search index: ${dropped} collection${dropped === 1 ? "" : "s"} deleted; Rei rebuilds them from its database`,
        );
        return 0;
      }
      case "status": {
        // For `./rei doctor`: one JSON line from the database alone.
        const db = openSqliteDb(join(env.REI_DATA || "/data", "app.sqlite"));
        try {
          out(JSON.stringify(backupHealth(db, Date.now())));
        } finally {
          db.close();
        }
        return 0;
      }
      default:
        out(
          "usage: backup-cli.ts <snapshots|fetch|rollback|apply|objects|index|status>\n  (the container side of ./rei backup; run ./rei backup --help)",
        );
        return command === undefined || command === "--help" ? 0 : 2;
    }
  } catch (error) {
    out(`rei: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function safeKey(key: string): boolean {
  try {
    parseObjectKey(key);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2), process.env, (line) => console.log(line));
