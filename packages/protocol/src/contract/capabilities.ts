// Skills, plugins and MCP connectors (issue 18). Request and response types still live in ../skills.ts, ../plugins.ts
// and ../api.ts as interfaces; each schema here is checked against its interface at compile time.
import {
  arr,
  bool,
  int,
  lit,
  map,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  type Static,
  str,
  unknown,
} from "@earendil-works/pi-schema";
import type {
  Connector,
  ConnectorOAuthFinishRequest,
  ConnectorOAuthStartRequest,
  ConnectorOAuthStartResponse,
  ConnectorResponse,
  ConnectorsResponse,
  ConnectorTool,
  ConnectorToolsResponse,
  CreateConnectorRequest,
  SetMcpProfileRequest,
  SetToolClassRequest,
  UpdateConnectorRequest,
} from "../api.ts";
import type { PluginDetail, PluginInstallationRequest, PluginRevision, PluginSummary } from "../plugins.ts";
import type {
  ComponentOwner,
  ImportSkillRequest,
  SkillResponse,
  SkillSavedResponse,
  SkillSummary,
  SkillsResponse,
  SkillVersionSummary,
  UpdateSkillRequest,
} from "../skills.ts";
import { OkSchema } from "./auth.ts";
import { defineRoute, named } from "./define.ts";
import { PluginPackageSchema, SkillFileSchema } from "./entities.ts";
import type { Same } from "./same.ts";

const flag = () => lit("1");

export const ComponentOwnerSchema = named("ComponentOwner", obj({ id: str(), name: str(), enabled: bool() }));
true satisfies Same<Static<typeof ComponentOwnerSchema>, ComponentOwner>;

// ---- skills ---------------------------------------------------------------------------------------------------------

export const SkillSummarySchema = named(
  "SkillSummary",
  obj({
    id: str(),
    name: str(),
    description: str(),
    version: int(),
    agents: nullable(arr(str())),
    fileCount: int(),
    author: oneOf(["user", "agent"]),
    builtIn: opt(bool()),
    plugin: opt(nullable(ComponentOwnerSchema)),
    createdAt: num(),
    updatedAt: num(),
  }),
);
true satisfies Same<Static<typeof SkillSummarySchema>, SkillSummary>;
export const SkillVersionSummarySchema = obj({
  version: int(),
  author: oneOf(["user", "agent"]),
  sessionId: nullable(str()),
  note: str(),
  createdAt: num(),
});
true satisfies Same<Static<typeof SkillVersionSummarySchema>, SkillVersionSummary>;
export const SkillsResponseSchema = obj({ skills: arr(SkillSummarySchema) });
true satisfies Same<Static<typeof SkillsResponseSchema>, SkillsResponse>;
export const SkillResponseSchema = obj({
  skill: SkillSummarySchema,
  version: int(),
  files: arr(SkillFileSchema),
  versions: arr(SkillVersionSummarySchema),
});
true satisfies Same<Static<typeof SkillResponseSchema>, SkillResponse>;
export const ImportSkillRequestSchema = obj({
  files: opt(arr(SkillFileSchema)),
  zip: opt(str({ description: "Base64 of a .zip whose SKILL.md is at the top or inside one folder." })),
});
true satisfies Same<Static<typeof ImportSkillRequestSchema>, ImportSkillRequest>;
export const SkillSavedResponseSchema = obj({ skill: SkillSummarySchema });
true satisfies Same<Static<typeof SkillSavedResponseSchema>, SkillSavedResponse>;
export const UpdateSkillRequestSchema = obj({
  files: opt(arr(SkillFileSchema)),
  restore: opt(int({ description: "A version number to make a new version from." })),
  agents: opt(nullable(arr(str()))),
});
true satisfies Same<Static<typeof UpdateSkillRequestSchema>, UpdateSkillRequest>;
export const SkillVersionQuerySchema = obj({ version: opt(int({ minimum: 1 })) });

