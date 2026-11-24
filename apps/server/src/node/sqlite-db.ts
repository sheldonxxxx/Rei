import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
import type { Db, SqlValue } from "../db/db.ts";

export function openSqliteDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // Deleted rows are overwritten with zeros, so a deleted session's text is not left in free pages.
  db.exec("PRAGMA secure_delete = ON");
  const cache = new Map<string, StatementSync>();
  let depth = 0;
  const stmt = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params: SqlValue[]) => {
      const statement = stmt(sql);
      // FTS5 can leave last_insert_rowid() outside JavaScript's safe integer range, even for a DELETE.
      // We only expose the change count; do not let conversion of that unused rowid fail a successful write.
      statement.setReadBigInts(true);
      try {
        return { changes: Number(statement.run(...params).changes) };
      } finally {
        statement.setReadBigInts(false);
      }
    },
    get: <T>(sql: string, ...params: SqlValue[]) => stmt(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: SqlValue[]) => stmt(sql).all(...params) as T[],
    transaction: <T>(fn: () => T): T => {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        throw error;
      } finally {
        depth--;
      }
    },
    checkpoint: () => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    backupTo: async (target) => {
      await backup(db, target);
    },
    close: () => {
      cache.clear();
      db.close();
    },
  };
}
