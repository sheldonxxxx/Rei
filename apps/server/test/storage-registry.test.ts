// The object ledger: what SQLite remembers about the bytes it asked Garage to hold, including the part a try/catch
// cannot keep — that a delete still has to happen, possibly after a restart.
import { describe, expect, it } from "vitest";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { ObjectRegistry, ORPHAN_GRACE_MS } from "../src/storage/registry.ts";
import type { Clock } from "../src/util/clock.ts";

const start = 1_700_000_000_000;

function makeRegistry(): {
  db: ReturnType<typeof openSqliteDb>;
  registry: ObjectRegistry;
  now: () => number;
  advance: (ms: number) => void;
  owns: (objectId: string, sessionId?: string) => void;
  unowns: (objectId: string, sessionId?: string) => void;
} {
  const db = openSqliteDb(":memory:");
  initializeDatabase(db, () => start);
  let t = start;
  const clock: Clock = { now: () => t };
  const registry = new ObjectRegistry(db, clock);
  return {
    db,
    registry,
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    owns: (objectId, sessionId = "ses_1") => {
      db.run(
        "INSERT INTO attachments(id,session_id,name,media_type,size,object_id,created_at) VALUES (?,?,?,?,?,?,?)",
        `att_${objectId}_${sessionId}`,
        sessionId,
        "notes.txt",
        "text/plain",
        3,
        objectId,
        t,
      );
    },
    unowns: (objectId, sessionId) =>
      db.run(
        "DELETE FROM attachments WHERE object_id = ?" + (sessionId ? " AND session_id = ?" : ""),
        objectId,
        ...(sessionId ? [sessionId] : []),
      ),
  };
}

/** Any hex string of the right length: the ledger does not hash bytes, it only records which hash they must match. */
const shaFor = (id: string): string =>
  id
    .split("")
    .reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 0xffffff, 7)
    .toString(16)
    .padStart(6, "0")
    .repeat(11)
    .slice(0, 64);

const begin = (fixture: ReturnType<typeof makeRegistry>, id: string) =>
  fixture.registry.begin({ id, sha256: shaFor(id), byteLength: 12, bucket: "rei-files" });

