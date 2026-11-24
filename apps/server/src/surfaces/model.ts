// The `rei.surfaces` conversation document (ADR 0015) and the pure operations on it: applying A2UI messages, keeping
// revisions, reconstructing an old revision, and the client shape of a surface.
//
// Revisions keep their A2UI messages for the newest SURFACE_LIMITS.revisionsKept; `base` is the full state just before
// the oldest kept one, so any kept revision is rebuilt by replaying messages onto it. Older revisions keep author, time
// and summary only. The document forks "as of" the fork point: a fork holds the surfaces as they stood, and a copy
// owned by another session is frozen.

import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import {
  A2UI_VERSION,
  type A2uiComponent,
  type A2uiCreateSurface,
  type A2uiMessage,
  SURFACE_LIMITS,
  type Surface,
  type SurfaceActionRecord,
  type SurfaceAuthor,
  type SurfaceDataModel,
  type SurfaceDetailResponse,
  type SurfaceFailure,
  type SurfaceFeed,
  type SurfaceRevision,
} from "@rei/protocol";
import { reachable } from "./validate.ts";

export const SURFACES_KIND = "rei.surfaces";

export interface StoredRevision {
  revision: number;
  author: SurfaceAuthor;
  at: number;
  summary: string;
  /** Absent once the revision is older than the kept window. */
  messages?: A2uiMessage[];
}

export interface SurfaceRecord {
  surfaceId: string;
  /** The session that made it; in a fork's copy this is another session, so the copy is frozen. */
  sessionId: string;
  runId: string;
  title: string;
  catalogId: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  removed?: boolean;
  components: A2uiComponent[];
  dataModel: SurfaceDataModel;
  fallback: string;
  /** Attached while the feed runs (the surface is live). */
  feed?: SurfaceFeed;
  /** Full state just before the oldest revision that still has its messages; null while revision 1 is kept. */
  base: { revision: number; components: A2uiComponent[]; dataModel: SurfaceDataModel } | null;
  revisions: StoredRevision[];
  actions: SurfaceActionRecord[];
  /** Feed data waiting for its coalescing window (written by the next feed flush). */
  feedAt?: number;
}

export interface SurfacesState {
  surfaces: Record<string, SurfaceRecord>;
  /** Surface ids in creation order. */
  order: string[];
  failures: SurfaceFailure[];
  /** Tool call id → the revision it made, so a replayed call returns its first result and changes nothing. */
  byCall: Record<string, { surfaceId: string; revision: number }>;
  /** Action request id → its decision, so a repeated action has no second effect. */
  byRequest: Record<string, { surfaceId: string; runId?: string; messageId?: string }>;
}

