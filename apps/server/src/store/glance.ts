// The glance (GET /api/glance): what a widget shows in one cheap read, without a stream. Every field is one indexed
// query or a row the store already keeps; the ETag is a digest of the answer, so a widget polling every few minutes
// mostly gets 304.
import type { GlanceResponse } from "@rei/protocol";
import { plainText } from "../memory/text.ts";
import type { AppStore } from "./store.ts";

const PREVIEW_MAX = 200;

export function glance(store: AppStore, previewShown: boolean): GlanceResponse {
  const companion = store.companion();
  const agent = store.getAgent(companion.agentId);
  const home = store.getSessionRow(companion.homeSessionId);
  const text = home ? plainText(home.preview).replace(/\s+/g, " ").trim() : "";
  const clipped = text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
  const pendingApprovals =
    store.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM approvals a JOIN sessions s ON s.id = a.session_id WHERE a.status = 'pending' AND s.deleted_at IS NULL",
    )?.n ?? 0;
  const next = store.db.get<{ id: string; name: string; next_fire_at: number }>(
    "SELECT id, name, next_fire_at FROM triggers WHERE status = 'active' AND next_fire_at IS NOT NULL ORDER BY next_fire_at, id LIMIT 1",
  );
  return {
    companion: {
      agentId: companion.agentId,
      name: agent?.name ?? "",
      avatar: agent?.avatar ?? "",
      homeSessionId: companion.homeSessionId,
    },
    preview: previewShown && clipped !== "" ? clipped : null,
    previewHidden: !previewShown,
    running: home ? store.runs.nonTerminal(home.id).length > 0 : false,
    pendingApprovals,
    unread: store.unreadTotal(),
    nextTrigger: next ? { id: next.id, name: next.name, at: next.next_fire_at } : null,
  };
}

/** A strong ETag for a JSON answer: a SHA-256 digest of its text. */
export async function etagOf(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest.slice(0, 16)) hex += b.toString(16).padStart(2, "0");
  return `"${hex}"`;
}

/** Whether an If-None-Match header names this ETag (a list, weak forms and `*` included). */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag);
}
