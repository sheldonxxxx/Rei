// The tools a model call was offered, and what changed since the session's previous model call, for the Trace. Each
// model call records the names it offered (`steps.offered_tools`), read from Pi's context before it is turned into a
// provider body: its tools plus the tool-change system messages, which every provider encodes differently.

import type { CapabilitySearchDetails, LoadReason, OfferedToolChanges } from "@rei/protocol";
import type { AppStore } from "./store/store.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The tool names a Pi context (or a recorded request) offers, in order; undefined when it has no recognisable tools. */
export function offeredTools(request: unknown): string[] | undefined {
  if (!isObj(request)) return undefined;
  const names = new Set<string>();
  let seen = false;
  const nameOf = (t: unknown): string | undefined => {
    if (!isObj(t)) return undefined;
    const f = isObj(t.function) ? t.function : t;
    return typeof f.name === "string" ? f.name : undefined;
  };
  if (Array.isArray(request.tools)) {
    seen = true;
    for (const t of request.tools) {
      const name = nameOf(t);
      if (name) names.add(name);
    }
  }
  if (Array.isArray(request.messages))
    for (const m of request.messages) {
      if (!isObj(m) || m.role !== "system") continue;
      // A changed definition comes as a removal and an addition in one message: removals first.
      if (Array.isArray(m.toolsRemoved))
        for (const t of m.toolsRemoved) {
          const name = nameOf(t);
          if (name) names.delete(name);
          seen = true;
        }
      if (Array.isArray(m.toolsAdded))
        for (const t of m.toolsAdded) {
          const name = nameOf(t);
          if (name) names.add(name);
          seen = true;
        }
    }
  return seen ? [...names] : undefined;
}

interface StepRef {
  id: string;
  session_id: string | null;
  started_at: number;
  usage_purpose: string | null;
  offered_tools?: string | null;
}

/** What a model call step offered: its recorded names, or what its recorded request shows. */
function offeredBy(row: { offered_tools?: string | null }, request: unknown): string[] | undefined {
  if (row.offered_tools) {
    try {
      const names = JSON.parse(row.offered_tools) as unknown;
      if (Array.isArray(names)) return names.filter((n): n is string => typeof n === "string");
    } catch {
      /* fall back to the request */
    }
  }
  return offeredTools(request);
}

/**
 * The tools this chat model call was offered and the change since the session's previous chat model call. Each added
 * tool is attributed to the `search_capabilities` step between the two calls that loaded it; an addition no search
 * explains came from a capability change (a connector added, signed in or refreshed) or a fork.
 */
export async function offeredToolChanges(
  store: AppStore,
  read: (ref: string | null) => Promise<unknown>,
  row: StepRef,
  request: unknown,
): Promise<OfferedToolChanges | undefined> {
  const offered = offeredBy(row, request);
  if (!offered || !row.session_id || row.usage_purpose !== "chat") return undefined;
  const previous = store.db.get<{
    id: string;
    started_at: number;
    payload_blob: string | null;
    offered_tools: string | null;
  }>(
    `SELECT id, started_at, payload_blob, offered_tools FROM steps
     WHERE session_id = ? AND type = 'llm.call' AND usage_purpose = 'chat' AND (started_at < ? OR (started_at = ? AND id < ?))
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    row.session_id,
    row.started_at,
    row.started_at,
    row.id,
  );
  if (!previous) return { offered, added: [], removed: [] };
  const before = previous.offered_tools
    ? offeredBy(previous, undefined)
    : offeredBy(previous, await read(previous.payload_blob));
  if (!before) return { offered, previousStepId: previous.id, added: [], removed: [] };
  const had = new Set(before);
  const has = new Set(offered);
  const searches = store.db.all<{ id: string; payload_blob: string | null }>(
    `SELECT id, payload_blob FROM steps
     WHERE session_id = ? AND type = 'tool.call' AND tool_name = 'search_capabilities' AND started_at >= ? AND started_at <= ?
     ORDER BY started_at, id`,
    row.session_id,
    previous.started_at,
    row.started_at,
  );
  const loadedBy = new Map<string, { stepId: string; reason: LoadReason; group?: string }>();
  for (const s of searches) {
    const payload = await read(s.payload_blob);
    const details = isObj(payload) ? (payload.details as CapabilitySearchDetails | undefined) : undefined;
    for (const l of details?.loaded ?? [])
      loadedBy.set(l.name, { stepId: s.id, reason: l.reason, ...(l.group ? { group: l.group } : {}) });
  }
  return {
    offered,
    previousStepId: previous.id,
    added: offered
      .filter((n) => !had.has(n))
      .map((name) => {
        const by = loadedBy.get(name);
        return by
          ? {
              name,
              loadedBy: by.stepId,
              reason: by.reason,
              ...(by.group ? { group: by.group } : {}),
            }
          : { name };
      }),
    removed: before.filter((n) => !has.has(n)),
  };
}
