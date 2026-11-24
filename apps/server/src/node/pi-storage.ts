// The one Node-only file that imports Pi: the SQLite storage opener (node:sqlite). Everything else about Pi lives in src/pi/.
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PiStorageOpener } from "../pi/types.ts";

export const openPiStorage: PiStorageOpener = (dbPath) => openNodeSqliteStorage(dbPath);
