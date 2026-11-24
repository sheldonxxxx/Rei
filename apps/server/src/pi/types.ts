import type { Storage } from "@earendil-works/pi-durable";

/** Opens Pi's storage over one SQLite file. The Node implementation lives in src/node/pi-storage.ts. */
export type PiStorageOpener = (dbPath: string) => Promise<Storage>;
