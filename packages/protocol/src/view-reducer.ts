// Applies session stream frames to a Conversation View: the one reducer the PWA and the tests share, so both read the
// stream the same way. Pure: it returns a new view (or a verdict), never mutates its input.

import type { ChatItem, ReiConversationViewV2, SessionEvent, SessionPatch } from "./stream.ts";

export interface ViewState {
  view: ReiConversationViewV2;
  epoch: string;
  rev: number;
}

export type ViewStep =
  | { kind: "view"; state: ViewState }
  /** The frame does not follow the state (another epoch, a gap) or the server asked: take a fresh snapshot. */
  | { kind: "resync" }
  /** The session was deleted; the stream ends. */
  | { kind: "removed" };

/** The next state after one frame of the session stream (`state` undefined before the first snapshot). */
export function applySessionEvent(state: ViewState | undefined, event: SessionEvent): ViewStep {
  if (event.type === "session.removed") return { kind: "removed" };
  if (event.type === "resync_required") return { kind: "resync" };
  if (event.type === "snapshot")
    return { kind: "view", state: { view: event.view, epoch: event.epoch, rev: event.rev } };
  if (!state || event.epoch !== state.epoch || event.rev !== state.rev + 1) return { kind: "resync" };
  return { kind: "view", state: { view: applyPatch(state.view, event), epoch: event.epoch, rev: event.rev } };
}

/** A view with one patch applied (upserts by id, removals, then the window's order; the rest replaces). */
export function applyPatch(view: ReiConversationViewV2, patch: SessionPatch): ReiConversationViewV2 {
  let items = view.items;
  if (patch.upsert?.length || patch.remove?.length || patch.order) {
    const byId = new Map<string, ChatItem>(items.map((i) => [i.id, i]));
    const removed = new Set(patch.remove ?? []);
    for (const id of removed) byId.delete(id);
    const appended: string[] = [];
    for (const item of patch.upsert ?? []) {
      if (!byId.has(item.id)) appended.push(item.id);
      byId.set(item.id, item);
    }
    const order = patch.order ?? [...items.map((i) => i.id).filter((id) => !removed.has(id)), ...appended];
    items = order.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }
  return {
    ...view,
    items,
    ...(patch.runs ? { runs: patch.runs } : {}),
    ...(patch.live ? { live: patch.live } : {}),
    ...(patch.overlays ? { overlays: patch.overlays } : {}),
    ...(patch.session ? { session: patch.session } : {}),
    ...(patch.before !== undefined ? { before: patch.before } : {}),
  };
}
