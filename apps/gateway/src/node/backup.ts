// Reads the gateway's state for a backup: `secret/*.json` (provider sign-ins, API keys, connectors, callers), `models.json`
// and a consistent online copy of `calls.sqlite`. Nothing else in the data directory is state.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_FORMAT, type GatewayBackup, type GatewayBackupFile } from "../core/backup.ts";
import type { CallLog } from "../core/types.ts";

function entry(path: string, bytes: Buffer): GatewayBackupFile {
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    data: bytes.toString("base64"),
  };
}

export function gatewayBackup(options: {
  dataDir: string;
  secretDir: string;
  modelsFile: string;
  calls: CallLog;
  version: string;
}): () => Promise<GatewayBackup> {
  return async () => {
    const files: GatewayBackupFile[] = [];
    const add = (path: string, file: string) => {
      try {
        if (statSync(file).isFile()) files.push(entry(path, readFileSync(file)));
      } catch {
        // missing: the gateway has not made it yet
      }
    };
    let names: string[] = [];
    try {
      names = readdirSync(options.secretDir)
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch {
      // no secret directory yet
    }
    for (const name of names) add(`secret/${name}`, join(options.secretDir, name));
    add("models.json", options.modelsFile);
    if (options.calls.backupTo) {
      // Beside the database, in the data volume: the root file system is read-only.
      const dir = mkdtempSync(join(options.dataDir, ".backup-"));
      try {
        const copy = join(dir, "calls.sqlite");
        await options.calls.backupTo(copy);
        files.push(entry("calls.sqlite", readFileSync(copy)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return { format: BACKUP_FORMAT, version: options.version, files };
  };
}
