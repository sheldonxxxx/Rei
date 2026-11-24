// What the backup service needs from restic, Rei's one backup engine. The client over the binary is in node/restic.ts.
import type { BackupRetention } from "@rei/protocol";

export interface ResticSnapshot {
  id: string;
  shortId: string;
  time: string;
  hostname: string;
  paths: string[];
  tags: string[];
}

export interface ResticBackupResult {
  snapshotId: string;
  /** New data after deduplication and compression. */
  bytesAdded: number;
  filesNew: number;
}

/** What the backup service needs from restic; tests supply a fake. */
export interface ResticClient {
  init(): Promise<void>;
  snapshots(): Promise<ResticSnapshot[]>;
  backup(dir: string, tags: string[]): Promise<ResticBackupResult>;
  forget(retention: BackupRetention): Promise<void>;
  prune(): Promise<void>;
  check(readDataSubset: string): Promise<void>;
  /** Restores `snapshot:subfolder` into `target`, only the given paths (relative to the subfolder) when `include` is given. */
  restore(snapshot: string, subfolder: string, target: string, include?: string[]): Promise<void>;
}

export class ResticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResticError";
  }
}
