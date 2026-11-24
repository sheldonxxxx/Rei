// Keeps Rei's derived records in step with one session's Pi conversation: the in-memory runs (from the command ledger and
// Pi's submissions), the run settlements (notify, report, title, trigger hooks), the trace links and the history index.
// It reads Pi's stored commits (`Harness.observeCommits()`), in commit order, one publication at a time; it never keeps a
// copy of the transcript.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CommitChange, Conversation, EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import type { StepRecorder } from "../pi/steps.ts";
import type { ApprovalStore } from "../store/approvals.ts";
import type { AppStore } from "../store/store.ts";
import { SurfacesDoc, type SurfacesState } from "../surfaces/model.ts";
import { surfaceParts } from "../surfaces/text.ts";
import type { Clock } from "../util/clock.ts";
import type { Logger } from "../util/log.ts";
import { COMMANDS_KIND, type CommandRecord, CommandsDoc, type InputData, isInputData, type Ledger } from "./ledger.ts";
import { currentRun, isTerminal, type RunRow, replyItemId, runFromRecords, userItemId } from "./runs.ts";
import { textOf } from "./view-model.ts";

const context = BACKGROUND_CONTEXT;

export interface SyncDeps {
  store: AppStore;
  approvals: ApprovalStore;
  recorder: StepRecorder;
  clock: Clock;
  log: Logger;
  treeId: string;
  sessionId: string;
  conv: Conversation;
  /** Memory: a finished tool result, for the history index. */
  onToolResult?: (input: {
    sessionId: string;
    runId: string | null;
    piEntryId: string;
    toolName: string;
    parts: readonly { type: string; text?: unknown }[];
    conversationId: string;
  }) => void;
}

