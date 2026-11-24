import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupService, type BackupServiceDeps, backupHealth, STALE_AFTER_MS } from "../src/backup/service.ts";
import { SecretBox } from "../src/events/sources.ts";
import { HttpError } from "../src/util/errors.ts";
import { nullLogger } from "../src/util/log.ts";
import { type BackupFixture, backupFixture, nodeDeps, putObject } from "./helpers/backup.ts";

const HOUR = 3_600_000;
let fx: BackupFixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

function service(f: BackupFixture, over: Partial<BackupServiceDeps> = {}): BackupService {
  return new BackupService({
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
    restic: (o) => {
      f.restic.password = o.password;
      return f.restic;
    },
    ...nodeDeps,
    ...over,
  });
}

const rows = (f: BackupFixture) =>
  f.db.all<{ request_id: string; payload: string }>(
    "SELECT request_id, payload FROM outbox WHERE kind = 'notify' ORDER BY id",
  );

async function ready(f: BackupFixture, over: Partial<BackupServiceDeps> = {}) {
  const s = service(f, over);
  await s.generatePassword();
  await s.setRepository({ mode: "create", confirmed: true });
  return s;
}

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string | undefined> => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e instanceof HttpError ? e.code : "other";
  }
  return undefined;
};

describe("BackupService: availability and settings", () => {
  it("says it is not available without a backup folder, and refuses changes", async () => {
    fx = backupFixture();
    const s = service(fx, { repositoryDir: undefined });
    expect(s.settings()).toMatchObject({ available: false, repository: "none", enabled: false, nextRunAt: null });
    expect(await code(() => s.update({ enabled: true }))).toBe("backups_unavailable");
    expect(await code(s.generatePassword())).toBe("backups_unavailable");
    expect(await code(s.start("manual"))).toBe("backups_unavailable");
  });

  it("needs an events key to seal the password", async () => {
    fx = backupFixture();
    expect(service(fx, { secrets: undefined }).settings().available).toBe(false);
  });

  it("has sensible defaults", () => {
    fx = backupFixture();
    expect(service(fx).settings()).toMatchObject({
      available: true,
      enabled: false,
      time: "03:00",
      timeZone: "UTC",
      retention: { daily: 7, weekly: 4, monthly: 12 },
      repository: "none",
      history: [],
    });
  });

  it("validates the time and the retention, and will not turn on without a repository", async () => {
    fx = backupFixture();
    const s = await ready(fx);
    expect(await code(() => s.update({ time: "25:00" }))).toBe("bad_request");
    expect(await code(() => s.update({ retention: { daily: 0, weekly: 0, monthly: 0 } }))).toBe("bad_request");
    expect(await code(() => s.update({ retention: { daily: -1, weekly: 1, monthly: 1 } }))).toBe("bad_request");
    expect(await code(() => s.update({ retention: { daily: 1.5, weekly: 1, monthly: 1 } }))).toBe("bad_request");
    expect(s.update({ time: "04:30", retention: { daily: 2, weekly: 0, monthly: 0 } })).toMatchObject({
      time: "04:30",
      retention: { daily: 2, weekly: 0, monthly: 0 },
    });
    const bare = service(backupFixture());
    expect(await code(() => bare.update({ enabled: true }))).toBe("repository_missing");
  });

  it("schedules the next run after enabling, in the owner's time zone, without running at once", async () => {
    fx = backupFixture(Date.UTC(2026, 0, 10, 12, 0, 0));
    const s = await ready(fx, { timeZone: () => "Asia/Macau" });
    const settings = s.update({ enabled: true, time: "03:00" });
    // 03:00 in Macau (UTC+8) is 19:00 UTC the day before.
    expect(new Date(settings.nextRunAt!).toISOString()).toBe("2026-01-10T19:00:00.000Z");
    await s.tick();
    expect(fx.restic.calls.includes("backup")).toBe(false);
  });
});

