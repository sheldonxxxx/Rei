// The history index: which messages and tool-result chunks are searchable, the keyword side (FTS5), and the vector sets
// with their in-memory cache. Everything here is synchronous SQLite; embedding (async) is the worker's job, and the
// merge of the two rankings is fusion.ts. Idempotent throughout: it may be asked about the same message twice, after a
// restart, or long after the message was inserted.
import type { MessagePart, SessionReport, TaintLabel } from "@rei/protocol";
import type { BranchEntryRef } from "../conversation/branches.ts";
import type { Db } from "../db/db.ts";
import type { OutboxIntent, RetrievalOutbox } from "../retrieval/outbox.ts";
import { denseCollectionFor, type IndexEntryRow, pointIdOf } from "../retrieval/points.ts";
import { partsText } from "../surfaces/text.ts";
import type { Clock } from "../util/clock.ts";
import { blobToVector, CONTEXT_TOKENS, type EmbedderIdentity, identityKey } from "./embedder.ts";
import { ftsText, matchExpr } from "./keyword.ts";
import { chunkText } from "./text.ts";
import { VectorCache } from "./vectors.ts";

/** Tool results shorter than this are not worth an entry; longer than the cap are cut. */
export const TOOL_RESULT_MIN_CHARS = 40;
export const TOOL_RESULT_MAX_CHARS = 20_000;
/** Tools whose results are about memory or sessions, not about the world; indexing them would make search find itself. */
const SKIPPED_TOOLS = /^(search_history|history_context|read_chat|memory_.*|list_sessions)$/;

export type EntryKind = "user" | "assistant" | "report" | "tool";

export interface VectorSet {
  id: number;
  status: "active" | "building" | "retired";
  identity: EmbedderIdentity;
  remote: boolean;
  createdAt: number;
}
interface SetRow {
  identity: string;
  id: number;
  status: string;
  model: string;
  endpoint: string;
  quant: string;
  dims: number;
  pooling: string;
  doc_template: string;
  query_template: string;
  build: string;
  remote: number;
  created_at: number;
}
// Vector-set identities carry the semantic metadata needed to compare profiles.
function semanticMetadata(raw: string): Partial<EmbedderIdentity> {
  const key: unknown = JSON.parse(raw);
  if (
    Array.isArray(key) &&
    key.length === 9 &&
    (key[1] === null || typeof key[1] === "string") &&
    (key[2] === null || typeof key[2] === "string") &&
    Number.isInteger(key[8]) &&
    key[8] > 0
  )
    return {
      ...(key[1] !== null ? { repository: key[1] } : {}),
      ...(key[2] !== null ? { revision: key[2] } : {}),
      ...(key[8] !== CONTEXT_TOKENS ? { contextTokens: key[8] } : {}),
    };
  throw new Error("Invalid vector-set identity.");
}
const toSet = (r: SetRow): VectorSet => ({
  id: r.id,
  status: r.status as VectorSet["status"],
  identity: {
    model: r.model,
    endpoint: r.endpoint,
    quant: r.quant,
    dims: r.dims,
    pooling: r.pooling,
    docTemplate: r.doc_template,
    queryTemplate: r.query_template,
    build: r.build,
    ...semanticMetadata(r.identity),
  },
  remote: r.remote === 1,
  createdAt: r.created_at,
});

export interface SearchFilters {
  from?: number;
  to?: number;
  /** Only this agent's chats and sessions (default: every agent's). */
  agentId?: string;
}

/** An index entry as a search hit is made from it. */
export interface EntryRow {
  id: number;
  session_id: string;
  kind: EntryKind;
  tool_name: string | null;
  text: string;
  created_at: number;
  message_id: string;
  title: string;
  agent_id: string;
  taint: string;
}

/** One chat item to index (an input or a finished reply), as the conversation view shows it. */
export interface IndexableItem {
  /** The item id (`u:<runId>`, `a:<runId>`). */
  id: string;
  sessionId: string;
  runId: string | null;
  role: "user" | "assistant" | "report";
  text: string;
  parts?: MessagePart[];
  report?: SessionReport;
  /** Sent by another session (not your own words). */
  fromSessionId?: string;
  /** The Pi conversation of the session that holds it (a session has one per message version). */
  conversationId?: string;
  createdAt: number;
}

