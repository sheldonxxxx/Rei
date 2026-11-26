import { arr, compile, int, obj, opt, type Schema, str } from "@earendil-works/pi-schema";
import { Server, type Tool, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { KnowledgeMetadataError, parseKnowledgeSource } from "@rei/protocol/knowledge-source";
import type { Context, Hono } from "hono";
import { bearerToken } from "../auth/service.ts";
import { readLimited } from "../events/receive.ts";
import type { AppDeps } from "../http/app.ts";
import type { Clock } from "../util/clock.ts";
import { HttpError, Invalid } from "../util/errors.ts";
import {
  checkKnowledgePageLinks,
  formatKnowledgePageLine,
  formatKnowledgeRead,
  formatLinkReport,
  inaccessibleKnowledgePage,
  KNOWLEDGE_CLIP,
  KnowledgeEditOpSchema,
} from "./format.ts";
import { refs } from "./markdown.ts";
import {
  type AuthenticatedMcpToken,
  KNOWLEDGE_MCP_ENDPOINT_PATH,
  type KnowledgeMcpScope,
  type KnowledgeMcpTokenStore,
} from "./mcp-tokens.ts";
import { age, type EditOp, KnowledgeConflict, type KnowledgeService, type Writer } from "./service.ts";

const MCP_MAX_BODY_BYTES = 512 * 1024;
const MAX_BROWSE_LINES = 120;
const WWW_AUTHENTICATE = 'Bearer realm="rei-knowledge-mcp"';

type ToolFlag = "read" | "write" | "delete";

interface McpToolDef {
  name: string;
  flag: ToolFlag;
  description: string;
  schema: Schema;
  annotations: NonNullable<Tool["annotations"]>;
  execute: (
    args: Record<string, unknown>,
    ctx: { token: AuthenticatedMcpToken; scope: KnowledgeMcpScope; writer: Writer },
  ) => Promise<ToolAnswer> | ToolAnswer;
}

type ToolAnswer = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

const okText = (text: string): ToolAnswer => ({ content: [{ type: "text", text }] });
const errText = (text: string): ToolAnswer => ({ isError: true, content: [{ type: "text", text }] });
const inaccessible = inaccessibleKnowledgePage;
const checkPageLinks = checkKnowledgePageLinks;

function isAllowedOrigin(origin: string, reqUrl: string, publicUrl?: string): boolean {
  return origin === new URL(reqUrl).origin || (publicUrl !== undefined && origin === new URL(publicUrl).origin);
}

function hasFlag(token: AuthenticatedMcpToken, flag: ToolFlag): boolean {
  switch (flag) {
    case "read":
      return token.canRead;
    case "write":
      return token.canWrite;
    case "delete":
      return token.canDelete;
  }
}

function formatError(error: unknown): ToolAnswer {
  if (error instanceof KnowledgeConflict) {
    return errText(
      `${error.message}\n---\n${KNOWLEDGE_CLIP(error.current, 3_000)}\n---\nRetry with baseRevision: ${error.revision}.`,
    );
  }
  if (error instanceof KnowledgeMetadataError || error instanceof HttpError) return errText(error.message);
  throw error;
}

function createKnowledgeTools(deps: { knowledge: KnowledgeService; clock: Clock }): {
  defs: readonly McpToolDef[];
  byName: ReadonlyMap<string, McpToolDef>;
} {
  const { knowledge, clock } = deps;
  const now = () => clock.now();

  const BrowseSchema = obj({
    pageId: opt(str({ description: "Allowed page whose children to list. Omit to list allowed root folders." })),
    depth: opt(int({ minimum: 1, maximum: 3, description: "Levels to show (default 1)." })),
    limit: opt(int({ minimum: 1, maximum: 100, description: "Entries per level (default 30)." })),
    offset: opt(int({ minimum: 0, description: "Skip this many entries at the first level (default 0)." })),
  });

  const ReadSchema = obj({
    pageId: str({ description: "ID of the allowed page to read." }),
    section: opt(str({ description: "Only this section: §n, #slug, heading text, or path." })),
    maxTokens: opt(int({ minimum: 200, maximum: 8_000, description: "Text budget (default 1500)." })),
  });

  const SearchSchema = obj({
    query: opt(str({ description: "Search query (omit to list recently updated allowed pages)." })),
    tags: opt(arr(str(), { maxItems: 20 })),
    under: opt(str({ description: "Limit search to this allowed page and its descendants." })),
    limit: opt(int({ minimum: 1, maximum: 20, description: "Max results (default 8)." })),
  });

  const CreateSchema = obj({
    parentId: str({ description: "Required ID of an allowed parent page (top-level creation is not permitted)." }),
    title: opt(str()),
    description: opt(str()),
    body: opt(str()),
    metadata: opt(obj({ tags: opt(arr(str(), { maxItems: 20 })) })),
    sourceMarkdown: opt(
      str({ description: "Complete YAML frontmatter + Markdown body (exclusive with typed fields)." }),
    ),
  });

  const EditSchema = obj({
    pageId: str({ description: "ID of the allowed page to edit." }),
    baseRevision: opt(int({ description: "Revision read earlier (required except for append and set_task ops)." })),
    ops: opt(arr(KnowledgeEditOpSchema, { maxItems: 20 })),
    title: opt(str()),
    description: opt(str()),
    body: opt(str()),
    metadata: opt(obj({ tags: opt(arr(str(), { maxItems: 20 })) })),
    sourceMarkdown: opt(
      str({ description: "Complete YAML frontmatter + Markdown body (exclusive with ops/typed fields)." }),
    ),
  });

  const MoveSchema = obj({
    pageId: str({ description: "ID of a non-root page inside an allowed folder." }),
    parentId: str({ description: "ID of the allowed destination parent page." }),
  });

  const DeleteSchema = obj({
    pageId: str({ description: "ID of a non-root descendant page inside an allowed folder to move to Trash." }),
  });

  const defs: McpToolDef[] = [
    {
      name: "knowledge_browse",
      flag: "read",
      description:
        "List allowed Knowledge root folders or the child pages under an allowed page, with ids, descriptions, child counts, and timestamps.",
      schema: BrowseSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: (args, { scope }) => {
        const depth = typeof args.depth === "number" ? args.depth : 1;
        const limit = typeof args.limit === "number" ? args.limit : 30;
        const offset = typeof args.offset === "number" ? args.offset : 0;
        const pageId = typeof args.pageId === "string" ? args.pageId : undefined;

        const walk = (id: string, level: number, skip: number, out: string[]): void => {
          const rows = knowledge.children(id, limit + 1, skip).filter((r) => scope.allowedPageIds.has(r.id));
          for (const row of rows.slice(0, limit)) {
            if (out.length >= MAX_BROWSE_LINES) return;
            out.push(formatKnowledgePageLine(row, level, knowledge, now()));
            if (level + 1 < depth) walk(row.id, level + 1, 0, out);
          }
          if (rows.length > limit && out.length < MAX_BROWSE_LINES) {
            const total = knowledge.childCount(id);
            out.push(
              `${"  ".repeat(level)}… ${total - skip - limit} more${level === 0 ? ` (offset: ${skip + limit})` : ""}`,
            );
          }
        };

        if (!pageId) {
          if (scope.effectiveRootIds.length === 0) {
            return okText("Allowed Knowledge folders:\n(No allowed pages configured for this token.)");
          }
          const out: string[] = ["Allowed Knowledge folders:"];
          const slice = scope.effectiveRootIds.slice(offset, offset + limit);
          for (const rootId of slice) {
            if (out.length >= MAX_BROWSE_LINES) break;
            const row = knowledge.page(rootId);
            if (!row || row.trashed_at !== null) continue;
            out.push(formatKnowledgePageLine(row, 0, knowledge, now()));
            if (depth > 1) walk(row.id, 1, 0, out);
          }
          if (scope.effectiveRootIds.length > offset + limit && out.length < MAX_BROWSE_LINES) {
            out.push(`… ${scope.effectiveRootIds.length - offset - limit} more (offset: ${offset + limit})`);
          }
          return okText(out.join("\n"));
        }

        if (!scope.allowedPageIds.has(pageId)) return errText(inaccessible(pageId));
        const parent = knowledge.page(pageId);
        if (!parent || parent.trashed_at !== null) return errText(inaccessible(pageId));
        const out: string[] = [`${knowledge.scopedPath(parent.id, scope.allowedPageIds)} (${parent.id}):`];
        walk(parent.id, 0, offset, out);
        if (out.length === 1) out.push("(no child pages)");
        return okText(out.join("\n"));
      },
    },
    {
      name: "knowledge_read",
      flag: "read",
      description:
        "Read an allowed Knowledge page (or one section) within maxTokens, returning its scoped path, revision, tags, outline, text, and child pages.",
      schema: ReadSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: (args, { scope }) => {
        const pageId = String(args.pageId);
        if (!scope.allowedPageIds.has(pageId)) return errText(inaccessible(pageId));
        const page = knowledge.page(pageId);
        if (!page || page.trashed_at !== null) return errText(inaccessible(pageId));
        try {
          const formatted = formatKnowledgeRead({
            page,
            path: knowledge.scopedPath(page.id, scope.allowedPageIds),
            ...(typeof args.section === "string" ? { section: args.section } : {}),
            ...(typeof args.maxTokens === "number" ? { maxTokens: args.maxTokens } : {}),
            knowledge,
            now: now(),
            allowedPageIds: scope.allowedPageIds,
          });
          return okText(formatted.textOutput);
        } catch (error) {
          return formatError(error);
        }
      },
    },
    {
      name: "knowledge_search",
      flag: "read",
      description:
        "Search allowed Knowledge pages by keyword and meaning. Returns scoped paths, sections, snippets, and page IDs.",
      schema: SearchSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: async (args, { scope }) => {
        const under = typeof args.under === "string" ? args.under : undefined;
        if (under !== undefined && !scope.allowedPageIds.has(under)) return errText(inaccessible(under));
        try {
          const hits = await knowledge.find(typeof args.query === "string" ? args.query : "", {
            ...(under !== undefined ? { under } : {}),
            ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
            limit: typeof args.limit === "number" ? args.limit : 8,
            allowedPageIds: scope.allowedPageIds,
          });
          if (hits.length === 0) return okText("No matching pages.");
          const byMeaning = (h: (typeof hits)[number]): boolean =>
            h.matched.includes("meaning") && !h.matched.includes("keyword");
          return okText(
            hits
              .map((h, i) => {
                const path = knowledge.scopedPath(h.pageId, scope.allowedPageIds);
                return `${i + 1}. ${path} (${h.pageId})${h.section ? ` › ${h.section}` : ""} · ${age(now() - h.updatedAt)}${byMeaning(h) ? " (by meaning)" : ""}: ${h.snippet}`;
              })
              .join("\n"),
          );
        } catch (error) {
          return formatError(error);
        }
      },
    },
    {
      name: "knowledge_create",
      flag: "write",
      description: "Create a new Knowledge page under an allowed parent page. Top-level creation is not permitted.",
      schema: CreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      execute: (args, { scope, writer }) => {
        const parentId = typeof args.parentId === "string" ? args.parentId.trim() : "";
        if (!parentId || parentId === "top") {
          return errText("Creating top-level pages is not permitted; pass an allowed parentId.");
        }
        if (!scope.allowedPageIds.has(parentId)) return errText(inaccessible(parentId));
        const parent = knowledge.page(parentId);
        if (!parent || parent.trashed_at !== null) return errText(inaccessible(parentId));

        if (typeof args.title !== "string" && typeof args.sourceMarkdown !== "string") {
          return errText("knowledge_create needs a title or sourceMarkdown.");
        }

        try {
          let titleForSimilar = typeof args.title === "string" ? args.title : "";
          let bodyForLinks = typeof args.body === "string" ? args.body : "";
          if (typeof args.sourceMarkdown === "string") {
            if ([args.title, args.description, args.body, args.metadata].some((v) => v !== undefined)) {
              return errText("Use sourceMarkdown alone, without title, description, body or metadata.");
            }
            const parsed = parseKnowledgeSource(args.sourceMarkdown);
            titleForSimilar = parsed.title;
            bodyForLinks = parsed.body;
          }

          const badLink = checkPageLinks(bodyForLinks, null, null, scope.allowedPageIds);
          if (badLink) return errText(badLink);

          const similar = knowledge.similar(titleForSimilar).filter((p) => scope.allowedPageIds.has(p.id));

          const page = knowledge.create(
            {
              parentId,
              ...(typeof args.title === "string" ? { title: args.title } : {}),
              ...(typeof args.description === "string" ? { description: args.description } : {}),
              ...(typeof args.body === "string" ? { body: args.body } : {}),
              ...(args.metadata !== undefined ? { metadata: args.metadata as { tags?: string[] } } : {}),
              ...(typeof args.sourceMarkdown === "string" ? { sourceMarkdown: args.sourceMarkdown } : {}),
            },
            writer,
          );
          const nextScope = new Set([...scope.allowedPageIds, page.id]);
          let answer = `Created ${knowledge.scopedPath(page.id, nextScope)} (${page.id}) · revision ${page.revision}.`;
          answer += formatLinkReport(page.id, null, knowledge, nextScope);
          if (similar.length > 0) {
            answer += `\nSimilar pages already exist — consider editing one instead next time: ${similar
              .map((p) => `${knowledge.scopedPath(p.id, nextScope)} (${p.id})`)
              .join("; ")}.`;
          }
          return okText(answer);
        } catch (error) {
          return formatError(error);
        }
      },
    },
    {
      name: "knowledge_edit",
      flag: "write",
      description:
        "Edit an allowed Knowledge page using structured ops or full-source replacement. Respects baseRevision conflicts and locked pages (append-only).",
      schema: EditSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      execute: (args, { scope, writer }) => {
        const pageId = String(args.pageId);
        if (!scope.allowedPageIds.has(pageId)) return errText(inaccessible(pageId));
        const beforePage = knowledge.page(pageId);
        if (!beforePage || beforePage.trashed_at !== null) return errText(inaccessible(pageId));

        const editWriter: Writer = {
          ...writer,
          validateBody: (body, previousBody) => {
            const badLink = checkPageLinks(body, pageId, new Set(refs(previousBody).pages), scope.allowedPageIds);
            if (badLink) throw new Invalid(badLink);
          },
        };
        const hasReplaceFields =
          args.sourceMarkdown !== undefined ||
          args.metadata !== undefined ||
          args.title !== undefined ||
          args.description !== undefined ||
          args.body !== undefined;

        try {
          if (hasReplaceFields) {
            if (args.ops !== undefined) return errText("Use sourceMarkdown or typed fields without ops.");
            if (typeof args.baseRevision !== "number") return errText("This edit needs baseRevision.");
            if (
              typeof args.sourceMarkdown === "string" &&
              [args.title, args.description, args.body, args.metadata].some((v) => v !== undefined)
            ) {
              return errText("Use sourceMarkdown alone, without title, description, body or metadata.");
            }
            const page = knowledge.replace(
              pageId,
              {
                ...(typeof args.sourceMarkdown === "string" ? { sourceMarkdown: args.sourceMarkdown } : {}),
                ...(args.metadata !== undefined ? { metadata: args.metadata as { tags?: string[] } } : {}),
                ...(typeof args.title === "string" ? { title: args.title } : {}),
                ...(typeof args.description === "string" ? { description: args.description } : {}),
                ...(typeof args.body === "string" ? { body: args.body } : {}),
              },
              args.baseRevision,
              editWriter,
            );
            let answer = `Saved ${knowledge.scopedPath(page.id, scope.allowedPageIds)} (${page.id}) · revision ${page.revision}.`;
            answer += formatLinkReport(page.id, beforePage.body, knowledge, scope.allowedPageIds);
            return okText(answer);
          }

          if (!Array.isArray(args.ops) || args.ops.length === 0) {
            return errText("knowledge_edit needs ops, metadata, or sourceMarkdown.");
          }
          const result = knowledge.edit(
            pageId,
            args.ops as EditOp[],
            editWriter,
            typeof args.baseRevision === "number" ? args.baseRevision : undefined,
          );
          let answer = `Saved ${knowledge.scopedPath(result.page.id, scope.allowedPageIds)} (${result.page.id}) · revision ${result.page.revision}.`;
          answer += formatLinkReport(result.page.id, beforePage.body, knowledge, scope.allowedPageIds);
          if (result.changed) answer += `\n---\n${KNOWLEDGE_CLIP(result.changed, 800)}`;
          return okText(answer);
        } catch (error) {
          return formatError(error);
        }
      },
    },
    {
      name: "knowledge_move",
      flag: "write",
      description: "Move a non-root page inside an allowed folder to another allowed parent page.",
      schema: MoveSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      execute: (args, { scope, writer }) => {
        const pageId = String(args.pageId);
        const parentId = typeof args.parentId === "string" ? args.parentId.trim() : "";
        if (!scope.allowedPageIds.has(pageId)) return errText(inaccessible(pageId));
        if (scope.grantedRootIds.has(pageId)) {
          return errText(`Cannot move granted root folder ${pageId}.`);
        }
        if (!parentId || parentId === "top") {
          return errText("Moving pages to the top level is not permitted; specify an allowed parentId.");
        }
        if (!scope.allowedPageIds.has(parentId)) return errText(inaccessible(parentId));
        try {
          const page = knowledge.move(pageId, parentId, writer);
          return okText(`Moved to ${knowledge.scopedPath(page.id, scope.allowedPageIds)} (${page.id}).`);
        } catch (error) {
          return formatError(error);
        }
      },
    },
    {
      name: "knowledge_delete",
      flag: "delete",
      description:
        "Move a descendant page inside an allowed folder (and its subtree) to Trash. Granted root folders, Inbox, and locked pages cannot be deleted.",
      schema: DeleteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      execute: (args, { scope, writer }) => {
        const pageId = String(args.pageId);
        if (!scope.allowedPageIds.has(pageId)) return errText(inaccessible(pageId));
        if (scope.grantedRootIds.has(pageId)) {
          return errText(
            `Cannot delete granted root folder ${pageId}; only descendant pages inside allowed folders can be moved to Trash.`,
          );
        }
        const page = knowledge.page(pageId);
        if (!page || page.trashed_at !== null) return errText(inaccessible(pageId));
        try {
          const n = knowledge.trashPage(pageId, writer, (pages) => {
            if (
              pages.some((p) => !scope.allowedPageIds.has(p.id) || scope.grantedRootIds.has(p.id) || p.locked === 1)
            ) {
              throw new Invalid("This subtree contains a page that this token cannot move to Trash.");
            }
          });
          return okText(
            `Moved "${page.title}"${n > 1 ? ` and ${n - 1} page${n === 2 ? "" : "s"} under it` : ""} to Trash. It can be restored for 30 days.`,
          );
        } catch (error) {
          return formatError(error);
        }
      },
    },
  ];

  return {
    defs,
    byName: new Map(defs.map((d) => [d.name, d])),
  };
}

/** Mounts the stateless Streamable HTTP Knowledge MCP server at `/api/mcp/knowledge`. */
export function mountKnowledgeMcpServer(app: Hono, deps: AppDeps): void {
  if (!deps.knowledge || !deps.knowledgeMcpTokens) return;
  const knowledge = deps.knowledge;
  const tokenStore: KnowledgeMcpTokenStore = deps.knowledgeMcpTokens;
  const { defs, byName } = createKnowledgeTools({ knowledge, clock: deps.clock });
  const validators = new Map(defs.map((d) => [d.name, compile(d.schema)]));

  const handler = async (c: Context): Promise<Response> => {
    const originHeader = c.req.header("origin");
    if (originHeader !== undefined && !isAllowedOrigin(originHeader, c.req.url, deps.publicUrl)) {
      deps.log.info("knowledge_mcp.auth_failed", { code: "forbidden_origin" });
      return c.json({ error: { code: "forbidden", message: "Cross-origin requests are not allowed." } }, 403);
    }

    if (c.req.method !== "POST") {
      c.header("allow", "POST");
      return c.json({ error: { code: "method_not_allowed", message: "Method not allowed. Use POST." } }, 405);
    }

    const rawBearer = bearerToken(c.req.header("authorization"));
    if (!rawBearer) {
      deps.log.info("knowledge_mcp.auth_failed", { code: "missing_bearer" });
      c.header("www-authenticate", WWW_AUTHENTICATE);
      return c.json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
    }

    const token = await tokenStore.authenticate(rawBearer);
    if (!token) {
      deps.log.info("knowledge_mcp.auth_failed", { code: "invalid_token" });
      c.header("www-authenticate", WWW_AUTHENTICATE);
      return c.json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
    }

    const rawBody = await readLimited(c.req.raw, MCP_MAX_BODY_BYTES);
    if (rawBody === null) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: `Request body exceeds ${MCP_MAX_BODY_BYTES} bytes.` },
          id: null,
        },
        413,
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: invalid JSON body." },
          id: null,
        },
        400,
      );
    }

    const mcpServer = new Server({ name: "rei-knowledge", version: "0.1.0" }, { capabilities: { tools: {} } });

    mcpServer.setRequestHandler("tools/list", async () => ({
      tools: defs
        .filter((d) => hasFlag(token, d.flag))
        .map(
          (d): Tool => ({
            name: d.name,
            description: d.description,
            inputSchema: d.schema as unknown as Tool["inputSchema"],
            annotations: d.annotations,
          }),
        ),
    }));

    mcpServer.setRequestHandler("tools/call", async (request) => {
      const toolName = request.params.name;
      const def = byName.get(toolName);
      if (!def) {
        deps.log.info("knowledge_mcp.denied", { tokenId: token.id, code: "unknown_tool" });
        return errText(`Unknown tool "${toolName}".`);
      }
      if (!hasFlag(token, def.flag)) {
        deps.log.info("knowledge_mcp.denied", { tokenId: token.id, tool: toolName, code: "permission_denied" });
        return errText(`Permission denied: token does not have ${def.flag} access.`);
      }

      const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
      const validate = validators.get(toolName)!;
      if (!validate.check(rawArgs)) {
        const issues = [...validate.errors(rawArgs)]
          .slice(0, 3)
          .map((e) => `${e.path || "(root)"} ${e.message}`)
          .join("; ");
        deps.log.info("knowledge_mcp.denied", { tokenId: token.id, tool: toolName, code: "invalid_params" });
        return errText(`Invalid arguments: ${issues}.`);
      }

      const scope = tokenStore.resolveScope(token.id);
      const writer: Writer = { actor: `mcp:${token.id}`, taint: ["external"] };
      const result = await def.execute(rawArgs, { token, scope, writer });
      deps.log.info("knowledge_mcp.tool_called", {
        tokenId: token.id,
        tool: toolName,
        outcome: result.isError ? "error" : "ok",
      });
      return result;
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MCP_MAX_BODY_BYTES,
    });

    try {
      await mcpServer.connect(transport);
      // WebStandardStreamableHTTPServerTransport requires Accept to include both application/json and text/event-stream;
      // normalize simple JSON-RPC clients (such as curl) that omit Accept or only send application/json or */*.
      const accept = c.req.header("accept") ?? "";
      let req = c.req.raw;
      if (
        (accept === "" || accept.includes("*/*") || accept.includes("application/json")) &&
        !accept.includes("text/event-stream")
      ) {
        const headers = new Headers(req.headers);
        headers.set("accept", "application/json, text/event-stream");
        req = new Request(req.url, { method: "POST", headers });
      }
      return await transport.handleRequest(req, { parsedBody });
    } finally {
      await mcpServer.close().catch(() => {});
    }
  };

  app.all(KNOWLEDGE_MCP_ENDPOINT_PATH, handler);
  app.all(`${KNOWLEDGE_MCP_ENDPOINT_PATH}/`, handler);
}
