// The Conversation View as a pure function of what Pi and Rei hold: a window of Pi entries, Pi's live state and inbox,
// the runs (Pi submissions plus the Rei command ledger), and the overlays (approval, takeover and memory cards). Every
// client shape comes from here; raw Pi documents never reach a client.

import type { AssistantMessage, Message as PiMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, InboxState, LiveState } from "@earendil-works/pi-durable";
import type {
  Approval,
  Attachment,
  ChatItem,
  ConversationLive,
  ConversationOverlay,
  MessageMemory,
  Run,
  Takeover,
} from "@rei/protocol";
import { runFailureError } from "../pi/errors.ts";
import type { SurfacesState } from "../surfaces/model.ts";
import { surfaceParts } from "../surfaces/text.ts";
import {
  INPUT_KIND,
  type InputData,
  isInputData,
  NOTICE_KIND,
  type NoticeData,
  TAKEOVER_NOTE_KIND,
  TRIGGER_KIND,
  type TriggerLineData,
} from "./ledger.ts";
import { currentRun, entryItemId, overlayItemId, type RunRow, replyItemId, toRun, userItemId } from "./runs.ts";

export const REPORT_KIND = "rei.report";
const INPUT_KINDS = new Set([INPUT_KIND, REPORT_KIND]);

export interface OverlayRow {
  id: string;
  session_id: string;
  kind: "approval" | "takeover" | "memory";
  ref_id: string;
  run_id: string | null;
  task_id: string | null;
  entry_id: string | null;
  json: string;
  text: string;
  created_at: number;
}

export interface ViewInputs {
  sessionId: string;
  origin: string;
  /** Entries of the window, ascending by id. */
  entries: readonly EntryRecord[];
  /** The id of the entry just before the window (paging); undefined when the window starts the transcript. */
  before: string | undefined;
  live: LiveState | undefined;
  inbox: InboxState | undefined;
  /** Runs this view may show, by id: those whose input is in the window, and every unfinished one. */
  runs: ReadonlyMap<string, RunRow>;
  /** Run ids in admission order (the ledger), for queued inputs that have no entry yet. */
  order: readonly string[];
  /** Display data of queued inputs, by run id (from `pi.inbox`). */
  queued: ReadonlyMap<string, InputData>;
  /** Files a run's reply produced, by run id. */
  files: ReadonlyMap<string, Attachment[]>;
  /** The newest manual compaction (`/compact`) that has not ended: Rei's own record, since Pi has no request. */
  manualCompaction?: ConversationLive["manualCompaction"];
  overlays: readonly OverlayRow[];
  /** The conversation's surfaces (`rei.surfaces`); each shows in the reply of the run that made it. */
  surfaces?: SurfacesState;
  /** When true, the view includes queued inputs and cards that can stand on their own. */
  newest: boolean;
}

export interface ViewModel {
  items: ChatItem[];
  runs: Run[];
  live: ConversationLive;
  overlays: ConversationOverlay[];
  before: string | null;
}

export const textOf = (message: PiMessage | AssistantMessage | undefined): string => {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : "")).join("");
};

const timestampOf = (entry: EntryRecord): number | undefined => {
  const at = (entry.data as { at?: unknown } | undefined)?.at;
  if (typeof at === "number") return at;
  const ts = (entry.model?.[0] as { timestamp?: unknown } | undefined)?.timestamp;
  return typeof ts === "number" ? ts : undefined;
};

interface Reply {
  runId: string;
  text: string;
  /** Text of an aborted generation, shown only when the run was cancelled (a crashed stream's partial is not). */
  abortedText?: string;
  errorText?: string;
  entryId?: string;
  /** An imported reply's reasoning (`ImportedAnswerData`), shown in detail mode only. */
  thinking?: string[];
  createdAt: number;
}

/**
 * Display data of an imported answer: a `pi.assistant` entry whose model message holds only the answer text, so the
 * reasoning the other app showed rides here, where the model never looks and history indexing never reads.
 */
export interface ImportedAnswerData {
  thinking?: string[];
  [key: string]: unknown;
}

const thinkingOf = (entry: EntryRecord): string[] | undefined => {
  const thinking = (entry.data as ImportedAnswerData | undefined)?.thinking;
  return Array.isArray(thinking) && thinking.length > 0 && thinking.every((t) => typeof t === "string")
    ? thinking
    : undefined;
};

/** Recover the state for older withdrawn entries that predate the display marker. */
function wasWithdrawn(run: RunRow | undefined): boolean {
  return run?.status === "cancelled" && run.kind === "input" && run.entry_id === null;
}