const ids = (list: readonly number[]): string => JSON.stringify(list);

/** The text of a report message as the index holds it: the title and outcome, then the summary. */
export function reportIndexText(report: SessionReport): string {
  return `${report.title} ${report.outcome}${report.summary.trim() === "" ? "" : `\n${report.summary}`}`;
}

/** The text of a tool result as the index holds it, or undefined when it is not indexed. */
export function indexableToolText(
  toolName: string,
  parts: readonly { type: string; text?: unknown }[],
): string | undefined {
  if (SKIPPED_TOOLS.test(toolName)) return undefined;
  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
  if (text.length < TOOL_RESULT_MIN_CHARS) return undefined;
  return text.length > TOOL_RESULT_MAX_CHARS ? text.slice(0, TOOL_RESULT_MAX_CHARS) : text;
}

export class HistoryIndex {
  readonly #db: Db;
  readonly #clock: Clock;
  /** When set, every change to what is searchable is queued here, in the same transaction as the change. */
  readonly outbox: RetrievalOutbox | undefined;
  #cache: { setId: number; cache: VectorCache } | undefined;

  constructor(db: Db, clock: Clock, outbox?: RetrievalOutbox) {
    this.#db = db;
    this.#clock = clock;
    this.outbox = outbox;
  }

  /** The entry as the retrieval index wants it, or nothing when it is hidden or its chat is deleted. */
  entryForRetrieval(entryId: number): IndexEntryRow | undefined {
    return this.entriesForRetrieval([entryId])[0];
  }