describe("the object ledger", () => {
  it("records the intent to store before the bytes exist, and can only move forward from there", () => {
    const f = makeRegistry();
    try {
      const row = begin(f, "obj_a");
      expect(row).toMatchObject({ state: "pending", byte_length: 12, bucket: "rei-files", attempts: 0 });
      // The key is derived here, so a caller cannot put a file's name in it.
      expect(row.object_key).toBe(`files/v1/obj_a/${shaFor("obj_a")}`);
      expect(f.registry.counts()).toMatchObject({ pending: 1, ready: 0, deletePending: 0, readyBytes: 0 });
      f.registry.markReady("obj_a");
      expect(f.registry.row("obj_a")).toMatchObject({ state: "ready" });
      expect(f.registry.counts()).toMatchObject({ pending: 0, ready: 1, readyBytes: 12 });
    } finally {
      f.db.close();
    }
  });

  it("refuses to treat an object it has already given up on as ready again", () => {
    const f = makeRegistry();
    try {
      begin(f, "obj_b");
      f.registry.markReady("obj_b");
      f.registry.scheduleDelete("obj_b");
      expect(() => f.registry.markReady("obj_b")).toThrow(/scheduled for deletion/);
      // ...and a failed upload attempt that never got the object marked ready stays reclaimable, not ready.
      expect(f.registry.row("obj_b")!.state).toBe("delete_pending");
    } finally {
      f.db.close();
    }
  });

  it("hands an object to one worker at a time, and only when it is due", () => {
    const f = makeRegistry();
    try {
      begin(f, "obj_c");
      f.registry.markReady("obj_c");
      f.registry.scheduleDelete("obj_c");
      expect(f.registry.due(10).map((r) => r.id)).toEqual(["obj_c"]);
      expect(f.registry.claim("obj_c")).toBe(true);
      // A second worker, or the same one again, gets nothing: the lease is held and the object is not due.
      expect(f.registry.claim("obj_c")).toBe(false);
      expect(f.registry.due(10)).toEqual([]);
      expect(f.registry.row("obj_c")!.attempts).toBe(1);
      f.registry.requeue("obj_c", new Error("garage unreachable"));
      expect(f.registry.row("obj_c")).toMatchObject({ state: "delete_pending", attempts: 1 });
      expect(f.registry.row("obj_c")!.next_attempt_at).toBeGreaterThan(f.now());
      expect(f.registry.counts()).toMatchObject({ deletePending: 1, lastError: "garage unreachable" });
    } finally {
      f.db.close();
    }
  });

  it("backs off further with each failed attempt, and never gives up on the intent", () => {
    const f = makeRegistry();
    try {
      begin(f, "obj_d");
      f.registry.scheduleDelete("obj_d");
      const waits: number[] = [];
      for (let attempt = 0; attempt < 8; attempt++) {
        f.advance(3_600_001);
        expect(f.registry.claim("obj_d")).toBe(true);
        f.registry.requeue("obj_d", new Error(`try ${attempt}`));
        waits.push(f.registry.row("obj_d")!.next_attempt_at - f.now());
      }
      // Growing, then flat: it keeps trying, and stays countable the whole time.
      expect(waits[0]).toBeLessThanOrEqual(waits[1]!);
      expect(waits[6]).toBe(waits[7]);
      expect(f.registry.row("obj_d")!.attempts).toBe(8);
      expect(f.registry.counts().deletePending).toBe(1);
    } finally {
      f.db.close();
    }
  });

  it("finishes a delete only when the service confirms it, and remembers that it did", () => {
    const f = makeRegistry();
    try {
      begin(f, "obj_e");
      f.registry.markReady("obj_e");
      f.owns("obj_e");
      f.registry.scheduleDelete("obj_e");
      f.registry.claim("obj_e");
      f.registry.markDeleted("obj_e");
      expect(f.registry.row("obj_e")).toMatchObject({ state: "deleted", next_attempt_at: 0, last_error: null });
      expect(f.registry.due(10)).toEqual([]);
      expect(f.registry.counts()).toMatchObject({ ready: 0, deletePending: 0 });
    } finally {
      f.db.close();
    }
  });

  it("owns an object while a chat names it, and reclaims the bytes the moment nothing does", () => {
    const f = makeRegistry();
    try {
      begin(f, "obj_f");
      f.registry.markReady("obj_f");
      f.advance(ORPHAN_GRACE_MS * 2);
      // Owned: an upload whose attachment row survived is not an orphan, however old it is.
      f.owns("obj_f");
      expect(f.registry.reclaimOrphans()).toBe(0);
      f.unowns("obj_f");
      expect(f.registry.reclaimOrphans()).toBe(1);
      expect(f.registry.row("obj_f")!.state).toBe("delete_pending");
    } finally {
      f.db.close();
    }
  });

  it("leaves an upload in flight alone, and reclaims one that was abandoned", () => {
    const f = makeRegistry();
    try {
      begin(f, "obj_live");
      begin(f, "obj_dead");
      f.registry.markReady("obj_dead");
      f.advance(ORPHAN_GRACE_MS / 2);
      // Nothing is old enough yet, including the row whose upload never finished.
      expect(f.registry.reclaimOrphans()).toBe(0);
      expect(f.registry.counts()).toMatchObject({ pending: 1, ready: 1 });
      f.advance(ORPHAN_GRACE_MS);
      expect(f.registry.reclaimOrphans()).toBe(2);
      expect(f.registry.counts()).toMatchObject({ pending: 0, ready: 0, deletePending: 2 });
    } finally {
      f.db.close();
    }
  });

  it("gives an object two owners when two chats hold it, and only reclaims it when both let go", () => {
    const f = makeRegistry();
    try {
      begin(f, "obj_shared");
      f.registry.markReady("obj_shared");
      f.owns("obj_shared", "ses_1");
      f.owns("obj_shared", "ses_2");
      f.advance(ORPHAN_GRACE_MS * 2);
      // One chat deleted: the other still reads this file, so its bytes must stay.
      f.unowns("obj_shared", "ses_1");
      expect(f.registry.reclaimOrphans()).toBe(0);
      f.unowns("obj_shared", "ses_2");
      expect(f.registry.reclaimOrphans()).toBe(1);
    } finally {
      f.db.close();
    }
  });

  it("keeps deleted history for the counts, so a restart cannot lose track of an unfinished delete", () => {
    const f = makeRegistry();
    try {
      begin(f, "obj_restart");
      f.registry.markReady("obj_restart");
      f.registry.scheduleDelete("obj_restart");
      const rows = f.registry.due(10);
      // A new process (a new registry over the same file) sees the same owed work.
      const reopened = new ObjectRegistry(f.db, { now: () => start });
      expect(reopened.due(10).map((r) => r.id)).toEqual(["obj_restart"]);
      expect(rows).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
});
