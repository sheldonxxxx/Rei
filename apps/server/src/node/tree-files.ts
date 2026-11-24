import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DELETING_PREFIX, type TreeFiles } from "../pi/tree-files.ts";

const DB_FILE = "pi.sqlite";

function fsyncDir(dir: string): void {
  // Makes a rename or unlink durable on Linux; best effort elsewhere.
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // not supported here
  }
}

export class NodeTreeFiles implements TreeFiles {
  readonly treesDir: string;
  constructor(dataDir: string) {
    this.treesDir = join(dataDir, "trees");
    mkdirSync(this.treesDir, { recursive: true });
  }
  #dir(treeId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(treeId)) throw new Error("invalid tree id");
    return join(this.treesDir, treeId);
  }
  dbPath(treeId: string): string {
    return join(this.#dir(treeId), DB_FILE);
  }
  create(treeId: string): void {
    mkdirSync(this.#dir(treeId), { recursive: false });
    fsyncDir(this.treesDir);
  }
  exists(treeId: string): boolean {
    return existsSync(this.#dir(treeId));
  }
  list(): string[] {
    return readdirSync(this.treesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(DELETING_PREFIX))
      .map((e) => e.name)
      .sort();
  }
  cleanStrays(treeId: string): void {
    const db = this.dbPath(treeId);
    if (existsSync(db)) return;
    for (const suffix of ["-wal", "-shm"]) rmSync(db + suffix, { force: true });
  }
  deleteTree(treeId: string): void {
    const dir = this.#dir(treeId);
    const doomed = join(this.treesDir, `${DELETING_PREFIX}${treeId}`);
    renameSync(dir, doomed);
    fsyncDir(this.treesDir);
    rmSync(doomed, { recursive: true, force: true });
    fsyncDir(this.treesDir);
  }
  pendingDeletes(): string[] {
    return readdirSync(this.treesDir).filter((n) => n.startsWith(DELETING_PREFIX));
  }
  sweep(): string[] {
    const finished: string[] = [];
    for (const name of this.pendingDeletes()) {
      rmSync(join(this.treesDir, name), { recursive: true, force: true });
      finished.push(name.slice(DELETING_PREFIX.length));
    }
    if (finished.length) fsyncDir(this.treesDir);
    return finished;
  }
}