export const skillsRoute = defineRoute({
  method: "GET",
  path: "/api/skills",
  tag: "skills",
  summary: "Every skill, with the plugin that owns it.",
  response: SkillsResponseSchema,
});
export const skillRoute = defineRoute({
  method: "GET",
  path: "/api/skills/:id",
  tag: "skills",
  summary: "A version's files (SKILL.md first) and the version list.",
  description: 'Errors: "not_found".',
  query: SkillVersionQuerySchema,
  response: SkillResponseSchema,
});
export const exportSkillRoute = defineRoute({
  method: "GET",
  path: "/api/skills/:id/export",
  tag: "skills",
  summary: "A version as a .zip with one folder named after the skill.",
  description: 'Errors: "not_found".',
  query: SkillVersionQuerySchema,
  raw: { kind: "binary", contentType: "application/zip" },
});
export const importSkillRoute = defineRoute({
  method: "POST",
  path: "/api/skills",
  tag: "skills",
  summary: "Import a skill from its files or a zip; the same name gets a new version.",
  description:
    'At most 8 MB. Errors: "bad_request" (the message says which rule failed: frontmatter, name, size...), "too_large" (413).',
  body: ImportSkillRequestSchema,
  response: SkillSavedResponseSchema,
});
export const updateSkillRoute = defineRoute({
  method: "PATCH",
  path: "/api/skills/:id",
  tag: "skills",
  summary: "Edit a skill's files, restore an old version, or set which agents see it.",
  description: 'Errors: "not_found", "bad_request".',
  body: UpdateSkillRequestSchema,
  response: SkillSavedResponseSchema,
});
export const deleteSkillRoute = defineRoute({
  method: "DELETE",
  path: "/api/skills/:id",
  tag: "skills",
  summary: "Remove a skill and its versions.",
  description: 'Errors: "not_found", "bad_request" (a built-in skill).',
  response: OkSchema,
});

// ---- plugins --------------------------------------------------------------------------------------------------------

const pluginSummaryFields = {
  id: str(),
  name: str(),
  description: str(),
  revision: int(),
  enabled: bool(),
  agents: nullable(arr(str())),
  builtIn: bool(),
  skillCount: int(),
  connectionCount: int(),
};
export const PluginSummarySchema = named("PluginSummary", obj(pluginSummaryFields));
true satisfies Same<Static<typeof PluginSummarySchema>, PluginSummary>;
export const PluginRevisionSchema = obj({
  revision: int(),
  author: oneOf(["user", "agent"]),
  sessionId: nullable(str()),
  createdAt: num(),
});
true satisfies Same<Static<typeof PluginRevisionSchema>, PluginRevision>;

// ---- connectors (before plugins' detail, which embeds them) ---------------------------------------------------------

const ToolClassSchema = oneOf(["read_external", "write_external", "send", "irreversible"]);
export const ConnectorSchema = named(
  "Connector",
  obj({
    id: str(),
    name: str(),
    url: str(),
    auth: oneOf(["oauth", "token", "none"]),
    tokenHeader: opt(str()),
    status: oneOf(["connected", "needs_auth", "error"]),
    error: nullable(str()),
    toolCount: nullable(int()),
    createdAt: num(),
    holdsPrivate: bool(),
    mcpProfile: opt(oneOf(["always_ask", "read_only", "read_write", "yolo"])),
    mcpProfileRevision: opt(str()),
    providerIdentity: opt(str()),
    plugin: opt(nullable(ComponentOwnerSchema)),
  }),
);
true satisfies Same<Static<typeof ConnectorSchema>, Connector>;

