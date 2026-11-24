// Surfaces (docs/surfaces.md, ADR 0014, ADR 0015). A surface is a live piece of interface an agent places in a session
// with the `show_surface` and `update_surface` tools. Its wire format is the A2UI v1.0 message set used verbatim, as a
// subset: `createSurface`, `updateComponents`, `updateDataModel` and `deleteSurface` from the agent, and `action` from
// the client. Components come from Rei's catalog (`catalog/rei-catalog-1.json`, in A2UI's catalog-definition format).
//
// Rei wraps the A2UI content in its own `surface` message part, which carries what A2UI lacks: the owning session, the
// revision, the surface state and the server-written fallback text. A client draws `message` when it knows the catalog
// and protocol version, and shows `fallback` otherwise. The server checks every message against the vendored official
// A2UI v1.0 JSON Schema (`vendor/a2ui-v1_0/`) and against Rei's own rules (ids, references, limits), so a client can rely
// on every stored surface having passed both.
import type { MessageId, RunId, SessionId } from "./entities.ts";

/** A2UI protocol version every surface message carries. */
export const A2UI_VERSION = "1.0";
/** Rei's catalog id (A2UI `catalogId`). */
export const SURFACE_CATALOG_ID = "rei/catalog/1";
/** The catalogs and protocol versions this release draws and emits. */
export const SURFACE_CATALOGS: readonly { catalogId: string; protocolVersion: string }[] = [
  { catalogId: SURFACE_CATALOG_ID, protocolVersion: A2UI_VERSION },
];

/** Limits the server checks; going over one is a validation error the model sees, never a silent cut. */
export const SURFACE_LIMITS = {
  components: 200,
  /** Serialized size of a surface's components. */
  componentBytes: 64_000,
  /** Serialized size of a surface's data model. */
  dataBytes: 256_000,
  /** Surfaces with a feed attached, per session. */
  liveSurfacesPerSession: 8,
  /** Revisions kept with their full content (older ones keep author, time and summary). */
  revisionsKept: 50,
  /** Feed revisions are coalesced to at most one per this many milliseconds per surface. */
  feedIntervalMs: 1_000,
  /** Action decisions and validation failures kept for the Inspector. */
  actionsKept: 50,
  failuresKept: 50,
  /** A surface id: [A-Za-z0-9_-]{1,64}. */
  idChars: 64,
} as const;

export type SurfaceState = "live" | "idle" | "removed" | "frozen";

/** One A2UI component: an `id`, its catalog `component` name, and that component's properties. */
export interface A2uiComponent {
  id: string;
  component: string;
  [property: string]: unknown;
}

export type SurfaceDataModel = Record<string, unknown>;

export interface A2uiCreateSurface {
  version: typeof A2UI_VERSION;
  createSurface: {
    surfaceId: string;
    catalogId: string;
    components?: A2uiComponent[];
    dataModel?: SurfaceDataModel;
    sendDataModel?: boolean;
  };
}
export interface A2uiUpdateComponents {
  version: typeof A2UI_VERSION;
  updateComponents: { surfaceId: string; components: A2uiComponent[] };
}
export interface A2uiUpdateDataModel {
  version: typeof A2UI_VERSION;
  /** `path` is a JSON Pointer ("/" or absent: the whole model); a `null` value deletes the key at `path`. */
  updateDataModel: { surfaceId: string; path?: string; value: unknown };
}
export interface A2uiDeleteSurface {
  version: typeof A2UI_VERSION;
  deleteSurface: { surfaceId: string };
}
/** The agent-to-client messages Rei uses. */
export type A2uiMessage = A2uiCreateSurface | A2uiUpdateComponents | A2uiUpdateDataModel | A2uiDeleteSurface;

/** The client-to-server message a component's action sends. */
export interface A2uiAction {
  version: typeof A2UI_VERSION;
  action: {
    name: string;
    surfaceId: string;
    sourceComponentId: string;
    /** ISO 8601. */
    timestamp: string;
    /** The component's action context with every binding resolved. */
    context: Record<string, unknown>;
    userMessage?: string;
  };
}