/** The user-facing item of an input entry (or a queued input) of a run. */
function inputItem(sessionId: string, data: InputData, run: RunRow | undefined, entryId: string | undefined): ChatItem {
  const role =
    data.role === "report"
      ? "report"
      : data.role === "trigger"
        ? "trigger"
        : data.role === "notice"
          ? "notice"
          : "user";
  const placed = entryId !== undefined;
  const terminal = run ? run.status === "completed" || run.status === "failed" || run.status === "cancelled" : placed;
  const withdrawn = data.withdrawn === true || wasWithdrawn(run);
  const status = withdrawn ? "aborted" : placed || (run && run.status !== "queued") ? "complete" : "pending";
  const item: ChatItem = {
    id: userItemId(data.runId),
    sessionId,
    role,
    // An input a fork copied belongs to a run of the chat it came from: here it has no run.
    runId: run ? data.runId : null,
    text: data.text,
    status: status === "pending" && terminal ? "complete" : status,
    ...(data.attachments?.length ? { attachments: data.attachments } : {}),
    ...(data.mentions?.length ? { mentions: data.mentions } : {}),
    ...(data.selectedSkills?.length ? { selectedSkills: data.selectedSkills } : {}),
    ...(data.from ? { from: data.from } : {}),
    ...(data.report ? { report: data.report } : {}),
    ...(data.trigger ? { trigger: data.trigger } : {}),
    ...(data.surfaceAction ? { surfaceAction: data.surfaceAction } : {}),
    ...(entryId !== undefined ? { entryId } : {}),
    ...(run && role === "user" ? { requestId: run.request_id } : {}),
    ...(data.steer ? { steer: true } : {}),
    createdAt: data.at,
  };
  // Edit and Retry: a message you typed that Pi has seen and that is not still being answered.
  if (
    role === "user" &&
    !data.from &&
    !data.surfaceAction &&
    !data.assignedBy &&
    !withdrawn &&
    terminal &&
    (entryId !== undefined || (data.attachments?.length && run?.status === "failed"))
  )
    item.editable = true;
  return item;
}

function replyItem(
  sessionId: string,
  origin: string,
  reply: Reply,
  run: RunRow | undefined,
  inputRole: string | undefined,
  files: Attachment[] | undefined,
  live: LiveState | undefined,
  liveRunId: string | null,
  steeredOver = false,
): ChatItem | undefined {
  const status = run?.status ?? "completed";
  let text = reply.text;
  let itemStatus: ChatItem["status"];
  let error: ChatItem["error"];
  let entryId = reply.entryId;
  // A steer joined this reply after a tool round: what came before it is done, and the answer shows under the steer.
  if (steeredOver && (status === "running" || status === "completed")) {
    itemStatus = "complete";
    entryId = undefined;
  } else if (status === "completed") itemStatus = "complete";
  else if (status === "running") {
    itemStatus = "streaming";
    // The in-flight generation's committed partial (Pi stores it shortly after; a host crash can lose it).
    if (liveRunId === reply.runId && live?.generation?.message) {
      const partial = textOf(live.generation.message as unknown as AssistantMessage);
      if (partial !== "" || text === "") text = partial;
    }
    entryId = undefined;
  } else if (status === "cancelled") {
    itemStatus = "aborted";
    if (reply.abortedText !== undefined && reply.abortedText !== "") text = reply.abortedText;
    entryId = undefined;
  } else if (status === "failed") {
    itemStatus = "error";
    if (reply.errorText !== undefined && reply.errorText !== "") text = reply.errorText;
    error = run?.error_code ? { code: run.error_code, message: run.error_message ?? "" } : undefined;
    entryId = undefined;
  } else return undefined; // queued: no reply yet
  const eventRun = origin === "home" && (inputRole === "trigger" || inputRole === "report");
  const internal = run?.silent === 1 || (eventRun && status === "running");
  return {
    id: replyItemId(reply.runId),
    sessionId,
    role: "assistant",
    runId: reply.runId,
    text,
    status: itemStatus,
    ...(internal ? { internal: true } : {}),
    ...(files?.length ? { attachments: files } : {}),
    ...(error ? { error } : {}),
    ...(itemStatus === "complete" && entryId !== undefined ? { forkable: true, entryId } : {}),
    ...(itemStatus === "complete" && reply.thinking ? { thinking: reply.thinking } : {}),
    createdAt: reply.createdAt,
  };
}