export const PluginDetailSchema = named(
  "PluginDetail",
  obj({
    ...pluginSummaryFields,
    package: PluginPackageSchema,
    selectedRevision: int(),
    revisions: arr(PluginRevisionSchema),
    skills: arr(obj({ name: str(), id: str(), reference: str() })),
    connections: arr(
      obj({
        name: str(),
        connectorId: nullable(str()),
        status: oneOf(["pending", "needs_auth", "ready", "error"]),
        error: nullable(str()),
        connector: opt(ConnectorSchema),
      }),
    ),
  }),
);
true satisfies Same<Static<typeof PluginDetailSchema>, PluginDetail>;
export const PluginsResponseSchema = obj({ plugins: arr(PluginSummarySchema) });
export const PluginResponseSchema = obj({ plugin: PluginDetailSchema });
export const SavePluginRequestSchema = obj({
  package: PluginPackageSchema,
  expectedRevision: opt(int({ description: "Required to change an existing plugin." })),
});
export const ImportPluginRequestSchema = obj({
  zip: opt(str({ description: "Base64 of the plugin's .zip." })),
  files: opt(arr(SkillFileSchema)),
  expectedRevision: opt(int({ description: "Required when a plugin of the same name exists." })),
});
export const PluginInstallationRequestSchema = obj({ enabled: opt(bool()), agents: opt(nullable(arr(str()))) });
true satisfies Same<Static<typeof PluginInstallationRequestSchema>, PluginInstallationRequest>;
export const PluginRevisionQuerySchema = obj({ revision: opt(int({ minimum: 1 })) });

const TOO_LARGE = 'At most 8 MB. Errors: "too_large" (413), "bad_request".';
export const pluginsRoute = defineRoute({
  method: "GET",
  path: "/api/plugins",
  tag: "plugins",
  summary: "Every plugin.",
  response: PluginsResponseSchema,
});
export const createPluginRoute = defineRoute({
  method: "POST",
  path: "/api/plugins",
  tag: "plugins",
  summary: "Save a new plugin from its package.",
  description: TOO_LARGE,
  body: SavePluginRequestSchema,
  response: PluginResponseSchema,
});
export const importPluginRoute = defineRoute({
  method: "POST",
  path: "/api/plugins/import",
  tag: "plugins",
  summary: "Import a plugin from a zip or a folder's files.",
  description: TOO_LARGE,
  body: ImportPluginRequestSchema,
  response: PluginResponseSchema,
});
export const exportPluginRoute = defineRoute({
  method: "GET",
  path: "/api/plugins/:id/export",
  tag: "plugins",
  summary: "A revision of a plugin as a .zip.",
  query: PluginRevisionQuerySchema,
  raw: { kind: "binary", contentType: "application/zip" },
});
export const pluginRoute = defineRoute({
  method: "GET",
  path: "/api/plugins/:id",
  tag: "plugins",
  summary: "One plugin, at a revision or the latest.",
  query: PluginRevisionQuerySchema,
  response: PluginResponseSchema,
});
export const updatePluginRoute = defineRoute({
  method: "PATCH",
  path: "/api/plugins/:id",
  tag: "plugins",
  summary: "Save a new revision of a plugin.",
  description: TOO_LARGE,
  body: SavePluginRequestSchema,
  response: PluginResponseSchema,
});
export const pluginInstallationRoute = defineRoute({
  method: "PATCH",
  path: "/api/plugins/:id/installation",
  tag: "plugins",
  summary: "Turn a plugin on or off, or set which agents see it.",
  body: PluginInstallationRequestSchema,
  response: PluginResponseSchema,
});
export const retryPluginRoute = defineRoute({
  method: "POST",
  path: "/api/plugins/:id/retry",
  tag: "plugins",
  summary: "Try again to set up a plugin's connections.",
  response: PluginResponseSchema,
});
export const deletePluginRoute = defineRoute({
  method: "DELETE",
  path: "/api/plugins/:id",
  tag: "plugins",
  summary: "Remove a plugin with its skills and connections.",
  response: OkSchema,
});

// ---- connectors -----------------------------------------------------------------------------------------------------

