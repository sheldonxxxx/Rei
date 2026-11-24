// The profile docs: lines with a source and a confirmed date that the app keeps, every edit as a change (undoable), and
// suggestions for edits the agent may not make itself. The model and the Memory page both go through here, so the rules
// (length, budget, who may write what) are one set. Reads and writes are synchronous SQLite.
import {
  AGENT_MEMORY_TOKEN_BUDGET,
  type AgentId,
  MEMORY_LINE_MAX_CHARS,
  type MemoryChange,
  type MemoryDoc,
  type MemoryLine,
  type MemoryResponse,
  type MemorySuggestion,
  USER_MEMORY_TOKEN_BUDGET,
} from "@rei/protocol";
import { GLOBAL_STREAM } from "../store/events.ts";
import type { AppStore } from "../store/store.ts";
import { HttpError, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { memoryDocTokens } from "./format.ts";
import { looksSecret } from "./guard.ts";
import { reviewSource } from "./review-source.ts";
import type { ReviewAuthority, ReviewChange, ReviewResult } from "./review-types.ts";
import { lineId, parseLineId, type SuggestionRow, toSuggestion } from "./rows.ts";

const bad = (code: string, message: string) => new HttpError(code === "not_undoable" ? 409 : 400, code, message);

interface LineRow {
  seq: number;
  doc: string;
  agent_id: string | null;
  text: string;
  source_session_id: string | null;
  source_message_id: string | null;
  source_deleted: number;
  added_at: number;
  confirmed_at: number;
  updated_at: number;
  removed_at: number | null;
  source_title: string | null;
  source_live: number | null;
}
interface ChangeRow {
  seq: number;
  id: string;
  line_seq: number;
  doc: string;
  agent_id: string | null;
  op: string;
  before_text: string | null;
  after_text: string | null;
  by: string;
  session_id: string | null;
  at: number;
  undone_at: number | null;
  sealed: number;
  prior_confirmed_at: number | null;
  prior_source_session_id: string | null;
  prior_source_message_id: string | null;
}
const LINE_SELECT = `SELECT l.*, s.title AS source_title, CASE WHEN s.id IS NOT NULL AND s.deleted_at IS NULL THEN 1 ELSE 0 END AS source_live
  FROM memory_lines l LEFT JOIN sessions s ON s.id = l.source_session_id`;

/** A line is one line: whitespace runs collapse to a space. */
export const normaliseLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export interface Actor {
  by: "agent" | "user";
  sessionId: string | null;
  /** The message that started the run that wrote this (agent changes). */
  source?: { sessionId: string; messageId: string } | null;
  /** Where the "Memory updated" chip goes; absent: no chip (the Memory page, confirm). */
  chip?: { sessionId: string; runId: string | null };
  /** Calling-agent attribution retained for interactive callers; each document has its own independent cap. */
  agentOf?: AgentId;
}

export class MemoryLines {
  readonly #store: AppStore;

  constructor(store: AppStore) {
    this.#store = store;
  }
  get #db() {
    return this.#store.db;
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  #toLine(r: LineRow): MemoryLine {
    const live = r.source_session_id !== null && r.source_live === 1;
    return {
      id: lineId(r.seq),
      doc: r.doc as MemoryDoc,
      agentId: r.agent_id,
      text: r.text,
      source: live
        ? { sessionId: r.source_session_id!, messageId: r.source_message_id ?? "", sessionTitle: r.source_title ?? "" }
        : null,
      sourceDeleted: r.source_deleted === 1 || (r.source_session_id !== null && !live),
      addedAt: r.added_at,
      confirmedAt: r.confirmed_at,
      updatedAt: r.updated_at,
    };
  }
  #row(seq: number): LineRow | undefined {
    return this.#db.get<LineRow>(`${LINE_SELECT} WHERE l.seq = ?`, seq);
  }
  /** A line that exists (not removed), by the id the model sees. */
  line(id: string): MemoryLine | undefined {
    const seq = parseLineId(id);
    const r = seq === undefined ? undefined : this.#row(seq);
    return r && r.removed_at === null ? this.#toLine(r) : undefined;
  }
  lines(doc: MemoryDoc, agentId: AgentId | null): MemoryLine[] {
    const rows =
      doc === "profile"
        ? this.#db.all<LineRow>(`${LINE_SELECT} WHERE l.doc = 'profile' AND l.removed_at IS NULL ORDER BY l.seq`)
        : this.#db.all<LineRow>(
            `${LINE_SELECT} WHERE l.doc = 'agent' AND l.agent_id = ? AND l.removed_at IS NULL ORDER BY l.seq`,
            agentId ?? "",
          );
    return rows.map((r) => this.#toLine(r));
  }
  /** Estimated tokens of a doc's lines. */
  tokens(doc: MemoryDoc, agentId: AgentId | null): number {
    return memoryDocTokens(doc, this.lines(doc, agentId), this.#store.clock.now());
  }
  /**
   * What an agent sees in context: the profile and its own agent.md. Without an agent: the profile plus the largest
   * agent.md, the most any agent could carry.
   */
  usedTokens(agentId?: AgentId): number {
    const profile = this.tokens("profile", null);
    if (agentId !== undefined) return profile + this.tokens("agent", agentId);
    return profile + Math.max(0, ...this.#store.listAgents().map((a) => this.tokens("agent", a.id)));
  }

  revision(): number {
    return Number(this.#store.metaGet("memory_revision") ?? "0");
  }

  response(): MemoryResponse {
    return {
      profile: this.lines("profile", null),
      agents: this.#store.listAgents().map((a) => ({
        agentId: a.id,
        lines: this.lines("agent", a.id),
        usedTokens: this.tokens("agent", a.id),
        tokenBudget: AGENT_MEMORY_TOKEN_BUDGET,
      })),
      userUsedTokens: this.tokens("profile", null),
      userTokenBudget: USER_MEMORY_TOKEN_BUDGET,
      usedTokens: this.usedTokens(),
    };
  }

  #toChange(r: ChangeRow): MemoryChange {
    const later =
      r.undone_at === null &&
      r.sealed === 0 &&
      this.#db.get(
        "SELECT 1 AS x FROM memory_changes WHERE line_seq = ? AND seq > ? AND undone_at IS NULL LIMIT 1",
        r.line_seq,
        r.seq,
      ) === undefined;
    return {
      id: r.id,
      lineId: lineId(r.line_seq),
      doc: r.doc as MemoryDoc,
      agentId: r.agent_id,
      op: r.op as MemoryChange["op"],
      before: r.before_text,
      after: r.after_text,
      by: r.by as MemoryChange["by"],
      sessionId: r.session_id,
      at: r.at,
      undoneAt: r.undone_at,
      undoable: later,
    };
  }
  #changeRow(id: string): ChangeRow | undefined {
    return this.#db.get<ChangeRow>("SELECT * FROM memory_changes WHERE id = ?", id);
  }
  change(id: string): MemoryChange | undefined {
    const r = this.#changeRow(id);
    return r ? this.#toChange(r) : undefined;
  }
  /** A line's versions, oldest first. Includes a removed line (undo can bring it back). */
  changesOf(id: string): MemoryChange[] {
    const seq = parseLineId(id);
    if (seq === undefined || !this.#row(seq)) throw notFound("No such line.");
    return this.#db
      .all<ChangeRow>("SELECT * FROM memory_changes WHERE line_seq = ? ORDER BY seq", seq)
      .map((r) => this.#toChange(r));
  }

  // ---- validation --------------------------------------------------------------------------------------------------

  #text(raw: string): string {
    const text = normaliseLine(raw);
    if (text === "") throw bad("empty", "There is nothing to save.");
    if (text.length > MEMORY_LINE_MAX_CHARS)
      throw bad(
        "too_long",
        `A line is at most ${MEMORY_LINE_MAX_CHARS} characters; this one is ${text.length}. Make it shorter.`,
      );
    return text;
  }
  #agent(doc: MemoryDoc, agentId: AgentId | null | undefined): AgentId | null {
    if (doc === "profile") return null;
    if (!agentId || !this.#store.getAgent(agentId)) throw bad("unknown_agent", "No such agent.");
    return agentId;
  }
  /** Shortening or removing oversized data remains possible. */
  #budget(doc: MemoryDoc, agentId: AgentId | null, before: readonly MemoryLine[]): void {
    const used = this.tokens(doc, agentId);
    const prior = memoryDocTokens(doc, before, this.#store.clock.now());
    const limit = doc === "profile" ? USER_MEMORY_TOKEN_BUDGET : AGENT_MEMORY_TOKEN_BUDGET;
    if (used > prior && used > limit)
      throw bad(
        "over_budget",
        `Memory is full (${used} of ${limit} tokens). Replace or remove lines first, then try again.`,
      );
  }

  // ---- writes ------------------------------------------------------------------------------------------------------

  #record(
    line: LineRow,
    op: MemoryChange["op"],
    before: string | null,
    after: string | null,
    actor: Actor,
    prior: { confirmedAt: number; sourceSessionId: string | null; sourceMessageId: string | null },
  ): MemoryChange {
    const id = newId("mch", this.#store.clock.now());
    this.#db.run(
      `INSERT INTO memory_changes (id, line_seq, doc, agent_id, op, before_text, after_text, by, session_id, at, prior_confirmed_at, prior_source_session_id, prior_source_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      line.seq,
      line.doc,
      line.agent_id,
      op,
      before,
      after,
      actor.by,
      actor.sessionId,
      this.#store.clock.now(),
      prior.confirmedAt,
      prior.sourceSessionId,
      prior.sourceMessageId,
    );
    return this.change(id)!;
  }

  #announce(lineSeq: number): void {
    this.#store.metaSet("memory_revision", String(this.revision() + 1));
    this.#store.events.append(GLOBAL_STREAM, { type: "memory.changed", what: "lines" });
    this.#refreshChips(lineSeq);
  }

  /** The chip of every change of a line is rewritten: a later change (or an undo) changes whether Undo is offered. */
  #refreshChips(lineSeq: number): void {
    for (const r of this.#db.all<{ id: string }>(
      "SELECT id FROM memory_changes WHERE line_seq = ? ORDER BY seq",
      lineSeq,
    )) {
      const change = this.change(r.id)!;
      this.#store.updateMemoryMessages(r.id, { change }, chipText(change));
      for (const group of this.#db.all<{ ref_id: string; json: string }>(
        "SELECT ref_id,json FROM overlays WHERE kind='memory' AND EXISTS(SELECT 1 FROM json_each(json_extract(overlays.json,'$.review.changeIds')) WHERE value=?)",
        r.id,
      )) {
        const memory = JSON.parse(group.json) as {
          change: MemoryChange;
          review: { jobId: string; changeIds: string[]; undoneCount?: number };
        };
        memory.review.undoneCount = memory.review.changeIds.filter((id) => this.change(id)?.undoneAt != null).length;
        memory.change = this.change(memory.review.changeIds[0]!) ?? memory.change;
        this.#store.updateMemoryMessages(
          group.ref_id,
          memory,
          `Memory updated · ${memory.review.changeIds.length} changes · ${memory.review.undoneCount} undone`,
        );
      }
    }
  }

  #chip(change: MemoryChange, actor: Actor): void {
    if (!actor.chip) return;
    this.#store.addMemoryMessage(actor.chip.sessionId, actor.chip.runId, chipText(change), change.id, { change });
  }

  /** A new line. Errors: empty, too_long, over_budget, unknown_agent. */
  add(
    input: { doc: MemoryDoc; agentId?: AgentId | null; text: string },
    actor: Actor,
  ): { line: MemoryLine; change: MemoryChange } {
    return this.#store.tx(() => {
      const text = this.#text(input.text);
      const agentId = this.#agent(input.doc, input.agentId);
      const before = this.lines(input.doc, agentId);
      const now = this.#store.clock.now();
      this.#db.run(
        "INSERT INTO memory_lines (doc, agent_id, text, source_session_id, source_message_id, added_at, confirmed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        input.doc,
        agentId,
        text,
        actor.source?.sessionId ?? null,
        actor.source?.messageId ?? null,
        now,
        now,
        now,
      );
      const seq = this.#db.get<{ seq: number }>("SELECT last_insert_rowid() AS seq")!.seq;
      const row = this.#row(seq)!;
      this.#budget(input.doc, agentId, before);
      const change = this.#record(row, "add", null, text, actor, {
        confirmedAt: now,
        sourceSessionId: null,
        sourceMessageId: null,
      });
      this.#chip(change, actor);
      this.#announce(seq);
      return { line: this.#toLine(this.#row(seq)!), change: this.change(change.id)! };
    });
  }

  /** Replaces a line's text; also confirms it and takes the new source. Errors: not_found, empty, too_long, over_budget. */
  replace(id: string, rawText: string, actor: Actor): { line: MemoryLine; change: MemoryChange } {
    return this.#store.tx(() => {
      const seq = parseLineId(id);
      const row = seq === undefined ? undefined : this.#row(seq);
      if (!row || row.removed_at !== null) throw notFound("No such line.");
      const text = this.#text(rawText);
      const before = this.lines(row.doc as MemoryDoc, row.agent_id);
      const now = this.#store.clock.now();
      const change = this.#record(row, "replace", row.text, text, actor, {
        confirmedAt: row.confirmed_at,
        sourceSessionId: row.source_session_id,
        sourceMessageId: row.source_message_id,
      });
      // An edit by you in the Memory page has no source: it was not said in a chat.
      this.#db.run(
        "UPDATE memory_lines SET text = ?, confirmed_at = ?, updated_at = ?, source_session_id = ?, source_message_id = ?, source_deleted = 0 WHERE seq = ?",
        text,
        now,
        now,
        actor.source?.sessionId ?? null,
        actor.source?.messageId ?? null,
        row.seq,
      );
      this.#budget(row.doc as MemoryDoc, row.agent_id, before);
      this.#chip(change, actor);
      this.#announce(row.seq);
      return { line: this.#toLine(this.#row(row.seq)!), change: this.change(change.id)! };
    });
  }

  /** Removes a line (its row stays, so the removal can be undone). Errors: not_found. */
  remove(id: string, actor: Actor): { change: MemoryChange } {
    return this.#store.tx(() => {
      const seq = parseLineId(id);
      const row = seq === undefined ? undefined : this.#row(seq);
      if (!row || row.removed_at !== null) throw notFound("No such line.");
      const now = this.#store.clock.now();
      const change = this.#record(row, "remove", row.text, null, actor, {
        confirmedAt: row.confirmed_at,
        sourceSessionId: row.source_session_id,
        sourceMessageId: row.source_message_id,
      });
      this.#db.run("UPDATE memory_lines SET removed_at = ?, updated_at = ? WHERE seq = ?", now, now, row.seq);
      this.#chip(change, actor);
      this.#announce(row.seq);
      return { change: this.change(change.id)! };
    });
  }

  /** The fact was stated again: moves the confirmed date, nothing else. Errors: not_found. */
  confirm(id: string, actor: Actor): { line: MemoryLine; change: MemoryChange } {
    return this.#store.tx(() => {
      const seq = parseLineId(id);
      const row = seq === undefined ? undefined : this.#row(seq);
      if (!row || row.removed_at !== null) throw notFound("No such line.");
      const now = this.#store.clock.now();
      const before = this.lines(row.doc as MemoryDoc, row.agent_id);
      const change = this.#record(row, "confirm", row.text, row.text, actor, {
        confirmedAt: row.confirmed_at,
        sourceSessionId: row.source_session_id,
        sourceMessageId: row.source_message_id,
      });
      this.#db.run("UPDATE memory_lines SET confirmed_at = ? WHERE seq = ?", now, row.seq);
      this.#budget(row.doc as MemoryDoc, row.agent_id, before);
      this.#announce(row.seq);
      return { line: this.#toLine(this.#row(row.seq)!), change: this.change(change.id)! };
    });
  }

  /** Puts the line back as it was before the change. Errors: not_found, not_undoable, over_budget. */
  undo(changeId: string): { change: MemoryChange; line: MemoryLine | null } {
    return this.#store.tx(() => {
      const c = this.#changeRow(changeId);
      if (!c) throw notFound("No such change.");
      if (!this.#toChange(c).undoable)
        throw bad(
          "not_undoable",
          c.undone_at !== null
            ? "That change was already undone."
            : "A later change touched this line; undo that one first.",
        );
      const row = this.#row(c.line_seq)!;
      const before = this.lines(row.doc as MemoryDoc, row.agent_id);
      const now = this.#store.clock.now();
      if (c.op === "add") {
        this.#db.run("UPDATE memory_lines SET removed_at = ?, updated_at = ? WHERE seq = ?", now, now, c.line_seq);
      } else if (c.op === "remove") {
        this.#db.run("UPDATE memory_lines SET removed_at = NULL, updated_at = ? WHERE seq = ?", now, c.line_seq);
      } else if (c.op === "replace") {
        this.#db.run(
          "UPDATE memory_lines SET text = ?, confirmed_at = ?, updated_at = ?, source_session_id = ?, source_message_id = ? WHERE seq = ?",
          c.before_text ?? "",
          c.prior_confirmed_at ?? row.confirmed_at,
          now,
          c.prior_source_session_id,
          c.prior_source_message_id,
          c.line_seq,
        );
      } else {
        this.#db.run(
          "UPDATE memory_lines SET confirmed_at = ?, updated_at = ?, source_session_id = ?, source_message_id = ? WHERE seq = ?",
          c.prior_confirmed_at ?? row.confirmed_at,
          now,
          c.prior_source_session_id,
          c.prior_source_message_id,
          c.line_seq,
        );
      }
      this.#budget(row.doc as MemoryDoc, row.agent_id, before);
      this.#db.run("UPDATE memory_changes SET undone_at = ? WHERE id = ?", now, changeId);
      this.#announce(c.line_seq);
      const after = this.#row(c.line_seq)!;
      return { change: this.change(changeId)!, line: after.removed_at === null ? this.#toLine(after) : null };
    });
  }

  /** Whether an automatic review may touch a line. A user edit/confirmation/Undo permanently takes precedence. */
  reviewProtected(id: string): boolean {
    const seq = parseLineId(id);
    const row = seq === undefined ? undefined : this.#row(seq);
    return (
      !row ||
      row.source_session_id === null ||
      row.source_deleted === 1 ||
      this.#db.get(
        "SELECT 1 FROM memory_changes WHERE line_seq = ? AND (by = 'user' OR undone_at IS NOT NULL OR sealed = 1) LIMIT 1",
        seq!,
      ) !== undefined
    );
  }

  /** A restricted atomic batch. Authority and the revision come only from the private background job. */
  applyReviewChanges(authority: ReviewAuthority, raw: unknown): ReviewResult {
    const fail = (code: string): ReviewResult => ({
      ok: false,
      code,
      remaining: {
        user: Math.max(0, USER_MEMORY_TOKEN_BUDGET - this.tokens("profile", null)),
        agent: Math.max(0, AGENT_MEMORY_TOKEN_BUDGET - this.tokens("agent", authority.agentId)),
      },
    });
    try {
      return this.#store.tx(() => {
        if (authority.revision !== this.revision()) return fail("CAS_CONFLICT");
        if (!this.#store.getAgent(authority.agentId)) return fail("UNKNOWN_AGENT");
        if (
          authority.jobId &&
          !authority.validateSources &&
          !this.#db.get(
            "SELECT 1 FROM memory_review_jobs WHERE source_run_id = ? AND agent_id = ? AND status = 'running'",
            authority.jobId,
            authority.agentId,
          )
        )
          return fail("JOB_NOT_RUNNING");
        if (!Array.isArray(raw) || raw.length > 32) return fail("INVALID_FORMAT");
        const allowed = new Map(authority.sources.map((s) => [s.id, s]));
        // Recheck the exact words and provenance at commit time, including deletions during inference.
        if (authority.validateSources && !authority.validateSources()) return fail("STALE_SOURCE");
        for (const source of authority.validateSources ? [] : authority.sources) {
          const current = reviewSource(this.#store, source.runId);
          if (
            !current ||
            current.id !== source.id ||
            current.sessionId !== source.sessionId ||
            current.agentId !== authority.agentId ||
            current.text !== source.text
          )
            return fail("STALE_SOURCE");
        }
        const now = this.#store.clock.now();
        const before = [...this.lines("profile", null), ...this.lines("agent", authority.agentId)];
        const simulated = new Map(before.map((l) => [l.id, { ...l }]));
        const refs = new Set<string>();
        const changes: ReviewChange[] = [];
        let nextSeq = Math.max(
          this.#db.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM memory_lines")!.n,
          this.#db.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'memory_lines'")?.seq ?? 0,
        );
        for (const value of raw) {
          if (!value || typeof value !== "object" || Array.isArray(value)) return fail("INVALID_FORMAT");
          const c = value as ReviewChange;
          if (
            Object.keys(c).some((k) => !["op", "doc", "id", "text", "sourceMessageId"].includes(k)) ||
            !["add", "replace", "remove", "confirm"].includes(c.op) ||
            !["profile", "agent"].includes(c.doc)
          )
            return fail("INVALID_FORMAT");
          const source = allowed.get(c.sourceMessageId);
          if (!source || source.agentId !== authority.agentId) return fail("UNAUTHORIZED_SOURCE");
          if (looksSecret(source.text)) return fail("SECRET");
          const corrected = this.#db.get(
            "SELECT 1 FROM memory_changes WHERE (doc = 'profile' OR agent_id = ?) AND (by = 'user' OR undone_at IS NOT NULL) AND (at >= ? OR undone_at >= ?) LIMIT 1",
            authority.agentId,
            source.createdAt,
            source.createdAt,
          );
          const existing = typeof c.id === "string" ? simulated.get(c.id) : undefined;
          if (c.op === "add") {
            if (c.id !== undefined) return fail("INVALID_FORMAT");
          } else {
            if (!existing || existing.doc !== c.doc) return fail("INVALID_REFERENCE");
            if (refs.has(existing.id)) return fail("DUPLICATE_REFERENCE");
            refs.add(existing.id);
            if (this.reviewProtected(existing.id)) return fail("USER_PROTECTED");
          }
          if (corrected) return fail("USER_CORRECTION");
          if (c.op === "add" || c.op === "replace") {
            if (typeof c.text !== "string") return fail("INVALID_FORMAT");
            if (looksSecret(c.text)) return fail("SECRET");
            if (
              // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point of this check.
              /[\u0000-\u001f\u007f]/u.test(c.text) ||
              /<\/?(?:system|assistant|developer|tool|profile)>|ignore (?:all |the )?(?:previous|prior) instructions/iu.test(
                c.text,
              )
            )
              return fail("UNSAFE_TEXT");
            const text = normaliseLine(c.text);
            if (!text) return fail("EMPTY");
            if (text.length > MEMORY_LINE_MAX_CHARS) return fail("TOO_LONG");
            if (existing?.text === text) continue;
            const id = existing?.id ?? lineId(++nextSeq);
            simulated.set(id, {
              ...(existing ?? {
                id,
                doc: c.doc,
                agentId: c.doc === "agent" ? authority.agentId : null,
                addedAt: now,
                sourceDeleted: false,
              }),
              text,
              confirmedAt: now,
              updatedAt: now,
              source: { sessionId: source.sessionId, messageId: source.id, sessionTitle: "" },
            });
            changes.push({ ...c, text });
          } else {
            if (c.text !== undefined) return fail("INVALID_FORMAT");
            if (c.op === "remove") simulated.delete(existing!.id);
            else simulated.set(existing!.id, { ...existing!, confirmedAt: now, updatedAt: now });
            changes.push(c);
          }
        }
        const after = [...simulated.values()];
        // Evaluate duplicates in the final state: adding before removing an old duplicate is still an atomic move.
        if (
          changes.some(
            (c) =>
              (c.op === "add" || c.op === "replace") &&
              after.filter((l) => l.doc === c.doc && l.text === c.text).length > 1,
          )
        )
          return fail("DUPLICATE_TEXT");
        const user = memoryDocTokens(
          "profile",
          after.filter((l) => l.doc === "profile"),
          now,
        );
        const agent = memoryDocTokens(
          "agent",
          after.filter((l) => l.doc === "agent"),
          now,
        );
        const priorUser = memoryDocTokens(
          "profile",
          before.filter((l) => l.doc === "profile"),
          now,
        );
        const priorAgent = memoryDocTokens(
          "agent",
          before.filter((l) => l.doc === "agent"),
          now,
        );
        const remaining = {
          user: Math.max(0, USER_MEMORY_TOKEN_BUDGET - user),
          agent: Math.max(0, AGENT_MEMORY_TOKEN_BUDGET - agent),
        };
        if (
          (user > USER_MEMORY_TOKEN_BUDGET && user > priorUser) ||
          (agent > AGENT_MEMORY_TOKEN_BUDGET && agent > priorAgent)
        ) {
          return {
            ok: false,
            code: "OVER_BUDGET",
            requiredFreeTokens: {
              user: Math.max(0, user - USER_MEMORY_TOKEN_BUDGET),
              agent: Math.max(0, agent - AGENT_MEMORY_TOKEN_BUDGET),
            },
            remaining,
          };
        }
        // Validation is complete. This narrow path avoids intermediate-budget errors and publishes only at commit.
        const touched: number[] = [];
        for (const c of changes) {
          const source = allowed.get(c.sourceMessageId)!;
          const actor: Actor = {
            by: "agent",
            sessionId: source.sessionId,
            source: { sessionId: source.sessionId, messageId: source.id },
          };
          let row: LineRow;
          if (c.op === "add") {
            this.#db.run(
              "INSERT INTO memory_lines (doc, agent_id, text, source_session_id, source_message_id, added_at, confirmed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              c.doc,
              c.doc === "agent" ? authority.agentId : null,
              c.text!,
              source.sessionId,
              source.id,
              now,
              now,
              now,
            );
            row = this.#row(this.#db.get<{ seq: number }>("SELECT last_insert_rowid() AS seq")!.seq)!;
          } else row = this.#row(parseLineId(c.id!)!)!;
          this.#record(
            row,
            c.op,
            c.op === "add" ? null : row.text,
            c.op === "remove" ? null : (c.text ?? row.text),
            actor,
            {
              confirmedAt: row.confirmed_at,
              sourceSessionId: c.op === "add" ? null : row.source_session_id,
              sourceMessageId: c.op === "add" ? null : row.source_message_id,
            },
          );
          if (c.op === "remove")
            this.#db.run("UPDATE memory_lines SET removed_at = ?, updated_at = ? WHERE seq = ?", now, now, row.seq);
          else if (c.op !== "add")
            this.#db.run(
              "UPDATE memory_lines SET text = ?, confirmed_at = ?, updated_at = ?, source_session_id = ?, source_message_id = ? WHERE seq = ?",
              c.text ?? row.text,
              now,
              now,
              source.sessionId,
              source.id,
              row.seq,
            );
          touched.push(row.seq);
        }
        if (touched.length > 0) {
          this.#store.metaSet("memory_revision", String(this.revision() + 1));
          for (const seq of touched) this.#refreshChips(seq);
          this.#store.events.append(GLOBAL_STREAM, { type: "memory.changed", what: "lines" });
        }
        authority.commitOutcome?.(touched.length > 0);
        if (authority.jobId && !authority.commitOutcome)
          this.#db.run(
            "UPDATE memory_review_jobs SET status = 'done', finished_at = ?, diagnostic = NULL WHERE source_run_id = ?",
            now,
            authority.jobId,
          );
        return { ok: true, applied: touched.length > 0, revision: this.revision(), remaining };
      });
    } catch {
      // Never echo rejected memory, model arguments, other agents' lines, or SQL errors.
      return fail("WRITE_FAILED");
    }
  }

  // ---- suggestions -------------------------------------------------------------------------------------------------

  suggestion(id: string): MemorySuggestion | undefined {
    const r = this.#db.get<SuggestionRow>("SELECT * FROM memory_suggestions WHERE id = ?", id);
    return r ? toSuggestion(r) : undefined;
  }
  /** What a session proposed that has not gone out on a report yet. */
  pendingFor(sessionId: string): MemorySuggestion[] {
    return this.#db
      .all<SuggestionRow>(
        "SELECT * FROM memory_suggestions WHERE session_id = ? AND status = 'pending' ORDER BY seq",
        sessionId,
      )
      .map(toSuggestion);
  }

  /**
   * A run without the user proposes an edit. Nothing is applied: it goes out on the session's next report, to the agent
   * that started it. Same checks as a direct edit, except the budget (that is the writer's problem when it decides).
   * Errors: empty, too_long, unknown_agent, not_found.
   */
  suggest(input: {
    doc: MemoryDoc;
    agentId?: AgentId | null;
    op: "add" | "replace" | "remove";
    lineId?: string;
    text?: string;
    sessionId: string;
  }): MemorySuggestion {
    return this.#store.tx(() => {
      const agentId = this.#agent(input.doc, input.agentId);
      let line: LineRow | undefined;
      if (input.op !== "add") {
        const seq = parseLineId(input.lineId ?? "");
        line = seq === undefined ? undefined : this.#row(seq);
        if (!line || line.removed_at !== null) throw notFound("No such line.");
      }
      const text = input.op === "remove" ? null : this.#text(input.text ?? "");
      const id = newId("sug", this.#store.clock.now());
      this.#db.run(
        "INSERT INTO memory_suggestions (id, doc, agent_id, op, line_seq, current_text, text, session_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        id,
        input.doc,
        agentId ?? line?.agent_id ?? null,
        input.op,
        line?.seq ?? null,
        line?.text ?? null,
        text,
        input.sessionId,
        this.#store.clock.now(),
      );
      return this.suggestion(id)!;
    });
  }

  // ---- delete integration ------------------------------------------------------------------------------------------

  /** A chat is being deleted: lines it was the source of keep their text without the source; its suggestions go. Inside the purge transaction. */
  purgeSession(sessionId: string): void {
    this.#db.run(
      "UPDATE memory_lines SET source_session_id = NULL, source_message_id = NULL, source_deleted = 1 WHERE source_session_id = ?",
      sessionId,
    );
    this.#db.run(
      "UPDATE memory_changes SET session_id = NULL, prior_source_session_id = CASE WHEN prior_source_session_id = ? THEN NULL ELSE prior_source_session_id END, prior_source_message_id = CASE WHEN prior_source_session_id = ? THEN NULL ELSE prior_source_message_id END WHERE session_id = ? OR prior_source_session_id = ?",
      sessionId,
      sessionId,
      sessionId,
      sessionId,
    );
    this.#db.run("DELETE FROM memory_suggestions WHERE session_id = ?", sessionId);
  }
}

// ---- the plain text of a memory message (the PWA draws chips and cards from `memory`; this is the fallback) ---------------

export function chipText(c: MemoryChange): string {
  if (c.undoneAt !== null) return "Memory change undone";
  if (c.op === "remove") return `Memory removed: ${c.before ?? ""}`;
  if (c.op === "replace") return `Memory updated: ${c.before ?? ""} → ${c.after ?? ""}`;
  return `Memory updated: ${c.after ?? ""}`;
}