function overlayItem(row: OverlayRow): ChatItem {
  const base: ChatItem = {
    id: overlayItemId(row.id),
    sessionId: row.session_id,
    role: row.kind,
    runId: row.run_id,
    text: row.text,
    status: "complete",
    createdAt: row.created_at,
  };
  const value = JSON.parse(row.json) as unknown;
  if (row.kind === "approval") base.approval = value as Approval;
  else if (row.kind === "takeover") base.takeover = value as Takeover;
  else base.memory = value as MessageMemory;
  return base;
}

/**
 * Where a card belongs: its tool task, entry or run. A script's approval is anchored to its nested task and names the
 * `codemode` call it belongs under (`parentCallId`, from the approval), so a client can place it under the script's row.
 */
const anchorOf = (row: OverlayRow, item: ChatItem): ConversationOverlay["anchor"] => {
  if (row.task_id) {
    const parentCallId = item.approval?.parentCallId;
    return { taskId: row.task_id, ...(parentCallId ? { parentCallId } : {}) };
  }
  return row.entry_id ? { entryId: row.entry_id } : { runId: row.run_id ?? "" };
};

const isOpenTakeover = (takeover: Takeover): boolean => takeover.status === "pending" || takeover.status === "active";

/** The running run: the one whose submission was placed and is not finished. */
/** The run being answered now: after a steer joined the running reply, the steer's run (what the model writes is its). */
function liveRunOf(runs: ReadonlyMap<string, RunRow>): string | null {
  return currentRun(runs.values())?.id ?? null;
}

export function liveOf(
  live: LiveState | undefined,
  runs: ReadonlyMap<string, RunRow>,
  manualCompaction?: ConversationLive["manualCompaction"],
): ConversationLive {
  const runId = liveRunOf(runs);
  const out: ConversationLive = { runId };
  if (manualCompaction) out.manualCompaction = manualCompaction;
  if (live?.run) out.turns = live.run.turns;
  if (live?.generation && runId) {
    out.generation = {
      attempt: live.generation.attempt,
      text: textOf(live.generation.message as unknown as AssistantMessage),
      ...(live.generation.retry
        ? { retry: { attempt: live.generation.attempt, error: live.generation.retry.error } }
        : {}),
    };
  }
  const tools = [
    ...(live?.tools ?? []).map((t) => ({ callId: t.callId, name: t.name, status: t.status })),
    ...(live?.nestedTools ?? []).map((t) => ({
      callId: t.callId,
      name: t.name,
      status: t.status,
      nested: true,
      parentCallId: t.parentCallId,
    })),
  ];
  if (tools.length > 0) out.tools = tools;
  if (live?.compactions?.length) out.compaction = { status: "running" };
  else if (live?.compactionFailure) out.compaction = { status: "failed", error: live.compactionFailure.error };
  if (live?.runFailure && !live.run) {
    const failed = [...runs.values()].filter((r) => r.status === "failed").pop();
    out.runFailure = {
      runId: failed?.id ?? null,
      reason: live.runFailure.reason,
      error: runFailureError(live.runFailure.reason, live.runFailure.detail),
      canContinue: runId === null && live.runFailure.reason !== "aborted" && live.runFailure.reason !== "reset",
    };
  }
  return out;
}

