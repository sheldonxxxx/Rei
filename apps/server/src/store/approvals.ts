// Approvals, grants and the demo connector's effect log, in the app store (D28). Rows are the record; the approval
// messages in the chats and the global `approval.upserted` event follow every change, in the same transaction.
import type {
  ActionClass,
  Approval,
  ApprovalStatus,
  DecideApprovalGroupRequest,
  Grant,
  GrantLength,
  TaintLabel,
} from "@rei/protocol";
import { badRequest, HttpError, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { GLOBAL_STREAM } from "./events.ts";
import type { AppStore, SessionRow } from "./store.ts";

export interface ApprovalRow {
  seq: number;
  id: string;
  session_id: string;
  session_title: string;
  agent_id: string;
  run_id: string | null;
  run_assigned_by: string | null;
  tool: string;
  args_json: string;
  args_hash: string;
  connector: string;
  operation: string;
  action_class: string;
  destination: string | null;
  summary: string;
  args_preview: string;
  taint: string;
  lengths: string;
  status: string;
  grant_length: string | null;
  grant_expires_at: number | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  once_expires_at: number | null;
  consumed_by: string | null;
  consumed_at: number | null;
  notified_at: number | null;
  preview_json: string | null;
  group_id: string | null;
  tool_call_id: string | null;
  tool_task_id: string | null;
  execution: Exclude<Approval["execution"], "interrupted" | undefined> | null;
  execution_interrupted: number;
  parent_call_id: string | null;
  cancel_reason: NonNullable<Approval["cancelReason"]> | null;
}
export interface ApprovalDraft {
  session: SessionRow;
  runId: string | null;
  assignedBy: string | null;
  tool: string;
  args: unknown;
  argsHash: string;
  connector: string;
  operation: string;
  actionClass: ActionClass;
  destination: string | null;
  summary: string;
  argsPreview: string;
  /** What a configure card shows. */
  preview?: Approval["preview"];
  taint: readonly TaintLabel[];
  lengths: readonly GrantLength[];
  ttlMs: number;
  group?: { id: string; callId: string; count: number };
  taskId?: string;
  /** A script's nested call (with `taskId`): the `codemode` call that made it. */
  parentCallId?: string;
}

interface GrantRow {
  id: string;
  connector: string;
  operation: string;
  destination: string | null;
  length: string;
  session_id: string | null;
  agent_id: string | null;
  expires_at: number | null;
  approval_id: string;
  created_at: number;
  revoked_at: number | null;
}

export const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  number: r.seq,
  sessionId: r.session_id,
  sessionTitle: r.session_title,
  agentId: r.agent_id,
  tool: r.tool,
  connector: r.connector,
  operation: r.operation,
  actionClass: r.action_class as ActionClass,
  destination: r.destination,
  summary: r.summary,
  argsPreview: r.args_preview,
  ...(r.preview_json ? { preview: JSON.parse(r.preview_json) as NonNullable<Approval["preview"]> } : {}),
  taint: JSON.parse(r.taint) as TaintLabel[],
  lengths: JSON.parse(r.lengths) as GrantLength[],
  status: r.status as ApprovalStatus,
  ...(r.group_id ? { groupId: r.group_id } : {}),
  ...(r.tool_task_id ? { resumesTool: true } : {}),
  ...(r.parent_call_id ? { parentCallId: r.parent_call_id } : {}),
  ...(r.cancel_reason ? { cancelReason: r.cancel_reason } : {}),
  ...(r.execution ? { execution: r.execution_interrupted ? "interrupted" : r.execution } : {}),
  ...(r.grant_length ? { grantLength: r.grant_length as GrantLength } : {}),
  ...(r.grant_expires_at !== null ? { grantExpiresAt: r.grant_expires_at } : {}),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
});
const toGrant = (r: GrantRow): Grant => ({
  id: r.id,
  connector: r.connector,
  operation: r.operation,
  destination: r.destination,
  length: r.length as Grant["length"],
  sessionId: r.session_id,
  agentId: r.agent_id,
  expiresAt: r.expires_at,
  approvalId: r.approval_id,
  createdAt: r.created_at,
});

export const HOUR_MS = 3_600_000;
export const MAX_GRANT_HOURS = 168;

export function resumesTool(row: ApprovalRow): boolean {
  return row.group_id !== null || row.tool_task_id !== null;
}

