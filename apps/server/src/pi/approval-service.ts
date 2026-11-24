// The host side of D28: the UI's decisions, expiry, telling the agent about a denial, and revoking grants.
import type { Approval, DecideApprovalGroupRequest, DecideApprovalRequest, Grant } from "@rei/protocol";
import { type ApprovalRow, type ApprovalStore, networkArgs, resumesTool } from "../store/approvals.ts";
import type { AppStore } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import { badRequest, notFound } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { ApprovalWake, callTasks, createSignalTask, type SignalOptions, type SignalTask } from "./signals.ts";
import { context, type TreeManager } from "./trees.ts";

export interface ApprovalConfig {
  /** How long an approval waits for a decision. */
  approvalTtlMs: number;
  /** How long the one-time grant of an approved call stays usable. */
  oneTimeGrantTtlMs: number;
}
export const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = { approvalTtlMs: 24 * 3_600_000, oneTimeGrantTtlMs: 3_600_000 };

export class ApprovalService {
  readonly #store: AppStore;
  readonly #approvals: ApprovalStore;
  readonly #trees: TreeManager;
  readonly #kick: (sessionId: string) => void;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #cfg: ApprovalConfig;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #notifying: Promise<unknown> = Promise.resolve();
  readonly #signal: SignalTask;

  constructor(
    store: AppStore,
    approvals: ApprovalStore,
    trees: TreeManager,
    kick: (sessionId: string) => void,
    clock: Clock,
    log: Logger,
    config: ApprovalConfig,
  ) {
    this.#store = store;
    this.#approvals = approvals;
    this.#trees = trees;
    this.#kick = kick;
    this.#clock = clock;
    this.#log = log;
    this.#cfg = config;
    this.#signal = createSignalTask(trees, log);
    // A new pending approval may expire before the one the timer waits for.
    approvals.onCreated = () => this.#arm();
  }

  list(): Approval[] {
    return this.#approvals.listPending();
  }
  grants(): Grant[] {
    return this.#approvals.listGrants();
  }