export const SurfacesDoc = defineDoc<SurfacesState & JsonObject>({
  kind: SURFACES_KIND,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ surfaces: {}, order: [], failures: [], byCall: {}, byRequest: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Sets (or with `null`, deletes) the value at a JSON Pointer, returning a new data model. */
export function setPointer(data: SurfaceDataModel, path: string | undefined, value: unknown): SurfaceDataModel {
  if (path === undefined || path === "" || path === "/") {
    if (value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("The whole data model must be an object.");
    return clone(value as SurfaceDataModel);
  }
  if (!path.startsWith("/")) throw new Error(`Data path "${path}" must start with "/".`);
  const keys = path
    .slice(1)
    .split("/")
    .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (keys.some((k) => k === "__proto__" || k === "constructor" || k === "prototype"))
    throw new Error(`Data path "${path}" is not allowed.`);
  const root = clone(data);
  let node: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as string;
    const next = (node as Record<string, unknown>)[key];
    if (next === null || typeof next !== "object") {
      const created = /^\d+$/.test(keys[i + 1] as string) ? [] : {};
      (node as Record<string, unknown>)[key] = created;
      node = created;
    } else node = next as Record<string, unknown>;
  }
  const last = keys[keys.length - 1] as string;
  if (value === null) {
    if (Array.isArray(node) && /^\d+$/.test(last)) node.splice(Number(last), 1);
    else delete (node as Record<string, unknown>)[last];
  } else if (Array.isArray(node) && last === "-") node.push(clone(value));
  else (node as Record<string, unknown>)[last] = clone(value);
  return root;
}

export interface SurfaceContent {
  components: A2uiComponent[];
  dataModel: SurfaceDataModel;
}

/** Applies one A2UI message to a surface's content. `updateComponents` adds or replaces components by id. */
export function applyMessage(content: SurfaceContent, message: A2uiMessage): SurfaceContent {
  if ("createSurface" in message)
    return {
      components: clone(message.createSurface.components ?? []),
      dataModel: clone(message.createSurface.dataModel ?? {}),
    };
  if ("updateComponents" in message) {
    const next = new Map(content.components.map((c) => [c.id, c]));
    for (const c of message.updateComponents.components) next.set(c.id, clone(c));
    const components = [...next.values()];
    // Components no longer reachable from root are dropped, so a replaced subtree does not linger.
    const keep = reachable(components);
    return { components: components.filter((c) => keep.has(c.id)), dataModel: content.dataModel };
  }
  if ("updateDataModel" in message)
    return {
      components: content.components,
      dataModel: setPointer(content.dataModel, message.updateDataModel.path, message.updateDataModel.value),
    };
  return { components: [], dataModel: {} };
}

/** Records a revision and trims messages older than the kept window into `base`. */
export function pushRevision(record: SurfaceRecord, revision: StoredRevision): void {
  record.revisions.push(revision);
  record.revision = revision.revision;
  const withMessages = record.revisions.filter((r) => r.messages);
  let excess = withMessages.length - SURFACE_LIMITS.revisionsKept;
  for (const r of record.revisions) {
    if (excess <= 0) break;
    if (!r.messages) continue;
    let content: SurfaceContent = record.base
      ? { components: record.base.components, dataModel: record.base.dataModel }
      : { components: [], dataModel: {} };
    for (const m of r.messages) content = applyMessage(content, m);
    record.base = { revision: r.revision, ...clone(content) };
    delete r.messages;
    excess--;
  }
  // Revision metadata is small but not unbounded: keep the newest 500.
  if (record.revisions.length > 500) record.revisions.splice(0, record.revisions.length - 500);
}

/** The full content of a kept revision, or undefined when it is past the window. */
export function contentAt(record: SurfaceRecord, revision: number): SurfaceContent | undefined {
  if (record.base && revision < record.base.revision) return undefined;
  let content: SurfaceContent = record.base
    ? { components: record.base.components, dataModel: record.base.dataModel }
    : { components: [], dataModel: {} };
  if (record.base && revision === record.base.revision) return clone(content);
  for (const r of record.revisions) {
    if (r.revision > revision) break;
    if (record.base && r.revision <= record.base.revision) continue;
    if (!r.messages) return undefined;
    for (const m of r.messages) content = applyMessage(content, m);
  }
  return clone(content);
}

export function stateOf(record: SurfaceRecord, viewerSessionId: string): Surface["state"] {
  if (record.sessionId !== viewerSessionId) return "frozen";
  if (record.removed) return "removed";
  return record.feed ? "live" : "idle";
}

/** The surface as one A2UI createSurface message. */
export function createMessage(
  record: Pick<SurfaceRecord, "surfaceId" | "catalogId">,
  content: SurfaceContent,
): A2uiCreateSurface {
  return {
    version: A2UI_VERSION,
    createSurface: {
      surfaceId: record.surfaceId,
      catalogId: record.catalogId,
      components: content.components,
      dataModel: content.dataModel,
    },
  };
}

/** The client shape of a surface, as the session `viewerSessionId` sees it. */
export function toSurface(record: SurfaceRecord, viewerSessionId: string): Surface {
  const state = stateOf(record, viewerSessionId);
  return {
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    runId: record.runId,
    revision: record.revision,
    state,
    title: record.title,
    fallback: record.fallback,
    protocolVersion: A2UI_VERSION,
    ...(record.feed && state === "live" ? { feed: record.feed } : {}),
    ...(record.removed ? {} : { message: createMessage(record, record) }),
    updatedAt: record.updatedAt,
  };
}

export function detailOf(state: SurfacesState, record: SurfaceRecord, viewerSessionId: string): SurfaceDetailResponse {
  const revisions: SurfaceRevision[] = record.revisions.map((r) => {
    const content = r.messages ? contentAt(record, r.revision) : undefined;
    return {
      revision: r.revision,
      author: r.author,
      at: r.at,
      summary: r.summary,
      ...(r.messages ? { messages: r.messages } : {}),
      ...(content ? { components: content.components, dataModel: content.dataModel } : {}),
    };
  });
  const toolCalls = new Set(record.revisions.flatMap((r) => (r.author.kind === "agent" ? [r.author.runId] : [])));
  const failures = state.failures.filter(
    (f) =>
      f.surfaceId === record.surfaceId ||
      (f.surfaceId === undefined && f.tool === "show_surface" && toolCalls.has(f.runId)),
  );
  return { surface: toSurface(record, viewerSessionId), revisions, actions: record.actions, failures };
}

/** A one-line summary of what a revision changed. */
export function summarize(messages: readonly A2uiMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if ("createSurface" in m) parts.push(`Created with ${m.createSurface.components?.length ?? 0} components`);
    else if ("updateComponents" in m) {
      const ids = m.updateComponents.components.map((c) => c.id);
      parts.push(`Components ${ids.slice(0, 4).join(", ")}${ids.length > 4 ? ` +${ids.length - 4}` : ""} changed`);
    } else if ("updateDataModel" in m)
      parts.push(`Data ${m.updateDataModel.path ?? "/"} ${m.updateDataModel.value === null ? "removed" : "changed"}`);
    else if ("deleteSurface" in m) parts.push("Removed");
  }
  const out = parts.join("; ");
  return out.length > 200 ? `${out.slice(0, 199)}…` : out;
}

export const pushCapped = <T>(list: T[], item: T, max: number): void => {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
};
