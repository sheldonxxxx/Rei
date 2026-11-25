import { defineExtension } from "@earendil-works/pi-durable";
import { arr, int, lit, obj, str, union } from "@earendil-works/pi-schema";
import type { PluginPreview } from "@rei/protocol";
import { MODEL_AND_SCRIPTS, MODEL_ONLY } from "../pi/callers.ts";
import { policyTool, type ToolCatalog } from "../pi/policy-ext.ts";
import { unifiedDiff } from "../skills/diff.ts";
import type { AppStore } from "../store/store.ts";
import { Invalid } from "../util/errors.ts";
import type { PluginService } from "./service.ts";

const pkgSchema = obj({
  formatVersion: lit(1),
  name: str(),
  description: str(),
  skills: arr(
    obj({
      name: str(),
      files: arr(
        obj({
          path: str(),
          encoding: union([lit("text"), lit("base64")]),
          content: str(),
        }),
      ),
    }),
  ),
  mcp: arr(
    obj({
      name: str(),
      url: str(),
      auth: union([lit("none"), lit("token"), lit("oauth")]),
      skills: arr(str()),
    }),
  ),
});
const ok = (value: unknown) => ({
  output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
});
export function createPluginsExtension(deps: {
  treeId: string;
  store: AppStore;
  plugins: PluginService;
  catalog: ToolCatalog;
}) {
  const { treeId, store, plugins, catalog } = deps;
  const caller = (conversation: unknown) => {
    const s = store.sessionByConversation(treeId, String(conversation));
    if (!s) throw new Invalid("This session is unavailable.");
    return s;
  };
  const read = (operation: string) => ({
    actionClass: "read_internal" as const,
    connector: "plugins",
    operation,
    summary: () => `Read plugins: ${operation}`,
  });
  const list = policyTool(catalog, read("list"), {
    name: "list_plugins",
    callers: MODEL_AND_SCRIPTS,
    description:
      "Discover available plugins: reusable skills, MCP tools, or both. Read a plugin before using its components.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api) => ok(await plugins.list(caller(api.conversationId).agent_id)),
  });
  const detail = policyTool(catalog, read("read"), {
    name: "read_plugin",
    callers: MODEL_AND_SCRIPTS,
    description:
      "Read a plugin's instructions, component inventory, current revision and connection setup status. Load linked instructions with use_skill before calling MCP tools.",
    parameters: obj({ plugin: str({ description: "Plugin ID or name." }) }),
    replay: "safe",
    execute: async (args, api) => {
      const found = await plugins.get(args.plugin, caller(api.conversationId).agent_id);
      return ok({
        ...found,
        instruction:
          "Call use_skill with each relevant skill reference before using its MCP tools. Authentication is completed by the user in Settings → Capabilities → Plugins.",
      });
    },
  });
  const writes = (["create", "update"] as const).map((op) =>
    policyTool(
      catalog,
      {
        actionClass: "configure",
        pluginConfiguration: true,
        connector: "plugins",
        operation: op,
        summary: (args: { package?: { name?: unknown } }) =>
          `${op === "create" ? "Create" : "Update"} plugin ${String(args.package?.name ?? "")}`,
        preview: (args, _facts, session): PluginPreview => {
          if (op === "update" && !plugins.visible(String(args.plugin), session.agent_id))
            throw new Invalid("That plugin is unavailable.");
          const pkg = plugins.validate(
            args.package,
            op === "update" ? String(args.plugin) : undefined,
            args.expectedRevision,
          );
          const before =
            op === "update"
              ? plugins.db.get<{ package_json: string }>(
                  "SELECT package_json FROM plugin_revisions WHERE plugin_id = (SELECT id FROM plugins WHERE id = ? OR name = ?) AND revision = ?",
                  String(args.plugin),
                  String(args.plugin),
                  Number(args.expectedRevision),
                )
              : undefined;
          return {
            kind: "plugin",
            op,
            name: pkg.name,
            package: pkg,
            ...(before
              ? {
                  fromRevision: args.expectedRevision,
                  diff: unifiedDiff(
                    JSON.stringify(JSON.parse(before.package_json), null, 2),
                    JSON.stringify(pkg, null, 2),
                    `r${args.expectedRevision}`,
                    "new",
                  ),
                }
              : {}),
          };
        },
      },
      {
        name: `${op}_plugin`,
        callers: MODEL_ONLY,
        description: `${op === "create" ? "Create a plugin" : "Update an existing plugin using its expectedRevision"} with complete skill files and MCP connection definitions. No credentials or permission grants. Strict and Standard show a preview for approval; YOLO applies automatically. Connections needing authentication are completed by the user in Settings → Capabilities → Plugins. Never put credentials in a plugin's content.`,
        parameters:
          op === "create"
            ? obj({ package: pkgSchema })
            : obj({
                plugin: str(),
                expectedRevision: int({ minimum: 1 }),
                package: pkgSchema,
              }),
        execute: async (args, api) => {
          const session = caller(api.conversationId);
          const input = args as { package: unknown; plugin?: string; expectedRevision?: number };
          if (op === "update" && !plugins.visible(input.plugin!, session.agent_id))
            throw new Invalid("That plugin is unavailable.");
          return ok(
            await plugins.save(input.package, {
              ...(op === "update" ? { id: input.plugin, expectedRevision: input.expectedRevision } : {}),
              author: "agent",
              sessionId: session.id,
            }),
          );
        },
      },
    ),
  );
  return defineExtension({
    name: "plugins",
    namespace: { name: "plugins", description: "Installed plugins: reusable skills and connectors." },
    tools: [list, detail, ...writes],
  });
}
