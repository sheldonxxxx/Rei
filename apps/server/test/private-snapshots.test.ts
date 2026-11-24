import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { NodePrivateSnapshots } from "../src/node/private-snapshots.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
function fixture() {
  dir = mkdtempSync(join(tmpdir(), "rei-snapshot-limits-"));
  mkdirSync(join(dir, "trees", "source"), { recursive: true });
  const db = new DatabaseSync(join(dir, "trees", "source", "pi.sqlite"));
  db.exec("PRAGMA journal_mode=WAL;CREATE TABLE probe(value TEXT);INSERT INTO probe VALUES('committed')");
  return { dir, db };
}
it("backs up live committed WAL state and erases the disposable store", async () => {
  const f = fixture();
  const snapshots = new NodePrivateSnapshots(f.dir);
  await snapshots.sweep();
  const started = performance.now();
  const copy = await snapshots.create("source", "probe", new AbortController().signal);
  const elapsedMs = Math.round(performance.now() - started);
  const restored = new DatabaseSync(copy.path, { readOnly: true });
  try {
    expect(restored.prepare("SELECT value FROM probe").get()).toEqual({ value: "committed" });
  } finally {
    restored.close();
    f.db.close();
  }
  console.info("snapshot_fixture", JSON.stringify({ bytes: statSync(copy.path).size, elapsedMs }));
  await copy.dispose();
  expect(readdirSync(snapshots.root)).toEqual([]);
});
it("rejects oversized snapshots and removes partial state", async () => {
  const f = fixture();
  f.db.close();
  const snapshots = new NodePrivateSnapshots(f.dir, { maxBytes: 1, timeoutMs: 3000 });
  await snapshots.sweep();
  await expect(snapshots.create("source", "large", new AbortController().signal)).rejects.toThrow(
    "SNAPSHOT_SIZE_LIMIT",
  );
  expect(readdirSync(snapshots.root)).toEqual([]);
});
it("bounds worker lifetime, honors cancellation and sweeps crash leftovers", async () => {
  const f = fixture();
  f.db.close();
  const snapshots = new NodePrivateSnapshots(f.dir, { maxBytes: 1024 * 1024, timeoutMs: 1 });
  await snapshots.sweep();
  await expect(snapshots.create("source", "timeout", new AbortController().signal)).rejects.toThrow("SNAPSHOT_TIMEOUT");
  const abort = new AbortController();
  abort.abort();
  await expect(snapshots.create("source", "cancelled", abort.signal)).rejects.toThrow();
  mkdirSync(join(snapshots.root, "crashed"));
  await snapshots.sweep();
  expect(readdirSync(snapshots.root)).toEqual([]);
});
