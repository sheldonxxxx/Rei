import { arr, bool, nullable, num, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type {
  CreateKnowledgeMcpTokenRequest,
  KnowledgeMcpAllowedPage,
  KnowledgeMcpPermissions,
  KnowledgeMcpSecretResponse,
  KnowledgeMcpToken,
  KnowledgeMcpTokensResponse,
  UpdateKnowledgeMcpTokenRequest,
} from "../knowledge.ts";
import { OkSchema } from "./auth.ts";
import { defineRoute, named } from "./define.ts";
import type { Same } from "./same.ts";

export const KnowledgeMcpPermissionsSchema = named(
  "KnowledgeMcpPermissions",
  obj({ read: bool(), write: bool(), delete: bool() }),
);
true satisfies Same<Static<typeof KnowledgeMcpPermissionsSchema>, KnowledgeMcpPermissions>;

export const KnowledgeMcpAllowedPageSchema = named(
  "KnowledgeMcpAllowedPage",
  obj({
    pageId: str(),
    title: nullable(str()),
    path: nullable(str()),
    status: oneOf(["live", "trashed", "missing"]),
  }),
);
true satisfies Same<Static<typeof KnowledgeMcpAllowedPageSchema>, KnowledgeMcpAllowedPage>;

export const KnowledgeMcpTokenSchema = named(
  "KnowledgeMcpToken",
  obj({
    id: str(),
    name: str(),
    tokenPrefix: str(),
    enabled: bool(),
    permissions: KnowledgeMcpPermissionsSchema,
    allowedPages: arr(KnowledgeMcpAllowedPageSchema),
    createdAt: num(),
    updatedAt: num(),
    lastUsedAt: nullable(num()),
  }),
);
true satisfies Same<Static<typeof KnowledgeMcpTokenSchema>, KnowledgeMcpToken>;

export const KnowledgeMcpTokensResponseSchema = obj({
  endpointPath: str(),
  tokens: arr(KnowledgeMcpTokenSchema),
});
true satisfies Same<Static<typeof KnowledgeMcpTokensResponseSchema>, KnowledgeMcpTokensResponse>;

const PermissionsPatchSchema = obj({ read: opt(bool()), write: opt(bool()), delete: opt(bool()) });

export const CreateKnowledgeMcpTokenRequestSchema = obj({
  name: str(),
  permissions: opt(PermissionsPatchSchema),
  allowedPageIds: opt(arr(str())),
});
true satisfies Same<Static<typeof CreateKnowledgeMcpTokenRequestSchema>, CreateKnowledgeMcpTokenRequest>;

export const UpdateKnowledgeMcpTokenRequestSchema = obj({
  name: opt(str()),
  enabled: opt(bool()),
  permissions: opt(PermissionsPatchSchema),
  allowedPageIds: opt(arr(str())),
});
true satisfies Same<Static<typeof UpdateKnowledgeMcpTokenRequestSchema>, UpdateKnowledgeMcpTokenRequest>;

export const KnowledgeMcpSecretResponseSchema = obj({
  token: KnowledgeMcpTokenSchema,
  secret: str(),
});
true satisfies Same<Static<typeof KnowledgeMcpSecretResponseSchema>, KnowledgeMcpSecretResponse>;

export const listKnowledgeMcpTokensRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/mcp/tokens",
  tag: "knowledge",
  summary: "List Knowledge MCP access tokens.",
  response: KnowledgeMcpTokensResponseSchema,
});

export const createKnowledgeMcpTokenRoute = defineRoute({
  method: "POST",
  path: "/api/knowledge/mcp/tokens",
  tag: "knowledge",
  summary: "Create a Knowledge MCP access token (returns the secret once).",
  body: CreateKnowledgeMcpTokenRequestSchema,
  response: KnowledgeMcpSecretResponseSchema,
  status: 201,
});

export const updateKnowledgeMcpTokenRoute = defineRoute({
  method: "PATCH",
  path: "/api/knowledge/mcp/tokens/:id",
  tag: "knowledge",
  summary: "Update a Knowledge MCP token's name, status, permissions, or allowed folders.",
  body: UpdateKnowledgeMcpTokenRequestSchema,
  response: obj({ token: KnowledgeMcpTokenSchema }),
});

export const rotateKnowledgeMcpTokenRoute = defineRoute({
  method: "POST",
  path: "/api/knowledge/mcp/tokens/:id/rotate",
  tag: "knowledge",
  summary: "Rotate a Knowledge MCP token's secret (returns the new secret once).",
  response: KnowledgeMcpSecretResponseSchema,
});

export const revokeKnowledgeMcpTokenRoute = defineRoute({
  method: "DELETE",
  path: "/api/knowledge/mcp/tokens/:id",
  tag: "knowledge",
  summary: "Revoke a Knowledge MCP token.",
  response: OkSchema,
});

export const knowledgeMcpRoutes = [
  listKnowledgeMcpTokensRoute,
  createKnowledgeMcpTokenRoute,
  updateKnowledgeMcpTokenRoute,
  rotateKnowledgeMcpTokenRoute,
  revokeKnowledgeMcpTokenRoute,
] as const;