describe("BackupService: the repository", () => {
  it("shows a generated password once, keeps it sealed, and creates only after it was generated", async () => {
    fx = backupFixture();
    const s = service(fx);
    expect(await code(s.setRepository({ mode: "create", confirmed: true }))).toBe("bad_request");
    const password = await s.generatePassword();
    expect(password).toMatch(/^[a-z2-7]{8}(-[a-z2-7]{8}){3}$/);
    expect(s.settings().repository).toBe("pending");
    // nothing readable in the database
    const meta = fx.db.all<{ value: string }>("SELECT value FROM meta");
    expect(meta.some((m) => m.value.includes(password))).toBe(false);
    const settings = await s.setRepository({ mode: "create", confirmed: true });
    expect(settings.repository).toBe("ready");
    expect(settings.snapshots).toBe(0);
    expect(fx.restic.password).toBe(password);
    expect(fx.restic.initialised).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(password);
    expect(await code(s.generatePassword())).toBe("repository_exists");
    expect(await code(s.setRepository({ mode: "connect", password: "x" }))).toBe("repository_exists");
  });

  it("refuses to create over a folder that already holds a repository", async () => {
    fx = backupFixture();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(fx.repositoryDir, "config"), "x");
    const s = service(fx);
    await s.generatePassword();
    expect(await code(s.setRepository({ mode: "create", confirmed: true }))).toBe("repository_failed");
    expect(s.settings().repository).toBe("pending");
    expect(fx.restic.initialised).toBe(false);
  });

  it("connects to an existing repository, and reports a wrong password without keeping it", async () => {
    fx = backupFixture();
    const s = service(fx);
    fx.restic.failOn = "snapshots";
    expect(await code(s.setRepository({ mode: "connect", password: "wrong" }))).toBe("repository_failed");
    expect(s.settings().repository).toBe("none");
    fx.restic.failOn = undefined;
    fx.restic.snapshotList.push({
      id: "a".repeat(64),
      shortId: "aaaaaaaa",
      time: "t",
      hostname: "rei",
      paths: [],
      tags: [],
    });
    const settings = await s.setRepository({ mode: "connect", password: "right" });
    expect(settings).toMatchObject({ repository: "ready", snapshots: 1 });
    expect(fx.restic.password).toBe("right");
  });

  it("forgets the repository and its password, turning backups off, and leaves the folder alone", async () => {
    fx = backupFixture();
    const s = await ready(fx);
    s.update({ enabled: true });
    const settings = s.forgetRepository();
    expect(settings).toMatchObject({ repository: "none", enabled: false, snapshots: null, nextRunAt: null });
    expect(await code(s.start("manual"))).toBe("repository_missing");
  });
});

describe("BackupService: runs", () => {
  it("backs up a bundle, keeps the retention, records the run and refuses a second at the same time", async () => {
    fx = backupFixture();
    await putObject(fx.objects, "obj_1", "file bytes");
    const s = await ready(fx);
    s.update({ retention: { daily: 3, weekly: 2, monthly: 1 } });
    let inside: string | undefined;
    fx.restic.onBackup = (dir) => {
      inside = dir;
      expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    };
    const started = await s.start("manual");
    expect(started).toMatchObject({ status: "running", trigger: "manual" });
    expect(s.settings().running).toBe(true);
    expect(await code(s.start("manual"))).toBe("backup_running");
    expect(await code(s.setRepository({ mode: "connect", password: "x" }))).toBe("repository_exists");
    expect(await code(() => s.forgetRepository())).toBe("backup_running");
    await s.idle();
    expect(inside).toBe(join(fx.stagingDir, "bundle"));
    const settings = s.settings();
    expect(settings.running).toBe(false);
    expect(settings.lastRun).toMatchObject({ status: "ok", trigger: "manual", bytesAdded: 1234, error: null });
    expect(settings.lastRun?.counts?.objects).toBe(1);
    expect(settings.snapshots).toBe(1);
    expect(settings.lastSuccessAt).toBe(fx.clock.t);
    expect(fx.restic.tags[0]).toEqual(["app=rei", "version=1.2.3", "trigger=manual"]);
    expect(fx.restic.retentions[0]).toEqual({ daily: 3, weekly: 2, monthly: 1 });
    expect(rows(fx)).toHaveLength(0);
  });

  it("prunes and checks the first time and then only weekly", async () => {
    fx = backupFixture();
    const s = await ready(fx);
    const run = async () => {
      await s.start("manual");
      await s.idle();
    };
    await run();
    expect(fx.restic.calls.filter((c) => c === "prune")).toHaveLength(1);
    expect(fx.restic.calls).toContain("check 5%");
    expect(s.settings().lastRun?.maintenance).toBe("pruned and checked");
    fx.clock.t += 6 * 24 * HOUR;
    await run();
    expect(fx.restic.calls.filter((c) => c === "prune")).toHaveLength(1);
    fx.clock.t += 2 * 24 * HOUR;
    await run();
    expect(fx.restic.calls.filter((c) => c === "prune")).toHaveLength(2);
  });

  it("records a failure with its reason and sends one notification", async () => {
    fx = backupFixture();
    const s = await ready(fx);
    fx.restic.failOn = "backup";
    const run = await s.start("manual");
    await s.idle();
    const settings = s.settings();
    expect(settings.lastRun).toMatchObject({ id: run.id, status: "failed" });
    expect(settings.lastRun?.error).toContain("restic backup failed");
    expect(settings.lastSuccessAt).toBeNull();
    const queued = rows(fx);
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0]!.payload)).toMatchObject({
      event: "backup_failed",
      title: "Backup failed",
      path: "#/",
    });
    // a later success clears the failure from the health
    fx.restic.failOn = undefined;
    await s.start("manual");
    await s.idle();
    expect(backupHealth(fx.db, fx.clock.t)).toMatchObject({ lastFailure: null });
  });

  it("fails the run when the gateway cannot be read or the bucket cannot be listed", async () => {
    fx = backupFixture();
    const s = await ready(fx, {
      gatewayState: async () => {
        throw new Error("the gateway is down");
      },
    });
    await s.start("manual");
    await s.idle();
    expect(s.settings().lastRun).toMatchObject({ status: "failed", error: "the gateway is down" });
    expect(fx.restic.calls).not.toContain("backup");
  });

  it("marks a run left running by a stopped process as failed when it starts", async () => {
    fx = backupFixture();
    const s = await ready(fx);
    fx.db.run(
      "INSERT INTO backup_runs (id, trigger, status, started_at) VALUES ('bk_old', 'schedule', 'running', ?)",
      fx.clock.t - HOUR,
    );
    s.begin();
    await s.end();
    expect(s.settings().history[0]).toMatchObject({
      id: "bk_old",
      status: "failed",
      error: "Rei stopped before this backup finished.",
    });
  });

  it("keeps only the latest 200 run records", async () => {
    fx = backupFixture();
    const s = await ready(fx);
    for (let i = 0; i < 205; i++)
      fx.db.run(
        "INSERT INTO backup_runs (id, trigger, status, started_at, finished_at) VALUES (?, 'schedule', 'ok', ?, ?)",
        `bk_${i}`,
        i + 1,
        i + 1,
      );
    await s.start("manual");
    await s.idle();
    expect(fx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM backup_runs")?.n).toBe(200);
    expect(s.settings().history).toHaveLength(30);
  });
});

