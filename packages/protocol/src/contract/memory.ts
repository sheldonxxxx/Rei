// Memory and history search (issue 16). Request and response types still live in ../memory.ts and ../gateway.ts as
// interfaces; each schema here is checked against its interface at compile time.
import { arr, bool, int, nullable, num, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type { MemorySetupSettings } from "../gateway.ts";
import type {
  AddMemoryLineRequest,
  HistoryHit,
  HistorySearchResponse,
  IndexStatus,
  IndexStatusResponse,
  MemoryChange,
  MemoryChangesResponse,
  MemoryLine,
  MemoryLineResponse,
  MemoryResponse,
  UndoMemoryChangeResponse,
  UpdateMemoryLineRequest,
} from "../memory.ts";
import { defineRoute, named } from "./define.ts";
import { MemoryChangeSchema, TaintLabelSchema } from "./entities.ts";
import type { Same } from "./same.ts";

const MemoryDocSchema = oneOf(["profile", "agent"]);

export const MemoryLineSchema = named(
  "MemoryLine",
  obj({
    id: str(),
    doc: MemoryDocSchema,
    agentId: nullable(str()),
    text: str(),
    source: nullable(obj({ sessionId: str(), messageId: str(), sessionTitle: str() })),
    sourceDeleted: bool(),
    addedAt: num(),
    confirmedAt: num(),
    updatedAt: num(),
  }),
);
true satisfies Same<Static<typeof MemoryLineSchema>, MemoryLine>;

export const HistoryHitSchema = named(
  "HistoryHit",
  obj({
    relevance: opt(oneOf(["match", "related"])),
    chunkId: str(),
    sessionId: str(),
    sessionTitle: str(),
    agentId: str(),
    messageId: str(),
    kind: oneOf(["user", "assistant", "report", "tool"]),
    toolName: nullable(str()),
    snippet: str(),
    createdAt: num(),
    score: num(),
    keywordRank: nullable(int()),
    vectorRank: nullable(int()),
    cosine: nullable(num()),
    taint: arr(TaintLabelSchema),
  }),
);
true satisfies Same<Static<typeof HistoryHitSchema>, HistoryHit>;

export const IndexStatusSchema = named(
  "IndexStatus",
  obj({
    state: oneOf(["ready", "indexing", "down", "off"]),
    model: nullable(str()),
    dimensions: nullable(int()),
    entries: int(),
    embedded: int(),
    building: nullable(obj({ model: str(), embedded: int(), total: int() })),
    lastError: nullable(str()),
    remote: bool(),
    indexing: opt(obj({ pending: int(), lastError: nullable(str()) })),
  }),
);
true satisfies Same<Static<typeof IndexStatusSchema>, IndexStatus>;

export const MemoryResponseSchema = obj({
  profile: arr(MemoryLineSchema),
  agents: arr(obj({ agentId: str(), lines: arr(MemoryLineSchema), usedTokens: num(), tokenBudget: num() })),
  userUsedTokens: num(),
  userTokenBudget: num(),
  usedTokens: num(),
});
true satisfies Same<Static<typeof MemoryResponseSchema>, MemoryResponse>;
export const AddMemoryLineRequestSchema = obj({ doc: MemoryDocSchema, agentId: opt(str()), text: str() });
true satisfies Same<Static<typeof AddMemoryLineRequestSchema>, AddMemoryLineRequest>;
export const UpdateMemoryLineRequestSchema = obj({ text: str() });
true satisfies Same<Static<typeof UpdateMemoryLineRequestSchema>, UpdateMemoryLineRequest>;
export const MemoryLineResponseSchema = obj({ line: MemoryLineSchema, change: MemoryChangeSchema });
true satisfies Same<Static<typeof MemoryLineResponseSchema>, MemoryLineResponse>;
export const MemoryChangeResponseSchema = obj({ change: MemoryChangeSchema });
true satisfies Same<Static<typeof MemoryChangeResponseSchema>, { change: MemoryChange }>;
export const MemoryChangesResponseSchema = obj({ changes: arr(MemoryChangeSchema) });
true satisfies Same<Static<typeof MemoryChangesResponseSchema>, MemoryChangesResponse>;
export const UndoMemoryChangeResponseSchema = obj({ change: MemoryChangeSchema, line: nullable(MemoryLineSchema) });
true satisfies Same<Static<typeof UndoMemoryChangeResponseSchema>, UndoMemoryChangeResponse>;
export const HistorySearchQuerySchema = obj({
  q: opt(str()),
  from: opt(num({ description: "Epoch milliseconds." })),
  to: opt(num({ description: "Epoch milliseconds." })),
  agent: opt(str({ description: "Only this agent's chats and sessions." })),
  limit: opt(num({ description: "1–50, default 20." })),
});
export const HistorySearchResponseSchema = obj({ hits: arr(HistoryHitSchema), index: IndexStatusSchema });
true satisfies Same<Static<typeof HistorySearchResponseSchema>, HistorySearchResponse>;
export const IndexStatusResponseSchema = obj({ index: IndexStatusSchema });
true satisfies Same<Static<typeof IndexStatusResponseSchema>, IndexStatusResponse>;
export const MemorySetupSettingsSchema = obj({ enabled: bool(), available: bool(), model: nullable(str()) });
true satisfies Same<Static<typeof MemorySetupSettingsSchema>, MemorySetupSettings>;
export const SaveMemorySetupRequestSchema = obj({ enabled: bool() });

export const memoryRoute = defineRoute({
  method: "GET",
  path: "/api/memory",
  tag: "memory",
  summary: "The profile and every agent's agent.md, with their token use.",
  response: MemoryResponseSchema,
});
export const addMemoryLineRoute = defineRoute({
  method: "POST",
  path: "/api/memory/lines",
  tag: "memory",
  summary: "Add a line you wrote.",
  description: 'Errors: "too_long", "over_budget", "unknown_agent", "empty", "bad_request".',
  body: AddMemoryLineRequestSchema,
  response: MemoryLineResponseSchema,
});
export const updateMemoryLineRoute = defineRoute({
  method: "PATCH",
  path: "/api/memory/lines/:id",
  tag: "memory",
  summary: "Edit a line; the same text confirms it.",
  description: 'Errors: "not_found", "too_long", "over_budget", "empty".',
  body: UpdateMemoryLineRequestSchema,
  response: MemoryLineResponseSchema,
});
export const removeMemoryLineRoute = defineRoute({
  method: "DELETE",
  path: "/api/memory/lines/:id",
  tag: "memory",
  summary: "Remove a line.",
  description: 'Answers the change, which can be undone. Errors: "not_found".',
  response: MemoryChangeResponseSchema,
});
export const memoryLineChangesRoute = defineRoute({
  method: "GET",
  path: "/api/memory/lines/:id/changes",
  tag: "memory",
  summary: "A line's versions, oldest first.",
  description: 'Errors: "not_found".',
  response: MemoryChangesResponseSchema,
});
export const undoMemoryChangeRoute = defineRoute({
  method: "POST",
  path: "/api/memory/changes/:id/undo",
  tag: "memory",
  summary: "Undo a change, restoring the line as it was before it.",
  description: 'Errors: "not_found", "not_undoable", "over_budget".',
  response: UndoMemoryChangeResponseSchema,
});
export const historySearchRoute = defineRoute({
  method: "GET",
  path: "/api/history/search",
  tag: "memory",
  summary: "Search past chats by keyword and meaning.",
  description: 'Errors: "bad_query" (a non-numeric from, to or limit), "unknown_agent".',
  query: HistorySearchQuerySchema,
  response: HistorySearchResponseSchema,
  fieldCodes: { from: "bad_query", to: "bad_query", limit: "bad_query" },
});
export const memoryIndexRoute = defineRoute({
  method: "GET",
  path: "/api/memory/index",
  tag: "memory",
  summary: "The embedder and the history index.",
  response: IndexStatusResponseSchema,
});
export const rebuildMemoryIndexRoute = defineRoute({
  method: "POST",
  path: "/api/memory/index/rebuild",
  tag: "memory",
  summary: "Re-embed everything into a new vector set in the background.",
  response: IndexStatusResponseSchema,
});
export const memorySetupRoute = defineRoute({
  method: "GET",
  path: "/api/memory/setup",
  tag: "memory",
  summary: "Whether meaning search is on, and whether it can be.",
  response: MemorySetupSettingsSchema,
});
export const saveMemorySetupRoute = defineRoute({
  method: "POST",
  path: "/api/memory/setup",
  tag: "memory",
  summary: "Turn meaning search on or off.",
  body: SaveMemorySetupRequestSchema,
  response: MemorySetupSettingsSchema,
});

export const memoryRoutes = [
  memoryRoute,
  addMemoryLineRoute,
  updateMemoryLineRoute,
  removeMemoryLineRoute,
  memoryLineChangesRoute,
  undoMemoryChangeRoute,
  historySearchRoute,
  memoryIndexRoute,
  rebuildMemoryIndexRoute,
  memorySetupRoute,
  saveMemorySetupRoute,
] as const;
