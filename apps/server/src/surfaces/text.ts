// Surfaces as text: what history search, copy, notifications and other agents read for a reply that shows surfaces.
// A surface counts by its server-written fallback, never by its components or data.

import type { MessagePart } from "@rei/protocol";
import { type SurfacesState, toSurface } from "./model.ts";

/** A reply's parts as text: its markdown, and each surface as its fallback. */
export function partsText(parts: readonly MessagePart[]): string {
  return parts
    .map((p) => (p.type === "text" ? p.text : p.surface.fallback))
    .filter((s) => s.trim() !== "")
    .join("\n\n");
}

/** What to show or index for a reply: its parts as text when it has any, else the text as written. */
export const replyText = (text: string, parts: readonly MessagePart[] | undefined): string =>
  parts ? partsText(parts) : text;

/**
 * The parts of a reply: the surfaces the given runs made, in creation order, then the answer text. Undefined when the
 * runs made none.
 */
export function surfaceParts(
  state: SurfacesState | undefined,
  runIds: readonly string[],
  viewerSessionId: string,
  text: string,
): MessagePart[] | undefined {
  if (!state) return undefined;
  const runs = new Set(runIds);
  const ids = state.order.filter((id) => {
    const record = state.surfaces[id];
    return record !== undefined && runs.has(record.runId);
  });
  if (ids.length === 0) return undefined;
  return [
    ...ids.map((id) => ({ type: "surface" as const, surface: toSurface(state.surfaces[id]!, viewerSessionId) })),
    ...(text !== "" ? [{ type: "text" as const, text }] : []),
  ];
}