const emptyLedger = (): Ledger => ({ order: [], byId: {}, byRequest: {} });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class SessionSync {
  readonly #d: SyncDeps;
  /**
   * The latest committed ledger of this conversation. Read-only: it is replaced (copy on write), never changed in place,
   * since it may be the value Pi handed to the commit observer.
   */
  ledger: Ledger = emptyLedger();
  /** Each run's record as last applied, serialized: a ledger commit refreshes only the runs whose record changed. */
  readonly #seen = new Map<string, string>();
  /** The latest submission of each run seen since the tree opened, by run id. */
  readonly #subs = new Map<string, SubmissionRecord>();
  #queue: Promise<void> = Promise.resolve();
  readonly #settling = new Set<string>();
  #disposed = false;

  constructor(deps: SyncDeps) {
    this.#d = deps;
  }

  get sessionId(): string {
    return this.#d.sessionId;
  }

  dispose(): void {
    this.#disposed = true;
  }

  drained(): Promise<void> {
    return this.#queue;
  }

  /**
   * On open: the runs of the ledger go into the registry (settled ones from the ledger alone, the others with their Pi
   * submission), and every run that ended while nobody settled it is settled now.
   */
  async hydrate(): Promise<void> {
    const { conv } = this.#d;
    const { ledger, subs } = await conv.commit(async (tx) => {
      const ledger = clone((await tx.doc(CommandsDoc, conv.id)) as unknown as Ledger);
      const subs = new Map<string, SubmissionRecord>();
      for (const runId of ledger.order) {
        const rec = ledger.byId[runId];
        if (!rec || rec.settled || rec.error) continue;
        const sub = await tx.submissionByRequest(conv.id, runId);
        if (sub) subs.set(runId, sub);
      }
      return { ledger, subs };
    }, context);
    this.ledger = ledger;
    for (const runId of ledger.order) this.#seen.set(runId, JSON.stringify(ledger.byId[runId]));
    for (const [runId, sub] of subs) this.#subs.set(runId, sub);
    this.#refresh(ledger.order);
  }

  /** Records a command this process just committed (before its commit is observed), so a repeat sees it at once. */
  noteCommand(runId: string, requestId: string, record: CommandRecord, extraKeys: readonly string[] = []): void {
    const l = this.ledger;
    const byRequest = { ...l.byRequest, [requestId]: runId };
    for (const key of extraKeys) byRequest[key] = runId;
    this.ledger = {
      ...l,
      order: l.byId[runId] ? l.order : [...l.order, runId],
      byId: { ...l.byId, [runId]: record },
      byRequest,
    };
    this.#seen.set(runId, JSON.stringify(record));
    this.#refresh([runId]);
  }

  /**
   * Changes ledger records in one commit of this conversation. `runIds` names the records `change` touches, so only they
   * are copied back and refreshed; without it the whole ledger is (a change outside the records, such as `inherited`).
   */
  async writeLedger(change: (ledger: Ledger) => void, runIds?: readonly string[]): Promise<void> {
    const { conv } = this.#d;
    type Written =
      | { whole: Ledger; records?: undefined }
      | { whole?: undefined; records: Record<string, CommandRecord> };
    const next = await conv.commit(async (tx): Promise<Written> => {
      const draft = (await tx.doc(CommandsDoc, conv.id)) as unknown as Ledger;
      change(draft);
      if (runIds === undefined) return { whole: clone(draft) };
      const records: Record<string, CommandRecord> = {};
      for (const id of runIds) {
        const record = draft.byId[id];
        if (record) records[id] = clone(record);
      }
      return { records };
    }, context);
    if (next.whole) {
      this.ledger = next.whole;
      for (const runId of next.whole.order) this.#seen.set(runId, JSON.stringify(next.whole.byId[runId]));
      this.#refresh(next.whole.order);
      return;
    }
    this.ledger = { ...this.ledger, byId: { ...this.ledger.byId, ...next.records } };
    for (const [runId, record] of Object.entries(next.records)) this.#seen.set(runId, JSON.stringify(record));
    this.#refresh(Object.keys(next.records));
  }

  /** One stored publication's changes of this conversation; handled after the ones before it. */
  enqueue(changes: readonly CommitChange[]): void {
    this.#queue = this.#queue
      .then(() => this.#onCommit(changes))
      .catch((error) => {
        this.#d.log.error("sync.error", { error: error instanceof Error ? error.name : "error" });
      });
  }

  async #onCommit(changes: readonly CommitChange[]): Promise<void> {
    if (this.#disposed) return;
    const entries: EntryRecord[] = [];
    const touched = new Set<string>();
    for (const change of changes) {
      if (change.type === "entry") entries.push(change.value);
      else if (change.type === "submission") {
        const runId = change.value.requestId;
        if (runId !== undefined && change.value.type !== "write") {
          this.#subs.set(runId, change.value);
          touched.add(runId);
        }
      } else if (change.type === "document" && change.kind === "change" && change.record.kind === COMMANDS_KIND) {
        const next = change.value as unknown as Ledger;
        // The ops name the records they change; anything else (a replacement, a whole byId) is compared record by record.
        const named = touchedRecords(change.ops);
        for (const runId of named ?? next.order) {
          const json = JSON.stringify(next.byId[runId]);
          if (json === this.#seen.get(runId)) continue;
          this.#seen.set(runId, json);
          touched.add(runId);
        }
        this.ledger = next;
      }
    }
    entries.sort((a, b) => Number(a.id) - Number(b.id));
    for (const entry of entries) this.#entry(entry);
    this.#refresh([...touched]);
  }

  /** Puts the runs into the registry; a run that just ended is settled. */
  #refresh(runIds: readonly string[]): void {
    const { store, treeId, sessionId } = this.#d;
    let statusChanged = false;
    for (const runId of runIds) {
      const record = this.ledger.byId[runId];
      if (!record) continue;
      const previous = store.runs.get(runId);
      const row = runFromRecords({ runId, treeId, sessionId, record, submission: this.#subs.get(runId) });
      if (previous && JSON.stringify(previous) === JSON.stringify(row)) continue;
      store.runs.put(row);
      // Rebuilding the registry for a reopened tree is not new chat activity. Settled runs already updated the
      // persisted session when they ended; loading them must preserve its date and position in the sidebar.
      if (previous?.status !== row.status && (previous !== undefined || !row.settled)) statusChanged = true;
      if (row.status === "running" && record.startedAt === undefined && !this.#settling.has(`start:${runId}`)) {
        this.#settling.add(`start:${runId}`);
        void this.writeLedger(
          (l) => {
            const r = l.byId[runId];
            if (r && r.startedAt === undefined) r.startedAt = this.#d.clock.now();
          },
          [runId],
        ).catch(() => undefined);
      }
      if (isTerminal(row.status) && !row.settled) void this.#settle(row);
    }
    if (statusChanged) store.touchSession(sessionId);
  }

  #runningRun(): RunRow | undefined {
    return currentRun(this.#d.store.runs.forSession(this.#d.sessionId));
  }

  #entry(entry: EntryRecord): void {
    const { recorder, sessionId, log } = this.#d;
    const message = entry.model?.[0];
    if (message?.role === "assistant") {
      // A model call that issued tool calls: its step's entry is linked after the calls were made.
      const run = this.#runningRun();
      if (run && (message as AssistantMessage).stopReason === "toolUse")
        recorder.linkModelEntry(run.id, String(entry.id));
    } else if (message?.role === "toolResult") {
      const runId = this.#runningRun()?.id;
      // Trace: the tool step learns which entry its result is.
      void recorder
        .linkToolEntry({
          sessionId,
          runId,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          entryId: String(entry.id),
          isError: message.isError,
          content: message.content,
        })
        .catch((error) => log.error("sync.tool_step_failed", { error: error instanceof Error ? error.name : "error" }));
      if (!message.isError)
        this.#d.onToolResult?.({
          sessionId,
          runId: runId ?? null,
          piEntryId: String(entry.id),
          toolName: message.toolName,
          parts: message.content as readonly { type: string; text?: unknown }[],
          conversationId: String(this.#d.conv.id),
        });
    }
  }

  /**
   * Rei's effects of a run that ended, then `settled` in the ledger. The effects are idempotent (outbox and notify keys,
   * index keys), so a crash between the two runs them again on the next open without doubling anything.
   */
  async #settle(run: RunRow): Promise<void> {
    if (this.#settling.has(run.id) || this.#disposed) return;
    this.#settling.add(run.id);
    const { store, conv, recorder, sessionId } = this.#d;
    try {
      const record = this.ledger.byId[run.id];
      if (!record) return;
      const { input, answer, surfaces } = await conv.commit(async (tx) => {
        const inputEntry =
          run.entry_id !== null && run.kind === "input" ? await tx.entry(Number(run.entry_id) as never) : undefined;
        const answerEntry =
          run.answer_entry_id !== null ? await tx.entry(Number(run.answer_entry_id) as never) : undefined;
        return {
          input: isInputData(inputEntry?.data) ? (inputEntry.data as InputData) : undefined,
          answer: answerEntry?.model?.[0],
          surfaces: JSON.parse(JSON.stringify(await tx.doc(SurfacesDoc, conv.id))) as SurfacesState,
        };
      }, context);
      const text = run.status === "completed" && answer?.role === "assistant" ? textOf(answer) : "";
      // Surfaces the run made count by their fallback in notifications and the history index.
      const parts = run.status === "completed" ? surfaceParts(surfaces, [run.id], sessionId, text) : undefined;
      const reply =
        run.status === "completed"
          ? { text, ...(parts ? { parts } : {}), ...(record.files?.length ? { attachments: record.files } : {}) }
          : record.files?.length
            ? { text: "", attachments: record.files }
            : undefined;
      this.#d.approvals.settleRun(run.id);
      store.settleRun(
        run,
        {
          role: record.role,
          text: input?.text ?? "",
          ...(input?.trigger ? { trigger: input.trigger } : {}),
          ...(input?.report ? { report: input.report } : {}),
          ...(record.firstUser ? { firstUser: true } : {}),
          ...(input?.from ? { fromSession: true } : {}),
          ...(input ? { createdAt: input.at } : {}),
        },
        reply,
      );
      if (run.status === "completed" && run.answer_entry_id !== null) recorder.linkEntry(run.id, run.answer_entry_id);
      const hooks = store.memoryHooks;
      if (hooks && input && (input.role === "user" || input.role === "report"))
        hooks.indexable({
          id: userItemId(run.id),
          sessionId,
          runId: run.id,
          role: input.role,
          text: input.text,
          ...(input.report ? { report: input.report } : {}),
          ...(input.from ? { fromSessionId: input.from.sessionId } : {}),
          conversationId: String(conv.id),
          createdAt: input.at,
        });
      if (hooks && run.status === "completed" && run.silent === 0 && text.trim() !== "")
        hooks.indexable({
          id: replyItemId(run.id),
          sessionId,
          runId: run.id,
          role: "assistant",
          text,
          ...(parts ? { parts } : {}),
          conversationId: String(conv.id),
          createdAt: run.started_at,
        });
      await this.writeLedger(
        (l) => {
          const r = l.byId[run.id];
          if (!r) return;
          r.settled = true;
          r.outcome = run.status as "completed" | "failed" | "cancelled";
          r.endedAt = r.endedAt ?? this.#d.clock.now();
          if (run.error_code) r.failure = { code: run.error_code, message: run.error_message ?? "" };
          if (run.entry_id !== null && run.kind === "input") r.entryId = Number(run.entry_id);
          if (run.answer_entry_id !== null) r.answerId = Number(run.answer_entry_id);
        },
        [run.id],
      );
    } catch (error) {
      this.#d.log.error("sync.settle_failed", { runId: run.id, error: error instanceof Error ? error.name : "error" });
    } finally {
      this.#settling.delete(run.id);
    }
  }
}

/** The run ids a ledger change's ops write under `byId`; undefined when an op is not confined to one record. */
function touchedRecords(ops: readonly (readonly unknown[])[]): Set<string> | undefined {
  const out = new Set<string>();
  for (const op of ops) {
    if (op[0] === "r") return undefined;
    const path = op[1];
    if (!Array.isArray(path) || path[0] !== "byId") continue;
    if (typeof path[1] !== "string") return undefined;
    out.add(path[1]);
  }
  return out;
}
