// Takeovers: you in control of a session's browser window. Rows are the record; the takeover messages in the chats,
// the session's `browser` and the global `takeover.upserted` event follow every change, in the same transaction.
import type { Takeover } from "@rei/protocol";
import { badRequest, HttpError, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { GLOBAL_STREAM } from "./events.ts";
import type { AppStore, SessionRow } from "./store.ts";

export interface TakeoverRow {
  seq: number;
  id: string;
  session_id: string;
  requested_by: string;
  reason: string | null;
  status: string;
  url: string | null;
  title: string | null;
  note: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  expires_at: number | null;
  notified_at: number | null;
}

export const toTakeover = (r: TakeoverRow): Takeover => ({
  id: r.id,
  sessionId: r.session_id,
  requestedBy: r.requested_by as Takeover["requestedBy"],
  reason: r.reason,
  status: r.status as Takeover["status"],
  url: r.url,
  title: r.title,
  note: r.note,
  createdAt: r.created_at,
  endedAt: r.ended_at,
});

export const MAX_NOTE_CHARS = 500;
const STATUS_WORD: Record<string, string> = {
  pending: "waiting for you",
  active: "you are in control",
  done: "done",
  cancelled: "cancelled",
};

/** Why an automatic cancel happened; stored as the note so the card and the agent can say it. */
export const CANCEL_EXPIRED = "The request expired.";
export const CANCEL_TIMED_OUT = "Timed out: no input for 15 minutes.";
export const CANCEL_CLOSED = "The browser window closed.";

export type ActKind = "navigate" | "click" | "select" | "type";

export class TakeoverStore {
  readonly app: AppStore;
  /** Called after a pending takeover is committed (the service arms its expiry timer). */
  onCreated: (() => void) | undefined;

  constructor(app: AppStore) {
    this.app = app;
  }

  get #db() {
    return this.app.db;
  }
  get #now(): number {
    return this.app.clock.now();
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  row(id: string): TakeoverRow | undefined {
    return this.#db.get<TakeoverRow>("SELECT * FROM takeovers WHERE id = ?", id);
  }
  get(id: string): Takeover | undefined {
    const r = this.row(id);
    return r ? toTakeover(r) : undefined;
  }
  /** The session's takeover that is pending or active (at most one). */
  openFor(sessionId: string): TakeoverRow | undefined {
    return this.#db.get<TakeoverRow>(
      "SELECT * FROM takeovers WHERE session_id = ? AND status IN ('pending', 'active') ORDER BY seq DESC LIMIT 1",
      sessionId,
    );
  }
  /** Pending and active takeovers in every live session, oldest first. */
  listOpen(): Takeover[] {
    return this.#db
      .all<TakeoverRow>(
        "SELECT t.* FROM takeovers t JOIN sessions s ON s.id = t.session_id WHERE t.status IN ('pending', 'active') AND s.deleted_at IS NULL ORDER BY t.seq",
      )
      .map(toTakeover);
  }
  activeRows(): TakeoverRow[] {
    return this.#db.all<TakeoverRow>("SELECT * FROM takeovers WHERE status = 'active' ORDER BY seq");
  }
  nextExpiry(): number | undefined {
    return (
      this.#db.get<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM takeovers WHERE status = 'pending'")?.at ??
      undefined
    );
  }
  /** Ended takeovers whose outcome the agent has not been told yet. */
  unnotified(): TakeoverRow[] {
    return this.#db.all<TakeoverRow>(
      "SELECT * FROM takeovers WHERE status IN ('done', 'cancelled') AND notified_at IS NULL ORDER BY seq",
    );
  }
  markNotified(id: string): void {
    this.#db.run("UPDATE takeovers SET notified_at = ? WHERE id = ?", this.#now, id);
  }

  /** The text of a takeover's message, the same in every chat that shows it. */
  messageText(t: Takeover): string {
    const what =
      t.requestedBy === "agent"
        ? `The assistant needs you in the browser${t.reason ? `: ${t.reason}` : ""}`
        : "You took over the browser";
    return `${what} (${STATUS_WORD[t.status] ?? t.status})${t.note && t.status !== "pending" ? `: ${t.note}` : ""}`;
  }

  // ---- create ------------------------------------------------------------------------------------------------------

  /**
   * An agent's request (pending until you start it) or your own takeover (active at once). When the session already has
   * an open takeover, that one is returned (`created` false): a repeated request does not stack cards.
   */
  create(input: {
    session: SessionRow;
    requestedBy: "agent" | "user";
    reason: string | null;
    url: string | null;
    title: string | null;
    runId: string | null;
    ttlMs: number;
  }): { takeover: Takeover; created: boolean } {
    const result = this.app.tx(() => {
      const open = this.openFor(input.session.id);
      if (open) return { takeover: toTakeover(open), created: false };
      const now = this.#now;
      const id = newId("tko", now);
      const status = input.requestedBy === "user" ? "active" : "pending";
      this.#db.run(
        `INSERT INTO takeovers (id, session_id, requested_by, reason, status, url, title, created_at, started_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.session.id,
        input.requestedBy,
        input.reason,
        status,
        input.url,
        input.title,
        now,
        status === "active" ? now : null,
        status === "pending" ? now + input.ttlMs : null,
      );
      const takeover = toTakeover(this.row(id)!);
      const text = this.messageText(takeover);
      this.app.addTakeoverMessage(input.session.id, input.runId, text, takeover);
      const parent =
        input.session.origin === "spawned" && input.session.parent_session_id
          ? this.app.getSessionRow(input.session.parent_session_id)
          : undefined;
      if (parent) this.app.addTakeoverMessage(parent.id, null, text, takeover);
      this.app.events.append(GLOBAL_STREAM, { type: "takeover.upserted", takeover });
      this.app.touchSession(input.session.id);
      if (parent) this.app.touchSession(parent.id);
      if (status === "pending")
        this.app.queueNotify({
          event: "takeover",
          sessionId: input.session.id,
          title: "Needs you in the browser",
          body: input.reason ?? "The assistant needs you in the browser.",
          dedupe: id,
        });
      return { takeover, created: true };
    });
    if (result.created && result.takeover.status === "pending") this.onCreated?.();
    return result;
  }

  // ---- transitions -------------------------------------------------------------------------------------------------

  #changed(row: TakeoverRow): Takeover {
    const takeover = toTakeover(this.row(row.id)!);
    this.app.updateTakeoverMessages(takeover, () => this.messageText(takeover));
    this.app.events.append(GLOBAL_STREAM, { type: "takeover.upserted", takeover });
    this.app.touchSession(row.session_id);
    const parentId = this.#db.get<{ parent_session_id: string | null }>(
      "SELECT parent_session_id FROM sessions WHERE id = ?",
      row.session_id,
    )?.parent_session_id;
    if (parentId) this.app.touchSession(parentId);
    return takeover;
  }

  /** pending to active (you pressed Take over on the agent's request). */
  start(id: string): Takeover {
    return this.app.tx(() => {
      const row = this.row(id);
      if (!row) throw notFound("That takeover does not exist.");
      if (row.status === "active") throw new HttpError(409, "already_active", "You are already in control.");
      if (row.status !== "pending") throw new HttpError(409, "not_open", "That takeover has ended.");
      if (row.expires_at !== null && row.expires_at <= this.#now) {
        this.#end(row, "cancelled", CANCEL_EXPIRED);
        throw new HttpError(409, "not_open", "That request has expired.");
      }
      this.#db.run(
        "UPDATE takeovers SET status = 'active', started_at = ?, expires_at = NULL WHERE id = ?",
        this.#now,
        id,
      );
      return this.#changed(row);
    });
  }

  #end(row: TakeoverRow, status: "done" | "cancelled", note: string | null, notified = false): Takeover {
    this.#db.run(
      "UPDATE takeovers SET status = ?, note = ?, ended_at = ?, expires_at = NULL, notified_at = ? WHERE id = ?",
      status,
      note,
      this.#now,
      notified ? this.#now : null,
      row.id,
    );
    return this.#changed(row);
  }

  /**
   * You finished (`done`) or gave up (`cancel`). A finished agent request starts a run for the agent in the same
   * transaction (idempotent by request id) so it carries on from the page as you left it.
   */
  end(
    id: string,
    action: "done" | "cancel",
    noteInput: string | undefined,
  ): { takeover: Takeover; runId: string | undefined } {
    if (action !== "done" && action !== "cancel") throw badRequest("bad_request", "action must be 'done' or 'cancel'.");
    if (noteInput !== undefined && typeof noteInput !== "string") throw badRequest("bad_request", "note must be text.");
    const note = noteInput?.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS) || null;
    return this.app.tx(() => {
      const row = this.row(id);
      if (!row) throw notFound("That takeover does not exist.");
      if (row.status !== "pending" && row.status !== "active")
        throw new HttpError(409, "not_open", "That takeover has already ended.");
      if (action === "done" && row.status === "pending") throw new HttpError(409, "not_open", "Take over first.");
      if (action === "done" && row.requested_by === "agent") {
        const takeover = this.#end(row, "done", note, true);
        const accepted = this.app.getSessionRow(row.session_id)
          ? this.app.queueAdmission({
              sessionId: row.session_id,
              requestId: `takeover:${row.id}`,
              role: "notice",
              text: note ? `You finished in the browser: ${note}` : "You finished in the browser.",
              modelText: finishedText(row, note),
            })
          : undefined;
        return { takeover, runId: accepted?.runId };
      }
      return { takeover: this.#end(row, action === "done" ? "done" : "cancelled", note), runId: undefined };
    });
  }

  /** Cancels a takeover for a reason of the app's (expired, idle timeout, window closed). Returns undefined when it is not open. */
  cancelAuto(id: string, reason: string): Takeover | undefined {
    return this.app.tx(() => {
      const row = this.row(id);
      if (!row || (row.status !== "pending" && row.status !== "active")) return undefined;
      return this.#end(row, "cancelled", reason);
    });
  }

  /** Expires every pending request past its time. */
  expireDue(): Takeover[] {
    return this.app.tx(() =>
      this.#db
        .all<TakeoverRow>("SELECT * FROM takeovers WHERE status = 'pending' AND expires_at <= ?", this.#now)
        .map((r) => this.#end(r, "cancelled", CANCEL_EXPIRED)),
    );
  }

  /** The sessions are being deleted: their open takeovers end as cancelled (nobody is told). */
  cancelForSessions(sessionIds: readonly string[]): Takeover[] {
    return this.app.tx(() => {
      const out: Takeover[] = [];
      for (const sid of sessionIds) {
        for (const row of this.#db.all<TakeoverRow>(
          "SELECT * FROM takeovers WHERE session_id = ? AND status IN ('pending', 'active')",
          sid,
        ))
          out.push(this.#end(row, "cancelled", CANCEL_CLOSED, true));
      }
      return out;
    });
  }

  // ---- acts --------------------------------------------------------------------------------------------------------

  /** What you did, never what you typed. */
  recordAct(takeoverId: string, kind: ActKind, detail: Record<string, unknown>): void {
    this.#db.run(
      "INSERT INTO takeover_acts (takeover_id, at, kind, detail) VALUES (?, ?, ?, ?)",
      takeoverId,
      this.#now,
      kind,
      JSON.stringify(detail),
    );
  }
  acts(takeoverId: string): { at: number; kind: ActKind; detail: Record<string, unknown> }[] {
    return this.#db
      .all<{ at: number; kind: string; detail: string }>(
        "SELECT at, kind, detail FROM takeover_acts WHERE takeover_id = ? ORDER BY seq",
        takeoverId,
      )
      .map((r) => ({ at: r.at, kind: r.kind as ActKind, detail: JSON.parse(r.detail) as Record<string, unknown> }));
  }
}

/** What the agent reads as the input of the run that follows a finished request. */
export function finishedText(row: Pick<TakeoverRow, "reason">, note: string | null): string {
  return `[Browser takeover finished] The user finished in the browser${note ? `: ${note}` : ""}. The page may have changed: call browser_snapshot to look at it again, then carry on with what you were doing${row.reason ? ` (you asked because: ${row.reason})` : ""}.`;
}
