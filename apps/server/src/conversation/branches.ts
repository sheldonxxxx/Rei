// Message versions: the Pi conversations one session has had, and how they hang together. Retry and Edit fork the
// conversation just before a message and swap the fork in under the same session; every earlier conversation stays,
// so each version of a message stays reachable. Pi entry ids are unique within a tree file, so a cut entry names one
// point of one conversation. Pure functions over the session's rows (`session_branches`).

export interface BranchRow {
  session_id: string;
  pi_conversation_id: string;
  /** The conversation this one was forked from; null for the session's original. */
  parent_conversation_id: string | null;
  /** The last entry kept from the parent; null when nothing was kept (the original, or a rewind of the first message). */
  cut_entry_id: string | null;
  /** The user item (on the parent) this branch is a version of. */
  replaced_message_id: string | null;
  created_at: number;
  last_active_at: number;
}

/** One link of the active chain: a conversation and the newest of its own entries that the chain sees (null: all). */
export interface ChainLink {
  conversationId: string;
  upTo: number | null;
}

/** What decides whether a history entry is in its session's active chain. */
export interface BranchEntryRef {
  run_id: string | null;
  pi_conversation_id: string | null;
  pi_entry_id: string | null;
}

const byId = (rows: readonly BranchRow[]): Map<string, BranchRow> =>
  new Map(rows.map((r) => [r.pi_conversation_id, r]));

/**
 * What a conversation shows, newest link first: all of its own entries, then each ancestor's up to the entry the
 * chain was cut at. A conversation with no row (a session that never rewound) is a chain of one.
 */
export function chainOf(rows: readonly BranchRow[], active: string): ChainLink[] {
  const index = byId(rows);
  const out: ChainLink[] = [{ conversationId: active, upTo: null }];
  const seen = new Set([active]);
  for (let row = index.get(active); row?.parent_conversation_id && row.cut_entry_id !== null; ) {
    const parent = row.parent_conversation_id;
    if (seen.has(parent)) break;
    seen.add(parent);
    out.push({ conversationId: parent, upTo: Number(row.cut_entry_id) });
    row = index.get(parent);
  }
  return out;
}

/** Whether an entry a conversation wrote is visible in a chain. */
export function inChain(chain: readonly ChainLink[], conversationId: string, entryId: number): boolean {
  const link = chain.find((l) => l.conversationId === conversationId);
  return link !== undefined && (link.upTo === null || entryId <= link.upTo);
}

/**
 * The conversation of the session that owns a visible entry: walking up from the active one, the first whose own
 * entries (those after its cut) include it. Entries of the session's original that came from another session's chat
 * (the original is a fork of it) count as the original's.
 */
export function ownerOf(rows: readonly BranchRow[], active: string, entryId: number): string {
  const index = byId(rows);
  let current = active;
  const seen = new Set<string>();
  for (;;) {
    const row = index.get(current);
    if (!row || row.cut_entry_id === null || !row.parent_conversation_id || entryId > Number(row.cut_entry_id))
      return current;
    if (seen.has(current)) return current;
    seen.add(current);
    current = row.parent_conversation_id;
  }
}

/** The session's original conversation: the row with no parent, else (no row yet) the active conversation. */
export function originalOf(rows: readonly BranchRow[], active: string): string {
  return rows.find((r) => r.parent_conversation_id === null)?.pi_conversation_id ?? active;
}

/**
 * The versions of the message right after `cut` (null: the first message of the chat), oldest first: the conversation
 * that carries on past the cut, then every branch cut there. Undefined when the message has only one version.
 */
export function versionsByCut(rows: readonly BranchRow[]): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();
  // The store returns rows in creation order, even when two were written in the same millisecond.
  for (const row of rows) {
    if (row.parent_conversation_id === null) continue;
    const versions = groups.get(row.cut_entry_id) ?? [row.parent_conversation_id];
    versions.push(row.pi_conversation_id);
    groups.set(row.cut_entry_id, versions);
  }
  return groups;
}

/** Of a message's versions, the one the active chain goes through (1-based), or 1 (the carrying-on conversation). */
export function activeVersion(versions: readonly string[], chain: readonly ChainLink[]): number {
  const on = new Set(chain.map((l) => l.conversationId));
  for (let i = versions.length - 1; i >= 1; i--) if (on.has(versions[i]!)) return i + 1;
  return 1;
}

/**
 * The conversation to activate for a version of the message after `cut`: the most recently active of the version and
 * the conversations below it (claude.ai reopens the branch you last used under the version you picked). Below means cut
 * after `cut`: the version's other children are cut at or before it, so they are siblings or earlier branches.
 */
export function latestLeaf(rows: readonly BranchRow[], version: string, cut: number | null): string {
  const children = new Map<string, BranchRow[]>();
  for (const r of rows) {
    if (!r.parent_conversation_id) continue;
    const siblings = children.get(r.parent_conversation_id) ?? [];
    siblings.push(r);
    children.set(r.parent_conversation_id, siblings);
  }
  const index = byId(rows);
  let best = version;
  let bestAt = index.get(version)?.last_active_at ?? Number.NEGATIVE_INFINITY;
  const below = (child: BranchRow) => child.cut_entry_id !== null && (cut === null || Number(child.cut_entry_id) > cut);
  const pending = [version];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const id = pending.pop()!;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.pi_conversation_id) || !below(child)) continue;
      seen.add(child.pi_conversation_id);
      pending.push(child.pi_conversation_id);
      if (child.last_active_at > bestAt) {
        best = child.pi_conversation_id;
        bestAt = child.last_active_at;
      }
    }
  }
  return best;
}
