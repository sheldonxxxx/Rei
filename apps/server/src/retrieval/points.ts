// How a `history_entries` row becomes a point in the search service. This is the whole mapping, in one place, so the
// identity of a chunk (and therefore what a re-index replaces, and what a purge has to remove) is not spread across
// the indexer, the worker and the purge path.

import type { EntryKind } from "../memory/index.ts";
import { ftsText } from "../memory/keyword.ts";
import type { RetrievalPayload, RetrievalPoint } from "./retrieval-store.ts";

/** Dense collections are named after the vector set they hold, so SQLite stays the authority on which generation exists. */
export const denseCollectionFor = (setId: number): string => `rei_history_dense_v${setId}`;

/** An entry as the retrieval index needs it: the chunk, its source's identity, and the chat it belongs to. */
export interface IndexEntryRow {
  id: number;
  session_id: string;
  message_id: string | null;
  kind: EntryKind;
  tool_name: string | null;
  pi_entry_id: string | null;
  chunk_index: number;
  text: string;
  created_at: number;
  agent_id: string;
}

/**
 * The point's identity: stable for the same chunk of the same message or tool result, whatever row SQLite happens to
 * give it. Rowids are reused after a delete, so deriving this from `entry.id` would let one chunk's point be mistaken
 * for another's — which is exactly the mistake a purge must not make.
 */
export function pointIdOf(
  entry: Pick<IndexEntryRow, "session_id" | "message_id" | "pi_entry_id" | "chunk_index">,
): string | undefined {
  if (entry.message_id) return `m:${entry.message_id}:${entry.chunk_index}`;
  if (entry.pi_entry_id) return `t:${entry.session_id}:${entry.pi_entry_id}:${entry.chunk_index}`;
  return undefined;
}

/**
 * The point for one entry, or undefined when the entry has no stable identity (it cannot be indexed safely, and the
 * caller says so in the log). `writtenBy` names the write, so a log or a test can tell which path produced a point.
 */
export function pointFor(entry: IndexEntryRow, writtenBy: string): RetrievalPoint | undefined {
  const pointId = pointIdOf(entry);
  if (!pointId) return undefined;
  const payload: RetrievalPayload = {
    entryId: entry.id,
    sourceType: entry.kind === "tool" ? "tool" : "message",
    sourceId: entry.kind === "tool" ? (entry.pi_entry_id ?? "") : (entry.message_id ?? ""),
    chunkId: `${pointId}#${entry.chunk_index}`,
    sessionId: entry.session_id,
    agentId: entry.agent_id,
    kind: entry.kind,
    toolName: entry.tool_name,
    createdAt: entry.created_at,
    text: entry.text,
    // Rei's own tokens: the CJK bigram split the FTS index used, so keyword results do not change with this move.
    tokens: ftsText(entry.text),
    writtenBy,
  };
  return { pointId, payload };
}
