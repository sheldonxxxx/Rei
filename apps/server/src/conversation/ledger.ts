// The Rei command ledger and the Rei entry kinds: what Rei writes into a Pi conversation besides Pi's own records.
//
// The ledger (`rei.commands`) is a Rei-owned Pi document written in the same commit as the submission it describes
// (`Conversation.submit(tx, draft)`), so a command is recorded together with its submission or not at all. It holds the
// product facts Pi does not: who asked, which trigger run it belongs to, whether the reply is silent, and whether
// Rei has processed the run's settlement.

import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import type {
  Attachment,
  ErrorInfo,
  MessageMention,
  MessageSkill,
  SessionReport,
  SurfaceActionRef,
  TriggerMessage,
} from "@rei/protocol";

export type InputRole = "user" | "report" | "trigger" | "notice";

export type CommandRecord = {
  /** The client's request id (idempotency key) when the command came from a client. */
  requestId: string;
  kind: "input" | "continue";
  role: InputRole;
  /** Whether the user is behind this run (a user chat's own message). */
  direct: boolean;
  assignedBy?: string;
  triggerRunId?: string;
  createdAt: number;
  submissionId?: number;
  cancelRequested?: boolean;
  silent?: boolean;
  /** Rei has committed the run's settlement effects (status, report, notify, title). */
  settled?: boolean;
  /** Set when the command failed before it reached Pi (attachment staging); no submission exists. */
  error?: { code: string; message: string };
  /** When Rei marked the run started (submission placed). */
  startedAt?: number;
  endedAt?: number;
  /** The run's input was the first message you typed in the session (a chat you started is titled from it). */
  firstUser?: boolean;
  /** A digest of the text Pi was given (the home chat's context window finds this input among the model messages). */
  inputDigest?: string;
  /** Files the run's reply produced (library outputs), shown with the reply. */
  files?: Attachment[];
  /** A continue: the newest entry when it was admitted (its reply follows it). */
  afterEntry?: number;
  /** Set with `settled`: how the run ended, its error, and its entries (so a reopened tree needs no submission reads). */
  outcome?: "completed" | "failed" | "cancelled";
  failure?: { code: string; message: string };
  entryId?: number;
  answerId?: number;
};

export type Ledger = {
  order: string[];
  byId: Record<string, CommandRecord>;
  byRequest: Record<string, string>;
  /** Files published by runs of the chat this one was forked from, by run id (a fork starts with no runs of its own). */
  inherited?: Record<string, Attachment[]>;
};

export const COMMANDS_KIND = "rei.commands";

export const CommandsDoc = defineDoc<Ledger & JsonObject>({
  kind: COMMANDS_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork starts with no commands of its own: its runs are its own.
  fork: "initial",
  initial: () => ({ order: [], byId: {}, byRequest: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** Entry kinds Rei writes. */
export const INPUT_KIND = "rei.input";
export const NOTICE_KIND = "rei.notice";
export const TAKEOVER_NOTE_KIND = "app.takeover";
export const TRIGGER_KIND = "rei.trigger";

/** Display data of an input entry (`rei.input`); the model sees the staged content, not this. */
export interface InputData {
  runId: string;
  role: InputRole;
  text: string;
  at: number;
  /** Stop withdrew this input before Pi placed it in model context. */
  withdrawn?: true;
  /** Sent to steer a running reply: placed after its current tool round instead of after it answers. */
  steer?: true;
  attachments?: Attachment[];
  mentions?: MessageMention[];
  /** The skills the user selected: id, the version frozen at admission, and the name the chip showed. */
  selectedSkills?: MessageSkill[];
  from?: { sessionId: string; title: string };
  surfaceAction?: SurfaceActionRef;
  trigger?: TriggerMessage;
  report?: SessionReport;
  assignedBy?: string;
  [key: string]: unknown;
}

export interface NoticeData {
  text: string;
  at: number;
  runId?: string;
  [key: string]: unknown;
}

export interface TriggerLineData {
  trigger: TriggerMessage;
  at: number;
  [key: string]: unknown;
}

export const isInputData = (data: unknown): data is InputData =>
  typeof data === "object" && data !== null && typeof (data as { runId?: unknown }).runId === "string";

export type RunFailure = ErrorInfo;

/** The digest a ledger record keeps of an input's model text. */
export function inputDigest(text: string): string {
  // FNV-1a, 64-bit, over UTF-16 code units: portable and synchronous; it only has to tell this chat's inputs apart.
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `${text.length.toString(36)}:${hash.toString(36)}`;
}

/**
 * The ledger a rewind's fork starts with: the settled runs of the conversation it was cut from whose entries are at or
 * before the cut (the runs of the kept prefix), with their request keys and the files inherited from another chat. A
 * fork's own ledger starts empty (`fork: "initial"`), so without this the kept messages would lose their runs: their
 * overlays, files, trace links and recall. A run that never reached Pi (no entry) is not carried.
 */
export function prefixLedger(source: Ledger, cut: number): Ledger {
  const out: Ledger = { order: [], byId: {}, byRequest: {} };
  for (const runId of source.order) {
    const record = source.byId[runId];
    if (!record?.settled) continue;
    const at = record.kind === "continue" ? record.afterEntry : record.entryId;
    if (at === undefined || at > cut) continue;
    out.order.push(runId);
    out.byId[runId] = JSON.parse(JSON.stringify(record)) as CommandRecord;
  }
  for (const [key, runId] of Object.entries(source.byRequest)) if (out.byId[runId]) out.byRequest[key] = runId;
  if (source.inherited) out.inherited = JSON.parse(JSON.stringify(source.inherited)) as Ledger["inherited"];
  return out;
}
