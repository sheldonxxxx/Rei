// Importing a past conversation from another app (docs/importing.md): one neutral transcript becomes one session of an
// agent, written straight into its Pi conversation without a model call. Each exchange is a run whose ledger record is
// settled from the start, so none of a finished run's effects (notification, title, memory review) ever fire for it.
// The other app's reasoning rides in the answer entry's `data`, which the model never sees.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  Attachment,
  ImportAttachment,
  ImportLookupResponse,
  ImportSessionResponse,
  ImportTranscript,
  ImportTurn,
} from "@rei/protocol";
import type { AttachmentService } from "../attachments/service.ts";
import type { TreeManager } from "../pi/trees.ts";
import type { AppStore } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import { badRequest, HttpError } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import type { Logger } from "../util/log.ts";
import {
  type CommandRecord,
  CommandsDoc,
  INPUT_KIND,
  type InputData,
  inputDigest,
  NOTICE_KIND,
  type NoticeData,
} from "./ledger.ts";
import { replyItemId, userItemId } from "./runs.ts";
import type { ImportedAnswerData } from "./view-model.ts";

const context = BACKGROUND_CONTEXT;

/** Exchanges written per Pi commit: small enough to keep a commit quick, large enough for a 2,000-turn chat. */
const EXCHANGES_PER_COMMIT = 100;
export const DEFAULT_IMPORT_NOTICE = "This chat was imported. Only its messages came along.";
/** The input line of an exchange the other app began with a reply of its own. */
export const LEADING_REPLY_TEXT = "The chat began with this reply.";
/** What an answer with no text says (the other app's reply was only a tool result, say). */
export const EMPTY_ANSWER_TEXT = "*(This reply had no text.)*";
export const UNAVAILABLE_FILE = "Not in export";

export interface ImportDeps {
  store: AppStore;
  trees: TreeManager;
  clock: Clock;
  log: Logger;
  attachments?: AttachmentService;
  /** The new chat's session and tree folder, recorded as a pending import. */
  begin(agentId: string, source: string, sourceId: string): { sessionId: string };
  /** Deletes a session through the usual delete chain (a half-written import is redone from scratch). */
  deleteSession(sessionId: string): Promise<void>;
}

interface Answer {
  text: string;
  at: number;
  model?: string;
  thinking: string[];
}

/** One run: a user turn (or none, when the chat began with a reply) and the reply that followed it. */
interface Exchange {
  input?: ImportTurn;
  answer?: Answer;
}

/** Pairs each user turn with the reply after it; replies in a row are one reply. */
export function exchangesOf(turns: readonly ImportTurn[]): Exchange[] {
  const out: Exchange[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      out.push({ input: turn });
      continue;
    }
    const last = out.at(-1);
    const thinking = turn.thinking ?? [];
    if (last?.answer) {
      const a = last.answer;
      a.text = [a.text, turn.text].filter((t) => t.trim() !== "").join("\n\n");
      a.thinking.push(...thinking);
      if (turn.model) a.model = turn.model;
      continue;
    }
    const answer: Answer = {
      text: turn.text,
      at: turn.at,
      ...(turn.model ? { model: turn.model } : {}),
      thinking: [...thinking],
    };
    if (last) last.answer = answer;
    else out.push({ answer });
  }
  return out;
}

/** The text the model sees for an imported user turn: what was typed, then the names of the files it carried. */
function modelTextOf(text: string, files: readonly Attachment[]): string {
  if (files.length === 0) return text.trim() === "" ? "(empty message)" : text;
  const list = files
    .map((f) => `${f.name} (${f.mediaType}${f.unavailable ? `, ${f.unavailable.toLowerCase()}` : ""})`)
    .join(", ");
  return `${text}${text.trim() === "" ? "" : "\n\n"}[Attached in the original chat: ${list}]`;
}

/** An answer as Pi stores a model's reply: its text only, no usage (no model was called). */
function answerMessage(answer: Answer): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: answer.text.trim() === "" ? EMPTY_ANSWER_TEXT : answer.text }],
    api: "import",
    provider: "import",
    model: answer.model ?? "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: answer.at,
  };
}

