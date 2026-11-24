// Backups (docs/backup-user.md): the settings, the schedule, the run records and the one run at a time. Each run writes a
// bundle (bundle.ts) and hands it to restic (restic.ts). The destination is a folder mounted from the host, so the control
// plane needs no network for it. The repository password is stored sealed under REI_EVENTS_KEY and is never returned,
// logged or shown again; a copy of the database alone does not reveal it.
import {
  BACKUP_RETENTION_DEFAULT,
  BACKUP_RETENTION_MAX,
  type BackupRetention,
  type BackupRun,
  type BackupSettings,
  type UpdateBackupSettingsRequest,
} from "@rei/protocol";
import type { Db } from "../db/db.ts";
import type { SecretBox } from "../events/sources.ts";
import type { FileObjectStore } from "../storage/file-object-store.ts";
import type { AppStore } from "../store/store.ts";
import { latestDue, nextRuns } from "../triggers/schedule.ts";
import type { Clock } from "../util/clock.ts";
import { randomBase32 } from "../util/encoding.ts";
import { badRequest, HttpError } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import type { BundleDeps, BundleRunner, GatewayState } from "./bundle-types.ts";
import { type ResticClient, ResticError } from "./restic.ts";

const HOUR_MS = 3_600_000;
const at = (dir: string, name: string): string => `${dir.replace(/\/+$/, "")}/${name}`;
export const STALE_AFTER_MS = 36 * HOUR_MS;
const MAINTENANCE_EVERY_MS = 7 * 24 * HOUR_MS;
const KEEP_RUNS = 200;
const HISTORY = 30;
const TICK_MS = 60_000;
const AAD = "backup-repository";

const META = {
  enabled: "backup_enabled",
  enabledAt: "backup_enabled_at",
  time: "backup_time",
  retention: "backup_retention",
  password: "backup_password",
  pending: "backup_pending_password",
  maintenanceAt: "backup_maintenance_at",
  snapshots: "backup_snapshot_count",
} as const;

/** What the service asks of the repository folder. */
export interface BackupFolder {
  exists(path: string): boolean;
  /** The size of everything below `dir`, or null when it cannot be read. */
  bytes(dir: string): number | null;
}

export interface BackupServiceDeps {
  store: AppStore;
  db: Db;
  clock: Clock;
  log: Logger;
  /** Where the repository folder is mounted in this container; undefined when the deployment gave none. */
  repositoryDir: string | undefined;
  /** The staging folder: the bundle, the mirror and restic's cache (a named volume). */
  stagingDir: string | undefined;
  dataDir: string;
  /** Data directory entries to leave out of the bundle besides the standard ones. */
  extraSkip?: readonly string[];
  objects: FileObjectStore;
  /** The gateway's state; undefined when there is no gateway. */
  gatewayState?: (() => Promise<GatewayState>) | undefined;
  /** Seals the repository password; without it backups cannot be turned on. */
  secrets: SecretBox | undefined;
  appVersion: string;
  host: string;
  /** The user's saved time zone, else the server's. */
  timeZone: () => string;
  /** A restic client for a repository, password and cache folder. */
  restic: (options: { repository: string; password: string; cacheDir: string }) => ResticClient;
  /** Makes the writer of one bundle (node/backup-bundle.ts). */
  bundle: (deps: BundleDeps) => BundleRunner;
  /** The repository folder, seen from the file system. */
  folder: BackupFolder;
  tickMs?: number;
}

interface RunRow {
  id: string;
  trigger: "schedule" | "manual";
  status: "running" | "ok" | "failed";
  started_at: number;
  finished_at: number | null;
  snapshot_id: string | null;
  bytes_added: number | null;
  counts: string | null;
  error: string | null;
  maintenance: string | null;
}

