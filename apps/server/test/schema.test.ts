import { describe, expect, it } from "vitest";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";

describe("fresh Rei database", () => {
  it("creates the complete schema once and preserves installation time and data", () => {
    const db = openSqliteDb(":memory:");
    try {
      expect(initializeDatabase(db, () => 1234)).toBe(true);
      expect(db.get("SELECT value FROM meta WHERE key = 'installed_at'")).toEqual({ value: "1234" });
      db.run("INSERT INTO meta VALUES ('test', 'kept')");
      expect(initializeDatabase(db, () => 9999)).toBe(false);
      expect(db.get("SELECT value FROM meta WHERE key = 'test'")).toEqual({ value: "kept" });
      expect(db.all<{ name: string }>("PRAGMA table_info(agents)").map((c) => c.name)).toEqual(
        expect.arrayContaining(["model", "thinking_level"]),
      );
      expect(db.all<{ name: string }>("PRAGMA table_info(sessions)").map((c) => c.name)).toContain("pinned");
      expect(db.get("SELECT name FROM sqlite_master WHERE name = 'library_versions'")).toBeTruthy();
      expect(db.get("SELECT name FROM sqlite_master WHERE name = 'memory_review_jobs'")).toBeTruthy();
      // M12: the queue between "what is searchable changed" and "the search service knows about it".
      expect(db.all<{ name: string }>("PRAGMA table_info(retrieval_outbox)").map((c) => c.name)).toEqual(
        expect.arrayContaining(["entry_id", "point_id", "op", "seq", "attempts", "next_attempt_at", "last_error"]),
      );
      expect(() =>
        db.run("INSERT INTO retrieval_outbox(entry_id,op,seq,queued_at) VALUES (1,'reindex',1,1)"),
      ).toThrow();
      // The object store's ledger (M11): file bytes live in Garage, this is what says which ones are ready or owed a delete.
      expect(db.all<{ name: string }>("PRAGMA table_info(storage_objects)").map((c) => c.name)).toEqual(
        expect.arrayContaining([
          "id",
          "bucket",
          "object_key",
          "content_sha256",
          "state",
          "attempts",
          "next_attempt_at",
        ]),
      );
      expect(
        db.run(
          "INSERT INTO storage_objects(id,bucket,object_key,content_sha256,byte_length,state,created_at) VALUES ('o','rei-files','files/v1/o/aaa','aaa',1,'pending',1)",
        ).changes,
      ).toBe(1);
      expect(() =>
        db.run(
          "INSERT INTO storage_objects(id,bucket,object_key,content_sha256,byte_length,state,created_at) VALUES ('x','rei-files','k','a',1,'gone',1)",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  // The upgrade policy (docs/versioning.md#database-upgrades): a too-old or a newer database is refused untouched, and the
  // message names the way back instead of suggesting the data be thrown away.
  it.each([
    [1, /schema 1, older than this release upgrades \(18 to 20\).*releases in between.*restore a backup/],
    [5, /schema 5, older than this release upgrades/],
    [9, /schema 9, older than this release upgrades/],
    [10, /schema 10, older than this release upgrades/],
    [11, /schema 11, older/],
    [12, /schema 12, older/],
    [13, /schema 13, older/],
    [14, /schema 14, older/],
    [15, /schema 15, older/],
    [16, /schema 16, older/],
    [17, /schema 17, older than this release upgrades \(18 to 20\)/],
    [21, /written by a newer Rei \(schema 21; this release reads up to 20\).*does not downgrade.*restore the backup/],
    [99, /written by a newer Rei \(schema 99/],
  ])("refuses version %i without migrating or resetting it", (version, message) => {
    const db = openSqliteDb(":memory:");
    try {
      db.exec(
        `CREATE TABLE saved_data(value TEXT);INSERT INTO saved_data VALUES('kept');PRAGMA user_version=${version}`,
      );
      expect(() => initializeDatabase(db)).toThrow(message);
      expect(() => initializeDatabase(db)).toThrow(/docs\/storage\.md#backup-and-recovery.*Nothing was changed/);
      expect(db.get("SELECT value FROM saved_data")).toEqual({ value: "kept" });
      expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(version);
      expect(db.get("SELECT name FROM sqlite_master WHERE name='agents'")).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it("refuses an unrecognized populated database", () => {
    const db = openSqliteDb(":memory:");
    try {
      db.exec("CREATE TABLE saved_data(value TEXT);INSERT INTO saved_data VALUES('kept')");
      expect(() => initializeDatabase(db)).toThrow(/empty data directory/);
      expect(db.get("SELECT value FROM saved_data")).toEqual({ value: "kept" });
    } finally {
      db.close();
    }
  });
});

describe("Knowledge fresh-schema boundary", () => {
  it("refuses the earlier Knowledge shape without modifying or resetting the database", () => {
    const db = openSqliteDb(":memory:");
    try {
      initializeDatabase(db);
      db.run("INSERT INTO meta VALUES ('preserved', 'yes')");
      db.exec("ALTER TABLE knowledge_pages DROP COLUMN metadata_json");
      expect(() => initializeDatabase(db)).toThrow(/earlier Knowledge schema.*No automatic migration or reset/);
      expect(db.get("SELECT value FROM meta WHERE key = 'preserved'")).toEqual({ value: "yes" });
      expect(
        db.all<{ name: string }>("PRAGMA table_info(knowledge_pages)").some((c) => c.name === "metadata_json"),
      ).toBe(false);
    } finally {
      db.close();
    }
  });
});