export class ImportService {
  readonly #d: ImportDeps;
  /** Imports being written by this process, by source and source id: a second request for one waits for nothing. */
  readonly #inFlight = new Set<string>();

  constructor(deps: ImportDeps) {
    this.#d = deps;
  }

  lookup(source: string, sourceIds: readonly string[]): ImportLookupResponse {
    return { found: this.#d.store.importedSessions(source, sourceIds) };
  }

  /** Imports one chat, or answers the chat a finished import of the same source chat made. */
  async importSession(agentId: string, transcript: ImportTranscript): Promise<ImportSessionResponse> {
    const { store } = this.#d;
    const key = JSON.stringify([transcript.source, transcript.sourceId]);
    const prior = store.importRow(transcript.source, transcript.sourceId);
    if (prior?.status === "complete") {
      const session = store.getSession(prior.session_id);
      if (session) return { session, created: false };
    }
    if (this.#inFlight.has(key)) throw new HttpError(409, "import_in_progress", "This chat is being imported already.");
    this.#inFlight.add(key);
    try {
      if (!store.getAgentRow(agentId)) throw badRequest("unknown_agent", "That agent does not exist.");
      const files = this.#checkFiles(transcript.turns);
      // A pending import was cut off (a crash, a lost connection): its half-written chat goes, and it starts again.
      const stale = store.importRow(transcript.source, transcript.sourceId);
      if (stale) {
        if (store.getSessionRow(stale.session_id)) await this.#d.deleteSession(stale.session_id);
        store.db.run(
          "DELETE FROM session_imports WHERE source = ? AND source_id = ?",
          transcript.source,
          transcript.sourceId,
        );
      }
      const { sessionId } = this.#d.begin(agentId, transcript.source, transcript.sourceId);
      try {
        return await this.#write(sessionId, transcript, files);
      } catch (error) {
        this.#d.log.error("import.failed", { error: error instanceof Error ? error.name : "error" });
        await this.#d.deleteSession(sessionId).catch(() => undefined);
        throw error;
      }
    } finally {
      this.#inFlight.delete(key);
    }
  }

  /** Every uploaded file the transcript names, checked before anything is written: it exists and no chat has it yet. */
  #checkFiles(turns: readonly ImportTurn[]): Map<string, Attachment> {
    const out = new Map<string, Attachment>();
    for (const turn of turns)
      for (const file of turn.attachments ?? []) {
        if (file.attachmentId === undefined) continue;
        const row = this.#d.attachments?.row(file.attachmentId);
        if (row?.session_id !== "" || row.file_id || out.has(row.id))
          throw badRequest("attachment_unavailable", `The file ${file.name} was not uploaded for this import.`);
        out.set(row.id, { id: row.id, name: file.name || row.name, mediaType: row.media_type, size: row.size });
      }
    return out;
  }

  #attachmentsOf(
    turn: ImportTurn,
    runId: string,
    files: ReadonlyMap<string, Attachment>,
    bound: { runId: string; attachment: Attachment }[],
  ): Attachment[] {
    return (turn.attachments ?? []).map((file: ImportAttachment, index) => {
      const uploaded = file.attachmentId !== undefined ? files.get(file.attachmentId) : undefined;
      if (uploaded) {
        bound.push({ runId, attachment: uploaded });
        return uploaded;
      }
      return {
        id: `${runId}_file${index}`,
        name: file.name,
        mediaType: file.mediaType || "application/octet-stream",
        size: file.size,
        unavailable: file.unavailable ?? UNAVAILABLE_FILE,
      };
    });
  }

