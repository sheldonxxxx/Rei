// Row shapes and conversions the store and the memory modules share.
import type { MemoryDoc, MemorySuggestion } from "@rei/protocol";

export const lineId = (seq: number): string => `m${seq}`;
export function parseLineId(id: string): number | undefined {
  const m = /^m(\d{1,12})$/.exec(id.trim());
  return m ? Number(m[1]) : undefined;
}

export interface SuggestionRow {
  seq: number;
  id: string;
  doc: string;
  agent_id: string | null;
  op: string;
  line_seq: number | null;
  current_text: string | null;
  text: string | null;
  session_id: string;
  status: string;
  created_at: number;
  reported_at: number | null;
}

export const toSuggestion = (r: SuggestionRow): MemorySuggestion => ({
  id: r.id,
  doc: r.doc as MemoryDoc,
  agentId: r.agent_id,
  op: r.op as MemorySuggestion["op"],
  lineId: r.line_seq === null ? null : lineId(r.line_seq),
  current: r.current_text,
  text: r.text,
  sessionId: r.session_id,
  status: r.status as MemorySuggestion["status"],
  createdAt: r.created_at,
  reportedAt: r.reported_at,
});

/** What the receiving agent's model reads about a report's memory suggestions. */
export function suggestionsLine(suggestions: readonly MemorySuggestion[]): string {
  const q = (t: string | null) => `"${t ?? ""}"`;
  const parts = suggestions.map((s) => {
    const where = s.doc === "profile" ? "profile" : "agent notes";
    if (s.op === "add") return `add to ${where}: ${q(s.text)}`;
    if (s.op === "replace") return `replace [${s.lineId}] with ${q(s.text)} (now ${q(s.current)})`;
    return `remove [${s.lineId}] (${q(s.current)})`;
  });
  return `Memory suggestions: ${parts.join("; ")}. Decide whether to save them with the memory tools.`;
}