/** Each decided approval (or group of grouped reads) of the runs that waited for a person: when it was asked and decided. */
const APPROVAL_WAITS = `SELECT run_id, MIN(created_at) AS asked, MAX(decided_at) AS decided FROM approvals
       WHERE run_id IN (SELECT value FROM json_each(?)) AND (group_id IS NOT NULL OR tool_task_id IS NOT NULL)
       GROUP BY run_id, COALESCE(group_id, id) HAVING COUNT(*) = COUNT(decided_at)`;

export function approvalWaitTimes(db: AppStore["db"], runIds: readonly string[]): Map<string, number> {
  if (!runIds.length) return new Map();
  const rows = db.all<{ run_id: string; ms: number }>(
    `SELECT run_id, SUM(decided - asked) AS ms FROM (${APPROVAL_WAITS}) GROUP BY run_id`,
    JSON.stringify(runIds),
  );
  return new Map(rows.map(({ run_id, ms }) => [run_id, ms]));
}

/** The spans one run's calls waited for a person to decide an approval, as [asked, decided] pairs. */
export function approvalWaitSpans(db: AppStore["db"], runId: string): [number, number][] {
  return db
    .all<{ asked: number; decided: number }>(APPROVAL_WAITS, JSON.stringify([runId]))
    .map(({ asked, decided }) => [asked, decided]);
}

/**
 * After the retry the agent carries on with its task: an approval can pause a longer piece of work (a worker's research),
 * and ending the turn there would hand back the retry's outcome, or its failure, as the result. No colon before the call:
 * the faux model reads the call after the first one.
 */
const AFTER_RETRY =
  "then carry on with what you were doing before the approval. If that call was the whole request, tell the user in one short sentence how it went. If it fails, work around the failure within the rules instead of stopping";

/** What the agent is told when an approval is granted: the call to make again, or for network access the command to run again. */
export function approvedText(n: number, row: Pick<ApprovalRow, "tool" | "args_json">): string {
  const network = networkArgs(row);
  if (network)
    return `[Approval #${n} approved] Network access to ${network.host} is allowed now. Run the command that needed it again, ${AFTER_RETRY}: ${network.command}`;
  return `[Approval #${n} approved] Make exactly this call again now, ${AFTER_RETRY}: ${row.tool} ${row.args_json}`;
}

/** The host and bash command of a network approval (tool "network"); undefined for any other approval. */
export function networkArgs(
  row: Pick<ApprovalRow, "tool" | "args_json">,
): { host: string; command: string } | undefined {
  if (row.tool !== "network") return undefined;
  try {
    const args = JSON.parse(row.args_json) as { host?: unknown; command?: unknown };
    if (typeof args.host === "string")
      return { host: args.host, command: typeof args.command === "string" ? args.command : "" };
  } catch {
    // fall through to the generic text
  }
  return undefined;
}

const STATUS_WORD: Record<string, string> = {
  pending: "waiting for you",
  approved: "approved",
  denied: "denied",
  expired: "expired",
  cancelled: "cancelled",
};
/** What a card says instead of "cancelled" when it was withdrawn for a reason other than the user. */
const CANCEL_WORD: Record<NonNullable<Approval["cancelReason"]>, string> = {
  script_ended: "withdrawn: the script that asked for this ended",
};

export class ApprovalStore {
  readonly app: AppStore;
  /** Called after a new pending approval is committed (the service arms its expiry timer). */
  onCreated: (() => void) | undefined;
  /** Set by triggers: approving with the length "trigger" adds the call to the allow list of the trigger the session is a run of (inside the approval's transaction). */
  onTriggerAllow: ((triggerId: string, entry: { tool: string; destination?: string }) => void) | undefined;

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