export function buildView(input: ViewInputs): ViewModel {
  const { sessionId, origin, runs } = input;
  const liveRunId = liveRunOf(runs);
  const items: ChatItem[] = [];
  const overlays: ConversationOverlay[] = [];
  const standaloneTakeovers = new Map(
    input.overlays.filter((row) => row.kind === "takeover" && row.run_id === null).map((row) => [row.ref_id, row]),
  );
  const replies = new Map<string, Reply>();
  const inputRoles = new Map<string, string>();
  const shownRuns = new Set<string>();
  /** Replies a steer joined before they answered (their run's answer shows under the steer). */
  const steeredOver = new Set<string>();
  let current: string | undefined;

  for (const entry of input.entries) {
    const entryId = String(entry.id);
    const message = entry.model?.[0];
    if (INPUT_KINDS.has(entry.kind) && isInputData(entry.data)) {
      const data = entry.data;
      if (data.steer && current !== undefined) {
        const before = replies.get(current);
        // Placed mid-reply (after a tool round, so the reply has a tool-calling message), not after an answer, a
        // failure or a stop. A steer sent while the chat was idle follows an answer and joins nothing.
        if (
          before &&
          before.entryId === undefined &&
          before.abortedText === undefined &&
          before.errorText === undefined
        )
          steeredOver.add(current);
      }
      current = data.runId;
      shownRuns.add(data.runId);
      inputRoles.set(data.runId, data.role);
      items.push(inputItem(sessionId, data, runs.get(data.runId), entryId));
      continue;
    }
    switch (entry.kind) {
      case "pi.user": {
        // An input Rei did not write (a reset's handoff): shown as you wrote it, answered by what follows.
        current = `pi-${entryId}`;
        items.push({
          id: entryItemId(entryId),
          sessionId,
          role: "user",
          runId: null,
          text: textOf(message),
          status: "complete",
          entryId,
          createdAt: timestampOf(entry) ?? 0,
        });
        break;
      }
      case "pi.assistant": {
        if (current === undefined || message?.role !== "assistant") break;
        let reply = replies.get(current);
        if (!reply) {
          reply = { runId: current, text: "", createdAt: timestampOf(entry) ?? 0 };
          replies.set(current, reply);
        }
        const text = textOf(message);
        switch (message.stopReason) {
          case "stop":
          case "length": {
            reply.text = text;
            reply.entryId = entryId;
            const thinking = thinkingOf(entry);
            if (thinking) reply.thinking = thinking;
            else delete reply.thinking;
            break;
          }
          case "aborted":
            reply.abortedText = text || reply.text;
            break;
          case "error":
            reply.errorText = text;
            break;
          default:
            reply.text = text;
        }
        break;
      }
      case "pi.compaction":
        items.push({
          id: entryItemId(entryId),
          sessionId,
          role: "compaction",
          runId: null,
          text: "Earlier messages were summarized to keep the conversation within the model's context.",
          status: "complete",
          entryId,
          createdAt: timestampOf(entry) ?? 0,
        });
        break;
      case "pi.reset":
        items.push({
          id: entryItemId(entryId),
          sessionId,
          role: "reset",
          runId: null,
          text: "A new context started here.",
          status: "complete",
          entryId,
          createdAt: timestampOf(entry) ?? 0,
        });
        break;
      case NOTICE_KIND: {
        const data = entry.data as NoticeData;
        items.push({
          id: entryItemId(entryId),
          sessionId,
          role: "notice",
          runId: data.runId ?? null,
          text: data.text,
          status: "complete",
          createdAt: data.at,
        });
        break;
      }
      case TAKEOVER_NOTE_KIND: {
        const data = entry.data as { id?: string; notice?: string; at?: number } | undefined;
        if (data?.notice && typeof data.at === "number")
          items.push({
            id: entryItemId(entryId),
            sessionId,
            role: "notice",
            runId: null,
            text: data.notice,
            status: "complete",
            createdAt: data.at,
          });
        const row = data?.id ? standaloneTakeovers.get(data.id) : undefined;
        if (!row) break;
        const item = overlayItem(row);
        if (item.takeover && !isOpenTakeover(item.takeover)) {
          items.push(item);
          overlays.push({ itemId: item.id, kind: "takeover", anchor: { entryId } });
        }
        break;
      }
      case TRIGGER_KIND: {
        const data = entry.data as TriggerLineData;
        items.push({
          id: entryItemId(entryId),
          sessionId,
          role: "trigger",
          runId: null,
          text: data.trigger.text,
          status: "complete",
          trigger: data.trigger,
          createdAt: data.at,
        });
        break;
      }
      default:
        break; // tool results, system prompts and Pi bookkeeping are not shown
    }
  }

  // Queued inputs (admitted, not placed): at the end, in admission order.
  if (input.newest) {
    for (const runId of input.order) {
      const run = runs.get(runId);
      if (!run || shownRuns.has(runId)) continue;
      const data = input.queued.get(runId);
      if (run.status === "queued" && data) {
        shownRuns.add(runId);
        inputRoles.set(runId, data.role);
        items.push(inputItem(sessionId, data, run, undefined));
      } else if (run.status === "failed" && run.entry_id === null && data) {
        // Failed before Pi placed it (attachment staging): its input and its error stay visible.
        shownRuns.add(runId);
        inputRoles.set(runId, data.role);
        items.push(inputItem(sessionId, data, run, undefined));
      }
    }
  }

  // A continue answers the input before the entry it continued after: that reply shows the newest such run's state.
  const continuedBy = new Map<string, RunRow>();
  const anchors: { key: string; at: number }[] = [];
  for (const item of items) {
    if (item.status === "aborted") continue;
    if (item.entryId === undefined || (item.role !== "user" && !item.id.startsWith("u:"))) continue;
    anchors.push({ key: item.id.startsWith("u:") ? item.id.slice(2) : `pi-${item.entryId}`, at: Number(item.entryId) });
  }
  const continues = [...runs.values()]
    .filter((r) => r.kind === "continue" && r.entry_id !== null)
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  const continuesOf = new Map<string, string[]>();
  const inputOfContinue = new Map<string, string>();
  for (const run of continues) {
    const at = Number(run.entry_id);
    const anchor = anchors.filter((a) => a.at <= at).at(-1);
    if (anchor) {
      continuedBy.set(anchor.key, run);
      continuesOf.set(anchor.key, [...(continuesOf.get(anchor.key) ?? []), run.id]);
      inputOfContinue.set(run.id, anchor.key);
    }
  }

  // Each run's reply goes right after its input.
  const out: ChatItem[] = [];
  for (const item of items) {
    out.push(item);
    let key: string | undefined;
    let runId: string | undefined;
    if (item.id.startsWith("u:")) key = runId = item.id.slice(2);
    else if (item.role === "user" && item.entryId !== undefined) key = `pi-${item.entryId}`;
    if (key === undefined) continue;
    const run = runId ? runs.get(runId) : undefined;
    let reply = replies.get(key);
    // A queued input withdrawn by Cancel never ran: it has no reply.
    const withdrawn = item.status === "aborted" || wasWithdrawn(run);
    if (!reply && run && run.status !== "queued" && !withdrawn)
      reply = { runId: key, text: "", createdAt: run.started_at };
    if (!reply) continue;
    const continuer = continuedBy.get(key);
    const shown = replyItem(
      sessionId,
      origin,
      reply,
      continuer ?? run,
      inputRoles.get(key),
      runId ? input.files.get(runId) : undefined,
      input.live,
      continuer && liveRunId === continuer.id ? reply.runId : liveRunId,
      !continuer && steeredOver.has(key),
    );
    if (!shown) continue;
    if (!run) shown.runId = null;
    // A surface sits in the reply of its run (or a continue of it), before the answer text written after its call.
    const parts = surfaceParts(input.surfaces, [key, ...(continuesOf.get(key) ?? [])], sessionId, shown.text);
    if (parts) shown.parts = parts;
    // A reply a steer joined before it wrote anything (only tool calls) shows nothing of its own.
    if (steeredOver.has(key) && shown.status === "complete" && shown.text === "" && !shown.parts && !shown.attachments)
      continue;
    out.push(shown);
  }

  // Cards follow their run's last item. A memory card belongs only in the page that shows its source turn.
  const sorted = [...input.overlays].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  for (const row of sorted) {
    const item = overlayItem(row);
    // A finished takeover without a run belongs to the page with its outcome entry. A worker's
    // run-less copy in the parent is only actionable while the takeover is open.
    if (row.run_id === null && item.takeover && !isOpenTakeover(item.takeover)) continue;
    let at = -1;
    if (row.kind === "memory" && row.run_id) {
      const inputId = inputOfContinue.get(row.run_id) ?? row.run_id;
      at = out.findLastIndex(
        (m) =>
          m.id === replyItemId(inputId) || (m.runId !== null && (inputOfContinue.get(m.runId) ?? m.runId) === inputId),
      );
    } else if (row.run_id) at = out.findLastIndex((m) => m.runId === row.run_id);
    if (at === -1) {
      if (!input.newest || row.kind === "memory") continue;
      // A run-less approval is a parent's copy of a side chat's card. It sits at the end while it waits for an answer;
      // once decided it would only float at the end with an old date, and the side chat keeps the record.
      if (
        item.role === "approval" &&
        item.approval?.status !== "pending" &&
        ((!item.approval?.groupId && !item.approval?.resumesTool) || row.run_id !== null)
      )
        continue;
      out.push(item);
    } else out.splice(at + 1, 0, item);
    overlays.push({ itemId: item.id, kind: row.kind, anchor: anchorOf(row, item) });
  }

  // A continue has no input of its own: it is shown with the window that holds the entry it continued after.
  const first = input.entries[0] === undefined ? undefined : Number(input.entries[0].id);
  const last = input.entries.at(-1) === undefined ? undefined : Number(input.entries.at(-1)!.id);
  for (const run of runs.values()) {
    if (run.kind !== "continue" || run.entry_id === null || first === undefined) continue;
    const at = Number(run.entry_id);
    if (at >= first && (input.newest || (last !== undefined && at <= last))) shownRuns.add(run.id);
  }

  const shownRunList = [...runs.values()]
    .filter((r) => shownRuns.has(r.id) || r.status === "queued" || r.status === "running")
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
    .map(toRun);
  return {
    items: out,
    runs: shownRunList,
    live: liveOf(input.live, runs, input.manualCompaction),
    overlays,
    before: input.before === undefined ? null : entryItemId(input.before),
  };
}