const toRun = (r: RunRow): BackupRun => ({
  id: r.id,
  trigger: r.trigger,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  snapshotId: r.snapshot_id,
  bytesAdded: r.bytes_added,
  counts: r.counts ? (JSON.parse(r.counts) as Record<string, number>) : null,
  error: r.error,
  maintenance: r.maintenance,
});

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function checkRetention(value: BackupRetention): BackupRetention {
  for (const [name, n] of Object.entries(value))
    if (!Number.isInteger(n) || n < 0 || n > BACKUP_RETENTION_MAX)
      throw badRequest("bad_request", `Keep ${name}: a whole number from 0 to ${BACKUP_RETENTION_MAX}.`);
  if (value.daily + value.weekly + value.monthly < 1)
    throw badRequest("bad_request", "Keep at least one snapshot: one of daily, weekly and monthly must be 1 or more.");
  return { daily: value.daily, weekly: value.weekly, monthly: value.monthly };
}

/** What a stored backup state says about itself, for `./rei doctor` (read from the database file without the service). */
export interface BackupHealth {
  enabled: boolean;
  stale: boolean;
  lastSuccessAt: number | null;
  lastFailure: string | null;
}

/** The health of backups from the database alone: used by the CLI inside the container, which has no running service. */
export function backupHealth(db: Db, now: number): BackupHealth {
  const meta = (key: string) => db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  let last: RunRow | undefined;
  let success: { finished_at: number } | undefined;
  try {
    last = db.get<RunRow>("SELECT * FROM backup_runs WHERE status <> 'running' ORDER BY started_at DESC LIMIT 1");
    success = db.get<{ finished_at: number }>(
      "SELECT finished_at FROM backup_runs WHERE status = 'ok' ORDER BY finished_at DESC LIMIT 1",
    );
  } catch {
    // an older database without the table
  }
  const enabled = meta(META.enabled) === "1";
  const since = success?.finished_at ?? Number(meta(META.enabledAt) ?? 0);
  return {
    enabled,
    stale: enabled && since > 0 && now - since > STALE_AFTER_MS,
    lastSuccessAt: success?.finished_at ?? null,
    lastFailure: last?.status === "failed" ? (last.error ?? "failed") : null,
  };
}

export class BackupService {
  readonly #d: BackupServiceDeps;
  #running: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #sizeCache: { at: number; bytes: number } | undefined;

  constructor(deps: BackupServiceDeps) {
    this.#d = deps;
  }