export const ConnectorToolSchema = named(
  "ConnectorTool",
  obj({
    name: str(),
    title: nullable(str()),
    description: str(),
    inputSchema: map(unknown()),
    outputSchema: opt(map(unknown())),
    annotations: obj({
      readOnlyHint: opt(bool()),
      destructiveHint: opt(bool()),
      idempotentHint: opt(bool()),
      openWorldHint: opt(bool()),
    }),
    defaultClass: ToolClassSchema,
    override: nullable(ToolClassSchema),
    effectiveClass: opt(ToolClassSchema),
    definitionFingerprint: opt(str()),
  }),
);
true satisfies Same<
  Omit<Static<typeof ConnectorToolSchema>, "inputSchema" | "outputSchema">,
  Omit<ConnectorTool, "inputSchema" | "outputSchema">
>;
export const ConnectorsResponseSchema = obj({ connectors: arr(ConnectorSchema) });
true satisfies Same<Static<typeof ConnectorsResponseSchema>, ConnectorsResponse>;
export const ConnectorResponseSchema = obj({ connector: ConnectorSchema });
true satisfies Same<Static<typeof ConnectorResponseSchema>, ConnectorResponse>;
export const CreateConnectorRequestSchema = obj({
  name: str({ description: "1 to 80 characters." }),
  url: str({ description: "1 to 2000 characters." }),
  token: opt(str({ description: "Up to 4000 characters; empty means none." })),
  tokenHeader: opt(str({ description: "Custom token header name. Omit for Authorization: Bearer." })),
});
true satisfies Same<Static<typeof CreateConnectorRequestSchema>, CreateConnectorRequest>;
export const UpdateConnectorRequestSchema = obj({
  name: opt(str()),
  token: opt(nullable(str({ description: "Null forgets the token." }))),
  tokenHeader: opt(nullable(str({ description: "Null restores Authorization: Bearer. Omit to keep the header." }))),
  holdsPrivate: opt(bool()),
});
true satisfies Same<Static<typeof UpdateConnectorRequestSchema>, UpdateConnectorRequest>;
export const SetMcpProfileRequestSchema = obj({
  profile: oneOf(["always_ask", "read_only", "read_write", "yolo"]),
  providerIdentity: str(),
  expectedRevision: str(),
  confirmYolo: opt(bool()),
});
true satisfies Same<Static<typeof SetMcpProfileRequestSchema>, SetMcpProfileRequest>;
export const ConnectorToolsQuerySchema = obj({ refresh: opt(flag()) });
export const ConnectorToolsResponseSchema = obj({ tools: arr(ConnectorToolSchema), fetchedAt: num() });
true satisfies Same<Omit<Static<typeof ConnectorToolsResponseSchema>, "tools">, Omit<ConnectorToolsResponse, "tools">>;
export const SetToolClassRequestSchema = obj({
  actionClass: nullable(ToolClassSchema),
  definitionFingerprint: opt(str({ description: "Required for read_external: the inspected tool's fingerprint." })),
});
true satisfies Same<Static<typeof SetToolClassRequestSchema>, SetToolClassRequest>;
export const ConnectorOAuthStartRequestSchema = obj({ clientId: opt(str()), clientSecret: opt(str()) });
true satisfies Same<Static<typeof ConnectorOAuthStartRequestSchema>, ConnectorOAuthStartRequest>;
export const ConnectorOAuthStartResponseSchema = obj({ authorizationUrl: str() });
true satisfies Same<Static<typeof ConnectorOAuthStartResponseSchema>, ConnectorOAuthStartResponse>;
export const ConnectorOAuthFinishRequestSchema = obj({ state: str(), code: str(), iss: opt(str()) });
true satisfies Same<Static<typeof ConnectorOAuthFinishRequestSchema>, ConnectorOAuthFinishRequest>;
export const McpOAuthCallbackQuerySchema = obj(
  {
    code: opt(str()),
    state: opt(str()),
    iss: opt(str()),
    error: opt(str()),
    error_description: opt(str()),
  },
  { open: true },
);

