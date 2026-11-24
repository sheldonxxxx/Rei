// Worker feeds: a surface shown with `feed: {session}` is live while that worker runs. Rei (not the model) writes the
// worker's progress into the surface's data model at the catalog's feed paths, at most once a second:
//   /status   waiting | running | done | failed | cancelled
//   /steps    the worker's latest tool calls as checklist items ({title, status})
//   /percent  100 once the worker is done (absent while running, so a bar moves without a number)
//   /summary  the worker's latest line
// Each write is a revision authored by the feed. When the worker ends, the final values are written and the feed is
// detached, so the surface goes from live to idle. Feeds are rows in SQLite so they survive a restart.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { A2UI_VERSION, type A2uiMessage } from "@rei/protocol";
import type { TreeManager } from "../pi/trees.ts";
import type { AppStore } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import { surfaceFallback } from "./fallback.ts";
import { applyMessage, pushRevision, SurfacesDoc, summarize } from "./model.ts";

const context = BACKGROUND_CONTEXT;
const MAX_STEPS = 8;
const TERMINAL: Record<string, string> = { completed: "done", failed: "failed", cancelled: "cancelled" };
const STEP_STATUS: Record<string, string> = {
  running: "running",
  ok: "done",
  error: "failed",
  blocked: "pending",
  not_executed: "skipped",
  cancelled: "skipped",
};

interface FeedRow {
  surface_id: string;
  owner_session_id: string;
  worker_session_id: string;
  tree_id: string;
  last_hash: string | null;
  written_at: number;
}

export interface FeedSnapshot {
  status: string;
  steps: { title: string; status: string }[];
  percent?: number;
  summary: string;
}

/** Records a feed (idempotent: a replayed show_surface call finds it). */
export function attachFeed(
  store: AppStore,
  row: { surfaceId: string; ownerSessionId: string; workerSessionId: string; treeId: string },
): void {
  store.db.run(
    "INSERT OR IGNORE INTO surface_feeds (surface_id, owner_session_id, worker_session_id, tree_id) VALUES (?, ?, ?, ?)",
    row.surfaceId,
    row.ownerSessionId,
    row.workerSessionId,
    row.treeId,
  );
}

/** Whether a worker session has ended (a feed on it is never attached, or is detached). */
export const workerEnded = (status: string): boolean => status in TERMINAL;

export class SurfaceFeeds {
  readonly #store: AppStore;
  readonly #trees: TreeManager;
  readonly #clock: Clock;
  readonly #intervalMs: number;
  #busy = false;

  /** `intervalMs`: the least time between two writes of one feed (the adapter's feed timer runs at the same rate). */
  constructor(deps: { store: AppStore; trees: TreeManager; clock: Clock; intervalMs: number }) {
    this.#store = deps.store;
    this.#trees = deps.trees;
    this.#clock = deps.clock;
    this.#intervalMs = deps.intervalMs;
  }

  /** What the feed writes now for a worker, or null when the worker is gone. */
  snapshot(workerSessionId: string): FeedSnapshot | null {
    const worker = this.#store.getSessionRow(workerSessionId);
    if (!worker || worker.deleted_at) return null;
    const ended = TERMINAL[worker.status];
    const status = ended ?? (worker.status === "running" ? "running" : "waiting");
    const rows = this.#store.db.all<{
      tool_name: string | null;
      activity: string | null;
      summary: string | null;
      status: string;
    }>(
      `SELECT s.tool_name, s.activity, s.summary,
              CASE WHEN s.status = 'running' AND a.status = 'pending' THEN 'pending' ELSE s.status END AS status
       FROM steps s LEFT JOIN approvals a ON a.id = s.approval_id
       WHERE s.session_id = ? AND s.type = 'tool.call' ORDER BY s.started_at DESC, s.id DESC LIMIT ?`,
      workerSessionId,
      MAX_STEPS,
    );
    const steps = rows.reverse().map((r) => ({
      title: (r.activity || r.summary || r.tool_name?.replaceAll("_", " ") || "A step").slice(0, 120),
      status: STEP_STATUS[r.status] ?? "pending",
    }));
    return {
      status,
      steps,
      ...(ended === "done" ? { percent: 100 } : {}),
      summary: (worker.preview ?? "").slice(0, 200),
    };
  }

  /** Writes every feed whose worker changed since its last write and whose second has passed; detaches ended ones. */
  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const rows = this.#store.db.all<FeedRow>("SELECT * FROM surface_feeds");
      for (const row of rows) await this.#write(row).catch(() => undefined);
    } finally {
      this.#busy = false;
    }
  }

  async #write(row: FeedRow): Promise<void> {
    const drop = () => this.#store.db.run("DELETE FROM surface_feeds WHERE surface_id = ?", row.surface_id);
    const owner = this.#store.getSessionRow(row.owner_session_id);
    const snap = this.snapshot(row.worker_session_id);
    if (!owner || owner.deleted_at) return void drop();
    const ended = !snap || snap.status in { done: 1, failed: 1, cancelled: 1 };
    const hash = JSON.stringify(snap);
    const now = this.#clock.now();
    if (hash === row.last_hash && !ended) return;
    if (!ended && now - row.written_at < this.#intervalMs) return;
    const tree = await this.#trees.open(row.tree_id);
    const conv = tree.session(row.owner_session_id)?.conv;
    if (!conv) return void drop();
    const kept = await conv.commit(async (tx) => {
      const doc = await tx.doc(SurfacesDoc, conv.id);
      const record = doc.surfaces[row.surface_id];
      if (!record || record.removed || !record.feed || record.sessionId !== row.owner_session_id) return false;
      const messages: A2uiMessage[] = [];
      if (snap)
        for (const key of ["status", "steps", "percent", "summary"] as const) {
          const value = snap[key];
          const before = record.dataModel[key];
          if (JSON.stringify(before) === JSON.stringify(value)) continue;
          if (value === undefined && before === undefined) continue;
          messages.push({
            version: A2UI_VERSION,
            updateDataModel: {
              surfaceId: record.surfaceId,
              path: `/${key}`,
              value: value === undefined ? null : value,
            },
          } as A2uiMessage);
        }
      if (messages.length > 0) {
        let content = { components: record.components, dataModel: record.dataModel };
        for (const m of messages) content = applyMessage(content, m);
        pushRevision(record, {
          revision: record.revision + 1,
          author: { kind: "feed", feed: "worker", sessionId: row.worker_session_id },
          at: now,
          summary: summarize(messages),
          messages,
        });
        record.dataModel = content.dataModel;
        record.fallback = surfaceFallback(record.title, record.components, record.dataModel);
        record.updatedAt = now;
      }
      if (ended) {
        delete record.feed;
        record.updatedAt = now;
      }
      return true;
    }, context);
    // A feed writes outside any run, often after the owner's tree went idle and its view stopped watching: say so.
    if (kept) this.#store.viewChanged(row.owner_session_id);
    if (!kept || ended) return void drop();
    this.#store.db.run(
      "UPDATE surface_feeds SET last_hash = ?, written_at = ? WHERE surface_id = ?",
      hash,
      now,
      row.surface_id,
    );
  }
}
