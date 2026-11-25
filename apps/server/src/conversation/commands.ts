// What Rei asks of a session's Pi conversation: admit an input (with its ledger record, in one commit), write a notice
// or a trigger line, cancel, continue after a run failure, and attach a reply's files. Admission is idempotent by the
// caller's request id (the ledger's `byRequest`), so a retried request, a replayed outbox row or a restart never admits
// the same input twice.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { InboxDoc, type InboxState } from "@earendil-works/pi-durable";
import type {
  Attachment,
  MessageMention,
  MessageSender,
  MessageSkill,
  SelectedSkill,
  SendWhenBusy,
  SessionReport,
  SurfaceActionRef,
  TriggerMessage,
} from "@rei/protocol";
import type { AttachmentService } from "../attachments/service.ts";
import type { OpenTree, TreeManager, TreeSession } from "../pi/trees.ts";
import type { SkillPreparer } from "../skills/prepare.ts";
import { type AppStore, type SessionRow, USER_CHAT_ORIGINS } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import { HttpError, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import type { Logger } from "../util/log.ts";
import {
  type CommandRecord,
  CommandsDoc,
  INPUT_KIND,
  type InputData,
  type InputRole,
  inputDigest,
  isInputData,
  NOTICE_KIND,
  type NoticeData,
  TRIGGER_KIND,
  type TriggerLineData,
} from "./ledger.ts";
import { isTerminal, unfinishedAssignment, userItemId } from "./runs.ts";
import { REPORT_KIND } from "./view-model.ts";

const context = BACKGROUND_CONTEXT;

export interface AdmitInput {
  sessionId: string;
  /** Idempotency key: a repeat returns the run admitted the first time. */
  requestId: string;
  /** A run id chosen in advance (a queued admission). */
  runId?: string;
  role: InputRole;
  /** What the chat shows. */
  text: string;
  /** What the model sees, when it is not the text (selected context is added to it). */
  modelText?: string;
  attachments?: Attachment[];
  mentions?: MessageMention[];
  /** Skills the user chose for this message (checked, loaded and put into the model input at admission). */
  selectedSkills?: SelectedSkill[];
  from?: MessageSender;
  surfaceAction?: SurfaceActionRef;
  trigger?: TriggerMessage;
  report?: SessionReport;
  assignedBy?: string;
  triggerRunId?: string;
  /** A second key the input claims (a form's submit-once key); a repeat with it is refused with 409. */
  onceKey?: string;
  /** Never the chat's first message for its title, even in an empty conversation (a rewind of the first message). */
  keepTitle?: boolean;
  /**
   * What the input does if a run is going: `steer` joins it after its current tool round, `queue` (default) starts the
   * next run. Steering is available for your own chat messages and explicit messages from a session's parent.
   */
  whenBusy?: SendWhenBusy;
}

/**
 * An input that is not the user's own send cannot be admitted while a manual compaction of the session runs. It is not
 * lost: its outbox row (or caller) tries again once the compaction ends.
 */
export class AdmissionDeferred extends Error {
  constructor() {
    super("The conversation is being compacted; this input waits until it is done.");
    this.name = "AdmissionDeferred";
  }
}

/**
 * Input its sender cannot send again: a session report, a trigger result, a parent's brief. Stop leaves it queued
 * (`onAbort: "keep"`) instead of withdrawing it; only your own messages are withdrawn.
 */
export function isBackgroundInput(input: { role: InputRole; from?: unknown }): boolean {
  return input.role === "report" || input.role === "trigger" || input.from !== undefined;
}

/** Whether an input is eligible to steer a running reply. */
export function steers(
  input: Pick<AdmitInput, "role" | "from" | "assignedBy" | "whenBusy">,
  origin: string,
  parentSessionId: string | null = null,
): boolean {
  if (input.whenBusy !== "steer" || input.role !== "user") return false;
  if (origin === "spawned" && parentSessionId !== null)
    return input.from?.sessionId === parentSessionId && input.assignedBy === parentSessionId;
  return input.from === undefined && input.assignedBy === undefined && USER_CHAT_ORIGINS.includes(origin);
}

export interface AdmitResult {
  runId: string;
  messageId: string;
  created: boolean;
}

export interface CommandsDeps {
  store: AppStore;
  trees: TreeManager;
  attachments?: AttachmentService;
  /** Selected skills: checked, loaded and mirrored at admission. */
  skills?: SkillPreparer;
  /** Whether a manual compaction of the session is running (admissions wait for it). */
  compacting?: (sessionId: string) => boolean;
  clock: Clock;
  log: Logger;
}

export class ConversationCommands {
  readonly #d: CommandsDeps;

  constructor(deps: CommandsDeps) {
    this.#d = deps;
  }

  async #session(sessionId: string): Promise<{ row: SessionRow; tree: OpenTree }> {
    const row = this.#d.store.getSessionRow(sessionId);
    if (!row) throw notFound("That session does not exist.");
    const tree = await this.#d.trees.open(row.tree_id);
    return { row, tree };
  }

  /** The open session of a tree, or 404 (it was deleted meanwhile). */
  #ts(tree: OpenTree, sessionId: string): TreeSession {
    const ts = tree.session(sessionId);
    if (!ts) throw notFound("That session does not exist.");
    return ts;
  }

  /**
   * Admits one input: its staged model content as a Pi input submission placed as a `rei.input` (or `rei.report`) entry,
   * and its ledger record, in one commit. Attachment staging that fails records the input with its error and no submission.
   */
  async admit(input: AdmitInput, lockedTree?: OpenTree): Promise<AdmitResult> {
    const { store, trees, attachments, clock } = this.#d;
    const { row, tree } = await this.#session(input.sessionId);
    const admit = async () => {
      tree.lastActivity = clock.now();
      const ts = this.#ts(tree, input.sessionId);
      const known = ts.sync.ledger.byRequest[input.requestId];
      if (known !== undefined) return { runId: known, messageId: userItemId(known), created: false };
      if (input.onceKey !== undefined && ts.sync.ledger.byRequest[input.onceKey] !== undefined)
        throw new HttpError(409, "already_submitted", "This form was already submitted.");
      // A manual compaction owns the conversation until it ends: your own send is refused (the draft stays), anything
      // else (a trigger, a report, another agent's message) waits. A retry of an admitted request was answered above.
      if (this.#d.compacting?.(input.sessionId)) {
        if (input.role === "user" && !input.from && !input.assignedBy)
          throw new HttpError(409, "compacting", "The conversation is being compacted. Send again in a moment.");
        throw new AdmissionDeferred();
      }
      const now = clock.now();
      const runId = input.runId ?? newId("run", now);
      // Selected skills: the exact versions are checked against the agent now and put into the model input; nothing
      // below changes them. Refused (nothing admitted) when one is unavailable or they cannot fit the context window.
      let skillBlocks: string[] = [];
      let skills: MessageSkill[] = [];
      if (input.selectedSkills?.length) {
        const prep = this.#d.skills;
        if (!prep) throw new HttpError(503, "unavailable", "Skills are unavailable.");
        const resolved = prep.resolve(row.agent_id, input.selectedSkills, await trees.contextWindowOf(row.id));
        skillBlocks = await prep.prepare(resolved, { treeId: row.tree_id, runId });
        skills = resolved.map(({ id, version, name }) => ({ id, version, name }));
      }
      const ctx = store.runContext(row, {
        role: input.role,
        ...(input.from ? { from: input.from } : {}),
        ...(input.assignedBy ? { assignedBy: input.assignedBy } : {}),
        ...(input.triggerRunId ? { triggerRunId: input.triggerRunId } : {}),
      });
      const firstUser =
        !input.keepTitle &&
        input.role === "user" &&
        !Object.values(ts.sync.ledger.byId).some((r) => r.role === "user" && r.kind === "input");
      const steer = steers(input, row.origin, row.parent_session_id);
      const data: InputData = {
        runId,
        role: input.role,
        text: input.text,
        at: now,
        ...(steer ? { steer: true as const } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.mentions?.length ? { mentions: input.mentions } : {}),
        ...(skills.length ? { selectedSkills: skills } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.surfaceAction ? { surfaceAction: input.surfaceAction } : {}),
        ...(input.trigger ? { trigger: input.trigger } : {}),
        ...(input.report ? { report: input.report } : {}),
        ...(input.assignedBy ? { assignedBy: input.assignedBy } : {}),
      };
      const record: CommandRecord = {
        requestId: input.requestId,
        kind: "input",
        role: input.role,
        direct: ctx.direct,
        ...(input.assignedBy ? { assignedBy: input.assignedBy } : {}),
        ...(ctx.triggerRunId ? { triggerRunId: ctx.triggerRunId } : {}),
        createdAt: now,
        ...(firstUser ? { firstUser: true } : {}),
      };
      const keys = input.onceKey !== undefined ? [input.onceKey] : [];
      let content = input.modelText ?? input.text;
      if (attachments && (input.attachments?.length || input.mentions?.length)) {
        try {
          content = await attachments.modelInput(
            { id: runId, sessionId: row.id, attachments: input.attachments, mentions: input.mentions },
            content,
          );
        } catch (error) {
          // The input stays in the chat with its error (Retry sends it again); Pi never sees it.
          record.error = {
            code: "attachment_staging_failed",
            message: error instanceof Error ? error.message : "Attachments could not be staged. Retry this message.",
          };
          await ts.conv.commit(async (tx) => {
            const ledger = await tx.doc(CommandsDoc, ts.conv.id);
            if (ledger.byRequest[input.requestId] !== undefined) return;
            await ts.conv.submit(tx, {
              type: "write",
              requestId: `${runId}:failed`,
              entry: { kind: INPUT_KIND, data: data as unknown as JsonValue },
            });
            ledger.byId[runId] = record as never;
            ledger.order.push(runId);
            ledger.byRequest[input.requestId] = runId;
            for (const key of keys) ledger.byRequest[key] = runId;
          }, context);
          ts.sync.noteCommand(runId, input.requestId, record, keys);
          store.recordAdmission({
            sessionId: row.id,
            runId,
            role: input.role,
            text: input.text,
            ...(input.attachments ? { attachments: input.attachments } : {}),
            firstUser,
          });
          return { runId, messageId: userItemId(runId), created: true };
        }
      }
      if (skillBlocks.length) content = `${skillBlocks.join("\n\n")}\n\n${content}`;
      record.inputDigest = inputDigest(content);
      await trees.prepareCall(tree, ts);
      const admitted = await ts.conv.commit(async (tx) => {
        const ledger = await tx.doc(CommandsDoc, ts.conv.id);
        const prior = ledger.byRequest[input.requestId];
        if (prior !== undefined) return prior;
        const submitted = await tx.submissionByRequest(ts.conv.id, runId);
        if (!submitted)
          await ts.conv.submit(tx, {
            type: "input",
            content,
            requestId: runId,
            ...(steer ? { whenBusy: "steer" as const } : {}),
            ...(isBackgroundInput(input) ? { onAbort: "keep" as const } : {}),
            entry: { kind: input.role === "report" ? REPORT_KIND : INPUT_KIND, data: data as unknown as JsonValue },
          });
        ledger.byId[runId] = record as never;
        ledger.order.push(runId);
        ledger.byRequest[input.requestId] = runId;
        for (const key of keys) ledger.byRequest[key] = runId;
        return undefined;
      }, context);
      if (admitted !== undefined) return { runId: admitted, messageId: userItemId(admitted), created: false };
      ts.sync.noteCommand(runId, input.requestId, record, keys);
      this.#d.skills?.recordUse(runId, skills);
      store.recordAdmission({
        sessionId: row.id,
        runId,
        role: input.role,
        text: input.text,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        firstUser,
      });
      return { runId, messageId: userItemId(runId), created: true };
    };
    // Rewind already owns this tree's queue from the cut through the replacement input.
    return lockedTree === tree ? admit() : tree.serial(admit);
  }

  /** The run a request id was admitted as, if it was (opens the session's tree). */
  async knownRequest(sessionId: string, requestId: string): Promise<string | undefined> {
    const { tree } = await this.#session(sessionId);
    return tree.session(sessionId)?.sync.ledger.byRequest[requestId];
  }

  /** A line from the app in a session's chat: a data-only entry (the model does not see it), appended at once. */
  async notice(sessionId: string, text: string, runId: string | null): Promise<void> {
    const data: NoticeData = { text, at: this.#d.clock.now(), ...(runId ? { runId } : {}) };
    await this.#write(sessionId, NOTICE_KIND, data);
  }

  /** A trigger's line in the chat it reports into, without a model turn. */
  async triggerLine(sessionId: string, trigger: TriggerMessage): Promise<void> {
    const data: TriggerLineData = { trigger, at: this.#d.clock.now() };
    await this.#write(sessionId, TRIGGER_KIND, data);
    this.#d.store.recordAgentEntry(sessionId, data.at, null);
  }

  /** Context the model should see without a turn of its own (a trigger result for the home chat): a write with a model message. */
  async contextNote(sessionId: string, requestId: string, text: string): Promise<void> {
    const { tree } = await this.#session(sessionId);
    const ts = this.#ts(tree, sessionId);
    await ts.conv.submit(
      {
        type: "write",
        requestId,
        entry: {
          kind: "rei.context",
          model: [{ role: "user", content: text, timestamp: this.#d.clock.now() }],
          data: { requestId, at: this.#d.clock.now() },
        },
      },
      context,
    );
  }

  async #write(sessionId: string, kind: string, data: NoticeData | TriggerLineData): Promise<void> {
    const { tree } = await this.#session(sessionId);
    const ts = this.#ts(tree, sessionId);
    await ts.conv.submit({ type: "write", entry: { kind, data: data as unknown as JsonValue } }, context);
  }

  /**
   * Stops the session's unfinished runs: marks them cancel-requested in the ledger, drops queued admissions that never
   * reached Pi, and aborts the conversation (the running run keeps its partial reply as aborted; queued inputs are
   * withdrawn). Returns the run that was running, or the first queued one.
   *
   * A queued report, trigger result or parent brief survives your Stop: Pi keeps it queued and a continue places it
   * right after the stopped run settles, so it is answered and the session is not left busy. `withdrawAll` is for the
   * callers that end the session's work on purpose (deleting it, a parent cancelling its worker): they withdraw those
   * too.
   */
  async cancel(sessionId: string, options: { withdrawAll?: boolean } = {}): Promise<{ cancelledRunId: string | null }> {
    const { store } = this.#d;
    const row = store.getSessionRow(sessionId) ?? store.getSessionRowAny(sessionId);
    if (!row) return { cancelledRunId: null };
    const runs = store.runs.nonTerminal(sessionId);
    const target = runs.find((r) => r.status === "running") ?? runs[0];
    if (!target) return { cancelledRunId: null };
    for (const run of runs) if (!this.#inLedger(row, run.id)) store.dropQueuedAdmission(run.id);
    const tree = this.#d.trees.get(row.tree_id);
    const ts = tree?.session(sessionId);
    if (!tree || !ts) return { cancelledRunId: target.id };
    await tree.serial(async () => {
      const ids = store.runs.nonTerminal(sessionId).map((r) => r.id);
      if (ids.length === 0) return;
      const queued = await ts.conv.commit(async (tx) => {
        const inbox = (await tx.doc(InboxDoc, ts.conv.id)) as unknown as InboxState;
        return JSON.parse(JSON.stringify(inbox.items ?? [])) as InboxState["items"];
      }, context);
      // A queued report, trigger result or parent brief survives Stop (Pi keeps it queued): it is neither marked
      // cancelled nor withdrawn. The input being answered right now is placed, so Stop still ends that one.
      const entryOf = (item: unknown) => (item as { entry?: { kind: string; data?: unknown } }).entry;
      const kept = new Set<string>();
      for (const item of queued) {
        const data = entryOf(item)?.data;
        if (isInputData(data) && ids.includes(data.runId) && isBackgroundInput(data)) kept.add(data.runId);
      }
      const stopped = ids.filter((id) => options.withdrawAll || !kept.has(id));
      if (stopped.length > 0)
        await ts.sync.writeLedger((l) => {
          for (const id of stopped) {
            const r = l.byId[id];
            if (r) r.cancelRequested = true;
          }
        }, stopped);
      await ts.conv.abort(context);
      // Abort withdraws the queued inputs from Pi's inbox without a transcript entry: each comes back as a data-only
      // entry, so what you typed stays in the chat, marked cancelled.
      for (const item of queued) {
        const entry = entryOf(item);
        if (!entry || !isInputData(entry.data) || !stopped.includes(entry.data.runId)) continue;
        const data = entry.data;
        const runId = data.runId;
        // Abort leaves a kept input queued; withdrawing it is explicit.
        if (kept.has(runId)) {
          const submitted = await ts.conv.commit((tx) => tx.submissionByRequest(ts.conv.id, runId), context);
          if (submitted) await tree.harness.abortSubmission(submitted.id, context, ts.conv.id);
        }
        await ts.conv.commit(async (tx) => {
          const sub = await tx.submissionByRequest(ts.conv.id, runId);
          if (sub && sub.status !== "unanswered") return;
          if (await tx.submissionByRequest(ts.conv.id, `${runId}:withdrawn`)) return;
          await ts.conv.submit(tx, {
            type: "write",
            requestId: `${runId}:withdrawn`,
            entry: { kind: entry.kind, data: { ...data, withdrawn: true } as unknown as JsonValue },
          });
        }, context);
      }
      if (kept.size > 0 && !options.withdrawAll) await this.#placeKept(ts);
    });
    return { cancelledRunId: target.id };
  }

  /**
   * Places the inputs Stop left queued. Pi places queued items with the next input or the next write that changes what
   * the model sees; a data-only write does not (the session would stay busy), but a continue does: it applies the final
   * boundary, so one run answers them, as after any finished reply. The conversation is idle here (abort resolved) and
   * `cancel` holds the tree's queue, so nothing else can be running or sneak in front.
   */
  async #placeKept(ts: TreeSession): Promise<void> {
    try {
      await ts.conv.submit({ type: "continue", requestId: `place:${newId("run", this.#d.clock.now())}` }, context);
    } catch (error) {
      // A person's message that arrived meanwhile already placed them.
      if (!(error instanceof Error && error.name === "ConversationBusy")) throw error;
    }
  }

  #inLedger(row: SessionRow, runId: string): boolean {
    const ts = this.#d.trees.get(row.tree_id)?.session(row.id);
    return ts?.sync.ledger.byId[runId] !== undefined;
  }

  /**
   * Continue after a run failure: a run on the context as it is, without a new message. Refused while a run is going
   * (409 `busy`).
   */
  async continueRun(sessionId: string): Promise<{ runId: string }> {
    const { store, trees, clock } = this.#d;
    const { row, tree } = await this.#session(sessionId);
    return tree.serial(async () => {
      const ts = this.#ts(tree, sessionId);
      if (store.runs.nonTerminal(sessionId).length > 0)
        throw new HttpError(409, "busy", "A run is still going. Wait for it to finish, or cancel it.");
      await trees.prepareCall(tree, ts);
      const now = clock.now();
      const runId = newId("run", now);
      const requestId = `continue:${runId}`;
      const assignedBy = unfinishedAssignment(store.runs.forSession(sessionId));
      const record: CommandRecord = {
        requestId,
        kind: "continue",
        role: "user",
        direct: USER_CHAT_ORIGINS.includes(row.origin),
        createdAt: now,
        ...(assignedBy ? { assignedBy } : {}),
      };
      try {
        await ts.conv.commit(async (tx) => {
          const latest = await tx.latestEntryId(ts.conv.id);
          await ts.conv.submit(tx, { type: "continue", requestId: runId });
          if (latest !== undefined) record.afterEntry = Number(latest);
          const ledger = await tx.doc(CommandsDoc, ts.conv.id);
          ledger.byId[runId] = record as never;
          ledger.order.push(runId);
          ledger.byRequest[requestId] = runId;
        }, context);
      } catch (error) {
        if (error instanceof Error && error.name === "ConversationBusy")
          throw new HttpError(409, "busy", "A run is still going. Wait for it to finish, or cancel it.");
        throw error;
      }
      ts.sync.noteCommand(runId, requestId, record);
      store.touchSession(sessionId);
      return { runId };
    });
  }

  /** Files a run's reply produced (library outputs): kept on the run's ledger record and shown with the reply. */
  async addFiles(sessionId: string, runId: string, files: readonly Attachment[]): Promise<void> {
    if (files.length === 0) return;
    this.#d.store.referenceAttachments(sessionId, runId, files);
    const { tree } = await this.#session(sessionId);
    const ts = this.#ts(tree, sessionId);
    await ts.sync.writeLedger(
      (l) => {
        const r = l.byId[runId];
        if (!r) return;
        const have = new Set((r.files ?? []).map((f) => f.id));
        r.files = [...(r.files ?? []), ...files.filter((f) => !have.has(f.id))];
      },
      [runId],
    );
    this.#d.store.viewChanged(sessionId);
  }

  /** Marks a run silent: its reply is neither published nor notified (the home assistant dismissed the event). */
  async silence(sessionId: string, runId: string): Promise<void> {
    const { tree } = await this.#session(sessionId);
    const ts = this.#ts(tree, sessionId);
    await ts.sync.writeLedger(
      (l) => {
        const r = l.byId[runId];
        if (r) r.silent = true;
      },
      [runId],
    );
    this.#d.store.viewChanged(sessionId);
  }

  /** A fork keeps showing the files the source chat's replies published (its ledger starts empty). */
  async inheritFiles(fromSessionId: string, toSessionId: string): Promise<void> {
    const { tree } = await this.#session(toSessionId);
    const from = tree.session(fromSessionId)?.sync.ledger;
    if (!from) return;
    const files: Record<string, Attachment[]> = { ...(from.inherited ?? {}) };
    for (const [runId, record] of Object.entries(from.byId)) if (record.files?.length) files[runId] = record.files;
    if (Object.keys(files).length === 0) return;
    await this.#ts(tree, toSessionId).sync.writeLedger((l) => {
      l.inherited = files;
    });
  }

  /** Whether a run (of an open tree) has ended. */
  ended(runId: string): boolean {
    const run = this.#d.store.runs.get(runId);
    return run === undefined || isTerminal(run.status);
  }
}
