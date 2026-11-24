// The two things the backup service asks of the repository folder, answered with the file system.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BackupFolder } from "../backup/service.ts";

export const backupFolder: BackupFolder = {
  exists: (path) => existsSync(path),
  /** The total size of the files below `dir`, or null when it cannot be read. */
  bytes(dir) {
    let bytes = 0;
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) bytes += statSync(path).size;
      }
    };
    try {
      walk(dir);
    } catch {
      return null;
    }
    return bytes;
  },
};