  async #write(
    sessionId: string,
    transcript: ImportTranscript,
    files: ReadonlyMap<string, Attachment>,
  ): Promise<ImportSessionResponse> {
    const { store, trees, clock } = this.#d;
    const row = store.getSessionRow(sessionId);
    if (!row) throw new HttpError(409, "session_deleted", "The imported chat was deleted while it was written.");
    const tree = await trees.open(row.tree_id);
    const ts = tree.session(sessionId);
    if (!ts) throw new HttpError(409, "session_deleted", "The imported chat was deleted while it was written.");
    const exchanges = exchangesOf(transcript.turns);
    const bound: { runId: string; attachment: Attachment }[] = [];
    const indexed: {
      runId: string;
      input?: { text: string; at: number };
      answer?: { text: string; at: number };
    }[] = [];
    await tree.serial(async () => {
      const notice: NoticeData = { text: transcript.notice ?? DEFAULT_IMPORT_NOTICE, at: transcript.createdAt };
      let first = true;
      for (let start = 0; start < exchanges.length || first; start += EXCHANGES_PER_COMMIT) {
        const batch = exchanges.slice(start, start + EXCHANGES_PER_COMMIT);
        const withNotice = first;
        first = false;
        await ts.conv.commit(async (tx) => {
          const ledger = await tx.doc(CommandsDoc, ts.conv.id);
          if (withNotice) await tx.appendEntry(ts.conv.id, { kind: NOTICE_KIND, data: notice as unknown as JsonValue });
          for (const exchange of batch) {
            const runId = newId("run", clock.now());
            const at = exchange.input?.at ?? exchange.answer?.at ?? transcript.createdAt;
            const attachments = exchange.input ? this.#attachmentsOf(exchange.input, runId, files, bound) : [];
            const text = exchange.input ? exchange.input.text : LEADING_REPLY_TEXT;
            const modelText = exchange.input ? modelTextOf(text, attachments) : text;
            const data: InputData = {
              runId,
              role: exchange.input ? "user" : "notice",
              text,
              at,
              ...(attachments.length ? { attachments } : {}),
            };
            const input = await tx.appendEntry(ts.conv.id, {
              kind: INPUT_KIND,
              model: [{ role: "user", content: modelText, timestamp: at }],
              data: data as unknown as JsonValue,
            });
            let answerId: number | undefined;
            if (exchange.answer) {
              const answerData: ImportedAnswerData = exchange.answer.thinking.length
                ? { thinking: exchange.answer.thinking }
                : {};
              const answer = await tx.appendEntry(ts.conv.id, {
                kind: "pi.assistant",
                model: [answerMessage(exchange.answer)],
                ...(exchange.answer.thinking.length ? { data: answerData as unknown as JsonValue } : {}),
              });
              answerId = Number(answer.id);
            }
            const record: CommandRecord = {
              requestId: `import:${runId}`,
              kind: "input",
              role: data.role,
              direct: exchange.input !== undefined,
              createdAt: at,
              startedAt: at,
              endedAt: exchange.answer?.at ?? at,
              settled: true,
              outcome: "completed",
              entryId: Number(input.id),
              ...(answerId !== undefined ? { answerId } : {}),
              inputDigest: inputDigest(modelText),
            };
            ledger.byId[runId] = record as never;
            ledger.order.push(runId);
            ledger.byRequest[record.requestId] = runId;
            indexed.push({
              runId,
              ...(exchange.input && text.trim() !== "" ? { input: { text, at } } : {}),
              ...(exchange.answer && exchange.answer.text.trim() !== ""
                ? { answer: { text: exchange.answer.text, at: exchange.answer.at } }
                : {}),
            });
          }
        }, context);
      }
    });
    // The runs are in the registry once the session has seen its own commits.
    await ts.drained();
    const hooks = store.memoryHooks;
    const conversationId = String(ts.conv.id);
    if (hooks)
      for (const item of indexed) {
        if (item.input)
          hooks.indexable({
            id: userItemId(item.runId),
            sessionId,
            runId: item.runId,
            role: "user",
            text: item.input.text,
            conversationId,
            createdAt: item.input.at,
          });
        if (item.answer)
          hooks.indexable({
            id: replyItemId(item.runId),
            sessionId,
            runId: item.runId,
            role: "assistant",
            text: item.answer.text,
            conversationId,
            createdAt: item.answer.at,
          });
      }
    const last = exchanges.at(-1);
    const preview = last?.answer?.text || last?.input?.text || "";
    const finished = store.finishImport({
      sessionId,
      title: transcript.title,
      createdAt: transcript.createdAt,
      updatedAt: Math.max(transcript.updatedAt, transcript.createdAt),
      pinned: transcript.starred === true,
      preview,
      files: bound,
    });
    const session = finished ? store.getSession(sessionId) : undefined;
    if (!session) throw new HttpError(409, "session_deleted", "The imported chat was deleted while it was written.");
    return { session, created: true };
  }
}