/** A Rei source that writes a surface's data while it runs. The first release has one kind: a worker session. */
export interface SurfaceFeed {
  kind: "worker";
  sessionId: SessionId;
  title: string;
}

/**
 * A surface as a client draws it: its current state as one A2UI `createSurface` message, wrapped with what A2UI lacks.
 * A revision replaces the whole part in the view (the client keeps local input state for components that still exist).
 */
export interface Surface {
  surfaceId: string;
  /** The session that owns it. In a fork, a copy owned by another session is frozen. */
  sessionId: SessionId;
  /** The run whose reply shows it. */
  runId: RunId;
  revision: number;
  state: SurfaceState;
  /** A short name for activity rows and the Inspector, such as "Flight prices". */
  title: string;
  /** Plain text carrying everything the surface shows, for clients that cannot draw it, search, copy and notifications. */
  fallback: string;
  protocolVersion: string;
  feed?: SurfaceFeed;
  /** The surface as one A2UI message; absent once removed. */
  message?: A2uiCreateSurface;
  updatedAt: number;
}

/**
 * A complete or streaming assistant reply that shows surfaces, as parts in order: markdown text and surfaces placed
 * where their tool call happened.
 */
export type MessagePart = { type: "text"; text: string } | { type: "surface"; surface: Surface };

/** On a user message an action sent: which surface, revision and component, and the action's name. */
export interface SurfaceActionRef {
  surfaceId: string;
  revision: number;
  componentId: string;
  name: string;
}

/**
 * POST /api/sessions/:id/surfaces/:surfaceId/actions. Idempotent by requestId. The server reloads the stored surface,
 * accepts the action only on a live or idle surface whose components have not changed since the revision the client
 * drew (a feed changing only data does not make it stale), re-runs the component's checks, then
 * writes a user message saying what was done (with `Message.surfaceAction` set) and starts a run. An action is never an
 * approval. Errors: "not_found", "stale_surface", "surface_closed", "bad_action", "already_submitted".
 */
export interface SurfaceActionRequest {
  requestId: string;
  /** The revision the client drew when the action happened. */
  revision: number;
  action: A2uiAction;
  /** The client's data model when the action happened (its inputs' values); the server re-runs the checks against it. */
  dataModel: SurfaceDataModel;
}
export interface SurfaceActionResponse {
  messageId: MessageId;
  runId: RunId;
}

export type SurfaceAuthor =
  | { kind: "agent"; runId: RunId; toolCallId: string; tool: "show_surface" | "update_surface" }
  | { kind: "feed"; feed: "worker"; sessionId: SessionId };

/** One revision as the Inspector shows it. `components` and `dataModel` are absent for revisions past the kept window. */
export interface SurfaceRevision {
  revision: number;
  author: SurfaceAuthor;
  at: number;
  /** What changed, in one line ("Created with 6 components", "Data /percent changed"). */
  summary: string;
  /** The A2UI messages of this revision. */
  messages?: A2uiMessage[];
  components?: A2uiComponent[];
  dataModel?: SurfaceDataModel;
}

export type SurfaceActionDecision = "accepted" | "stale" | "rejected" | "duplicate";

export interface SurfaceActionRecord {
  requestId: string;
  at: number;
  revision: number;
  componentId: string;
  name: string;
  decision: SurfaceActionDecision;
  /** Why it was refused, or for an accepted one, the run it started. */
  reason?: string;
  runId?: RunId;
}

/** A `show_surface` or `update_surface` call the server refused; the model saw these errors and may repair. */
export interface SurfaceFailure {
  at: number;
  runId: RunId;
  toolCallId: string;
  tool: "show_surface" | "update_surface";
  surfaceId?: string;
  title?: string;
  errors: string[];
}

/** GET /api/sessions/:id/surfaces/:surfaceId — everything the Inspector shows about one surface. */
export interface SurfaceDetailResponse {
  surface: Surface;
  revisions: SurfaceRevision[];
  actions: SurfaceActionRecord[];
  /** Failed calls that named this surface, or that tried to create it in the same run. */
  failures: SurfaceFailure[];
}
