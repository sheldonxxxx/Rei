// Real restic, real bundle: what the fakes in backup-service.test.ts cannot show (restic's own path and include rules,
// the password never reaching an error). Needs the restic binary: RUN_RESTIC_TESTS=1 npx vitest run --project server
// apps/server/test/backup-restic.integration.test.ts
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResticError } from "../src/backup/restic.ts";
import { BackupService } from "../src/backup/service.ts";
import { SecretBox } from "../src/events/sources.ts";
import { includesFor, parseParts, pickSnapshot, run, verifyBundle } from "../src/node/backup-cli.ts";
import { ProcessRestic } from "../src/node/restic.ts";
import { nullLogger } from "../src/util/log.ts";
import { type BackupFixture, backupFixture, nodeDeps, putObject } from "./helpers/backup.ts";

let fx: BackupFixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

describe.skipIf(process.env.RUN_RESTIC_TESTS !== "1")("restic against a real repository", () => {
  const real = (f: BackupFixture) =>
    new BackupService({
      store: f.store,
      db: f.db,
      clock: f.clock,
      log: nullLogger,
      repositoryDir: f.repositoryDir,
      stagingDir: f.stagingDir,
      dataDir: f.dataDir,
      objects: f.objects,
      gatewayState: async () => f.gateway,
      secrets: new SecretBox(new Uint8Array(32).fill(7)),
      appVersion: "1.2.3",
      host: "rei",
      timeZone: () => "UTC",
      restic: (o) => new ProcessRestic(o),
      ...nodeDeps,
    });

  it("backs up a bundle twice, lists it, restores a part by path and verifies it", async () => {
    fx = backupFixture();
    await putObject(fx.objects, "obj_1", "some file bytes");
    const service = real(fx);
    const password = await service.generatePassword();
    await service.setRepository({ mode: "create", confirmed: true });
    await service.start("manual");
    await service.idle();
    expect(service.settings().lastRun).toMatchObject({ status: "ok" });
    await putObject(fx.objects, "obj_2", "more bytes");
    await service.start("manual");
    await service.idle();
    const settings = service.settings();
    expect(settings.lastRun).toMatchObject({ status: "ok" });
    expect(settings.snapshots).toBe(2);
    expect(settings.repositoryBytes).toBeGreaterThan(0);

    const restic = new ProcessRestic({ repository: fx.repositoryDir, password, cacheDir: join(fx.dir, "cache") });
    const snapshots = await restic.snapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.hostname).toBe("rei");
    expect(snapshots[0]?.tags).toContain("app=rei");
    const latest = pickSnapshot(snapshots, "latest");
    const subfolder = latest.paths[0]!;
    expect(subfolder).toBe(join(fx.stagingDir, "bundle"));

    // A read-only copy of the repository (the restore's mount) cannot take restic's lock, so reads go without one.
    const unlocked = new ProcessRestic({
      repository: fx.repositoryDir,
      password,
      cacheDir: join(fx.dir, "cache"),
      lock: false,
    });
    expect(await unlocked.snapshots()).toHaveLength(2);

    // All of it.
    const all = mkdtempSync(join(fx.dir, "all-"));
    await restic.restore(latest.id, subfolder, all);
    const manifest = await verifyBundle(all, parseParts(undefined));
    expect(manifest.counts.objects).toBe(2);
    expect(existsSync(join(all, "objects"))).toBe(true);

    // Only the database: the include patterns select by path below the snapshot's folder.
    const some = mkdtempSync(join(fx.dir, "some-"));
    await restic.restore(latest.id, subfolder, some, includesFor(["db"]));
    expect(readdirSync(some).sort()).toEqual(["db", "manifest.json"]);
    await verifyBundle(some, ["db"]);

    const gateway = mkdtempSync(join(fx.dir, "gw-"));
    await restic.restore(latest.id, subfolder, gateway, includesFor(["gateway", "files"]));
    expect(readdirSync(gateway).sort()).toEqual(["files", "gateway", "manifest.json"]);
    expect(existsSync(join(gateway, "gateway", "secret", "provider.json"))).toBe(true);
    expect(existsSync(join(gateway, "files", "uploads"))).toBe(false);

    // A damaged file is caught.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(some, "db", "app.sqlite"), "tampered");
    await expect(verifyBundle(some, ["db"])).rejects.toThrow(/damaged/);

    await restic.forget({ daily: 1, weekly: 0, monthly: 0 });
    await restic.prune();
    await restic.check("100%");
    expect(await restic.snapshots()).toHaveLength(1);
  });

  it("never puts the password in an error", async () => {
    fx = backupFixture();
    const secret = "correct-horse-battery-staple";
    const ok = new ProcessRestic({ repository: fx.repositoryDir, password: secret, cacheDir: join(fx.dir, "c") });
    await ok.init();
    const wrong = new ProcessRestic({ repository: fx.repositoryDir, password: "not-it", cacheDir: join(fx.dir, "c") });
    const error = await wrong.snapshots().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResticError);
    expect(String((error as Error).message)).not.toContain(secret);
    await expect(ok.init()).rejects.toThrow(ResticError);
  });

  it("serves the container commands: snapshots, and status from the database", async () => {
    fx = backupFixture();
    const service = real(fx);
    const password = await service.generatePassword();
    await service.setRepository({ mode: "create", confirmed: true });
    await service.start("manual");
    await service.idle();
    const lines: string[] = [];
    const env = { RESTIC_PASSWORD: password, RESTIC_CACHE_DIR: join(fx.dir, "c2") };
    expect(await run(["snapshots", "--repo", fx.repositoryDir], env, (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toContain("app=rei");
    const json: string[] = [];
    expect(await run(["snapshots", "--repo", fx.repositoryDir, "--json"], env, (l) => json.push(l))).toBe(0);
    expect(JSON.parse(json[0]!)).toHaveLength(1);
    const status: string[] = [];
    expect(await run(["status"], { REI_DATA: fx.dataDir }, (l) => status.push(l))).toBe(0);
    expect(JSON.parse(status[0]!)).toMatchObject({ enabled: false, stale: false, lastFailure: null });
    const wrong: string[] = [];
    expect(
      await run(["snapshots", "--repo", fx.repositoryDir], { ...env, RESTIC_PASSWORD: "no" }, (l) => wrong.push(l)),
    ).toBe(1);
    expect(wrong.join("\n")).not.toContain(password);
  });
});