describe("BackupService: the schedule", () => {
  it("runs once a day at the set time, including a missed one after downtime", async () => {
    fx = backupFixture(Date.UTC(2026, 0, 10, 12, 0, 0));
    const s = await ready(fx);
    s.update({ enabled: true });
    fx.clock.t = Date.UTC(2026, 0, 11, 2, 59, 0);
    await s.tick();
    await s.idle();
    expect(fx.restic.calls).not.toContain("backup");
    fx.clock.t = Date.UTC(2026, 0, 11, 3, 1, 0);
    await s.tick();
    await s.idle();
    expect(fx.restic.calls.filter((c) => c === "backup")).toHaveLength(1);
    expect(s.settings().lastRun?.trigger).toBe("schedule");
    fx.clock.t = Date.UTC(2026, 0, 11, 9, 0, 0);
    await s.tick();
    await s.idle();
    expect(fx.restic.calls.filter((c) => c === "backup")).toHaveLength(1);
    // the machine was off over the next 03:00 and wakes at noon
    fx.clock.t = Date.UTC(2026, 0, 12, 12, 0, 0);
    await s.tick();
    await s.idle();
    expect(fx.restic.calls.filter((c) => c === "backup")).toHaveLength(2);
  });

  it("does nothing while off, and a failing scheduled start does not throw", async () => {
    fx = backupFixture();
    const s = await ready(fx);
    fx.clock.t += 3 * 24 * HOUR;
    await s.tick();
    expect(fx.restic.calls).not.toContain("backup");
    s.update({ enabled: true });
    s.forgetRepository();
    await expect(s.tick()).resolves.toBeUndefined();
  });

  it("warns once a day when the last good backup is older than 36 hours", async () => {
    fx = backupFixture();
    const s = await ready(fx);
    await s.start("manual");
    await s.idle();
    s.update({ enabled: true });
    fx.restic.failOn = "backup";
    fx.clock.t += STALE_AFTER_MS + HOUR;
    await s.tick();
    await s.idle();
    await s.tick();
    const stale = rows(fx).filter((r) => r.request_id.includes("stale:"));
    expect(stale).toHaveLength(1);
    expect(JSON.parse(stale[0]!.payload).title).toBe("Backups are stale");
    fx.clock.t += 24 * HOUR;
    await s.tick();
    await s.idle();
    expect(rows(fx).filter((r) => r.request_id.includes("stale:"))).toHaveLength(2);
  });
});

describe("backupHealth", () => {
  it("is quiet when off, and stale only once on and overdue", async () => {
    fx = backupFixture();
    expect(backupHealth(fx.db, fx.clock.t)).toEqual({
      enabled: false,
      stale: false,
      lastSuccessAt: null,
      lastFailure: null,
    });
    const s = await ready(fx);
    s.update({ enabled: true });
    expect(backupHealth(fx.db, fx.clock.t).stale).toBe(false);
    expect(backupHealth(fx.db, fx.clock.t + STALE_AFTER_MS + 1)).toMatchObject({
      enabled: true,
      stale: true,
      lastSuccessAt: null,
    });
  });
});
