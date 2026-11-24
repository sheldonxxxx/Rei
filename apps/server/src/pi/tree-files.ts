// Where a session tree lives on disk: `trees/<tree_id>/pi.sqlite` plus any per-tree sidecars (D29).
// Everything that touches the file system is behind this interface (implemented in src/node/).
export interface TreeFiles {
  dbPath(treeId: string): string;
  /** Creates the tree's own folder; throws if it already exists (ids are never reused). */
  create(treeId: string): void;
  exists(treeId: string): boolean;
  /** Live tree folders (not `.deleting-*`). */
  list(): string[];
  /** Removes a stray `-wal`/`-shm` that has no database next to it; SQLite would merge it into a new db. */
  cleanStrays(treeId: string): void;
  /** Renames the folder to `.deleting-<id>` (atomic, durable), then removes it. The tree must be closed. */
  deleteTree(treeId: string): void;
  /** Finishes deletions a crash left behind. Returns the ids it removed. */
  sweep(): string[];
  pendingDeletes(): string[];
}

export const DELETING_PREFIX = ".deleting-";
