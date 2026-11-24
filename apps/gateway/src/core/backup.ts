// What `GET /backup` returns (admin scope only): the gateway's own state as a list of files, so the control plane can put
// it in a backup. The wire format is JSON with each file's bytes in base64, with its size and SHA-256 so the receiver
// can check what it got. The state is small (credentials, settings, models, and the call log's database).

export const BACKUP_FORMAT = 1;

export interface GatewayBackupFile {
  /** Relative to the gateway's data directory, with forward slashes: `secret/credentials.json`, `calls.sqlite`. */
  path: string;
  size: number;
  sha256: string;
  /** The bytes, base64. */
  data: string;
}

export interface GatewayBackup {
  format: typeof BACKUP_FORMAT;
  version: string;
  files: GatewayBackupFile[];
}