  /** The same, for a batch: an id with no row here is one the retrieval index must not have. */
  entriesForRetrieval(entryIds: readonly number[]): IndexEntryRow[] {
    if (entryIds.length === 0) return [];
    return this.#db.all<IndexEntryRow>(
      `SELECT e.id, e.session_id, e.message_id, e.kind, e.tool_name, e.pi_entry_id, e.chunk_index, e.text, e.created_at,
              s.agent_id
       FROM history_entries e JOIN sessions s ON s.id = e.session_id
       WHERE e.id IN (SELECT value FROM json_each(?)) AND e.hidden = 0 AND s.deleted_at IS NULL AND e.text <> ''`,
      ids(entryIds),
    );
  }

  /** The points these entries stood for, from the rows themselves (before they are hidden or deleted). */
  #intentsFor(entryIds: readonly number[]): OutboxIntent[] {
    if (entryIds.length === 0) return [];
    return this.#db
      .all<{
        id: number;
        session_id: string;
        message_id: string | null;
        pi_entry_id: string | null;
        chunk_index: number;
      }>(
        "SELECT id, session_id, message_id, pi_entry_id, chunk_index FROM history_entries WHERE id IN (SELECT value FROM json_each(?))",
        ids(entryIds),
      )
      .map((row) => ({ entryId: row.id, pointId: pointIdOf(row) }));
  }

  /** Queue recovery before creating collections, so a crash cannot leave empty indexes marked complete. */
  recoverRetrieval(collections: readonly string[], lexicalCollection: string): void {
    this.#db.transaction(() => {
      if (!collections.includes(lexicalCollection)) {
        const entries = this.#db.all<{ id: number }>("SELECT id FROM history_entries WHERE hidden = 0");
        this.outbox?.enqueueUpsert(this.#intentsFor(entries.map((e) => e.id)));
      }
      for (const set of this.#db.all<{ id: number }>("SELECT id FROM memory_vector_sets"))
        if (!collections.includes(denseCollectionFor(set.id))) this.resetCoverage(set.id);
    });
  }

  resetCoverage(setId: number): void {
    this.#db.run("DELETE FROM history_vectors WHERE set_id = ?", setId);
    if (this.#cache?.setId === setId) this.#cache = undefined;
  }

  /** Old tool IDs were local counters. Remove their points before durably scheduling their new identities. */
  legacyToolPointIds(): string[] {
    if (this.#db.get("SELECT 1 FROM meta WHERE key = 'retrieval_tool_namespace'")) return [];
    return this.#db
      .all<{ pi_entry_id: string; chunk_index: number }>(
        "SELECT DISTINCT pi_entry_id, chunk_index FROM history_entries WHERE kind = 'tool' AND pi_entry_id IS NOT NULL",
      )
      .map((e) => `t:${e.pi_entry_id}:${e.chunk_index}`);
  }

  finishToolNamespaceUpgrade(): void {
    if (this.#db.get("SELECT 1 FROM meta WHERE key = 'retrieval_tool_namespace'")) return;
    this.#db.transaction(() => {
      const entries = this.#db.all<{ id: number }>("SELECT id FROM history_entries WHERE kind = 'tool' AND hidden = 0");
      this.outbox?.enqueueUpsert(this.#intentsFor(entries.map((e) => e.id)));
      this.#db.run(
        "DELETE FROM history_vectors WHERE entry_id IN (SELECT id FROM history_entries WHERE kind = 'tool')",
      );
      this.#cache = undefined;
      this.#db.run("INSERT INTO meta (key, value) VALUES ('retrieval_tool_namespace', '1')");
    });
  }

  // ---- entries -----------------------------------------------------------------------------------------------------

  #insert(entry: {
    sessionId: string;
    messageId: string | null;
    runId: string | null;
    kind: EntryKind;
    toolName: string | null;
    piEntryId: string | null;
    chunkIndex: number;
    text: string;
    createdAt: number;
    hidden?: boolean;
    conversationId?: string | undefined;
  }): number | undefined {
    const row = this.#db.get<{ id: number }>(
      `INSERT INTO history_entries (session_id, message_id, run_id, kind, tool_name, pi_entry_id, chunk_index, text, created_at, hidden, pi_conversation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT pi_conversation_id FROM sessions WHERE id = ?))) ON CONFLICT DO NOTHING RETURNING id`,
      entry.sessionId,
      entry.messageId,
      entry.runId,
      entry.kind,
      entry.toolName,
      entry.piEntryId,
      entry.chunkIndex,
      entry.text,
      entry.createdAt,
      entry.hidden ? 1 : 0,
      entry.conversationId ?? null,
      entry.sessionId,
    );
    if (!row) return undefined;
    if (!entry.hidden) {
      this.#db.run("INSERT INTO history_fts (rowid, text) VALUES (?, ?)", row.id, ftsText(entry.text));
      this.outbox?.enqueueUpsert([
        {
          entryId: row.id,
          pointId: pointIdOf({
            session_id: entry.sessionId,
            message_id: entry.messageId,
            pi_entry_id: entry.piEntryId,
            chunk_index: entry.chunkIndex,
          }),
        },
      ]);
    }
    return row.id;
  }

  /** Indexes one chat item if it is not indexed yet. Returns the number of entries added. */
  indexItem(item: IndexableItem): number {
    const m = {
      id: item.id,
      session_id: item.sessionId,
      run_id: item.runId,
      role: item.role,
      text: item.text,
      created_at: item.createdAt,
      from_session_id: item.fromSessionId ?? null,
    };
    if (!this.#db.get("SELECT 1 AS x FROM sessions WHERE id = ? AND deleted_at IS NULL", m.session_id)) return 0;
    if (this.#db.get("SELECT 1 AS x FROM history_entries WHERE message_id = ? AND kind <> 'tool' LIMIT 1", m.id))
      return 0;
    let text = m.text;
    // A reply with components is indexed as text with each block as its fallback, never as the blocks' JSON.
    if (item.parts) {
      try {
        text = partsText(item.parts);
      } catch {
        // keep the text as written
      }
    }
    if (m.role === "report" && item.report) text = reportIndexText(item.report);
    // A message another session sent into this chat is not your own words.
    const kind: EntryKind =
      m.role === "assistant" ? "assistant" : m.role === "report" || m.from_session_id ? "report" : "user";
    return this.#db.transaction(() => {
      const chunks = chunkText(text);
      // Nothing to search in it: a hidden placeholder, so it is not looked at again.
      if (chunks.length === 0) {
        this.#insert({
          sessionId: m.session_id,
          messageId: m.id,
          runId: m.run_id,
          kind,
          toolName: null,
          piEntryId: null,
          chunkIndex: 0,
          text: "",
          createdAt: m.created_at,
          hidden: true,
          conversationId: item.conversationId,
        });
        return 0;
      }
      let added = 0;
      chunks.forEach((chunk, i) => {
        if (
          this.#insert({
            sessionId: m.session_id,
            messageId: m.id,
            runId: m.run_id,
            kind,
            toolName: null,
            piEntryId: null,
            chunkIndex: i,
            text: chunk,
            createdAt: m.created_at,
            conversationId: item.conversationId,
          }) !== undefined
        )
          added++;
      });
      return added;
    });
  }

  /** Indexes a tool result (already filtered by indexableToolText) as chunks linked to the run's reply. Idempotent per Pi entry. */
  addToolResult(input: {
    sessionId: string;
    runId: string | null;
    piEntryId: string;
    toolName: string;
    text: string;
    createdAt?: number;
    conversationId?: string;
  }): number {
    if (!this.#db.get("SELECT 1 AS x FROM sessions WHERE id = ? AND deleted_at IS NULL", input.sessionId)) return 0;
    const at = input.createdAt ?? this.#clock.now();
    return this.#db.transaction(() => {
      let added = 0;
      chunkText(input.text).forEach((chunk, i) => {
        if (
          this.#insert({
            sessionId: input.sessionId,
            messageId: null,
            runId: input.runId,
            kind: "tool",
            toolName: input.toolName,
            piEntryId: input.piEntryId,
            chunkIndex: i,
            text: chunk,
            createdAt: at,
            conversationId: input.conversationId,
          }) !== undefined
        )
          added++;
      });
      return added;
    });
  }

  /** Entries that can be found (the placeholders of empty messages are hidden). */
  countEntries(): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_entries WHERE hidden = 0")?.n ?? 0;
  }

  // ---- search: keyword side and hydration --------------------------------------------------------------------------

  #filterSql(f: SearchFilters): { sql: string; params: (number | string)[] } {
    let sql = "";
    const params: (number | string)[] = [];
    if (f.agentId !== undefined) {
      sql += " AND s.agent_id = ?";
      params.push(f.agentId);
    }
    if (f.from !== undefined) {
      sql += " AND e.created_at >= ?";
      params.push(f.from);
    }
    if (f.to !== undefined) {
      sql += " AND e.created_at <= ?";
      params.push(f.to);
    }
    return { sql, params };
  }

  /** Best-first entry ids by BM25 for the query (the same bigram split as the index), with hidden entries and deleted sessions left out. */
  keywordSearch(query: string, filters: SearchFilters = {}, limit = 50): number[] {
    const expr = matchExpr(query);
    if (expr === null) return [];
    const f = this.#filterSql(filters);
    return this.#db
      .all<{ id: number }>(
        `SELECT e.id AS id FROM history_fts JOIN history_entries e ON e.id = history_fts.rowid JOIN sessions s ON s.id = e.session_id
         WHERE history_fts MATCH ? AND e.hidden = 0 AND s.deleted_at IS NULL${f.sql}
         ORDER BY bm25(history_fts), e.id LIMIT ?`,
        expr,
        ...f.params,
        limit,
      )
      .map((r) => r.id);
  }

  /** Of these entry ids, the ones that may be returned (not hidden, session live, inside the dates), keeping their order. */
  validIds(candidates: readonly number[], filters: SearchFilters = {}): number[] {
    if (candidates.length === 0) return [];
    const f = this.#filterSql(filters);
    const ok = new Set(
      this.#db
        .all<{ id: number }>(
          `SELECT e.id AS id FROM history_entries e JOIN sessions s ON s.id = e.session_id
           WHERE e.id IN (SELECT value FROM json_each(?)) AND e.hidden = 0 AND s.deleted_at IS NULL${f.sql}`,
          ids(candidates),
          ...f.params,
        )
        .map((r) => r.id),
    );
    return candidates.filter((id) => ok.has(id));
  }

  /** The entries with what a hit needs: the chat's title and agent, its labels, and the message to open. */
  hydrate(entryIds: readonly number[]): Map<number, EntryRow> {
    const out = new Map<number, EntryRow>();
    if (entryIds.length === 0) return out;
    const rows = this.#db.all<EntryRow>(
      `SELECT e.id, e.session_id, e.kind, e.tool_name, e.text, e.created_at,
              COALESCE(e.message_id, CASE WHEN e.run_id IS NOT NULL THEN 'a:' || e.run_id END, '') AS message_id,
              s.title, s.agent_id, s.taint
       FROM history_entries e JOIN sessions s ON s.id = e.session_id
       WHERE e.id IN (SELECT value FROM json_each(?))`,
      ids(entryIds),
    );
    for (const r of rows) out.set(r.id, r);
    return out;
  }

  static taintOf(row: Pick<EntryRow, "taint">): TaintLabel[] {
    return JSON.parse(row.taint) as TaintLabel[];
  }

  // ---- vector sets -------------------------------------------------------------------------------------------------

  activeSet(): VectorSet | undefined {
    const r = this.#db.get<SetRow>("SELECT * FROM memory_vector_sets WHERE status = 'active' ORDER BY id DESC LIMIT 1");
    return r ? toSet(r) : undefined;
  }
  buildingSet(): VectorSet | undefined {
    const r = this.#db.get<SetRow>(
      "SELECT * FROM memory_vector_sets WHERE status = 'building' ORDER BY id DESC LIMIT 1",
    );
    return r ? toSet(r) : undefined;
  }
  setById(id: number): VectorSet | undefined {
    const r = this.#db.get<SetRow>("SELECT * FROM memory_vector_sets WHERE id = ?", id);
    return r ? toSet(r) : undefined;
  }

  createSet(identity: EmbedderIdentity, status: "active" | "building", remote: boolean): VectorSet {
    const row = this.#db.get<SetRow>(
      `INSERT INTO memory_vector_sets (status, identity, model, endpoint, quant, dims, pooling, doc_template, query_template, build, remote, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      status,
      identityKey(identity),
      identity.model,
      identity.endpoint,
      identity.quant,
      identity.dims,
      identity.pooling,
      identity.docTemplate,
      identity.queryTemplate,
      identity.build,
      remote ? 1 : 0,
      this.#clock.now(),
    )!;
    return toSet(row);
  }

  /** Drops a set and its vectors. */
  dropSet(id: number): void {
    this.#db.transaction(() => {
      this.#db.run("DELETE FROM history_vectors WHERE set_id = ?", id);
      this.#db.run("DELETE FROM memory_vector_sets WHERE id = ?", id);
    });
    if (this.#cache?.setId === id) this.#cache = undefined;
  }

  /** Reuse retained vectors after a configuration rollback, catching up before promotion. */
  retainedSet(identity: EmbedderIdentity): VectorSet | undefined {
    const row = this.#db.get<SetRow>(
      "SELECT * FROM memory_vector_sets WHERE status = 'retired' AND identity = ? ORDER BY id DESC LIMIT 1",
      identityKey(identity),
    );
    return row ? toSet(row) : undefined;
  }
  stageRetained(id: number): VectorSet {
    this.#db.run("UPDATE memory_vector_sets SET status = 'building' WHERE id = ? AND status = 'retired'", id);
    return this.setById(id)!;
  }

  /** The building set takes over; retain the previous set for rollback. */
  promote(buildingId: number): void {
    const old = this.activeSet();
    this.#db.transaction(() => {
      this.#db.run("UPDATE memory_vector_sets SET status = 'active' WHERE id = ?", buildingId);
      if (old && old.id !== buildingId) {
        this.#db.run("UPDATE memory_vector_sets SET status = 'retired' WHERE id = ?", old.id);
      }
    });
    this.#cache = undefined;
  }

  /** Entries without a vector in the set (newest first), that are not marked as unembeddable. The identity columns let
   * the worker name the point it writes, including for an entry that was deleted while its vector was computed. */
  pendingEntries(
    setId: number,
    limit: number,
  ): {
    id: number;
    session_id: string;
    text: string;
    message_id: string | null;
    pi_entry_id: string | null;
    chunk_index: number;
  }[] {
    return this.#db.all<{
      id: number;
      session_id: string;
      text: string;
      message_id: string | null;
      pi_entry_id: string | null;
      chunk_index: number;
    }>(
      `SELECT e.id, e.session_id, e.text, e.message_id, e.pi_entry_id, e.chunk_index FROM history_entries e
       WHERE e.hidden = 0 AND e.embed_failed = 0 AND NOT EXISTS (SELECT 1 FROM history_vectors v WHERE v.set_id = ? AND v.entry_id = e.id)
       ORDER BY e.id DESC LIMIT ?`,
      setId,
      limit,
    );
  }

  markEmbedFailed(entryId: number): void {
    this.#db.run("UPDATE history_entries SET embed_failed = 1 WHERE id = ?", entryId);
  }
  /** After a rebuild or a model change: give the entries that no model could embed another try. */
  clearEmbedFailures(): void {
    this.#db.run("UPDATE history_entries SET embed_failed = 0 WHERE embed_failed = 1");
  }

  /**
   * Stores vectors. An entry hidden or deleted while its vector was being computed is skipped, so a deleted text never
   * gets a vector. Returns how many were stored.
   */
  /** `vec` is the vector itself, and is only kept when Rei holds the vectors in SQLite; when the search service holds
   * them, the row records that this entry is embedded for this set and nothing more. */
  storeVectors(setId: number, vectors: { entryId: number; vec?: Uint8Array; vector?: Float32Array }[]): number {
    let stored = 0;
    this.#db.transaction(() => {
      for (const v of vectors) {
        const r = this.#db.run(
          `INSERT OR REPLACE INTO history_vectors (set_id, entry_id, vec)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM history_entries WHERE id = ? AND hidden = 0) AND EXISTS (SELECT 1 FROM memory_vector_sets WHERE id = ?)`,
          setId,
          v.entryId,
          v.vec ?? null,
          v.entryId,
          setId,
        );
        if (r.changes > 0) {
          stored++;
          if (v.vector && this.#cache?.setId === setId) this.#cache.cache.set(v.entryId, v.vector);
        }
      }
    });
    return stored;
  }

  /** How many entries have a vector in the set, and how many cannot be embedded. */
  coverage(setId: number): { entries: number; embedded: number; failed: number } {
    const entries = this.countEntries();
    const embedded =
      this.#db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM history_vectors v JOIN history_entries e ON e.id = v.entry_id WHERE v.set_id = ? AND e.hidden = 0",
        setId,
      )?.n ?? 0;
    const failed =
      this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_entries WHERE hidden = 0 AND embed_failed = 1")
        ?.n ?? 0;
    return { entries, embedded, failed };
  }

  /** The active set's vectors in memory (loaded on first use, kept in step by storeVectors and the removals). */
  activeCache(): { set: VectorSet; cache: VectorCache } | undefined {
    const set = this.activeSet();
    if (!set) return undefined;
    if (this.#cache?.setId !== set.id) {
      const cache = new VectorCache(set.identity.dims);
      for (const row of this.#db.all<{ entry_id: number; vec: Uint8Array }>(
        "SELECT entry_id, vec FROM history_vectors WHERE set_id = ?",
        set.id,
      )) {
        cache.set(row.entry_id, blobToVector(row.vec));
      }
      this.#cache = { setId: set.id, cache };
    }
    return { set, cache: this.#cache.cache };
  }

  // ---- removal -----------------------------------------------------------------------------------------------------

  /** Removes entries, their keyword rows and vectors (every set). Returns the vectors deleted. */
  #remove(entryIds: readonly number[]): number {
    if (entryIds.length === 0) return 0;
    const list = ids(entryIds);
    let vectors = 0;
    const intents = this.#intentsFor(entryIds);
    this.#db.transaction(() => {
      this.outbox?.enqueueDelete(intents);
      this.#db.run("DELETE FROM history_fts WHERE rowid IN (SELECT value FROM json_each(?))", list);
      vectors = this.#db.run(
        "DELETE FROM history_vectors WHERE entry_id IN (SELECT value FROM json_each(?))",
        list,
      ).changes;
      this.#db.run("DELETE FROM history_entries WHERE id IN (SELECT value FROM json_each(?))", list);
    });
    if (this.#cache) for (const id of entryIds) this.#cache.cache.delete(id);
    return vectors;
  }

  /**
   * FTS5 deletes leave tokens in old segments until they are merged; this rewrites the segments. Run after
   * purging, then checkpoint the WAL (secure_delete zeroes the freed pages).
   */
  optimize(): void {
    this.#db.exec("INSERT INTO history_fts (history_fts) VALUES ('optimize')");
  }

  /**
   * After a rewind or a version switch: the session's entries outside its active chain stop being searchable (keyword
   * rows, vectors and search-service points go, as for a hidden entry), and entries back in the chain are searchable
   * again (their vectors are computed anew). `branch_hidden` marks the rows hidden this way, so the placeholders of empty
   * messages, which are hidden for good, never come back. Returns how many rows changed each way.
   */
  setBranchVisibility(sessionId: string, visible: (row: BranchEntryRef) => boolean): { hidden: number; shown: number } {
    const rows = this.#db.all<BranchEntryRef & { id: number; text: string; hidden: number; branch_hidden: number }>(
      "SELECT id, run_id, pi_conversation_id, pi_entry_id, text, hidden, branch_hidden FROM history_entries WHERE session_id = ? AND (hidden = 0 OR branch_hidden = 1)",
      sessionId,
    );
    const hide = rows.filter((r) => r.hidden === 0 && !visible(r));
    const show = rows.filter((r) => r.branch_hidden === 1 && visible(r));
    if (hide.length === 0 && show.length === 0) return { hidden: 0, shown: 0 };
    const hideIds = hide.map((r) => r.id);
    this.#db.transaction(() => {
      if (hide.length > 0) {
        const list = ids(hideIds);
        this.outbox?.enqueueDelete(this.#intentsFor(hideIds));
        this.#db.run("DELETE FROM history_fts WHERE rowid IN (SELECT value FROM json_each(?))", list);
        this.#db.run("DELETE FROM history_vectors WHERE entry_id IN (SELECT value FROM json_each(?))", list);
        this.#db.run(
          "UPDATE history_entries SET hidden = 1, branch_hidden = 1 WHERE id IN (SELECT value FROM json_each(?))",
          list,
        );
      }
      if (show.length > 0) {
        const showIds = show.map((r) => r.id);
        this.#db.run(
          "UPDATE history_entries SET hidden = 0, branch_hidden = 0 WHERE id IN (SELECT value FROM json_each(?))",
          ids(showIds),
        );
        for (const r of show)
          this.#db.run("INSERT INTO history_fts (rowid, text) VALUES (?, ?)", r.id, ftsText(r.text));
        this.outbox?.enqueueUpsert(this.#intentsFor(showIds));
      }
    });
    if (this.#cache) for (const id of hideIds) this.#cache.cache.delete(id);
    return { hidden: hide.length, shown: show.length };
  }

  /** Delete integration: everything indexed from these sessions goes. Call inside the purge transaction. */
  purgeSession(sessionId: string): void {
    const entryIds = this.#db
      .all<{ id: number }>("SELECT id FROM history_entries WHERE session_id = ?", sessionId)
      .map((r) => r.id);
    this.#remove(entryIds);
  }

  /** The ids of the searchable entries whose text contains the phrase, case-insensitively (tests and diagnostics). */
  entriesContaining(phrase: string, limit = 100): number[] {
    // instr is the plain substring test; lower() folds ASCII only, so the phrase as typed is tried as well.
    return this.#db
      .all<{ id: number }>(
        `SELECT e.id FROM history_entries e JOIN sessions s ON s.id = e.session_id
         WHERE e.hidden = 0 AND s.deleted_at IS NULL AND (instr(lower(e.text), ?) > 0 OR instr(e.text, ?) > 0) ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
        phrase.toLowerCase(),
        phrase,
        limit,
      )
      .map((r) => r.id);
  }
}
