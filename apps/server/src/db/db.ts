// The app store's SQLite, behind a synchronous interface (node:sqlite today, Durable Object SQLite later).
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number };
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  /** Runs `fn` in a transaction (nested calls join the outer one); rolls back if it throws. */
  transaction<T>(fn: () => T): T;
  /** Folds the write-ahead log into the database file and empties it (after a purge, so deleted text is not left in it). */
  checkpoint?(): void;
  /** An online, consistent copy of the whole database in a new file, while writers carry on (SQLite's backup API). */
  backupTo?(path: string): Promise<void>;
  close(): void;
}
