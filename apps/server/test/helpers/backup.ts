import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BackupRetention } from "@rei/protocol";
import type { GatewayState } from "../../src/backup/bundle-types.ts";
import {
  type ResticBackupResult,
  type ResticClient,
  ResticError,
  type ResticSnapshot,
} from "../../src/backup/restic.ts";
import { initializeDatabase } from "../../src/db/schema.ts";
import { BundleWriter } from "../../src/node/backup-bundle.ts";
import { backupFolder } from "../../src/node/backup-folder.ts";
import { openSqliteDb } from "../../src/node/sqlite-db.ts";
import { MemoryFileObjectStore, objectKey, sha256Hex } from "../../src/storage/file-object-store.ts";
import { EventLog } from "../../src/store/events.ts";
import { AppStore } from "../../src/store/store.ts";

/** A restic that keeps its repository in memory and records what it was asked. */
export class FakeRestic implements ResticClient {
  readonly calls: string[] = [];
  readonly snapshotList: ResticSnapshot[] = [];
  readonly retentions: BackupRetention[] = [];
  readonly tags: string[][] = [];
  password = "";
  failOn: string | undefined;
  initialised = false;
  /** Called with the bundle directory during `backup`, to look inside it while it exists. */
  onBackup: ((dir: string) => void) | undefined;

  #fail(op: string): void {
    if (this.failOn === op) throw new ResticError(`restic ${op} failed (exit 1): boom`);
  }
  async init(): Promise<void> {
    this.calls.push("init");
    this.#fail("init");
    this.initialised = true;
  }
  async snapshots(): Promise<ResticSnapshot[]> {
    this.calls.push("snapshots");
    this.#fail("snapshots");
    return [...this.snapshotList];
  }
  async backup(dir: string, tags: string[]): Promise<ResticBackupResult> {
    this.calls.push("backup");
    this.#fail("backup");
    this.onBackup?.(dir);
    this.tags.push(tags);
    const id = createHash("sha256").update(String(this.snapshotList.length)).digest("hex");
    this.snapshotList.push({
      id,
      shortId: id.slice(0, 8),
      time: new Date().toISOString(),
      hostname: "rei",
      paths: [dir],
      tags,
    });
    return { snapshotId: id.slice(0, 8), bytesAdded: 1234, filesNew: 5 };
  }
  async forget(retention: BackupRetention): Promise<void> {
    this.calls.push("forget");
    this.#fail("forget");
    this.retentions.push(retention);
  }
  async prune(): Promise<void> {
    this.calls.push("prune");
    this.#fail("prune");
  }
  async check(subset: string): Promise<void> {
    this.calls.push(`check ${subset}`);
    this.#fail("check");
  }
  async restore(): Promise<void> {
    this.calls.push("restore");
  }
}

export interface BackupFixture {
  dir: string;
  dataDir: string;
  stagingDir: string;
  repositoryDir: string;
  db: ReturnType<typeof openSqliteDb>;
  store: AppStore;
  objects: MemoryFileObjectStore;
  clock: { t: number; now(): number };
  restic: FakeRestic;
  gateway: GatewayState;
  cleanup(): void;
}

/** One gateway file as `GET /backup` returns it. */
export function gatewayFile(path: string, text: string): GatewayState["files"][number] {
  const data = Buffer.from(text);
  return {
    path,
    size: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    data: data.toString("base64"),
  };
}

/** A data directory with the things a bundle keeps and the things it leaves out, a real database file and an empty bucket. */
export function backupFixture(now = Date.UTC(2026, 0, 10, 12, 0, 0)): BackupFixture {
  const dir = mkdtempSync(join(tmpdir(), "rei-backup-"));
  const dataDir = join(dir, "data");
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dataDir, path)), { recursive: true });
    writeFileSync(join(dataDir, path), text);
  };
  write("settings/profile.json", '{"name":"x"}');
  write("sessions/a.jsonl", "line\n");
  write("uploads/tmp-1", "spool");
  write("setup-code.txt", "CODE-1234");
  const db = openSqliteDb(join(dataDir, "app.sqlite"));
  initializeDatabase(db);
  const clock = { t: now, now: () => clock.t };
  const store = new AppStore(db, clock, new EventLog(clock));
  const stagingDir = join(dir, "staging");
  const repositoryDir = join(dir, "repo");
  mkdirSync(stagingDir);
  mkdirSync(repositoryDir);
  return {
    dir,
    dataDir,
    stagingDir,
    repositoryDir,
    db,
    store,
    objects: new MemoryFileObjectStore(),
    clock,
    restic: new FakeRestic(),
    gateway: {
      format: 1,
      version: "gw-1",
      files: [gatewayFile("secret/provider.json", '{"k":"v"}'), gatewayFile("models.json", "{}")],
    },
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Puts an object in the fake bucket under the key Rei would give it. */
export async function putObject(store: MemoryFileObjectStore, id: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  const sha256 = await sha256Hex(bytes);
  const key = objectKey(id, sha256);
  await store.put({ key, sha256, bytes });
  return key;
}

/** What the Node host hands the backup service: the real bundle writer and the real folder. */
export const nodeDeps = {
  bundle: (deps: ConstructorParameters<typeof BundleWriter>[0]) => new BundleWriter(deps),
  folder: backupFolder,
};
