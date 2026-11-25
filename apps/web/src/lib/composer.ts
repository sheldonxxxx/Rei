import type { MessageMention } from "@rei/protocol";
import { ATTACHMENT_MAX_BYTES, MESSAGE_MAX_ATTACHMENT_BYTES, MESSAGE_MAX_ATTACHMENTS } from "@rei/protocol";

export const LARGE_PASTE_CHARS = 4_000;
export const isLargePaste = (text: string) => Array.from(text).length > LARGE_PASTE_CHARS;
export function pastedFileName(date: Date, existing: readonly string[]): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `pasted-text-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  let name = `${base}.txt`,
    i = 2;
  while (existing.includes(name)) name = `${base}-${i++}.txt`;
  return name;
}
export function attachmentLimit(file: Pick<File, "size">, files: readonly { size: number }[]): string | null {
  if (file.size > ATTACHMENT_MAX_BYTES) return "Files can be at most 1 GiB.";
  if (files.length >= MESSAGE_MAX_ATTACHMENTS) return "Choose at most 10 attachments.";
  if (files.reduce((n, f) => n + f.size, file.size) > MESSAGE_MAX_ATTACHMENT_BYTES)
    return "Attachments can total at most 2 GiB.";
  return null;
}

/** All editor offsets use UTF-16, matching native textarea selection. Mentions are indivisible ranges. */
export function replaceDraft(
  text: string,
  mentions: readonly MessageMention[],
  start: number,
  end: number,
  inserted: string,
) {
  for (const m of mentions) {
    if ((start > m.start && start < m.end) || (start <= m.start && end > m.start)) start = Math.min(start, m.start);
    if ((end > m.start && end < m.end) || (start < m.end && end >= m.end)) end = Math.max(end, m.end);
  }
  const delta = inserted.length - (end - start);
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    mentions: mentions
      .filter((m) => m.end <= start || m.start >= end)
      .map((m) => (m.start >= end ? { ...m, start: m.start + delta, end: m.end + delta } : m)),
    cursor: start + inserted.length,
  };
}

export function changedDraft(text: string, mentions: readonly MessageMention[], next: string) {
  let start = 0;
  while (start < text.length && start < next.length && text[start] === next[start]) start++;
  let end = text.length,
    nextEnd = next.length;
  while (end > start && nextEnd > start && text[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return replaceDraft(text, mentions, start, end, next.slice(start, nextEnd));
}
export function mentionQuery(text: string, cursor: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([^@\n]*)$/.exec(text.slice(0, cursor));
  return match ? { start: cursor - match[1]!.length - 1, query: match[1]! } : null;
}
/**
 * The picker row to highlight for what was typed, so Tab and Enter take the one that was meant: a name that starts
 * with the query, then a later word of a name (`sum` for `acme/summarize`), then anywhere in a name, then whatever
 * else matched (a description). Ties keep list order, and a disabled row is highlighted only when nothing else is left.
 */
export function bestChoice(choices: readonly { label: string; disabled?: boolean }[], query: string): number {
  const wanted = query.toLocaleLowerCase();
  const rank = ({ label }: { label: string }) => {
    const name = label.toLocaleLowerCase().replace(/^\//, "");
    if (name.startsWith(wanted)) return 0;
    if (name.split(/[\s/_.:-]+/).some((word) => word.startsWith(wanted))) return 1;
    return name.includes(wanted) ? 2 : 3;
  };
  let best = 0,
    bestRank = Number.POSITIVE_INFINITY;
  choices.forEach((choice, index) => {
    const value = choice.disabled ? Number.POSITIVE_INFINITY : rank(choice);
    if (value < bestRank) {
      best = index;
      bestRank = value;
    }
  });
  return best;
}
/** The one built-in slash command: `/compact` always means it, never a skill of that name. */
export const COMPACT_COMMAND = "compact";

/**
 * The slash token at the start of the draft the caret is in: only a first non-whitespace token that begins with `/`
 * counts (never mid-sentence text, a path later in a line, a URL or code), and never while an IME is composing.
 * `start`/`end` are UTF-16 offsets of the whole token (`/query`), `query` is what follows the slash.
 */
export function slashQuery(
  text: string,
  cursor: number,
  composing = false,
): { start: number; end: number; query: string } | null {
  if (composing) return null;
  const lead = /^\s*/.exec(text)![0].length;
  if (text[lead] !== "/") return null;
  const token = /^\S*/.exec(text.slice(lead))![0];
  const end = lead + token.length;
  // The caret must be inside the token, after the slash (a caret in later words is ordinary typing).
  if (cursor <= lead || cursor > end) return null;
  return { start: lead, end, query: token.slice(1) };
}

/** A complete `/compact [guidance]` draft: its guidance (trimmed; absent when none). Anything else is a message. */
export function parseSlashAction(text: string): { kind: "compact"; instructions?: string } | null {
  const match = /^\s*\/compact(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return null;
  const instructions = match[1]?.trim();
  return { kind: "compact", ...(instructions ? { instructions } : {}) };
}

export const attachmentUrl = (sessionId: string, id: string, preview = false) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}${preview ? "?preview=1" : ""}`;
export const isPreviewImage = (type: string) => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type);