  row(id: string): ApprovalRow | undefined {
    return this.#db.get<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", id);
  }
  get(id: string): Approval | undefined {
    const r = this.row(id);
    return r ? toApproval(r) : undefined;
  }
  /** The short per-user number the agent and the cards use ("#3"). */
  numberOf(id: string): number | undefined {
    return this.row(id)?.seq;
  }
  /** Pending approvals in every live session, oldest first. */
  listPending(): Approval[] {
    return this.#db
      .all<ApprovalRow>(
        "SELECT a.* FROM approvals a JOIN sessions s ON s.id = a.session_id WHERE a.status = 'pending' AND s.deleted_at IS NULL ORDER BY a.seq",
      )
      .map(toApproval);
  }
  pendingForSession(sessionId: string): Approval[] {
    return this.#db
      .all<ApprovalRow>("SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY seq", sessionId)
      .map(toApproval);
  }
  nextExpiry(): number | undefined {
    return (
      this.#db.get<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM approvals WHERE status = 'pending'")?.at ??
      undefined
    );
  }
  /** Denied or expired approvals whose outcome the agent has not been told yet. */
  unnotified(): ApprovalRow[] {
    return this.#db.all<ApprovalRow>(
      "SELECT * FROM approvals WHERE status IN ('denied', 'expired') AND notified_at IS NULL AND group_id IS NULL AND tool_task_id IS NULL ORDER BY seq",
    );
  }
  markNotified(id: string): void {
    this.#db.run("UPDATE approvals SET notified_at = ? WHERE id = ?", this.#now, id);
  }

  /** The text of an approval's message, the same in every chat that shows it. */
  messageText(a: Approval): string {
    const n = this.numberOf(a.id);
    const status = a.cancelReason ? CANCEL_WORD[a.cancelReason] : (STATUS_WORD[a.status] ?? a.status);
    return `Approval${n === undefined ? "" : ` #${n}`} (${status}): ${a.summary}`;
  }

  // ---- create ------------------------------------------------------------------------------------------------------

  /**
   * The pending approval for this exact call (session + tool + arguments), created when there is none: a repeat of a
   * blocked call reuses it. Writes the approval message into the session, and a second one into the chat that
   * spawned it; the session is "waiting_for_user" when no run is going.
   */
  findOrCreate(input: ApprovalDraft): { approval: Approval; number: number; created: boolean } {
    const result = this.app.tx(() => {
      const now = this.#now;
      const checkpoint = input.taskId ? this.forTask(input.session.id, input.taskId) : undefined;
      if (checkpoint) return { approval: toApproval(checkpoint), number: checkpoint.seq, created: false };
      // An existing legacy request keeps its original approval and retry flow.
      let existing = input.group
        ? undefined
        : this.#db.get<ApprovalRow>(
            "SELECT * FROM approvals WHERE session_id = ? AND tool = ? AND args_hash = ? AND status = 'pending' AND group_id IS NULL AND tool_task_id IS NULL",
            input.session.id,
            input.tool,
            input.argsHash,
          );
      if (existing && existing.expires_at <= now) {
        this.#transition(existing, "expired");
        existing = undefined;
      }
      if (existing) return { approval: toApproval(existing), number: existing.seq, created: false };
      const id = newId("apr", now);
      this.#db.run(
        `INSERT INTO approvals (id, session_id, session_title, agent_id, run_id, run_assigned_by, tool, args_json, args_hash, connector, operation, action_class,
           destination, summary, args_preview, taint, lengths, status, created_at, expires_at, preview_json, group_id, tool_call_id, tool_task_id,
           parent_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.session.id,
        input.session.title,
        input.session.agent_id,
        input.runId,
        input.assignedBy,
        input.tool,
        JSON.stringify(input.args ?? {}),
        input.argsHash,
        input.connector,
        input.operation,
        input.actionClass,
        input.destination,
        input.summary,
        input.argsPreview,
        JSON.stringify([...input.taint].sort()),
        JSON.stringify(input.lengths),
        now,
        now + input.ttlMs,
        input.preview ? JSON.stringify(input.preview) : null,
        input.group?.id ?? null,
        input.group?.callId ?? null,
        input.taskId ?? null,
        input.taskId ? (input.parentCallId ?? null) : null,
      );
      const row = this.row(id)!;
      const approval = toApproval(row);
      const text = this.messageText(approval);
      // A script's card is anchored to its nested task; the view model names the script's call beside it.
      this.app.addApprovalMessage(
        input.session.id,
        input.runId,
        text,
        approval,
        approval.parentCallId ? input.taskId : undefined,
      );
      const parent =
        input.session.origin === "spawned" && input.session.parent_session_id
          ? this.app.getSessionRow(input.session.parent_session_id)
          : undefined;
      if (parent) this.app.addApprovalMessage(parent.id, null, text, approval);
      this.app.events.append(GLOBAL_STREAM, { type: "approval.upserted", approval });
      this.app.touchSession(input.session.id);
      if (parent) this.app.touchSession(parent.id);
      this.app.queueNotify({
        event: "approval",
        sessionId: input.session.id,
        title: "Needs your approval",
        body: input.group ? `${input.group.count} connector reads need your approval.` : input.summary,
        dedupe: input.group?.id ?? id,
      });
      return { approval, number: row.seq, created: true };
    });
    if (result.created) this.onCreated?.();
    return result;
  }

  group(id: string): ApprovalRow[] {
    return this.#db.all<ApprovalRow>("SELECT * FROM approvals WHERE group_id = ? ORDER BY seq", id);
  }

  forTask(sessionId: string, taskId: string): ApprovalRow | undefined {
    return this.#db.get<ApprovalRow>(
      "SELECT * FROM approvals WHERE session_id = ? AND tool_task_id = ?",
      sessionId,
      taskId,
    );
  }

  createGroup(id: string, calls: readonly (ApprovalDraft & { callId: string })[]): ApprovalRow[] {
    return this.app.tx(() => {
      const existing = this.group(id);
      if (existing.length) return existing;
      for (const { callId, ...draft } of calls)
        this.findOrCreate({ ...draft, group: { id, callId, count: calls.length } });
      return this.group(id);
    });
  }

  decideGroup(id: string, request: DecideApprovalGroupRequest, oneTimeTtlMs: number): Approval[] {
    return this.app.tx(() => {
      const rows = this.group(id);
      if (!rows.length) throw notFound("That approval group does not exist.");
      const decisions = new Map(request.decisions.map(({ id, decision }) => [id, decision]));
      const matches = (row: ApprovalRow, decision: "approve" | "deny") =>
        row.status === (decision === "approve" ? "approved" : "denied");
      if (
        decisions.size !== request.decisions.length ||
        request.decisions.some(
          ({ id, decision }) =>
            !rows.some((row) => row.id === id && (row.status === "pending" || matches(row, decision))),
        ) ||
        rows.some((row) => row.status === "pending" && !decisions.has(row.id))
      )
        throw new HttpError(
          409,
          "approval_group_changed",
          "These requests changed. Review the current requests and try again.",
        );
      const now = this.#now;
      return rows.map((row) => {
        if (row.status !== "pending") return toApproval(row);
        const approved = decisions.get(row.id) === "approve";
        return this.#transition(
          this.#decidable(row.id),
          approved ? "approved" : "denied",
          approved ? { grantLength: "once", onceExpiresAt: now + oneTimeTtlMs } : {},
          now,
        );
      });
    });
  }

  executionFinished(id: string, execution: NonNullable<Approval["execution"]>): void {
    this.app.tx(() => {
      const changed = this.#db.run(
        `UPDATE approvals SET execution = ?, execution_interrupted = ?
         WHERE id = ? AND (group_id IS NOT NULL OR tool_task_id IS NOT NULL) AND status = 'approved' AND execution IS NULL`,
        execution === "interrupted" ? "failed" : execution,
        Number(execution === "interrupted"),
        id,
      ).changes;
      if (changed) this.#publish(this.row(id)!);
    });
  }

  /** Finish any calls that lost their tool task as the original Pi run settled. */
  settleRun(runId: string): void {
    this.app.tx(() => {
      const rows = this.#db.all<ApprovalRow>(
        `SELECT * FROM approvals WHERE run_id = ? AND (group_id IS NOT NULL OR tool_task_id IS NOT NULL)
         AND execution IS NULL AND status IN ('pending', 'approved')`,
        runId,
      );
      for (const row of rows) {
        if (row.status === "pending" && row.parent_call_id) this.cancelPending(row.id, "script_ended");
        else if (row.status === "pending") this.#transition(row, "cancelled");
        else this.executionFinished(row.id, "failed");
      }
    });
  }

  // ---- decisions ---------------------------------------------------------------------------------------------------

  /** Moves a pending approval to a final status; updates the messages, the session and the global stream. */
  #transition(
    row: ApprovalRow,
    status: Exclude<ApprovalStatus, "pending">,
    extra: { grantLength?: GrantLength; grantExpiresAt?: number; onceExpiresAt?: number } = {},
    now = this.#now,
  ): Approval {
    this.#db.run(
      "UPDATE approvals SET status = ?, decided_at = ?, grant_length = ?, grant_expires_at = ?, once_expires_at = ?, notified_at = ? WHERE id = ?",
      status,
      now,
      extra.grantLength ?? null,
      extra.grantExpiresAt ?? null,
      extra.onceExpiresAt ?? null,
      // A waiting tool handles its own outcome. Standalone denials and expiries need a separate notice.
      !resumesTool(row) && (status === "denied" || status === "expired") ? null : now,
      row.id,
    );
    return this.#publish(this.row(row.id)!);
  }

  #publish(row: ApprovalRow): Approval {
    const approval = toApproval(row);
    this.app.updateApprovalMessages(approval, () => this.messageText(approval));
    this.app.events.append(GLOBAL_STREAM, { type: "approval.upserted", approval });
    this.app.touchSession(row.session_id);
    const parentId = this.#db.get<{ parent_session_id: string | null }>(
      "SELECT parent_session_id FROM sessions WHERE id = ?",
      row.session_id,
    )?.parent_session_id;
    if (parentId) this.app.touchSession(parentId);
    return approval;
  }

  #decidable(id: string): ApprovalRow {
    const row = this.row(id);
    if (!row) throw notFound("That approval does not exist.");
    if (row.status !== "pending")
      throw new HttpError(409, "not_pending", "That approval was already decided or has expired.");
    if (row.expires_at <= this.#now) {
      this.#transition(row, "expired");
      throw new HttpError(409, "not_pending", "That approval has expired.");
    }
    return row;
  }

  /**
   * Approve: a one-time grant for exactly this call, a standing grant when `length` is not "once", and the input that
   * asks the agent to make the call again (one run, request id derived from the approval id), all in one transaction.
   */
  approve(
    id: string,
    request: { length?: GrantLength; hours?: number },
    oneTimeTtlMs: number,
  ): { approval: Approval; runId: string | undefined; grant: Grant | undefined } {
    return this.app.tx(() => {
      const row = this.#decidable(id);
      const length = request.length ?? "once";
      const offered = JSON.parse(row.lengths) as GrantLength[];
      if (
        !["once", "session", "web_session", "agent", "hours", "always", "trigger"].includes(length) ||
        !offered.includes(length)
      ) {
        throw badRequest("bad_length", `That approval can only be granted for: ${offered.join(", ")}.`);
      }
      let hours = 0;
      if (length === "hours") {
        hours = request.hours ?? NaN;
        if (!Number.isInteger(hours) || hours < 1 || hours > MAX_GRANT_HOURS)
          throw badRequest("bad_hours", `Hours must be a whole number from 1 to ${MAX_GRANT_HOURS}.`);
      }
      const now = this.#now;
      const grantExpiresAt = length === "hours" ? now + hours * HOUR_MS : undefined;
      const approval = this.#transition(
        row,
        "approved",
        {
          grantLength: length,
          onceExpiresAt: now + oneTimeTtlMs,
          ...(grantExpiresAt !== undefined ? { grantExpiresAt } : {}),
        },
        now,
      );
      let grant: Grant | undefined;
      if (length === "trigger") {
        // Not a grant: the call joins the allow list of the trigger this session is a run of, then re-runs like "once".
        const triggerId = this.app.getSessionRow(row.session_id)?.trigger_id;
        if (!triggerId || !this.onTriggerAllow)
          throw badRequest("bad_length", "That approval is not part of a trigger's run.");
        this.onTriggerAllow(triggerId, {
          tool: row.tool,
          ...(row.destination !== null ? { destination: row.destination } : {}),
        });
      } else if (length !== "once") {
        const gid = newId("gnt", now);
        this.#db.run(
          "INSERT INTO grants (id, connector, operation, destination, length, session_id, agent_id, expires_at, approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          gid,
          length === "web_session" ? "web" : row.connector,
          length === "web_session" ? "research" : row.operation,
          length === "web_session" ? null : row.destination,
          length,
          length === "session" || length === "web_session" ? row.session_id : null,
          length === "agent" ? row.agent_id : null,
          grantExpiresAt ?? null,
          row.id,
          now,
        );
        grant = toGrant(this.#db.get<GrantRow>("SELECT * FROM grants WHERE id = ?", gid)!);
      }
      if (resumesTool(row)) return { approval, runId: undefined, grant };
      const n = row.seq;
      const accepted = this.app.getSessionRow(row.session_id)
        ? this.app.queueAdmission({
            sessionId: row.session_id,
            requestId: `approval:${row.id}`,
            role: "notice",
            text: `You approved #${n}: ${row.summary}`,
            modelText: approvedText(n, row),
            ...(row.run_assigned_by ? { assignedBy: row.run_assigned_by } : {}),
          })
        : undefined;
      return { approval, runId: accepted?.runId, grant };
    });
  }

  deny(id: string): Approval {
    return this.app.tx(() => this.#transition(this.#decidable(id), "denied"));
  }

  /** Expires every pending approval past its time. */
  expireDue(): Approval[] {
    return this.app.tx(() =>
      this.#db
        .all<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ?", this.#now)
        .map((r) => this.#transition(r, "expired")),
    );
  }

  /** A parked call's deadline came: these approvals expire unless the sweep or a decision got there first. */
  expirePending(ids: readonly string[]): Approval[] {
    return this.app.tx(() =>
      ids.flatMap((id) => {
        const row = this.row(id);
        return row?.status === "pending" ? [this.#transition(row, "expired")] : [];
      }),
    );
  }

  /**
   * The call this approval was for ended without running while it was parked: cancelled. `script_ended` when a script's
   * nested call was aborted with its script (the deadline passed, or the run was stopped); its card says so.
   */
  cancelPending(id: string, reason?: NonNullable<Approval["cancelReason"]>): Approval | undefined {
    return this.app.tx(() => {
      const row = this.row(id);
      if (row?.status !== "pending") return undefined;
      if (reason) this.#db.run("UPDATE approvals SET cancel_reason = ? WHERE id = ?", reason, id);
      return this.#transition(this.row(id)!, "cancelled");
    });
  }

  /** The sessions are being deleted: their pending approvals end as cancelled. */
  cancelForSessions(sessionIds: readonly string[]): Approval[] {
    return this.app.tx(() => {
      const out: Approval[] = [];
      for (const sid of sessionIds) {
        for (const row of this.#db.all<ApprovalRow>(
          "SELECT * FROM approvals WHERE session_id = ? AND status = 'pending'",
          sid,
        ))
          out.push(this.#transition(row, "cancelled"));
      }
      return out;
    });
  }

  // ---- one-time grants ---------------------------------------------------------------------------------------------

  /**
   * Uses the approved, unconsumed one-time grant for exactly this call. Idempotent per `by` (the tool task): asking
   * again with the same task id returns the same grant, so a hook that runs twice consumes one.
   */
  consumeOnce(
    sessionId: string,
    tool: string,
    argsHash: string,
    by: string,
    onceOnly = false,
    approvalId?: string,
  ): { id: string; number: number } | undefined {
    return this.app.tx(() => {
      const again = this.#db.get<ApprovalRow>(
        `SELECT * FROM approvals WHERE session_id = ? AND tool = ? AND args_hash = ? AND consumed_by = ?
         AND ((group_id IS NULL AND tool_task_id IS NULL) OR id = ?) AND (? IS NULL OR id = ?)`,
        sessionId,
        tool,
        argsHash,
        by,
        approvalId ?? null,
        approvalId ?? null,
        approvalId ?? null,
      );
      if (
        again &&
        (!onceOnly ||
          (again.status === "approved" && again.grant_length === "once" && (again.once_expires_at ?? 0) > this.#now))
      )
        return { id: again.id, number: again.seq };
      const row = this.#db.get<ApprovalRow>(
        `SELECT * FROM approvals WHERE session_id = ? AND tool = ? AND args_hash = ? AND status = 'approved'
         AND consumed_by IS NULL AND once_expires_at > ? AND (? = 0 OR grant_length = 'once')
         AND ((group_id IS NULL AND tool_task_id IS NULL) OR id = ?) AND (? IS NULL OR id = ?) ORDER BY seq LIMIT 1`,
        sessionId,
        tool,
        argsHash,
        this.#now,
        onceOnly ? 1 : 0,
        approvalId ?? null,
        approvalId ?? null,
        approvalId ?? null,
      );
      if (!row) return undefined;
      this.#db.run("UPDATE approvals SET consumed_by = ?, consumed_at = ? WHERE id = ?", by, this.#now, row.id);
      return { id: row.id, number: row.seq };
    });
  }

  // ---- standing grants ---------------------------------------------------------------------------------------------

  /** A grant in force for this session that covers connector + operation + destination (null matches null). */
  findGrant(input: {
    connector: string;
    operation: string;
    destination: string | null;
    sessionId: string;
    agentId: string;
  }): Grant | undefined {
    const now = this.#now;
    const r = this.#db.get<GrantRow>(
      `SELECT * FROM grants WHERE connector = ? AND operation = ? AND destination IS ? AND revoked_at IS NULL AND (
         (length = 'session' AND session_id = ?) OR (length = 'agent' AND agent_id = ?) OR (length = 'hours' AND expires_at > ?) OR length = 'always')
       ORDER BY created_at DESC LIMIT 1`,
      input.connector,
      input.operation,
      input.destination,
      input.sessionId,
      input.agentId,
      now,
    );
    return r ? toGrant(r) : undefined;
  }

  findWebGrant(sessionId: string): Grant | undefined {
    const row = this.#db.get<GrantRow>(
      "SELECT * FROM grants WHERE session_id = ? AND length = 'web_session' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      sessionId,
    );
    return row ? toGrant(row) : undefined;
  }

  /** Approval history at a destination, for validating definition-bound MCP authority. */
  approvedFor(input: {
    connector: string;
    operation: string;
    destination: string | null;
    sessionId: string;
  }): ApprovalRow[] {
    return this.#db.all<ApprovalRow>(
      "SELECT * FROM approvals WHERE session_id = ? AND connector = ? AND operation = ? AND destination IS ? AND status = 'approved'",
      input.sessionId,
      input.connector,
      input.operation,
      input.destination,
    );
  }

  /** True when nothing was ever approved for this connector + operation + destination in this session. */
  isNewDestination(input: {
    connector: string;
    operation: string;
    destination: string | null;
    sessionId: string;
  }): boolean {
    return (
      this.#db.get(
        "SELECT 1 AS x FROM approvals WHERE session_id = ? AND connector = ? AND operation = ? AND destination IS ? AND status = 'approved' LIMIT 1",
        input.sessionId,
        input.connector,
        input.operation,
        input.destination,
      ) === undefined
    );
  }

  /** Grants in force (not revoked, not past their hours), newest first. */
  listGrants(): Grant[] {
    return this.#db
      .all<GrantRow>(
        "SELECT * FROM grants WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC, id DESC",
        this.#now,
      )
      .map(toGrant);
  }
  getGrant(id: string): Grant | undefined {
    const r = this.#db.get<GrantRow>("SELECT * FROM grants WHERE id = ?", id);
    return r ? toGrant(r) : undefined;
  }
  /** Revokes a grant in force; the row stays with `revoked_at`. Returns the grant, or undefined when none was in force. */
  revoke(id: string): Grant | undefined {
    const r = this.#db.get<GrantRow>(
      "SELECT * FROM grants WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      id,
      this.#now,
    );
    if (!r) return undefined;
    this.#db.run("UPDATE grants SET revoked_at = ? WHERE id = ?", this.#now, id);
    return toGrant(r);
  }

  /** Revokes every grant in force for a connector whose destination starts with `prefix` (an MCP connector that was removed). */
  revokeDestinationsOf(connector: string, prefix: string): number {
    const rows = this.#db.all<{ id: string }>(
      "SELECT id FROM grants WHERE connector = ? AND revoked_at IS NULL AND substr(destination, 1, ?) = ?",
      connector,
      prefix.length,
      prefix,
    );
    for (const r of rows) this.#db.run("UPDATE grants SET revoked_at = ? WHERE id = ?", this.#now, r.id);
    return rows.length;
  }

  // ---- the demo connector -----------------------------------------------------------------------------------------

  recordDemoEffect(tool: string, args: unknown, sessionId: string | null): void {
    this.#db.run(
      "INSERT INTO demo_effects (tool, args, session_id, at) VALUES (?, ?, ?, ?)",
      tool,
      JSON.stringify(args),
      sessionId,
      this.#now,
    );
  }
  demoEffects(): { tool: string; args: unknown; sessionId: string | null; at: number }[] {
    return this.#db
      .all<{ tool: string; args: string; session_id: string | null; at: number }>(
        "SELECT * FROM demo_effects ORDER BY seq",
      )
      .map((r) => ({ tool: r.tool, args: JSON.parse(r.args), sessionId: r.session_id, at: r.at }));
  }
}
