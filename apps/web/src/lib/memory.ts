import type { HistoryHit, IndexStatus, MemoryChange, MemoryLine, Message } from "@rei/protocol";
import { MEMORY_STALE_DAYS } from "@rei/protocol";

const DAY_MS = 86_400_000;

/** A line not confirmed for MEMORY_STALE_DAYS reads as possibly out of date. */
export function isStale(line: Pick<MemoryLine, "confirmedAt">, now: number = Date.now()): boolean {
  return now - line.confirmedAt > MEMORY_STALE_DAYS * DAY_MS;
}

/** "Not confirmed for 8 months", for a stale line's tooltip. */
export function staleFor(line: Pick<MemoryLine, "confirmedAt">, now: number = Date.now()): string {
  const months = Math.max(1, Math.floor((now - line.confirmedAt) / (30 * DAY_MS)));
  return `Not confirmed for ${months} ${months === 1 ? "month" : "months"}`;
}

/** Where a line came from, in words. */
export function sourceLabel(line: Pick<MemoryLine, "source" | "sourceDeleted">): string {
  if (line.source) return `From ${line.source.sessionTitle}`;
  return line.sourceDeleted ? "Chat deleted" : "Added by you";
}

/** What a change did, as a past-tense word for the versions list. */
export const CHANGE_VERB: Record<MemoryChange["op"], string> = {
  add: "Added",
  replace: "Edited",
  remove: "Removed",
  confirm: "Confirmed",
};

/** Who made it. */
export const changeBy = (c: Pick<MemoryChange, "by">) => (c.by === "user" ? "you" : "the assistant");

export function isMemoryChange(m: Message): m is Message & { memory: { change: MemoryChange } } {
  return m.role === "memory" && !!m.memory?.change && m.memory.change.op !== "confirm";
}

/** Consecutive "Memory updated" chips are shown as one row; everything else stands alone. */
export type MessageGroup = { kind: "message"; message: Message } | { kind: "chips"; messages: Message[] };

/** The rows of the message list, one per group; a memory message with nothing to show (a confirmation) has no row. */
export function groupMessages(messages: Message[]): MessageGroup[] {
  const out: MessageGroup[] = [];
  for (const m of messages) {
    if (m.role === "memory" && !isMemoryChange(m)) continue;
    if (isMemoryChange(m)) {
      const last = out[out.length - 1];
      if (last?.kind === "chips") last.messages.push(m);
      else out.push({ kind: "chips", messages: [m] });
    } else out.push({ kind: "message", message: m });
  }
  return out;
}

// ---- the index ---------------------------------------------------------------------------------------------------------

export interface IndexView {
  /** The one line: "Ready · 1,234 entries · mlx-community/embeddinggemma-2-6bit affine-6bit-g64-bf16". */
  text: string;
  /** Set while something is being embedded. */
  progress: { done: number; total: number } | null;
  /** Rebuild only means something when there is an embedder. */
  canRebuild: boolean;
  tone: "ok" | "busy" | "warn" | "off";
}

export function describeIndex(index: IndexStatus): IndexView {
  const n = (x: number) => x.toLocaleString("en-US");
  switch (index.state) {
    case "ready":
      return {
        text: ["Ready", `${n(index.entries)} ${index.entries === 1 ? "entry" : "entries"}`, index.model]
          .filter(Boolean)
          .join(" · "),
        progress: null,
        canRebuild: true,
        tone: "ok",
      };
    case "indexing": {
      const b = index.building;
      const progress = b ? { done: b.embedded, total: b.total } : { done: index.embedded, total: index.entries };
      const text = b
        ? `Rebuilding the index for ${b.model}: ${n(b.embedded)} of ${n(b.total)}`
        : `Indexing ${n(index.embedded)} of ${n(index.entries)}`;
      return { text, progress, canRebuild: true, tone: "busy" };
    }
    case "down":
      return { text: "Embedder down — keyword search only", progress: null, canRebuild: false, tone: "warn" };
    case "off":
      return { text: "Off — keyword search only", progress: null, canRebuild: false, tone: "off" };
  }
}

// ---- search results ----------------------------------------------------------------------------------------------------

/** Who said it, for the result's role chip. */
export function hitRole(hit: Pick<HistoryHit, "kind" | "toolName">): string {
  switch (hit.kind) {
    case "user":
      return "You";
    case "assistant":
      return "Assistant";
    case "report":
      return "Report";
    case "tool":
      return hit.toolName ? `Tool: ${hit.toolName}` : "Tool result";
  }
}

/** "keyword #2 · meaning #1, 0.71": which side found it, and how close in meaning. */
export function whyLine(hit: Pick<HistoryHit, "keywordRank" | "vectorRank" | "cosine">): string {
  const parts: string[] = [];
  if (hit.keywordRank !== null) parts.push(`keyword #${hit.keywordRank}`);
  if (hit.vectorRank !== null) parts.push(`meaning #${hit.vectorRank}`);
  const line = parts.length > 0 ? parts.join(" · ") : "matched";
  return hit.cosine !== null ? `${line}, ${hit.cosine.toFixed(2)}` : line;
}

const CJK = /[⺀-鿿豈-﫿가-힯぀-ヿ]/;

/** The pieces of the query worth marking in a snippet: whole words, and for CJK also its two-character runs (as the index sees them). */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.split(/\s+/)) {
    if (!word) continue;
    const chars = Array.from(word);
    if (CJK.test(word)) {
      terms.add(word);
      for (let i = 0; i + 1 < chars.length; i++) terms.add(chars[i]! + chars[i + 1]!);
    } else if (chars.length >= 2) terms.add(word);
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text cut into plain and matching parts (case-insensitive). Never HTML. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const terms = queryTerms(query);
  if (terms.length === 0 || !text) return [{ text, match: false }];
  const re = new RegExp(`(${terms.map(escapeRe).join("|")})`, "giu");
  // split() with one capture group alternates plain, match, plain, ...
  return text
    .split(re)
    .map((p, i) => ({ text: p, match: i % 2 === 1 }))
    .filter((p) => p.text !== "");
}

/** A date input's value ("2026-10-31") as the start or end of that local day, in epoch ms. */
export function dayBound(value: string, edge: "start" | "end"): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return edge === "start"
    ? new Date(y, mo - 1, d, 0, 0, 0, 0).getTime()
    : new Date(y, mo - 1, d, 23, 59, 59, 999).getTime();
}
