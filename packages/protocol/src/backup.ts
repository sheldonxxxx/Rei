/** How long snapshots are kept: the newest per day, week and month, that many of each. */
export interface BackupRetention {
  daily: number;
  weekly: number;
  monthly: number;
}
export const BACKUP_RETENTION_DEFAULT: BackupRetention = { daily: 7, weekly: 4, monthly: 12 };
export const BACKUP_RETENTION_MAX = 999;

/** One run of a backup, scheduled or started by hand. `error` is the full message of a failure. */
export interface BackupRun {
  id: string;
  trigger: "schedule" | "manual";
  status: "running" | "ok" | "failed";
  startedAt: number;
  finishedAt: number | null;
  snapshotId: string | null;
  /** New data the snapshot added to the repository, after deduplication. */
  bytesAdded: number | null;
  /** Rows and objects in the bundle, by name. */
  counts: Record<string, number> | null;
  error: string | null;
  /** What the run did besides the backup itself: "pruned and checked" once a week. */
  maintenance: string | null;
}

/**
 * GET /api/settings/backups and the answer of every change: the settings, the repository and the state of the schedule.
 * `available` is false when the deployment did not give Rei a backup folder (REI_BACKUP_DIR); nothing else works then.
 */
export interface BackupSettings {
  available: boolean;
  enabled: boolean;
  /** Daily at this 24-hour time (HH:mm) in `timeZone`. */
  time: string;
  /** The user's time zone (Settings > General), else the server's. */
  timeZone: string;
  retention: BackupRetention;
  /** `none`: no repository yet. `pending`: a password was generated and not confirmed. `ready`: the repository is open. */
  repository: "none" | "pending" | "ready";
  /** Where the repository is, as the server sees it. */
  path: string;
  running: boolean;
  lastRun: BackupRun | null;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  /** Backups are on and the last success is older than 36 hours (or there is none and they have been on that long). */
  stale: boolean;
  snapshots: number | null;
  repositoryBytes: number | null;
  /** Newest first, at most 30. */
  history: BackupRun[];
}

/** PUT /api/settings/backups: any of the three. Errors: "bad_request" (a time or a number out of range), "repository_missing" (turning on without a repository). */
export interface UpdateBackupSettingsRequest {
  enabled?: boolean;
  time?: string;
  retention?: BackupRetention;
}

/** POST /api/settings/backups/password: a new password for a repository to be created. It is shown here and nowhere else. Error "backups_unavailable". */
export interface BackupPasswordResponse {
  password: string;
}

/**
 * POST /api/settings/backups/repository. `create` opens a new repository with the password the last call to /password
 * made, and only once `confirmed` says the owner saved it. `connect` opens an existing repository with its own password.
 * Answers BackupSettings. Errors: "backups_unavailable", "bad_request", "repository_exists" (a repository is already set up), "repository_failed" (restic's message).
 */
export type BackupRepositoryRequest = { mode: "create"; confirmed: true } | { mode: "connect"; password: string };

/** POST /api/settings/backups/run: starts a backup now and answers BackupSettings with `running` true. Errors: "backups_unavailable", "repository_missing", "backup_running". */

/** The manifest at the root of every bundle (`manifest.json`). */
export const BACKUP_MANIFEST_FORMAT = 1;
export interface BackupManifest {
  format: typeof BACKUP_MANIFEST_FORMAT;
  app: "rei";
  appVersion: string;
  /** SQLite's user_version of app.sqlite. A restore refuses a bundle newer than its code. */
  schemaVersion: number;
  /** The gateway's own state format and version, when the bundle has gateway state. */
  gatewayVersion: string | null;
  createdAt: string;
  host: string;
  trigger: "schedule" | "manual";
  /** Every file in the bundle, relative to its root, except this one. */
  files: { path: string; size: number; sha256: string }[];
  /** Rows in key tables and objects in the mirror. */
  counts: Record<string, number>;
}
