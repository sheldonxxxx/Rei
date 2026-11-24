// The shapes of a backup bundle and of what writes one. The writer itself is node/backup-bundle.ts.
import type { BackupManifest } from "@rei/protocol";
import type { Db } from "../db/db.ts";
import type { FileObjectStore } from "../storage/file-object-store.ts";
import type { Logger } from "../util/log.ts";

/** What the gateway's `GET /backup` returns; the same shape as apps/gateway/src/core/backup.ts (a network boundary, not shared code). */
export interface GatewayState {
  format: number;
  version: string;
  files: { path: string; size: number; sha256: string; data: string }[];
}

export interface BundleDeps {
  /** `<staging>/bundle`. Kept between runs, so the mirror downloads only what is new. */
  dir: string;
  dataDir: string;
  /** Data directory entries to leave out besides `DATA_SKIP` (the folder file store keeps its objects in `files`, which the mirror has). */
  extraSkip?: readonly string[];
  db: Db;
  objects: FileObjectStore;
  /** The gateway's state; absent when there is no gateway (faux mode). */
  gatewayState?: (() => Promise<GatewayState>) | undefined;
  /** How many objects SQLite believes are in the bucket: a bucket that lists none while this is positive is not trusted. */
  expectedObjects: () => number;
  appVersion: string;
  host: string;
  log: Logger;
  now: () => number;
}

export interface BundleResult {
  manifest: BackupManifest;
}

/** Writes one bundle into `BundleDeps.dir`. */
export interface BundleRunner {
  write(trigger: "schedule" | "manual"): Promise<BundleResult>;
}
