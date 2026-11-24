// Schemas of surfaces as messages carry them (docs/surfaces.md). These describe Rei's wrapper. The A2UI content
// (`message`, components, actions) is described here structurally; its exact shape is A2UI v1.0 with Rei's catalog,
// published as JSON Schema in `packages/protocol/vendor/a2ui-v1_0/` and `packages/protocol/catalog/rei-catalog-1.json`,
// and the server checks every stored message against them.
import { arr, bool, int, lit, map, obj, oneOf, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import type {
  A2uiAction,
  A2uiComponent,
  A2uiCreateSurface,
  A2uiMessage,
  MessagePart,
  Surface,
  SurfaceActionRecord,
  SurfaceActionRef,
  SurfaceActionRequest,
  SurfaceActionResponse,
  SurfaceAuthor,
  SurfaceDetailResponse,
  SurfaceFailure,
  SurfaceRevision,
} from "../surfaces.ts";
import { defineRoute, named, type Schema } from "./define.ts";
import type { Same } from "./same.ts";

const v1 = () => lit("1.0");

export const A2uiComponentSchema = named(
  "A2uiComponent",
  // Open: the remaining properties are the catalog component's own (pi-schema types an open object by its named fields).
  obj(
    { id: str(), component: str() },
    { open: true, description: "An A2UI v1.0 component from Rei's catalog; its properties follow the catalog." },
  ) as unknown as Schema<A2uiComponent>,
);
true satisfies Same<Static<typeof A2uiComponentSchema>, A2uiComponent>;

const DataModelSchema = map(unknown());

export const A2uiCreateSurfaceSchema = named(
  "A2uiCreateSurface",
  obj({
    version: v1(),
    createSurface: obj({
      surfaceId: str(),
      catalogId: str(),
      components: opt(arr(A2uiComponentSchema)),
      dataModel: opt(DataModelSchema),
      sendDataModel: opt(bool()),
    }),
  }),
);

export const A2uiMessageSchema = named(
  "A2uiMessage",
  union([
    A2uiCreateSurfaceSchema,
    obj({ version: v1(), updateComponents: obj({ surfaceId: str(), components: arr(A2uiComponentSchema) }) }),
    obj({ version: v1(), updateDataModel: obj({ surfaceId: str(), path: opt(str()), value: unknown() }) }),
    obj({ version: v1(), deleteSurface: obj({ surfaceId: str() }) }),
  ]),
);

export const A2uiActionSchema = named(
  "A2uiAction",
  obj({
    version: v1(),
    action: obj({
      name: str({ minLength: 1, maxLength: 100 }),
      surfaceId: str(),
      sourceComponentId: str(),
      timestamp: str({ description: "ISO 8601." }),
      context: DataModelSchema,
      userMessage: opt(str({ maxLength: 500 })),
    }),
  }),
);
true satisfies Same<Static<typeof A2uiActionSchema>, A2uiAction>;

export const SurfaceSchema = named(
  "Surface",
  obj({
    surfaceId: str(),
    sessionId: str(),
    runId: str(),
    revision: int({ minimum: 1 }),
    state: oneOf(["live", "idle", "removed", "frozen"]),
    title: str(),
    fallback: str({ description: "Plain text carrying everything the surface shows." }),
    protocolVersion: str(),
    feed: opt(obj({ kind: lit("worker"), sessionId: str(), title: str() })),
    message: opt(A2uiCreateSurfaceSchema),
    updatedAt: int(),
  }),
);

export const MessagePartSchema = named(
  "MessagePart",
  union([obj({ type: lit("text"), text: str() }), obj({ type: lit("surface"), surface: SurfaceSchema })]),
);

export const SurfaceActionRefSchema = named(
  "SurfaceActionRef",
  obj({ surfaceId: str(), revision: int(), componentId: str(), name: str() }),
);
true satisfies Same<Static<typeof SurfaceActionRefSchema>, SurfaceActionRef>;

export const SurfaceActionRequestSchema = obj({
  requestId: str({ minLength: 1, maxLength: 100 }),
  revision: int({ minimum: 1 }),
  action: A2uiActionSchema,
  dataModel: DataModelSchema,
});
true satisfies Same<Static<typeof SurfaceActionRequestSchema>, SurfaceActionRequest>;

export const SurfaceActionResponseSchema = obj({ messageId: str(), runId: str() });
true satisfies Same<Static<typeof SurfaceActionResponseSchema>, SurfaceActionResponse>;

const SurfaceAuthorSchema = union([
  obj({ kind: lit("agent"), runId: str(), toolCallId: str(), tool: oneOf(["show_surface", "update_surface"]) }),
  obj({ kind: lit("feed"), feed: lit("worker"), sessionId: str() }),
]);
true satisfies Same<Static<typeof SurfaceAuthorSchema>, SurfaceAuthor>;

const SurfaceRevisionSchema = obj({
  revision: int(),
  author: SurfaceAuthorSchema,
  at: int(),
  summary: str(),
  messages: opt(arr(A2uiMessageSchema)),
  components: opt(arr(A2uiComponentSchema)),
  dataModel: opt(DataModelSchema),
});

const SurfaceActionRecordSchema = obj({
  requestId: str(),
  at: int(),
  revision: int(),
  componentId: str(),
  name: str(),
  decision: oneOf(["accepted", "stale", "rejected", "duplicate"]),
  reason: opt(str()),
  runId: opt(str()),
});
true satisfies Same<Static<typeof SurfaceActionRecordSchema>, SurfaceActionRecord>;

const SurfaceFailureSchema = obj({
  at: int(),
  runId: str(),
  toolCallId: str(),
  tool: oneOf(["show_surface", "update_surface"]),
  surfaceId: opt(str()),
  title: opt(str()),
  errors: arr(str()),
});
true satisfies Same<Static<typeof SurfaceFailureSchema>, SurfaceFailure>;

export const SurfaceDetailResponseSchema = obj({
  surface: SurfaceSchema,
  revisions: arr(SurfaceRevisionSchema),
  actions: arr(SurfaceActionRecordSchema),
  failures: arr(SurfaceFailureSchema),
});

true satisfies Same<Static<typeof A2uiCreateSurfaceSchema>, A2uiCreateSurface>;
true satisfies Same<Static<typeof A2uiMessageSchema>, A2uiMessage>;
true satisfies Same<Static<typeof SurfaceSchema>, Surface>;
true satisfies Same<Static<typeof MessagePartSchema>, MessagePart>;
true satisfies Same<Static<typeof SurfaceRevisionSchema>, SurfaceRevision>;
true satisfies Same<Static<typeof SurfaceDetailResponseSchema>, SurfaceDetailResponse>;

export const surfaceActionRoute = defineRoute({
  method: "POST",
  path: "/api/sessions/:id/surfaces/:surfaceId/actions",
  tag: "chat",
  summary: "Send a surface action (a button press or a final submit); starts a run like a message.",
  description:
    'Idempotent by requestId. Accepted only on a live or idle surface at its current revision. Errors: "not_found", "stale_surface", "surface_closed", "bad_action", "already_submitted".',
  body: SurfaceActionRequestSchema,
  response: SurfaceActionResponseSchema,
  fieldCodes: { action: "bad_action", revision: "bad_action" },
});

export const surfaceDetailRoute = defineRoute({
  method: "GET",
  path: "/api/sessions/:id/surfaces/:surfaceId",
  tag: "chat",
  summary: "One surface with its revisions, action decisions and validation failures, for the Inspector.",
  description: 'Errors: "not_found".',
  response: SurfaceDetailResponseSchema,
});

export const surfaceRoutes = [surfaceActionRoute, surfaceDetailRoute];
