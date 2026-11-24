import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import type {
  Agent,
  EditMessageResponse,
  MessageContext,
  MessageMention,
  SelectedSkill,
  SendWhenBusy,
  Session,
  SurfaceActionRequest,
  SurfaceActionResponse,
  SwitchVersionRequest,
  TriggerMessage,
} from "@rei/protocol";
import { SURFACE_LIMITS } from "@rei/protocol";
import type { AttachmentService } from "../attachments/service.ts";
import type { BlobStore } from "../blobs/blob-store.ts";
import {
  activeVersion,
  chainOf,
  inChain,
  latestLeaf,
  originalOf,
  ownerOf,
  versionsByCut,
} from "../conversation/branches.ts";
import { AdmissionDeferred, type AdmitResult, ConversationCommands } from "../conversation/commands.ts";
import { ManualCompactions } from "../conversation/compaction.ts";
import { ImportService } from "../conversation/imports.ts";
import { CommandsDoc, prefixLedger } from "../conversation/ledger.ts";
import { ViewService } from "../conversation/view.ts";
import type { WorkspaceManager } from "../exec/workspaces.ts";
import type { SkillPreparer } from "../skills/prepare.ts";
import type { ApprovalStore } from "../store/approvals.ts";
import {
  type AppStore,
  type DeletionJob,
  MAX_MESSAGE_CHARS,
  reportInputText,
  reportLine,
  type SessionRow,
  SpawnRefused,
} from "../store/store.ts";
import { SurfaceActions } from "../surfaces/actions.ts";
import { SurfaceFeeds } from "../surfaces/feeds.ts";
import type { Clock } from "../util/clock.ts";
import { badRequest, HttpError, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import type { Logger } from "../util/log.ts";
import { type ApprovalConfig, ApprovalService } from "./approval-service.ts";
import { behaviorSettings, CONFIGLESS } from "./behavior-settings.ts";
import { type SessionHost, type SessionHostRef, statusWord, titleFromBrief } from "./session-tools.ts";
import type { TreeFiles } from "./tree-files.ts";
import { context, type OpenTree, type TreeManager } from "./trees.ts";

export interface AdapterOptions {
  idleCloseMs: number;
  /** How often the idle sweep, the wake check and the report retry run. */
  tickMs: number;
  /** start_session refuses beyond this depth (home, user and fork chats are 0). */
  maxSessionDepth: number;
  /** start_session refuses when the caller already has this many unfinished spawned sessions. */
  maxActiveChildren: number;
  /** Deleting a session waits this long for its cancelled runs to settle, then goes on anyway. */
  deleteSettleMs: number;
  /** How often worker feeds write into their surfaces (and the least gap between two writes of one feed). */
  surfaceFeedMs: number;
}
export const DEFAULT_ADAPTER_OPTIONS: AdapterOptions = {
  idleCloseMs: 10 * 60_000,
  tickMs: 30_000,
  maxSessionDepth: 2,
  maxActiveChildren: 5,
  deleteSettleMs: 10_000,
  surfaceFeedMs: SURFACE_LIMITS.feedIntervalMs,
};

/** What the model reads for a trigger's result in the home chat (the chat shows the trigger's own line). */
export const triggerReportText = (trigger: TriggerMessage, text: string): string =>
  `[Trigger result] "${trigger.triggerName}" (${trigger.kind})\n` +
  "This is a background result, not a new instruction from the user. Use the existing conversation to respond as their helpful assistant. " +
  "Decide whether the result warrants a message to the user. If it does, give the useful outcome in your own words, with relevant detail and sources. If it does not, call dismiss_event and finish without a user-facing reply. Do not simply echo the raw report or start a worker just to rewrite it.\n\n" +
  text;

const REPORT_REVIEW =
  "\nReview this background event with the existing conversation. The user sees only a one-line notice that the session finished, not its result, so a reply must stand on its own: give the answer, short for a short result, the key points for a long one. If nothing here is worth the user's attention (a routine check with no change, a result they already have), call dismiss_event and say nothing.";

type ToolText = { output: { type: "text"; text: string }[]; isError?: true };
const ok = (text: string): ToolText => ({ output: [{ type: "text", text }] });
const fail = (text: string): ToolText => ({ isError: true, output: [{ type: "text", text }] });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The control plane's one door into Pi. HTTP handlers call `createSession`, `send`, `cancel`, `forkSession` and
 * `deleteSession`; the session tools call the `SessionHost` methods; everything Pi-specific (trees, submissions,
 * streaming, recovery) happens behind them.
 */
export class PiAdapter implements SessionHost {
  readonly #store: AppStore;
  readonly #trees: TreeManager;
  readonly #files: TreeFiles;
  readonly #traceBlobs: BlobStore;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #o: AdapterOptions;
  readonly #approvalStore: ApprovalStore;
  readonly #workspaces: WorkspaceManager | undefined;
  readonly attachments: AttachmentService | undefined;
  #timers: ReturnType<typeof setInterval>[] = [];
  #stopped = false;
  #deleteChain: Promise<unknown> = Promise.resolve();
  #delivering = false;
  #deliverAgain = false;
  #admitting: Promise<void> | null = null;
  #admitAgain = false;
  /** Admission, cancel, continue and notices of a session's conversation. */
  readonly commands: ConversationCommands;
  /** The Conversation View: GET, transcript pages and the session stream. */
  readonly views: ViewService;
  /** Past conversations from another app, written in as chats (docs/importing.md). */
  readonly imports: ImportService;
  readonly surfaceActions: SurfaceActions;
  /** Writes worker progress into live surfaces (ticks once a second). */
  readonly surfaceFeeds: SurfaceFeeds;
  /** Manual compaction (`/compact`): requests, their follow-up and the send barrier while one runs. */
  readonly compactions: ManualCompactions;
  /** Selected skills (`/` in the composer): the list, the checks and the model-input blocks. */
  readonly skillPreparer: SkillPreparer | undefined;
  /** Test hook: while set, reports stay in the outbox (as if the process died before delivering them). */
  holdReports = false;
  /** Decisions on approvals, expiry and grants. */
  readonly approvals: ApprovalService;
  /** Called with the ids of sessions about to be deleted, before they are hidden (the browser closes their windows). */
  onSessionsDeleting: ((ids: string[]) => void) | undefined;

  constructor(
    store: AppStore,
    trees: TreeManager,
    files: TreeFiles,
    traceBlobs: BlobStore,
    clock: Clock,
    log: Logger,
    hostRef: SessionHostRef,
    options: Partial<AdapterOptions>,
    approvalStore: ApprovalStore,
    approvalConfig: ApprovalConfig,
    workspaces?: WorkspaceManager,
    attachments?: AttachmentService,
    skillPreparer?: SkillPreparer,
  ) {
    this.#store = store;
    this.#trees = trees;
    this.#files = files;
    this.#traceBlobs = traceBlobs;
    this.#clock = clock;
    this.#log = log;
    this.#o = { ...DEFAULT_ADAPTER_OPTIONS, ...options };
    this.#approvalStore = approvalStore;
    this.#workspaces = workspaces;
    this.attachments = attachments;
    this.approvals = new ApprovalService(
      store,
      approvalStore,
      trees,
      (sessionId) => this.kick(sessionId),
      clock,
      log,
      approvalConfig,
    );
    this.skillPreparer = skillPreparer;
    this.commands = new ConversationCommands({
      store,
      trees,
      ...(attachments ? { attachments } : {}),
      ...(skillPreparer ? { skills: skillPreparer } : {}),
      compacting: (sessionId) => this.compactions.active(sessionId),
      clock,
      log,
    });
    this.compactions = new ManualCompactions({
      store,
      trees,
      clock,
      log,
      notice: (sessionId, text) => this.commands.notice(sessionId, text, null),
      kick: () => this.kick(),
    });
    this.views = new ViewService({ store, trees, log });
    this.imports = new ImportService({
      store,
      trees,
      clock,
      log,
      ...(attachments ? { attachments } : {}),
      begin: (agentId, source, sourceId) => {
        const { session, treeId } = store.beginImport(agentId, source, sourceId);
        this.#files.create(treeId);
        return { sessionId: session.id };
      },
      deleteSession: (sessionId) => this.deleteSession(sessionId, false),
    });
    this.surfaceActions = new SurfaceActions({ store, trees, commands: this.commands, clock });
    this.surfaceFeeds = new SurfaceFeeds({ store, trees, clock, intervalMs: this.#o.surfaceFeedMs });
    hostRef.current = this;
    store.onReportQueued = () => void this.deliverReports();
    store.onAdmitQueued = () => void this.deliverAdmissions();
    store.reader = this.views;
    store.fileOutputs = (sessionId, runId, files) => this.commands.addFiles(sessionId, runId, files);
    store.silence = (sessionId, runId) => this.commands.silence(sessionId, runId);
    // Lines from the app (notices, trigger lines) are written into the session's Pi conversation.
    store.transcript = {
      notice: (sessionId, text, runId) => this.#background("notice", this.commands.notice(sessionId, text, runId)),
      triggerLine: (sessionId, trigger) =>
        this.#background("trigger_line", this.commands.triggerLine(sessionId, trigger)),
    };
  }

  readonly #pendingWrites = new Set<Promise<unknown>>();

  #background(what: string, work: Promise<unknown>): void {
    const tracked = work
      .catch((error) => {
        if (this.#stopped) return;
        this.#log.error(`conversation.${what}_failed`, { error: error instanceof Error ? error.name : "error" });
      })
      .finally(() => this.#pendingWrites.delete(tracked));
    this.#pendingWrites.add(tracked);
  }

  /** Resolves when the chat lines written in the background (notices, trigger lines) are in their conversations. */
  async writesSettled(): Promise<void> {
    while (this.#pendingWrites.size > 0) await Promise.all([...this.#pendingWrites]);
  }

  get trees(): TreeManager {
    return this.#trees;
  }

  /** Startup: finish interrupted deletions, make sure every live tree has its folder, reopen trees with work in flight. */
  async start(): Promise<void> {
    for (const job of this.#store.deletionJobs()) {
      try {
        await this.#runDeletion(job);
        this.#log.info("deletion.resumed", { jobId: job.id });
      } catch (error) {
        this.#log.error("deletion.resume_failed", {
          jobId: job.id,
          error: error instanceof Error ? error.name : "error",
        });
      }
    }
    // Workspaces of trees deleted while the sandbox was down (or before a crash): try again in the background.
    this.#workspaces?.kick();
    const swept = this.#files.sweep();
    if (swept.length > 0) this.#log.info("trees.swept", { count: swept.length });
    for (const id of this.#store.liveTreeIds()) if (!this.#files.exists(id)) this.#files.create(id);
    // Queued admissions count as queued runs from the start; opening a tree settles what ended while Rei was down.
    this.#store.pendingAdmissions();
    for (const treeId of this.#store.treesWithWork()) {
      try {
        await this.#trees.open(treeId);
      } catch (error) {
        this.#log.error("tree.recover_failed", { treeId, error: error instanceof Error ? error.name : "error" });
      }
    }
    const every = (ms: number, fn: () => Promise<void>) => {
      const timer = setInterval(() => void fn().catch(() => undefined), ms);
      (timer as { unref?: () => void }).unref?.();
      this.#timers.push(timer);
    };
    every(this.#o.tickMs, async () => {
      await this.#trees.closeIdle(this.#o.idleCloseMs);
      for (const treeId of this.#store.dueTrees(this.#clock.now()))
        await this.#trees.open(treeId).catch(() => undefined);
      await this.deliverReports();
      await this.deliverAdmissions();
      if (!this.#stopped) await this.#trees.compactIdleHomes();
      this.#workspaces?.kick();
    });
    await this.attachments?.sweep();
    every(60_000, async () => {
      await this.attachments?.sweep();
    });
    every(this.#o.surfaceFeedMs, () => this.surfaceFeeds.tick());
    await this.deliverAdmissions();
    await this.deliverReports();
    await this.approvals.start();
    // A manual compaction that was in flight when Rei stopped is followed to its end, or reported as unknown.
    await this.compactions.recover();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.compactions.stop();
    this.approvals.stop();
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    await this.#admitting?.catch(() => {});
    await this.#trees.closeAll(true);
    await this.#workspaces?.stop();
    await this.attachments?.settled();
  }

  /** New chat: the session, its tree row and its tree folder. */
  createSession(agentId: string): Session {
    const { session, treeId } = this.#store.createSession(agentId);
    this.#files.create(treeId);
    return session;
  }

  /** New agent: its rows with the home chat, and the home chat's tree folder. */
  createAgent(design: { name: string; avatar: string; instructions: string }): { agent: Agent; session: Session } {
    const { agent, session, treeId } = this.#store.createAgent(design);
    this.#files.create(treeId);
    this.#log.info("agent.created", { agentId: agent.id });
    return { agent, session };
  }

  /**
   * Deletes an agent: every chat of it (home chat, forks, spawned and trigger runs) through the delete chain, which stops
   * their runs and purges them, then its triggers, grants and memory. Refuses the default agent (409) and an unknown one (404).
   */
  async deleteAgent(agentId: string): Promise<void> {
    if (!this.#store.getAgentRow(agentId)) throw notFound("That agent does not exist.");
    if (this.#store.defaultAgentId() === agentId)
      throw new HttpError(409, "default_agent", "The default agent can't be deleted.");
    // Again until none is left: a trigger can start a run while the others are going.
    for (let ids = this.#store.agentSessionIds(agentId); ids.length > 0; ids = this.#store.agentSessionIds(agentId)) {
      // A fork or a spawned chat may already have gone with an earlier one.
      for (const id of ids) if (this.#store.getSessionRow(id)) await this.deleteSession(id, false, "purge");
    }
    this.#store.tx(() => {
      this.#workspaces?.scheduleAgentPurge(agentId);
      this.#store.removeAgentRows(agentId);
    });
    this.#workspaces?.kick();
    this.#log.info("agent.deleted", { agentId });
  }

  /** The tree folder of a session made inside a store transaction (a trigger's run). */
  createTreeFolder(treeId: string): void {
    this.#files.create(treeId);
  }

  /**
   * Trigger results start an assistant turn (an input with the trigger's line); context-only notes append without a
   * model turn (a write with a model message). Both are idempotent by request id.
   */
  async noteInHome(sessionId: string, requestId: string, text: string, trigger?: TriggerMessage): Promise<void> {
    const session = this.#store.getSessionRow(sessionId);
    if (!session) return;
    if (this.#stopped) throw new Error("The control plane is stopping.");
    if (trigger) {
      await this.commands.admit({
        sessionId,
        requestId,
        role: "trigger",
        text: trigger.text,
        trigger,
        modelText: triggerReportText(trigger, text),
      });
      // Background observations have the same provenance as their originating session.
      const source = trigger.sessionId ? this.#store.getSessionRowAny(trigger.sessionId) : undefined;
      if (source) this.#store.addTaint(sessionId, JSON.parse(source.taint));
      return;
    }
    await this.commands.contextNote(sessionId, requestId, text);
  }

  /** Admits your message into the session's conversation (idempotent by requestId). */
  async send(
    input: Omit<MessageContext, "selectedSkills"> & {
      sessionId: string;
      requestId: string;
      text: string;
      selectedSkills?: SelectedSkill[];
      keepTitle?: boolean;
      /** Overrides Settings > Behavior `chat.whenBusy` for this message. */
      whenBusy?: SendWhenBusy;
    },
    lockedTree?: OpenTree,
  ): Promise<AdmitResult> {
    this.#store.checkMessage(input.text, input.attachments);
    if (this.#stopped) throw new HttpError(503, "stopping", "The server is stopping.");
    return this.commands.admit(
      {
        sessionId: input.sessionId,
        requestId: input.requestId,
        role: "user",
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.mentions?.length ? { mentions: input.mentions } : {}),
        ...(input.selectedSkills?.length ? { selectedSkills: input.selectedSkills } : {}),
        ...(input.keepTitle ? { keepTitle: true } : {}),
        whenBusy: input.whenBusy ?? behaviorSettings(this.#store, CONFIGLESS).chat.whenBusy,
      },
      lockedTree,
    );
  }

  /**
   * Checks that a session's agent can use each selected skill version now, without admitting anything (Edit checks
   * before it forks a chat). Throws "skill_unavailable" or "skills_too_large".
   */
  async checkSkills(sessionId: string, selected: SelectedSkill[]): Promise<void> {
    if (selected.length === 0) return;
    const row = this.#store.getSessionRow(sessionId);
    if (!row) throw notFound("That session does not exist.");
    if (!this.skillPreparer) throw new HttpError(503, "unavailable", "Skills are unavailable.");
    this.skillPreparer.resolve(row.agent_id, selected, await this.#trees.contextWindowOf(sessionId));
  }

  /** Delivers queued admissions of a session now (after an approval, a takeover, a trigger start). */
  kick(_sessionId?: string): void {
    if (this.#stopped) return;
    void this.deliverAdmissions();
  }

  /**
   * Admits every queued admission (approval and takeover notices, trigger briefs), once per request id, oldest first.
   * Runs on write, on startup and on every tick, so a queued input reaches Pi at least once.
   */
  async deliverAdmissions(): Promise<void> {
    if (this.#stopped) return;
    if (this.#admitting) {
      this.#admitAgain = true;
      return;
    }
    this.#admitting = this.#admitAll().finally(() => {
      this.#admitting = null;
    });
    await this.#admitting;
  }

  async #admitAll(): Promise<void> {
    do {
      this.#admitAgain = false;
      for (const { row, admission } of this.#store.pendingAdmissions()) {
        if (this.#stopped) return;
        if (!this.#store.getSessionRow(admission.sessionId)) {
          this.#store.dropQueuedAdmission(admission.runId);
          continue;
        }
        try {
          await this.commands.admit(admission);
          if (this.#stopped) return;
          this.#store.finishOutbox(row.id, "delivered");
        } catch (error) {
          if (this.#stopped) return;
          // Waiting for a manual compaction to end is not a failure: the row stays and the next tick delivers it.
          if (error instanceof AdmissionDeferred) continue;
          this.#store.bumpOutboxAttempts(row.id);
          this.#log.error("admission.failed", {
            requestId: row.request_id,
            error: error instanceof Error ? error.name : "error",
          });
        }
      }
    } while (this.#admitAgain && !this.#stopped);
  }

  /**
   * Stops the session's unfinished runs. The running one keeps its partial text as "aborted"; runs queued behind it are
   * withdrawn (Pi drops queued inputs on abort) and end as cancelled. Returns the run that was running (or first queued).
   */
  async cancel(sessionId: string): Promise<{ cancelledRunId: string | null }> {
    const row = this.#store.getSessionRow(sessionId);
    if (!row) return { cancelledRunId: null };
    return this.commands.cancel(sessionId);
  }

  /** Continue after a run failure: a run on the conversation as it is. */
  continueRun(sessionId: string): Promise<{ runId: string }> {
    if (!this.#store.getSessionRow(sessionId)) throw notFound("That session does not exist.");
    return this.commands.continueRun(sessionId);
  }

  /** The delete primitive for a whole tree: refuses while it has work, then closes, removes and records it. */
  async deleteTree(treeId: string): Promise<void> {
    if (this.#store.hasWork(treeId)) throw new Error(`tree ${treeId} has unfinished runs`);
    await this.#trees.close(treeId);
    this.#files.deleteTree(treeId);
    this.#store.markTreeDeleted(treeId);
    this.#log.info("tree.deleted", { treeId });
  }

  // ---- fork ----------------------------------------------------------------------------------------------------------

  /**
   * Branch in new chat at a finished reply: forks the session's Pi conversation at the reply's entry (the fork holds the
   * transcript up to and including it). Only finished output can be forked, never a tool call or a trace step. Refuses
   * anything else (409 `not_forkable`).
   */
  async forkSession(sessionId: string, messageId: string): Promise<Session> {
    const row = this.#store.getSessionRow(sessionId);
    if (!row) throw notFound("That session does not exist.");
    const cut = await this.#forkPoint(row, messageId);
    const tree = await this.#trees.open(row.tree_id);
    return tree.serial(async () => {
      const ts = tree.session(sessionId);
      const source = this.#store.getSessionRow(sessionId);
      if (!ts || !source) throw notFound("That session does not exist.");
      // Safe while the conversation is busy: the fork copies entries up to the cut, no tasks, no queue.
      const conv = await tree.guard.fork(ts.conv, cut.entry as never, { ownership: { kind: "ownerless" } }, context);
      const session = this.#store.createFork({
        source,
        cut: { messageId: cut.messageId },
        conversationId: String(conv.id),
        preview: cut.preview,
      });
      await this.#trees.attachSession(tree, this.#store.getSessionRowAny(session.id)!, conv);
      await this.commands.inheritFiles(source.id, session.id);
      tree.lastActivity = this.#clock.now();
      this.#log.info("session.forked", { sessionId: session.id, from: sessionId });
      return this.#store.getSession(session.id) ?? session;
    });
  }

  /**
   * Where a fork (or an Edit/Retry of one of your messages) would cut, for the "what this leaves behind" preview: the last
   * entry kept (null: nothing is kept), the time of the cut, and whether it is an edit (the input itself is left out).
   */
  async forkCut(
    sessionId: string,
    messageId: string,
  ): Promise<{ entry: string | null; after: number; edited: boolean }> {
    const row = this.#store.getSessionRow(sessionId);
    if (!row) throw notFound("That session does not exist.");
    const item = await this.views.findItem(sessionId, messageId);
    if (!item) throw notFound("That message does not exist.");
    if (item.role === "user") {
      if (!item.editable || item.entryId === undefined)
        throw new HttpError(409, "not_forkable", "This message cannot be edited or retried.");
      const { before } = await this.views.inputBefore(sessionId, Number(item.entryId));
      return { entry: before ? String(before.id) : null, after: item.createdAt, edited: true };
    }
    const point = await this.#forkPoint(row, messageId);
    return { entry: String(point.entry), after: item.createdAt, edited: false };
  }

  /** Where a fork is cut: the reply's entry, the item a client links back to, and the line the new chat previews. */
  async #forkPoint(row: SessionRow, messageId: string): Promise<{ entry: number; messageId: string; preview: string }> {
    const item = await this.views.findItem(row.id, messageId);
    if (!item) throw notFound("That message does not exist.");
    if (!item.forkable || item.entryId === undefined)
      throw new HttpError(409, "not_forkable", "Only a finished reply can be branched into a new chat.");
    return { entry: Number(item.entryId), messageId: item.id, preview: collapse(item.text) };
  }

  /**
   * Edit or Retry of one of your messages, in place: the session's conversation is cut back to just before the message
   * (a fork of it; for the first message of a chat, an empty conversation), the fork is swapped in under the same
   * session, and `text` is sent there as a direct run. The conversation it replaced stays in the tree as another version
   * of the message (`session_branches`). Refuses a message that is not editable (409 `not_editable`), empty text, and a
   * busy chat (409 `busy`).
   */
  async editMessage(
    sessionId: string,
    messageId: string,
    text: string,
    editedMentions?: MessageMention[],
    editedSkills?: SelectedSkill[],
  ): Promise<EditMessageResponse> {
    const row = this.#store.getSessionRow(sessionId);
    if (!row) throw notFound("That session does not exist.");
    const tree = await this.#trees.open(row.tree_id);
    return tree.serial(async () => {
      this.#refuseBusy(sessionId);
      const original = await this.views.findItem(sessionId, messageId);
      if (!original) throw notFound("That message does not exist.");
      if (text.trim() === "" && !original.attachments?.length) throw badRequest("bad_request", "The message is empty.");
      if (text.length > MAX_MESSAGE_CHARS)
        throw new HttpError(413, "too_long", `Messages can be at most ${MAX_MESSAGE_CHARS} characters.`);
      if (!original.editable || original.entryId === undefined)
        throw new HttpError(
          409,
          "not_editable",
          "Only a message you typed, once it has been answered, can be edited or retried.",
        );
      const { before, input } = await this.views.inputBefore(sessionId, Number(original.entryId));
      // Nothing of the conversation stays before a chat's first message: an empty conversation instead of a fork.
      const first = !input || before === undefined;
      const ts = tree.session(sessionId);
      if (!ts || !this.#store.getSessionRow(sessionId)) throw notFound("That session does not exist.");
      this.#refuseBusy(sessionId);
      const active = String(ts.conv.id);
      const rows = this.#store.branchesOf(sessionId);
      let conv: Conversation;
      let parent: string;
      if (first) {
        parent = originalOf(rows, active);
        conv = await tree.guard.createConversation(tree.harness, { ownership: { kind: "ownerless" } }, context);
      } else {
        // Forked from the conversation that owns the cut, so every version of the message hangs off one parent.
        parent = ownerOf(rows, active, Number(before.id));
        const from =
          parent === active ? ts.conv : await tree.harness.conversation(Number(parent) as ConversationId, context);
        if (!from) throw new Error(`conversation ${parent} of session ${sessionId} is missing`);
        conv = await tree.guard.fork(from, before.id, { ownership: { kind: "ownerless" } }, context);
        const carried = prefixLedger(ts.sync.ledger, Number(before.id));
        if (carried.order.length > 0 || carried.inherited)
          await conv.commit(async (tx) => {
            const ledger = await tx.doc(CommandsDoc, conv.id);
            Object.assign(ledger, JSON.parse(JSON.stringify(carried)));
          }, context);
      }
      const requestId = newId("req", this.#clock.now());
      this.#store.addBranch({
        sessionId,
        conversationId: String(conv.id),
        parentConversationId: parent,
        cutEntryId: first ? null : String(before.id),
        replacedMessageId: messageId,
      });
      // Retry keeps all references; edited text retains only mentions whose exact range is unchanged.
      const mentions = editedMentions ?? original.mentions?.filter((m) => text.slice(m.start, m.end) === `@${m.label}`);
      // Retry keeps the skills, each at the version the message was sent with; Edit may drop them or keep a subset.
      const skills = editedSkills ?? original.selectedSkills?.map(({ id, version }) => ({ id, version }));
      let sent: AdmitResult;
      try {
        await this.#swapIn(tree, sessionId, conv);
        sent = await this.send(
          {
            sessionId,
            requestId,
            text,
            ...(original.attachments ? { attachments: original.attachments } : {}),
            ...(mentions ? { mentions } : {}),
            ...(skills?.length ? { selectedSkills: skills } : {}),
            // The chat keeps its title when its first message is rewound.
            ...(first ? { keepTitle: true } : {}),
          },
          tree,
        );
      } catch (error) {
        if (this.#store.getSessionRow(sessionId) && !tree.session(sessionId)?.sync.ledger.byRequest[requestId]) {
          this.#store.undoBranch(sessionId, String(conv.id), active, rows.length > 0);
          await this.#swapIn(tree, sessionId, ts.conv);
        }
        await this.#afterSwap(sessionId);
        throw error;
      }
      await this.#afterSwap(sessionId);
      this.#log.info("session.rewound", { sessionId, first, retried: original.text === text });
      return { session: this.#store.getSession(sessionId)!, messageId: sent.messageId, runId: sent.runId };
    });
  }

  /** Shows a neighboring version, with whichever continuation was last active below it. */
  async switchVersion(sessionId: string, { messageId, to }: SwitchVersionRequest): Promise<void> {
    const row = this.#store.getSessionRow(sessionId);
    if (!row) throw notFound("That session does not exist.");
    const tree = await this.#trees.open(row.tree_id);
    await tree.serial(async () => {
      const ts = tree.session(sessionId);
      if (!ts || !this.#store.getSessionRow(sessionId)) throw notFound("That session does not exist.");
      this.#refuseBusy(sessionId);
      const item = await this.views.findItem(sessionId, messageId);
      if (!item) throw notFound("That message does not exist.");
      const rows = this.#store.branchesOf(sessionId);
      const groups = versionsByCut(rows);
      let target: string | undefined;
      let cut: string | null = null;
      if (item.role === "user" && item.entryId !== undefined && item.versions) {
        const { before, input } = await this.views.inputBefore(sessionId, Number(item.entryId));
        cut = input && before ? String(before.id) : null;
        const versions = groups.get(cut);
        if (versions) {
          const current = activeVersion(versions, chainOf(rows, String(ts.conv.id)));
          target = versions[to === "prev" ? current - 2 : current];
        }
      }
      if (target === undefined) throw new HttpError(409, "no_version", "There is no other version in that direction.");
      const leaf = latestLeaf(rows, target, cut === null ? null : Number(cut));
      const conv = await tree.harness.conversation(Number(leaf) as ConversationId, context);
      if (!conv) throw new Error(`conversation ${leaf} of session ${sessionId} is missing`);
      this.#refuseBusy(sessionId);
      this.#store.activateBranch(sessionId, leaf);
      await this.#swapIn(tree, sessionId, conv);
      await this.#afterSwap(sessionId);
    });
  }

  /**
   * A chat is busy while a run is going or queued, an approval waits, or a manual compaction runs: a rewind or a
   * version switch then would swap the conversation out from under it (409 `busy`).
   */
  #refuseBusy(sessionId: string): void {
    if (
      this.#store.hasUnfinishedRun(sessionId) ||
      this.#approvalStore.pendingForSession(sessionId).length > 0 ||
      this.compactions.active(sessionId)
    )
      throw new HttpError(409, "busy", "Wait for the reply to finish, or stop it.");
  }

  /**
   * Swaps `conv` in under the session (inside `tree.serial`, after the store names it). Waits, bounded, for Rei to finish
   * settling the runs that just ended, so their effects land on the conversation they ran in.
   */
  async #swapIn(tree: OpenTree, sessionId: string, conv: Conversation): Promise<void> {
    const deadline = Date.now() + this.#o.deleteSettleMs;
    while (
      this.#store.runs.forSession(sessionId).some((r) => !r.settled && r.status !== "queued") &&
      Date.now() < deadline
    )
      await sleep(10);
    await this.#trees.swapConversation(tree, sessionId, conv);
    tree.lastActivity = this.#clock.now();
  }

  /** After a swap: the history index follows the active chain, and every watcher gets the new conversation's view. */
  async #afterSwap(sessionId: string): Promise<void> {
    const row = this.#store.getSessionRow(sessionId);
    const ts = row ? this.#trees.get(row.tree_id)?.session(sessionId) : undefined;
    if (row && ts) {
      const chain = chainOf(this.#store.branchesOf(sessionId), String(ts.conv.id));
      const runs = new Set(ts.sync.ledger.order);
      this.#store.memoryHooks?.branchVisibility?.(sessionId, (entry) =>
        entry.run_id !== null
          ? runs.has(entry.run_id)
          : entry.pi_conversation_id !== null && entry.pi_entry_id !== null
            ? inChain(chain, entry.pi_conversation_id, Number(entry.pi_entry_id))
            : true,
      );
      const model = await this.views.view(sessionId);
      const preview = model.items.findLast(
        (item) => (item.role === "assistant" || item.role === "user") && item.text.trim(),
      );
      this.#store.refreshBranchSession(sessionId, collapse(preview?.text ?? ""), model.runs.at(-1)?.status);
    }
    await this.views.rebind(sessionId);
    this.views.refreshForkSources(sessionId);
  }

  /** A surface action (a button press or a final submit): decided against the stored surface, then an input. */
  surfaceAction(sessionId: string, surfaceId: string, request: SurfaceActionRequest): Promise<SurfaceActionResponse> {
    return this.surfaceActions.send(sessionId, surfaceId, request);
  }

  // ---- delete --------------------------------------------------------------------------------------------------------

  /**
   * Deletes a session (hide at once, cancel, purge, then remove the tree file when the last session of the tree
   * is gone). `withForks` deletes the session and every session branched from it, too. `clearHome` lets a home chat
   * be deleted (the agent gets a new one); "purge" deletes it with no new one (the agent is being deleted). Resolves when
   * it is all done.
   */
  deleteSession(sessionId: string, withForks: boolean, clearHome: boolean | "purge" = false): Promise<void> {
    const next = this.#deleteChain.then(async () => {
      const row = this.#store.getSessionRow(sessionId);
      if (!row) throw notFound("That session does not exist.");
      if (row.origin === "home") {
        // Only "forget" may clear a home chat: it is deleted like any other and the agent gets a fresh one in a new tree.
        if (!clearHome) throw new HttpError(409, "home_chat", "A home chat can't be deleted.");
        if (clearHome !== "purge") {
          const fresh = this.#store.replaceHome(row.agent_id);
          this.#files.create(fresh.treeId);
        }
      }
      const doomed = withForks ? [row, ...this.#store.forkDescendants(row.id)] : [row];
      const ids = new Set(doomed.map((r) => r.id));
      const removeTree = this.#store.treeSessions(row.tree_id).every((r) => ids.has(r.id));
      this.approvals.cancelForSessions([...ids]);
      this.onSessionsDeleting?.([...ids]);
      const jobId = this.#store.beginDeletion({ sessionIds: [...ids], treeId: row.tree_id, removeTree });
      const job = this.#store.deletionJobs().find((j) => j.id === jobId)!;
      await this.#runDeletion(job);
    });
    this.#deleteChain = next.catch(() => undefined);
    return next;
  }

  /** The rest of a deletion, after the sessions are hidden. Safe to run again (startup runs what a crash left). */
  async #runDeletion(job: DeletionJob): Promise<void> {
    const store = this.#store;
    // 1. Stop the runs and give them a bounded time to settle; whatever is left is closed here.
    for (const id of job.sessionIds) {
      const row = store.getSessionRowAny(id);
      if (row) await this.commands.cancel(row.id, { withdrawAll: true }).catch(() => undefined);
    }
    const deadline = Date.now() + this.#o.deleteSettleMs;
    while (job.sessionIds.some((id) => store.nonTerminalRuns(id).length > 0) && Date.now() < deadline) await sleep(25);
    for (const id of job.sessionIds) for (const run of store.nonTerminalRuns(id)) store.dropQueuedAdmission(run.id);
    // 2. Stop syncing them (or close the whole tree, which is about to go).
    if (job.removeTree) {
      await this.#trees.close(job.tree_id, true).catch(() => undefined);
    } else {
      const tree = this.#trees.get(job.tree_id);
      if (tree) for (const id of job.sessionIds) await this.#trees.detachSession(tree, id);
    }
    // 3. Purge what the app store holds (trace steps and payloads, cards, outbox rows). The transcript goes with Pi.
    const refs = store.purgeSessions(job.id);
    for (const ref of refs) {
      try {
        await this.#traceBlobs.delete(ref);
      } catch (error) {
        this.#log.error("deletion.blob_failed", {
          jobId: job.id,
          error: error instanceof Error ? error.name : "error",
        });
      }
    }
    // 4. The tree's file, when no live session is left in it.
    if (job.removeTree) {
      if (this.#files.exists(job.tree_id)) this.#files.deleteTree(job.tree_id);
      store.markTreeDeleted(job.tree_id);
      // Agent-owned files outlive individual chats and workers.
    }
    store.finishDeletionJob(job.id);
    this.#log.info("session.deleted", { jobId: job.id, sessions: job.sessionIds.length, removedTree: job.removeTree });
  }

  // ---- report-back ---------------------------------------------------------------------------------------------------

  /**
   * Delivers every pending report: a report message and a reaction run in the parent, once per request id, then
   * kicks the parent. Runs on write, on startup and on every tick, so a report is delivered at least once.
   */
  async deliverReports(): Promise<void> {
    if (this.holdReports || this.#stopped) return;
    if (this.#delivering) {
      this.#deliverAgain = true;
      return;
    }
    this.#delivering = true;
    try {
      do {
        this.#deliverAgain = false;
        for (const row of this.#store.pendingOutbox("report")) {
          try {
            const target = this.#store.reportToDeliver(row);
            if (!target) continue;
            const { parent, report } = target;
            const admitted = await this.commands.admit({
              sessionId: parent.id,
              requestId: row.request_id,
              role: "report",
              text: reportLine(report),
              report,
              modelText: reportInputText(report) + REPORT_REVIEW,
              ...(report.files?.length ? { attachments: report.files } : {}),
            });
            this.#store.reportDelivered(row, parent.id, report, admitted.runId);
          } catch (error) {
            if (error instanceof AdmissionDeferred) continue;
            this.#store.bumpOutboxAttempts(row.id);
            this.#log.error("report.delivery_failed", {
              requestId: row.request_id,
              error: error instanceof Error ? error.name : "error",
            });
          }
        }
      } while (this.#deliverAgain && !this.holdReports && !this.#stopped);
    } finally {
      this.#delivering = false;
    }
  }

  // ---- session tools (SessionHost) ---------------------------------------------------------------------------------

  async startSession(input: {
    caller: SessionRow;
    callId: string;
    brief: string;
    title?: string;
    agent?: string;
  }): Promise<ToolText> {
    const { caller } = input;
    const brief = input.brief.trim();
    if (brief === "") return fail("The brief is empty. Say what the session should do.");
    let agentId = caller.agent_id;
    if (input.agent !== undefined && input.agent.trim() !== "") {
      const wanted = input.agent.trim().toLowerCase();
      const agents = this.#store.listAgents();
      const found =
        agents.find((a) => a.id === input.agent!.trim()) ?? agents.find((a) => a.name.toLowerCase() === wanted);
      if (!found)
        return fail(
          `Unknown agent "${input.agent.trim()}". Available agents: ${agents.map((a) => `${a.name} (${a.id})`).join(", ")}.`,
        );
      agentId = found.id;
    }
    const given = input.title?.replace(/\s+/g, " ").trim();
    const title = given ? given.slice(0, 60) : titleFromBrief(brief);
    try {
      const made = this.#store.createSpawned({
        callerId: caller.id,
        spawnKey: `${caller.id}:${input.callId}`,
        brief,
        title,
        agentId,
        maxDepth: this.#o.maxSessionDepth,
        maxActive: this.#o.maxActiveChildren,
      });
      if (made.deleted) return ok(`Session "${made.session.title}" was started earlier and has since been deleted.`);
      // Also for a replay: the first attempt may have died before the brief was admitted (admission is idempotent).
      await this.commands.admit({
        sessionId: made.session.id,
        requestId: `brief:${caller.id}:${input.callId}`,
        role: "user",
        text: brief,
        from: { sessionId: caller.id, title: caller.title },
        assignedBy: caller.id,
      });
      return ok(
        `Started session "${made.session.title}" (${made.session.id}). It will report back here when it finishes.`,
      );
    } catch (error) {
      if (error instanceof SpawnRefused) return fail(error.message);
      throw error;
    }
  }

  #ownChild(caller: SessionRow, sessionId: string): SessionRow | undefined {
    const child = this.#store.getSessionRow(sessionId);
    return child && child.parent_session_id === caller.id ? child : undefined;
  }

  async messageSession(input: {
    caller: SessionRow;
    callId: string;
    sessionId: string;
    text: string;
  }): Promise<ToolText> {
    const child = this.#ownChild(input.caller, input.sessionId);
    if (!child)
      return fail(`${input.sessionId} is not one of your sessions. Use list_sessions to see the ones you started.`);
    if (input.text.trim() === "") return fail("The message is empty.");
    if (input.text.length > MAX_MESSAGE_CHARS)
      return fail(`The message is too long (at most ${MAX_MESSAGE_CHARS} characters).`);
    try {
      await this.commands.admit({
        sessionId: child.id,
        requestId: `msg:${input.caller.id}:${input.callId}`,
        role: "user",
        text: input.text,
        from: { sessionId: input.caller.id, title: input.caller.title },
        assignedBy: input.caller.id,
        whenBusy: "steer",
      });
    } catch (error) {
      if (error instanceof AdmissionDeferred)
        return fail(`${child.title} is compacting its conversation. Try again in a moment.`);
      throw error;
    }
    return ok(
      `Sent your message to session "${child.title}" (${child.id}). It will report back here when it finishes.`,
    );
  }

  async cancelSession(input: { caller: SessionRow; sessionId: string }): Promise<ToolText> {
    const child = this.#ownChild(input.caller, input.sessionId);
    if (!child)
      return fail(`${input.sessionId} is not one of your sessions. Use list_sessions to see the ones you started.`);
    const result = await this.commands.cancel(child.id, { withdrawAll: true });
    return ok(
      result.cancelledRunId
        ? `Cancelled the work of session "${child.title}" (${child.id}).`
        : `Session "${child.title}" (${child.id}) has nothing running.`,
    );
  }

  listSessions(caller: SessionRow): ToolText {
    const children = this.#store.childrenOf(caller.id);
    if (children.length === 0) return ok("You have not started any sessions.");
    const lines = children.map((c) => {
      const report = this.#store.lastReportFrom(caller.id, c.id);
      const last = report
        ? ` Last report (${report.outcome}): ${report.summary.replace(/\s+/g, " ").slice(0, 300) || "(no text)"}`
        : "";
      return `- ${c.id} "${c.title}" ${statusWord(c.status)}.${last}`;
    });
    return ok(lines.join("\n"));
  }
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 200);