  get #now(): number {
    return this.#d.clock.now();
  }
  get available(): boolean {
    return !!this.#d.repositoryDir && !!this.#d.stagingDir && !!this.#d.secrets;
  }
  #meta(key: string): string | undefined {
    return this.#d.store.metaGet(key);
  }

  // ---- settings ----------------------------------------------------------------------------------------------------

  #retention(): BackupRetention {
    try {
      const saved = this.#meta(META.retention);
      return saved ? checkRetention(JSON.parse(saved) as BackupRetention) : BACKUP_RETENTION_DEFAULT;
    } catch {
      return BACKUP_RETENTION_DEFAULT;
    }
  }
  #time(): string {
    const saved = this.#meta(META.time);
    return saved && TIME.test(saved) ? saved : "03:00";
  }
  #enabled(): boolean {
    return this.#meta(META.enabled) === "1";
  }
  #repository(): BackupSettings["repository"] {
    return this.#meta(META.password) ? "ready" : this.#meta(META.pending) ? "pending" : "none";
  }
  #lastStarted(): number {
    return this.#d.db.get<{ at: number | null }>("SELECT MAX(started_at) AS at FROM backup_runs")?.at ?? 0;
  }
  #nextRunAt(): number | null {
    if (!this.#enabled() || this.#repository() !== "ready") return null;
    const anchor = Math.max(this.#lastStarted(), Number(this.#meta(META.enabledAt) ?? 0));
    return nextRuns(this.#schedule(), anchor, 1)[0] ?? null;
  }
  #schedule() {
    return { kind: "daily" as const, times: [this.#time()], timeZone: this.#d.timeZone() };
  }
  #repositoryBytes(): number | null {
    const dir = this.#d.repositoryDir;
    if (!dir || this.#repository() !== "ready") return null;
    if (this.#sizeCache && this.#now - this.#sizeCache.at < 60_000) return this.#sizeCache.bytes;
    const bytes = this.#d.folder.bytes(dir);
    if (bytes === null) return null;
    this.#sizeCache = { at: this.#now, bytes };
    return bytes;
  }

  settings(): BackupSettings {
    const rows = this.#d.db.all<RunRow>(
      "SELECT * FROM backup_runs ORDER BY started_at DESC, rowid DESC LIMIT ?",
      HISTORY,
    );
    const history = rows.map(toRun);
    const health = backupHealth(this.#d.db, this.#now);
    const snapshots = this.#meta(META.snapshots);
    return {
      available: this.available,
      enabled: this.#enabled(),
      time: this.#time(),
      timeZone: this.#d.timeZone(),
      retention: this.#retention(),
      repository: this.#repository(),
      path: this.#d.repositoryDir ?? "",
      running: this.#running !== undefined,
      lastRun: history[0] ?? null,
      lastSuccessAt: health.lastSuccessAt,
      nextRunAt: this.#nextRunAt(),
      stale: health.stale,
      snapshots: snapshots === undefined ? null : Number(snapshots),
      repositoryBytes: this.#repositoryBytes(),
      history,
    };
  }

  #needAvailable(): void {
    if (!this.available)
      throw new HttpError(
        409,
        "backups_unavailable",
        "Backups need a backup folder for this stack (REI_BACKUP_DIR in the stack's .env) and REI_EVENTS_KEY. See docs/backup-user.md.",
      );
  }

  update(request: UpdateBackupSettingsRequest): BackupSettings {
    this.#needAvailable();
    if (request.time !== undefined && !TIME.test(request.time))
      throw badRequest("bad_request", 'The time must look like "03:00" (24 hours).');
    const retention = request.retention ? checkRetention(request.retention) : undefined;
    if (request.enabled === true && this.#repository() !== "ready")
      throw badRequest("repository_missing", "Create or connect a repository before turning backups on.");
    if (request.time !== undefined) this.#d.store.metaSet(META.time, request.time);
    if (retention) this.#d.store.metaSet(META.retention, JSON.stringify(retention));
    if (request.enabled !== undefined && request.enabled !== this.#enabled()) {
      this.#d.store.metaSet(META.enabled, request.enabled ? "1" : "0");
      if (request.enabled) this.#d.store.metaSet(META.enabledAt, String(this.#now));
    }
    this.#d.log.info("backup.settings_changed", {});
    return this.settings();
  }

  // ---- the repository ----------------------------------------------------------------------------------------------

  #restic(password: string): ResticClient {
    return this.#d.restic({
      repository: this.#d.repositoryDir!,
      password,
      cacheDir: at(this.#d.stagingDir!, "restic-cache"),
    });
  }
  async #storedPassword(key: string): Promise<string | undefined> {
    const sealed = this.#meta(key);
    return sealed ? await this.#d.secrets!.open(sealed, AAD) : undefined;
  }

  /** A new password for a repository to be created, kept sealed until it is confirmed; returned this once. */
  async generatePassword(): Promise<string> {
    this.#needAvailable();
    if (this.#repository() === "ready")
      throw new HttpError(
        409,
        "repository_exists",
        "A repository is already set up. Forget it first to create another.",
      );
    const password = `${randomBase32(8)}-${randomBase32(8)}-${randomBase32(8)}-${randomBase32(8)}`.toLowerCase();
    this.#d.store.metaSet(META.pending, await this.#d.secrets!.seal(password, AAD));
    return password;
  }

  async setRepository(
    request: { mode: "create"; confirmed: true } | { mode: "connect"; password: string },
  ): Promise<BackupSettings> {
    this.#needAvailable();
    if (this.#repository() === "ready")
      throw new HttpError(
        409,
        "repository_exists",
        "A repository is already set up. Forget it first to set up another.",
      );
    if (this.#running) throw new HttpError(409, "backup_running", "A backup is running; try again when it is done.");
    let password: string;
    if (request.mode === "create") {
      const pending = await this.#storedPassword(META.pending);
      if (!pending) throw badRequest("bad_request", "Generate a password first.");
      password = pending;
    } else password = request.password;
    const restic = this.#restic(password);
    try {
      if (request.mode === "create") {
        // An empty folder is needed: restic refuses to initialise over a repository, and so do we.
        if (this.#d.folder.exists(at(this.#d.repositoryDir!, "config")))
          throw new ResticError("The backup folder already holds a repository. Use Connect with its password.");
        await restic.init();
        this.#d.store.metaSet(META.snapshots, "0");
      } else {
        const snapshots = await restic.snapshots();
        this.#d.store.metaSet(META.snapshots, String(snapshots.length));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "restic failed.";
      throw new HttpError(422, "repository_failed", message);
    }
    this.#d.store.metaSet(META.password, await this.#d.secrets!.seal(password, AAD));
    this.#d.store.metaSet(META.pending, null);
    this.#sizeCache = undefined;
    this.#d.log.info("backup.repository_ready", { mode: request.mode });
    return this.settings();
  }

  /** Forgets the repository and its password and turns backups off; the files in the folder stay. */
  forgetRepository(): BackupSettings {
    this.#needAvailable();
    if (this.#running) throw new HttpError(409, "backup_running", "A backup is running; try again when it is done.");
    for (const key of [META.password, META.pending, META.snapshots, META.maintenanceAt])
      this.#d.store.metaSet(key, null);
    this.#d.store.metaSet(META.enabled, "0");
    this.#sizeCache = undefined;
    this.#d.log.info("backup.repository_forgotten", {});
    return this.settings();
  }

  // ---- runs --------------------------------------------------------------------------------------------------------

  /** Starts a run in the background. Resolves once it is recorded as running. */
  async start(trigger: "schedule" | "manual"): Promise<BackupRun> {
    this.#needAvailable();
    if (this.#repository() !== "ready")
      throw new HttpError(409, "repository_missing", "Create or connect a repository first.");
    if (this.#running) throw new HttpError(409, "backup_running", "A backup is already running.");
    const password = await this.#storedPassword(META.password);
    if (!password) throw new HttpError(409, "repository_missing", "Create or connect a repository first.");
    const id = `bk_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const startedAt = this.#now;
    this.#d.db.run(
      "INSERT INTO backup_runs (id, trigger, status, started_at) VALUES (?, ?, 'running', ?)",
      id,
      trigger,
      startedAt,
    );
    const run = this.#execute(id, trigger, password).finally(() => {
      this.#running = undefined;
    });
    this.#running = run;
    void run;
    return toRun(this.#d.db.get<RunRow>("SELECT * FROM backup_runs WHERE id = ?", id)!);
  }

  /** Resolves when the run in progress (if any) is over. For tests and shutdown. */
  async idle(): Promise<void> {
    await this.#running;
  }

  async #execute(id: string, trigger: "schedule" | "manual", password: string): Promise<void> {
    const d = this.#d;
    const log = d.log;
    log.info("backup.started", { id, trigger });
    let snapshotId: string | null = null;
    let bytesAdded: number | null = null;
    let counts: Record<string, number> | null = null;
    const notes: string[] = [];
    try {
      const restic = this.#restic(password);
      const bundle = d.bundle({
        dir: at(d.stagingDir!, "bundle"),
        dataDir: d.dataDir,
        ...(d.extraSkip ? { extraSkip: d.extraSkip } : {}),
        db: d.db,
        objects: d.objects,
        gatewayState: d.gatewayState,
        expectedObjects: () =>
          d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM storage_objects WHERE state = 'ready'")?.n ?? 0,
        appVersion: d.appVersion,
        host: d.host,
        log,
        now: () => this.#now,
      });
      const { manifest } = await bundle.write(trigger);
      counts = manifest.counts;
      const result = await restic.backup(at(d.stagingDir!, "bundle"), [
        "app=rei",
        `version=${d.appVersion}`,
        `trigger=${trigger}`,
      ]);
      snapshotId = result.snapshotId;
      bytesAdded = result.bytesAdded;
      await restic.forget(this.#retention());
      const maintainedAt = Number(this.#meta(META.maintenanceAt) ?? 0);
      if (this.#now - maintainedAt >= MAINTENANCE_EVERY_MS) {
        await restic.prune();
        await restic.check("5%");
        d.store.metaSet(META.maintenanceAt, String(this.#now));
        notes.push("pruned and checked");
      }
      d.store.metaSet(META.snapshots, String((await restic.snapshots()).length));
      this.#sizeCache = undefined;
      this.#finish(id, "ok", { snapshotId, bytesAdded, counts, error: null, maintenance: notes.join(", ") || null });
      log.info("backup.finished", { id, trigger, bytesAdded: bytesAdded ?? 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#finish(id, "failed", {
        snapshotId,
        bytesAdded,
        counts,
        error: message,
        maintenance: notes.join(", ") || null,
      });
      log.warn("backup.failed", { id, trigger });
      d.store.queueNotify({
        event: "backup_failed",
        sessionId: "",
        title: "Backup failed",
        body: message.split("\n")[0] ?? "A backup failed.",
        dedupe: `failed:${id}`,
      });
    }
  }

  #finish(
    id: string,
    status: "ok" | "failed",
    f: {
      snapshotId: string | null;
      bytesAdded: number | null;
      counts: Record<string, number> | null;
      error: string | null;
      maintenance: string | null;
    },
  ): void {
    const d = this.#d;
    d.db.run(
      "UPDATE backup_runs SET status = ?, finished_at = ?, snapshot_id = ?, bytes_added = ?, counts = ?, error = ?, maintenance = ? WHERE id = ?",
      status,
      this.#now,
      f.snapshotId,
      f.bytesAdded,
      f.counts ? JSON.stringify(f.counts) : null,
      f.error,
      f.maintenance,
      id,
    );
    d.db.run(
      "DELETE FROM backup_runs WHERE id NOT IN (SELECT id FROM backup_runs ORDER BY started_at DESC, rowid DESC LIMIT ?)",
      KEEP_RUNS,
    );
  }

  // ---- the schedule ------------------------------------------------------------------------------------------------

  /** Runs what is due and warns about a stale backup; called every minute. */
  async tick(): Promise<void> {
    if (!this.available || !this.#enabled() || this.#repository() !== "ready") return;
    const now = this.#now;
    const health = backupHealth(this.#d.db, now);
    if (health.stale) {
      const day = new Date(now).toISOString().slice(0, 10);
      this.#d.store.queueNotify({
        event: "backup_failed",
        sessionId: "",
        title: "Backups are stale",
        body: health.lastSuccessAt
          ? `The last backup that worked was ${Math.floor((now - health.lastSuccessAt) / HOUR_MS)} hours ago.`
          : "Backups are on but none has worked yet.",
        dedupe: `stale:${day}`,
      });
    }
    if (this.#running) return;
    const anchor = Math.max(this.#lastStarted(), Number(this.#meta(META.enabledAt) ?? 0));
    if (latestDue(this.#schedule(), anchor, now) === null) return;
    try {
      await this.start("schedule");
    } catch (error) {
      this.#d.log.warn("backup.schedule_failed", { code: error instanceof HttpError ? error.code : "error" });
    }
  }

  /** A run that was going when the process stopped did not finish. */
  #failInterrupted(): void {
    this.#d.db.run(
      "UPDATE backup_runs SET status = 'failed', finished_at = ?, error = 'Rei stopped before this backup finished.' WHERE status = 'running'",
      this.#now,
    );
  }

  begin(): void {
    this.#failInterrupted();
    this.#timer = setInterval(() => void this.tick(), this.#d.tickMs ?? TICK_MS);
    this.#timer.unref?.();
  }

  async end(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => {});
  }
}
