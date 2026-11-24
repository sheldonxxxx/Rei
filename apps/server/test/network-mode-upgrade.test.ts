import { describe, expect, it } from "vitest";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";

// A version 18 agents table: the same columns as today, with the old sandbox network modes in its CHECK constraint.
const VERSION_18_AGENTS = `
CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        home_session_id TEXT,
        created_at INTEGER NOT NULL
      , default_profile TEXT NOT NULL DEFAULT 'standard', model TEXT, allowed_connector_ids TEXT, thinking_level TEXT NOT NULL DEFAULT 'off'
      CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
        network_mode TEXT NOT NULL DEFAULT 'off' CHECK (network_mode IN ('off', 'restricted', 'full')));
`;

describe("sandbox network mode upgrade", () => {
  it.each([
    { version: 18, modes: ["off", "restricted", "full"] },
    { version: 19, modes: ["ask", "whitelist", "any_site"] },
  ])("maps version $version modes and keeps every other agent field", ({ version, modes }) => {
    const db = openSqliteDb(":memory:");
    initializeDatabase(db);
    db.exec("DROP TABLE agents");
    db.exec(
      version === 18
        ? VERSION_18_AGENTS
        : VERSION_18_AGENTS.replace(
            "DEFAULT 'off' CHECK (network_mode IN ('off', 'restricted', 'full'))",
            "DEFAULT 'ask' CHECK (network_mode IN ('ask', 'whitelist', 'any_site'))",
          ),
    );
    db.exec(`PRAGMA user_version = ${version}`);
    for (const [id, mode] of [
      ["a_off", modes[0]!],
      ["a_restricted", modes[1]!],
      ["a_full", modes[2]!],
    ] as const)
      db.run(
        "INSERT INTO agents (id, name, avatar, instructions, created_at, thinking_level, network_mode) VALUES (?, ?, 'a', 'keep me', 7, 'high', ?)",
        id,
        id,
        mode,
      );

    expect(initializeDatabase(db)).toBe(false);

    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(20);
    expect(db.all<{ id: string; network_mode: string }>("SELECT id, network_mode FROM agents ORDER BY id")).toEqual([
      { id: "a_full", network_mode: "any" },
      { id: "a_off", network_mode: "block" },
      { id: "a_restricted", network_mode: "whitelist" },
    ]);
    expect(
      db.get<{ instructions: string; created_at: number; thinking_level: string }>(
        "SELECT instructions, created_at, thinking_level FROM agents WHERE id = 'a_off'",
      ),
    ).toEqual({ instructions: "keep me", created_at: 7, thinking_level: "high" });
  });

  it("refuses the old mode names after the upgrade", () => {
    const db = openSqliteDb(":memory:");
    initializeDatabase(db);
    expect(() =>
      db.run("INSERT INTO agents (id, name, avatar, created_at, network_mode) VALUES ('x', 'x', 'a', 0, 'restricted')"),
    ).toThrow();
    expect(() =>
      db.run("INSERT INTO agents (id, name, avatar, created_at, network_mode) VALUES ('y', 'y', 'a', 0, 'any')"),
    ).not.toThrow();
  });
});
