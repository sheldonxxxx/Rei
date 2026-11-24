// A workspace belongs to an agent. Home chats, workers and forks use it across conversation-tree lifetimes.
import type { Db } from "../db/db.ts";
import type { Clock } from "../util/clock.ts";
import type { Logger } from "../util/log.ts";
import type { ExecBackend } from "./backend.ts";

interface PurgeRow {
  tree_id: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
}

export class WorkspaceManager {
  readonly #db: Db;
  readonly #backend: ExecBackend;
  readonly #clock: Clock;
  readonly #log: Logger;
  #running: Promise<void> | undefined;
  #again = false;
  #stopped = false;

  constructor(db: Db, backend: ExecBackend, clock: Clock, log: Logger) {
    this.#db = db;
    this.#backend = backend;
    this.#clock = clock;
    this.#log = log;
  }

  /** Records a directory id to purge (idempotent). */
  schedulePurge(treeId: string): void {
    this.#db.run(
      "INSERT OR IGNORE INTO workspace_purges (tree_id, created_at) VALUES (?, ?)",
      treeId,
      this.#clock.now(),
    );
  }

  /** A tree-scoped adapter: Pi still identifies conversations by tree, but their files belong to the agent. */
  forTree(treeId: string) {
    const row = this.#db.get<{ agent_id: string }>("SELECT agent_id FROM sessions WHERE tree_id = ? LIMIT 1", treeId);
    if (!row) throw new Error("The workspace's agent could not be found.");
    const agentId = row.agent_id;
    return {
      cwd: (_treeId: string) => this.#backend.cwd(agentId),
      env: (_treeId: string) => this.#backend.env(agentId),
      ready: (_treeId: string) => this.#backend.ready(agentId),
      reset: () => this.#backend.reset(),
    };
  }

  /** Records all directories before removing the agent's rows, so an unavailable sandbox can be retried after restart. */
  scheduleAgentPurge(agentId: string): void {
    this.schedulePurge(agentId);
  }

  pending(): { treeId: string; attempts: number }[] {
    return this.#db
      .all<PurgeRow>("SELECT * FROM workspace_purges ORDER BY created_at, tree_id")
      .map((r) => ({ treeId: r.tree_id, attempts: r.attempts }));
  }

  /** Tries every pending purge in the background (a run already going picks up what was added meanwhile). */
  kick(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await this.#runPending();
        } while (this.#again && !this.#stopped);
      } finally {
        this.#running = undefined;
      }
    })();
  }

  /** Resolves when the purges under way have finished. */
  async settled(): Promise<void> {
    while (this.#running) await this.#running;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 3_000);
    });
    await Promise.race([this.settled(), limit]);
    clearTimeout(timer);
  }

  async #runPending(): Promise<void> {
    for (const { treeId } of this.pending()) {
      if (this.#stopped) return;
      try {
        await this.#backend.purge(treeId);
        this.#db.run("DELETE FROM workspace_purges WHERE tree_id = ?", treeId);
        this.#log.info("workspace.purged", { treeId });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 200) : "error";
        try {
          this.#db.run(
            "UPDATE workspace_purges SET attempts = attempts + 1, last_error = ? WHERE tree_id = ?",
            message,
            treeId,
          );
        } catch {
          // the database is closing; the row stays for the next start
        }
        this.#log.warn("workspace.purge_failed", { treeId, error: error instanceof Error ? error.name : "error" });
      }
    }
  }
}
