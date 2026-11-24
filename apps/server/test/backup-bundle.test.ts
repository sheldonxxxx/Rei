import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BundleWriter } from "../src/node/backup-bundle.ts";
import { sha256File } from "../src/node/backup-files.ts";
import { nullLogger } from "../src/util/log.ts";
import { type BackupFixture, backupFixture, gatewayFile, putObject } from "./helpers/backup.ts";

let fx: BackupFixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

function writer(f: BackupFixture, over: Partial<ConstructorParameters<typeof BundleWriter>[0]> = {}) {
  return new BundleWriter({
    dir: join(f.stagingDir, "bundle"),
    dataDir: f.dataDir,
    db: f.db,
    objects: f.objects,
    gatewayState: async () => f.gateway,
    expectedObjects: () => 0,
    appVersion: "9.9.9",
    host: "rei",
    log: nullLogger,
    now: () => f.clock.t,
    ...over,
  });
}

describe("BundleWriter", () => {
  it("writes the database, the data files, the gateway state and the objects, and a manifest that names each by hash", async () => {
    fx = backupFixture();
    const key = await putObject(fx.objects, "obj_1", "hello bucket");
    const { manifest } = await writer(fx).write("manual");
    const dir = join(fx.stagingDir, "bundle");
    expect(manifest).toMatchObject({
      format: 1,
      app: "rei",
      appVersion: "9.9.9",
      gatewayVersion: "gw-1",
      trigger: "manual",
    });
    expect(manifest.counts.objects).toBe(1);
    const paths = manifest.files.map((f) => f.path).sort();
    expect(paths).toEqual(
      expect.arrayContaining([
        "db/app.sqlite",
        "files/settings/profile.json",
        "files/sessions/a.jsonl",
        "gateway/secret/provider.json",
        "gateway/models.json",
        key.replace(/^/, "objects/"),
      ]),
    );
    // What a backup must not carry: the upload spool, the setup code, and the live database files.
    expect(
      paths.some((p) => p.startsWith("files/uploads") || p.includes("setup-code") || p.startsWith("files/app.sqlite")),
    ).toBe(false);
    for (const f of manifest.files) expect(await sha256File(join(dir, f.path))).toBe(f.sha256);
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))).toEqual(manifest);
  });

  it("writes a database copy that stands alone (no write-ahead log) and holds the rows", async () => {
    fx = backupFixture();
    fx.store.metaSet("probe", "yes");
    await writer(fx).write("manual");
    const dir = join(fx.stagingDir, "bundle", "db");
    expect(existsSync(join(dir, "app.sqlite-wal"))).toBe(false);
    const { DatabaseSync } = await import("node:sqlite");
    const copy = new DatabaseSync(join(dir, "app.sqlite"), { readOnly: true });
    try {
      expect((copy.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as { value: string }).value).toBe("yes");
    } finally {
      copy.close();
    }
  });

  it("leaves the run that is writing the copy out of it, so a restored stack does not start with a failed backup", async () => {
    fx = backupFixture();
    fx.db.run("INSERT INTO backup_runs (id, trigger, status, started_at) VALUES ('bk_now', 'manual', 'running', ?)", 1);
    fx.db.run(
      "INSERT INTO backup_runs (id, trigger, status, started_at, finished_at) VALUES ('bk_done', 'manual', 'ok', 1, 2)",
    );
    await writer(fx).write("manual");
    const { DatabaseSync } = await import("node:sqlite");
    const copy = new DatabaseSync(join(fx.stagingDir, "bundle", "db", "app.sqlite"), { readOnly: true });
    try {
      const ids = (copy.prepare("SELECT id FROM backup_runs").all() as { id: string }[]).map((r) => r.id);
      expect(ids).toEqual(["bk_done"]);
    } finally {
      copy.close();
    }
    expect(fx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM backup_runs")?.n).toBe(2);
  });

  it("copies an open write-ahead database as one consistent file, with no log beside it", async () => {
    fx = backupFixture();
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(fx.dataDir, "trees", "t1"), { recursive: true });
    const live = new DatabaseSync(join(fx.dataDir, "trees", "t1", "pi.sqlite"));
    try {
      live.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('in the log')");
      expect(existsSync(join(fx.dataDir, "trees", "t1", "pi.sqlite-wal"))).toBe(true);
      const { manifest } = await writer(fx).write("manual");
      const paths = manifest.files.map((f) => f.path);
      expect(paths).toContain("files/trees/t1/pi.sqlite");
      expect(paths.some((p) => p.endsWith("-wal") || p.endsWith("-shm"))).toBe(false);
      const copy = new DatabaseSync(join(fx.stagingDir, "bundle", "files", "trees", "t1", "pi.sqlite"), {
        readOnly: true,
      });
      try {
        expect((copy.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("in the log");
      } finally {
        copy.close();
      }
      // a tree that is gone leaves nothing behind
      live.close();
      const { rmSync } = await import("node:fs");
      rmSync(join(fx.dataDir, "trees"), { recursive: true });
      const again = await writer(fx).write("manual");
      expect(again.manifest.files.some((f) => f.path.includes("trees"))).toBe(false);
    } finally {
      try {
        live.close();
      } catch {
        // already closed
      }
    }
  });

  it("is incremental: a second run downloads only new objects and drops deleted ones", async () => {
    fx = backupFixture();
    const first = await putObject(fx.objects, "obj_1", "one");
    await writer(fx).write("schedule");
    const second = await putObject(fx.objects, "obj_2", "two");
    await fx.objects.delete(first);
    const { manifest } = await writer(fx).write("schedule");
    const objects = manifest.files.filter((f) => f.path.startsWith("objects/")).map((f) => f.path);
    expect(objects).toEqual([`objects/${second}`]);
    expect(existsSync(join(fx.stagingDir, "bundle", "objects", first))).toBe(false);
  });

  it("ignores keys Rei did not write", async () => {
    fx = backupFixture();
    await putObject(fx.objects, "obj_1", "one");
    fx.objects.objects.set("somebody/else.txt", new Uint8Array([1]));
    const { manifest } = await writer(fx).write("manual");
    expect(manifest.counts.objects).toBe(1);
  });

  it("refuses to empty the mirror when the bucket lists nothing but the database expects objects", async () => {
    fx = backupFixture();
    const key = await putObject(fx.objects, "obj_1", "one");
    await writer(fx, { expectedObjects: () => 1 }).write("manual");
    fx.objects.objects.delete(key);
    await expect(writer(fx, { expectedObjects: () => 1 }).write("manual")).rejects.toThrow(/lists no objects/);
    expect(existsSync(join(fx.stagingDir, "bundle", "objects", key))).toBe(true);
    // An honestly empty bucket (the database expects nothing) clears it.
    await writer(fx, { expectedObjects: () => 0 }).write("manual");
    expect(existsSync(join(fx.stagingDir, "bundle", "objects", key))).toBe(false);
  });

  it("removes files that were deleted from the data directory and drops the gateway part when there is no gateway", async () => {
    fx = backupFixture();
    await writer(fx).write("manual");
    const bundle = join(fx.stagingDir, "bundle");
    expect(existsSync(join(bundle, "files", "sessions", "a.jsonl"))).toBe(true);
    const { rmSync } = await import("node:fs");
    rmSync(join(fx.dataDir, "sessions"), { recursive: true });
    const { manifest } = await writer(fx, { gatewayState: undefined }).write("manual");
    expect(existsSync(join(bundle, "files", "sessions"))).toBe(false);
    expect(existsSync(join(bundle, "gateway"))).toBe(false);
    expect(manifest.gatewayVersion).toBeNull();
  });

  it("refuses gateway files that are unsafe or arrive damaged", async () => {
    fx = backupFixture();
    const unsafe = { ...fx.gateway, files: [gatewayFile("../escape.json", "x")] };
    await expect(writer(fx, { gatewayState: async () => unsafe }).write("manual")).rejects.toThrow(/not safe/);
    const damaged = { ...fx.gateway, files: [{ ...gatewayFile("models.json", "{}"), sha256: "0".repeat(64) }] };
    await expect(writer(fx, { gatewayState: async () => damaged }).write("manual")).rejects.toThrow(
      /did not arrive intact/,
    );
    expect(existsSync(join(fx.stagingDir, "bundle", "manifest.json"))).toBe(false);
  });

  it("skips what the deployment asks it to (the folder file store's own directory)", async () => {
    fx = backupFixture();
    writeFileSync(join(fx.dataDir, "settings", "extra.txt"), "x");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(fx.dataDir, "files"));
    writeFileSync(join(fx.dataDir, "files", "o"), "x");
    const { manifest } = await writer(fx, { extraSkip: ["files"] }).write("manual");
    expect(manifest.files.some((f) => f.path.startsWith("files/files/"))).toBe(false);
    expect(manifest.files.some((f) => f.path === "files/settings/extra.txt")).toBe(true);
  });
});