export const connectorsRoute = defineRoute({
  method: "GET",
  path: "/api/connectors",
  tag: "connectors",
  summary: "Every MCP connector, with the plugin that owns it.",
  response: ConnectorsResponseSchema,
});
export const createConnectorRoute = defineRoute({
  method: "POST",
  path: "/api/connectors",
  tag: "connectors",
  summary: "Add an MCP connector.",
  description: 'Errors: "bad_request", "bad_url", "connector_unreachable".',
  body: CreateConnectorRequestSchema,
  response: ConnectorResponseSchema,
});
export const updateConnectorRoute = defineRoute({
  method: "PATCH",
  path: "/api/connectors/:id",
  tag: "connectors",
  summary: "Change a connector's name, token, token header or private data setting.",
  description: 'Errors: "not_found", "bad_request".',
  body: UpdateConnectorRequestSchema,
  response: ConnectorResponseSchema,
});
export const deleteConnectorRoute = defineRoute({
  method: "DELETE",
  path: "/api/connectors/:id",
  tag: "connectors",
  summary: "Remove a connector and revoke the grants for its tools.",
  status: 204,
});
export const setConnectorProfileRoute = defineRoute({
  method: "PUT",
  path: "/api/connectors/:id/profile",
  tag: "connectors",
  summary: "Set a connector's permission profile against its current revision.",
  description: "YOLO needs confirmYolo: true.",
  body: SetMcpProfileRequestSchema,
  response: ConnectorResponseSchema,
});
export const connectorToolsRoute = defineRoute({
  method: "GET",
  path: "/api/connectors/:id/tools",
  tag: "connectors",
  summary: "A connector's tools and their classes.",
  description: 'Errors: "not_found", "needs_auth" (409), "connector_unreachable".',
  query: ConnectorToolsQuerySchema,
  response: ConnectorToolsResponseSchema,
});
export const setConnectorToolRoute = defineRoute({
  method: "PUT",
  path: "/api/connectors/:id/tools/:tool",
  tag: "connectors",
  summary: "Override a tool's class; null clears the override.",
  description: 'Errors: "not_found", "bad_request".',
  body: SetToolClassRequestSchema,
  response: OkSchema,
});
export const connectorOAuthStartRoute = defineRoute({
  method: "POST",
  path: "/api/connectors/:id/oauth/start",
  tag: "connectors",
  summary: "Start signing in to a connector; answers the provider's address to open.",
  description: 'Errors: "no_app_origin", "client_id_required".',
  body: ConnectorOAuthStartRequestSchema,
  response: ConnectorOAuthStartResponseSchema,
});
export const mcpOAuthCallbackRoute = defineRoute({
  method: "GET",
  path: "/api/mcp/oauth/callback",
  tag: "connectors",
  auth: "open",
  summary: "Where the provider sends the browser back; answers 302 to /settings/connectors with the parameters.",
  query: McpOAuthCallbackQuerySchema,
  status: 302,
});
export const connectorOAuthFinishRoute = defineRoute({
  method: "POST",
  path: "/api/connectors/oauth/finish",
  tag: "connectors",
  summary: "Finish signing in: the gateway checks the state and exchanges the code.",
  description: 'Errors: "invalid_state", "state_expired", "iss_mismatch", "oauth_failed".',
  body: ConnectorOAuthFinishRequestSchema,
  response: ConnectorResponseSchema,
});

export const capabilityRoutes = [
  skillsRoute,
  skillRoute,
  exportSkillRoute,
  importSkillRoute,
  updateSkillRoute,
  deleteSkillRoute,
  pluginsRoute,
  createPluginRoute,
  importPluginRoute,
  exportPluginRoute,
  pluginRoute,
  updatePluginRoute,
  pluginInstallationRoute,
  retryPluginRoute,
  deletePluginRoute,
  connectorsRoute,
  createConnectorRoute,
  updateConnectorRoute,
  deleteConnectorRoute,
  setConnectorProfileRoute,
  connectorToolsRoute,
  setConnectorToolRoute,
  connectorOAuthStartRoute,
  mcpOAuthCallbackRoute,
  connectorOAuthFinishRoute,
] as const;
