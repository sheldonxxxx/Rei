// Importing past conversations from another app (docs/importing.md): a neutral transcript per chat, which the server
// turns into one session without running a model. Times are epoch milliseconds.

import type { AgentId, Session, SessionId } from "./entities.ts";

/** A file of an imported message: uploaded first (`attachmentId`), or only named (`unavailable` says why). */
export interface ImportAttachment {
  name: string;
  mediaType: string;
  size: number;
  /** An attachment uploaded with `POST /api/imports/files` and not yet used by another import. */
  attachmentId?: string;
  /** Why the file is not carried (e.g. "Not in export", "Too large to import"); the chat shows a placeholder. */
  unavailable?: string;
}

export interface ImportTurn {
  role: "user" | "assistant";
  at: number;
  /** Markdown, as the other app showed it. */
  text: string;
  /** For an assistant turn: the model the other app named. */
  model?: string;
  /** For an assistant turn: the reasoning shown, one block per step. Display only; the model never sees it. */
  thinking?: string[];
  /** For a user turn. */
  attachments?: ImportAttachment[];
}

export interface ImportTranscript {
  /** Where it came from, e.g. "chatgpt". With `sourceId` the import's identity: a repeat returns the same session. */
  source: string;
  sourceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Pinned in the sidebar. */
  starred?: boolean;
  /** Kept for the record; an archived chat is imported like any other. */
  archived?: boolean;
  /** The line at the top of the chat; a generic one when absent. */
  notice?: string;
  turns: ImportTurn[];
}

export interface ImportSessionRequest {
  agentId: AgentId;
  transcript: ImportTranscript;
}

export interface ImportSessionResponse {
  session: Session;
  /** False when this source id was imported before: `session` is that chat, unchanged. */
  created: boolean;
}

export interface ImportLookupRequest {
  source: string;
  sourceIds: string[];
}

export interface ImportLookupResponse {
  /** The source ids already imported (and not deleted since), with their sessions. */
  found: { sourceId: string; sessionId: SessionId }[];
}