  revokeGrant(id: string): void {
    const grant = this.#approvals.revoke(id);
    if (!grant) throw notFound("That grant does not exist or is no longer in force.");
    this.#log.info("grant.revoked", {
      grantId: grant.id,
      connector: grant.connector,
      operation: grant.operation,
      length: grant.length,
    });
  }

  async decide(id: string, request: DecideApprovalRequest): Promise<Approval> {
    if (request.decision !== "approve" && request.decision !== "deny")
      throw badRequest("bad_request", "decision must be 'approve' or 'deny'.");
    if (!this.#approvals.row(id)) throw notFound("That approval does not exist.");
    // Anything past its time is expired first, so a late decision gets "not_pending".
    await this.sweep();
    if (request.decision === "deny") {
      const approval = this.#approvals.deny(id);
      this.#log.info("approval.denied", { approvalId: id, sessionId: approval.sessionId });
      const row = this.#approvals.row(id)!;
      if (!resumesTool(row)) await this.#notify(row);
      await this.#wake([row]);
      return approval;
    }
    const done = this.#approvals.approve(
      id,
      {
        ...(request.length !== undefined ? { length: request.length } : {}),
        ...(request.hours !== undefined ? { hours: request.hours } : {}),
      },
      this.#cfg.oneTimeGrantTtlMs,
    );
    this.#log.info("approval.approved", {
      approvalId: id,
      sessionId: done.approval.sessionId,
      length: done.approval.grantLength ?? "once",
    });
    if (done.grant) {
      this.#log.info("grant.created", {
        grantId: done.grant.id,
        approvalId: id,
        connector: done.grant.connector,
        operation: done.grant.operation,
        length: done.grant.length,
        expiresAt: done.grant.expiresAt,
      });
    }
    if (done.runId) this.#kick(done.approval.sessionId);
    await this.#wake([this.#approvals.row(id)!]);
    return done.approval;
  }

  async decideGroup(id: string, request: DecideApprovalGroupRequest): Promise<Approval[]> {
    await this.sweep();
    const decided = this.#approvals.decideGroup(id, request, this.#cfg.oneTimeGrantTtlMs);
    await this.#wake(this.#approvals.group(id));
    return decided;
  }

  /** Cancels the pending approvals of sessions about to be deleted. */
  cancelForSessions(sessionIds: readonly string[]): void {
    const cancelled = this.#approvals.cancelForSessions(sessionIds);
    for (const a of cancelled) this.#log.info("approval.cancelled", { approvalId: a.id, sessionId: a.sessionId });
    // The deletion stops these runs anyway; the wake only lets a parked call end now. Closed trees stay closed.
    const rows = cancelled.flatMap((a) => this.#approvals.row(a.id) ?? []);
    void this.#wake(rows, { open: false });
  }

  /** Expires what is due, tells agents about denials and expiries not yet told, and arms the timer for the next expiry. */
  async sweep(): Promise<void> {
    const expired = this.#approvals.expireDue();
    for (const a of expired) this.#log.info("approval.expired", { approvalId: a.id, sessionId: a.sessionId });
    // A parked call also wakes at its own deadline; this covers a Pi clock behind the app's.
    await this.#wake(expired.flatMap((a) => this.#approvals.row(a.id) ?? []));
    for (const row of this.#approvals.unnotified()) await this.#notify(row);
    this.#arm();
  }

  async start(): Promise<void> {
    await this.sweep();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Wakes the calls parked on these rows, after their change is committed. A single call is the row's own task; a group
   * wakes once none of its rows is pending, and only the calls of the round that have started. The wake carries nothing:
   * the call reads the rows again. Never throws: a call that misses a wake reads the rows at its next open.
   */
  async #wake(rows: readonly ApprovalRow[], options?: SignalOptions): Promise<void> {
    const groups = new Set<string>();
    for (const row of rows) {
      try {
        const session = this.#store.getSessionRowAny(row.session_id);
        if (!session) continue;
        if (row.tool_task_id !== null && row.status !== "pending") {
          await this.#signal(session.tree_id, row.tool_task_id, ApprovalWake, row.id, context, options);
          continue;
        }
        if (row.group_id === null || groups.has(row.group_id)) continue;
        groups.add(row.group_id);
        const group = this.#approvals.group(row.group_id);
        if (group.some((r) => r.status === "pending")) continue;
        if (options?.open !== false) await this.#trees.open(session.tree_id);
        const calls = new Set(group.flatMap((r) => (r.tool_call_id ? [r.tool_call_id] : [])));
        for (const taskId of await callTasks(this.#trees, session.tree_id, session.id, calls, context))
          await this.#signal(session.tree_id, taskId, ApprovalWake, row.group_id, context, options);
      } catch (error) {
        this.#log.error("approval.wake_failed", {
          approvalId: row.id,
          error: error instanceof Error ? error.name : "error",
        });
      }
    }
  }

  #arm(): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const next = this.#approvals.nextExpiry();
    if (next === undefined) return;
    // setTimeout caps at about 24.8 days; the TTL is far below that, but re-arm in slices to be safe.
    const wait = Math.min(Math.max(0, next - this.#clock.now()) + 5, 2 ** 31 - 1);
    this.#timer = setTimeout(
      () =>
        void this.sweep().catch((error) =>
          this.#log.error("approval.sweep_failed", { error: error instanceof Error ? error.name : "error" }),
        ),
      wait,
    );
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /**
   * Tells the agent a call was NOT done, without starting a model turn: a `write` entry (Pi appends it at once when
   * idle, or at the next boundary), idempotent by request id. Marked notified afterwards; a crash in between is repaired
   * by the sweep at the next start.
   */
  #notify(row: ApprovalRow): Promise<void> {
    const next = this.#notifying.then(async () => {
      const session = this.#store.getSessionRow(row.session_id);
      if (!session || this.#stopped) {
        if (!session) this.#approvals.markNotified(row.id);
        return;
      }
      try {
        const tree = await this.#trees.open(session.tree_id);
        const ts = tree.session(session.id);
        if (!ts) return;
        const what = row.status === "expired" ? "expired" : "denied";
        const network = networkArgs(row);
        const content = network
          ? what === "denied"
            ? `[Approval #${row.seq} denied] The user did not allow network access to ${network.host}, so it was NOT allowed. Do not retry it and do not work around it.`
            : `[Approval #${row.seq} expired] The user did not decide in time, so network access to ${network.host} was NOT allowed. Do not retry it unless the user asks again.`
          : what === "denied"
            ? `[Approval #${row.seq} denied] The user denied this call, so it was NOT done: ${row.tool} ${row.args_json}. Do not retry it and do not work around it.`
            : `[Approval #${row.seq} expired] The user did not decide in time, so this call was NOT done: ${row.tool} ${row.args_json}. Do not retry it unless the user asks again.`;
        await ts.conv.submit(
          {
            type: "write",
            requestId: `approval:${row.id}`,
            entry: {
              kind: "app.approval",
              model: [{ role: "user", content, timestamp: this.#clock.now() }],
              data: { id: row.id, status: what },
            },
          },
          context,
        );
        this.#approvals.markNotified(row.id);
      } catch (error) {
        this.#log.error("approval.notify_failed", {
          approvalId: row.id,
          error: error instanceof Error ? error.name : "error",
        });
      }
    });
    this.#notifying = next.catch(() => undefined);
    return next;
  }
}
