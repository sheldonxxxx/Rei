// The "knowledge" extension: five tools over shared long-term pages, and the prompt section that points at them.
// Reads are read_internal and bring the page's labels into the reading session (a page written after reading outside
// content carries "external"). Writes are write_internal: always allowed, recorded with who, where and whether the
// writing session had read outside content. Output is compact text, because every token here is paid on every call.

import type { JsonValue } from "@earendil-works/chord/json";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { arr, bool, int, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { TaintLabel } from "@rei/protocol";
import { KnowledgeMetadataError, parseKnowledgeSource } from "@rei/protocol/knowledge-source";
import { MODEL_AND_SCRIPTS } from "../pi/callers.ts";
import { policyTool, type ToolCatalog } from "../pi/policy-ext.ts";
import { toJson } from "../pi/structured.ts";
import type { AppStore, SessionRow } from "../store/store.ts";
import { HttpError, Invalid } from "../util/errors.ts";
import {
  checkKnowledgePageLinks,
  formatKnowledgePageLine,
  formatKnowledgeRead,
  formatLinkReport,
  inaccessibleKnowledgePage,
  KNOWLEDGE_CLIP,
  KNOWLEDGE_FLAT,
  KnowledgeEditOpSchema,
} from "./format.ts";
import { refs } from "./markdown.ts";
import {
  age,
  type EditOp,
  KnowledgeConflict,
  type KnowledgeScope,
  type KnowledgeService,
  type PageRow,
  type Writer,
} from "./service.ts";

export const KNOWLEDGE_CONNECTOR = "knowledge";

export const KNOWLEDGE_NOTE = [
  "Knowledge is the shared long-term layer above chat history: nested pages that you, the other agents and the user keep. Chat history is day-to-day; Knowledge is where lasting learning goes.",
  "Read before you start. Before research, planning or project work that may have come up before, run knowledge_search and build on what is there; skip it for self-contained questions.",
  "Write on your own initiative when something is worth keeping beyond this chat: research results, plans, decisions and their reasons, how-tos learned the hard way, project state to resume later. Facts and preferences about the user go to memory instead; passing details of one task go nowhere.",
  "Before creating a page, browse or search and prefer editing an existing page. You choose where a page goes (an existing page, a new parent you create, or Inbox when nothing fits); nothing is filed for you. Give pages a clear title and a one-line description so others can find them by browsing. Load the rei-knowledge skill before creating a page or restructuring one.",
  "Find things by browsing from the list below first (knowledge_browse, then knowledge_read with a section), and use knowledge_search when the place is unclear.",
].join(" ");

export const KNOWLEDGE_READ_ONLY_NOTE = [
  "Knowledge is the shared long-term layer above chat history: nested pages kept by the user and other agents. You have read-only access to Knowledge.",
  "Read before you start. Before research, planning or project work that may have come up before, run knowledge_search and build on what is there; skip it for self-contained questions.",
  "Find things by browsing from the list below first (knowledge_browse, then knowledge_read with a section), and use knowledge_search when the place is unclear.",
].join(" ");

type ToolText = { output: { type: "text"; text: string }[]; isError?: true; structuredOutput?: JsonValue };
const ok = (text: string, structuredOutput?: unknown): ToolText => ({
  output: [{ type: "text", text }],
  ...(structuredOutput !== undefined ? { structuredOutput: toJson(structuredOutput) } : {}),
});
const fail = (text: string): ToolText => ({ isError: true, output: [{ type: "text", text }] });
const clip = KNOWLEDGE_CLIP;
const flat = KNOWLEDGE_FLAT;
/** A link the model can paste into its reply: chat renders `page:` links as page chips. */
const pageLink = (page: { id: string; title: string }): string =>
  `Link: [${flat(page.title).replace(/[[\]]/g, "")}](page:${page.id})`;

export interface KnowledgeToolsDeps {
  treeId: string;
  store: AppStore;
  knowledge: KnowledgeService;
  catalog: ToolCatalog;
}

const MAX_LINES = 120;

/** What a script gets from knowledge_search: the hits the text lists, in the same order. */
const KnowledgeSearchOutput = obj({
  hits: arr(
    obj({
      rank: int({ description: "1-based position in the list." }),
      pageId: str({ description: "Pass to knowledge_read." }),
      title: str(),
      path: str({ description: "The page's path in the tree." }),
      section: str({ description: 'Heading path of the best-matching section; "" for the title or description.' }),
      snippet: str(),
      updatedAt: num({ description: "Epoch milliseconds." }),
      byMeaning: bool({ description: "Found by similar meaning only: it shares no words with the query." }),
      matched: arr(StringEnum(["keyword", "meaning"])),
    }),
  ),
  note: opt(str({ description: "Set when there are no hits: what to try next." })),
});

/** What a script gets from knowledge_read: the page's facts, and its text as the text output shows it. */
const KnowledgeReadOutput = obj({
  pageId: str(),
  path: str(),
  title: str(),
  revision: int({ description: "Pass back as baseRevision to knowledge_write." }),
  updatedAt: num({ description: "Epoch milliseconds." }),
  updatedBy: str(),
  locked: bool({ description: "Locked for agents: append only." }),
  tags: arr(str()),
  description: str(),
  outline: arr(str({ description: "§n heading #slug ≈tokens." })),
  text: str({ description: "The page or section text, up to maxTokens; empty for an empty page." }),
  truncated: bool({ description: "The text was cut at maxTokens; note says how to read on." }),
  note: opt(str({ description: "Set when truncated: where the cut is and what to pass to read on." })),
  children: arr(obj({ id: str(), title: str() })),
  moreChildren: bool({ description: "The page has more child pages than the 15 listed." }),
});

export function createKnowledgeExtension(deps: KnowledgeToolsDeps): Extension {
  const { treeId, store, knowledge, catalog } = deps;
  const callerOf = (conversationId: unknown): SessionRow | undefined =>
    store.sessionByConversation(treeId, String(conversationId));
  const scopeOf = (session: SessionRow): KnowledgeScope | null => {
    const roots = store.agentAllowedKnowledgePageIds(session.agent_id);
    return roots === null ? null : knowledge.resolveScope(roots);
  };
  const readInto = (session: SessionRow, page: PageRow): void => {
    const labels = knowledge.taintOf(page);
    if (labels.length > 0) store.addTaint(session.id, labels);
  };
  const now = () => store.clock.now();
  const line = (p: PageRow, indent: number): string => formatKnowledgePageLine(p, indent, knowledge, now());
  const explain = (error: unknown): ToolText => {
    if (error instanceof KnowledgeConflict)
      return fail(
        `${error.message}\n---\n${clip(error.current, 3_000)}\n---\nRetry with baseRevision: ${error.revision}.`,
      );
    if (error instanceof KnowledgeMetadataError || error instanceof HttpError) return fail(error.message);
    throw error;
  };
  const guardAsync = async (run: () => Promise<ToolText>): Promise<ToolText> => {
    try {
      return await run();
    } catch (error) {
      return explain(error);
    }
  };
  const guard = (run: () => ToolText): ToolText => {
    try {
      return run();
    } catch (error) {
      return explain(error);
    }
  };

  const browse = policyTool(
    catalog,
    {
      actionClass: "read_internal",
      connector: KNOWLEDGE_CONNECTOR,
      operation: "browse",
      summary: (a: { pageId?: string }) => (a.pageId ? `Browse Knowledge under ${a.pageId}` : "Browse Knowledge"),
    },
    {
      name: "knowledge_browse",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Use to see what Knowledge holds before creating a page or starting work on a topic. Lists child pages (titles, ids, descriptions, child counts, who changed them last), newest activity first. No page text. Omit pageId for the top level. depth 1–3 nests grandchildren.",
      parameters: obj({
        pageId: opt(str({ description: "The page whose children to list. Omit for the top level." })),
        depth: opt(int({ minimum: 1, maximum: 3, description: "Levels to show (default 1)." })),
        limit: opt(int({ minimum: 1, maximum: 100, description: "Children per level (default 30)." })),
        offset: opt(int({ minimum: 0, description: "Skip this many children (paging)." })),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const session = callerOf(api.conversationId);
        if (!session) return fail("This session is no longer available.");
        const scope = scopeOf(session);
        return guard(() => {
          const depth = args.depth ?? 1;
          const limit = args.limit ?? 30;
          const offset = args.offset ?? 0;
          const walk = (id: string | null, level: number, skip: number, out: string[]): void => {
            const rows = knowledge
              .children(id, limit + 1, skip)
              .filter((r) => !scope || scope.allowedPageIds.has(r.id));
            for (const row of rows.slice(0, limit)) {
              if (out.length >= MAX_LINES) return;
              out.push(line(row, level));
              if (level + 1 < depth) walk(row.id, level + 1, 0, out);
            }
            if (rows.length > limit && out.length < MAX_LINES) {
              const total = id === null ? knowledge.children(null).length : knowledge.childCount(id);
              out.push(
                `${"  ".repeat(level)}… ${total - skip - limit} more${level === 0 ? ` (offset: ${skip + limit})` : ""}`,
              );
            }
          };

          if (scope && !args.pageId) {
            if (scope.effectiveRootIds.length === 0) {
              return ok("Allowed Knowledge folders:\n(No allowed folders configured for this agent.)");
            }
            const out: string[] = ["Allowed Knowledge folders:"];
            const slice = scope.effectiveRootIds.slice(offset, offset + limit);
            for (const rootId of slice) {
              if (out.length >= MAX_LINES) break;
              const row = knowledge.page(rootId);
              if (!row || row.trashed_at !== null) continue;
              out.push(line(row, 0));
              if (depth > 1) walk(row.id, 1, 0, out);
            }
            if (scope.effectiveRootIds.length > offset + limit && out.length < MAX_LINES) {
              out.push(`… ${scope.effectiveRootIds.length - offset - limit} more (offset: ${offset + limit})`);
            }
            return ok(out.join("\n"));
          }

          if (scope && args.pageId) {
            if (!scope.allowedPageIds.has(args.pageId)) return fail(inaccessibleKnowledgePage(args.pageId));
            const parent = knowledge.page(args.pageId);
            if (!parent || parent.trashed_at !== null) return fail(inaccessibleKnowledgePage(args.pageId));
            const out: string[] = [`${knowledge.scopedPath(parent.id, scope.allowedPageIds)} (${parent.id}):`];
            walk(parent.id, 0, offset, out);
            if (out.length === 1) out.push("(no child pages)");
            return ok(out.join("\n"));
          }

          const parent = args.pageId ? knowledge.live(args.pageId) : null;
          const out: string[] = [parent ? `${knowledge.path(parent.id)} (${parent.id}):` : "Knowledge top level:"];
          walk(parent?.id ?? null, 0, offset, out);
          if (out.length === 1) out.push(parent ? "(no child pages)" : "(Knowledge is empty)");
          return ok(out.join("\n"));
        });
      },
    },
  );

  const read = policyTool(
    catalog,
    {
      actionClass: "read_internal",
      connector: KNOWLEDGE_CONNECTOR,
      operation: "read",
      summary: (a: { pageId: string }) => `Read Knowledge page ${a.pageId}`,
    },
    {
      name: "knowledge_read",
      callers: MODEL_AND_SCRIPTS,
      description:
        'Use after browse or search to read a page before building on it or editing it. Returns path, revision, outline (§n heading #slug ≈tokens) and text up to maxTokens. Pass section (§n, #slug, a heading, or a path like "Plan > Week 2") to read just that part. Link to a section with [text](page:<pageId>#<slug>). Long pages stop at a section boundary and say which section to read next. In a script it returns { pageId, path, revision, tags, outline, text, truncated, note?, children, ... }.',
      parameters: obj({
        pageId: str(),
        section: opt(str({ description: "Only this section: §n, #slug, heading text, or path." })),
        maxTokens: opt(int({ minimum: 200, maximum: 8_000, description: "Text budget (default 1500)." })),
      }),
      structuredOutputSchema: KnowledgeReadOutput,
      replay: "safe",
      execute: async (args, api) => {
        const session = callerOf(api.conversationId);
        if (!session) return fail("This session is no longer available.");
        const scope = scopeOf(session);
        return guard(() => {
          if (scope && !scope.allowedPageIds.has(args.pageId)) return fail(inaccessibleKnowledgePage(args.pageId));
          const page = scope ? knowledge.page(args.pageId) : knowledge.live(args.pageId);
          if (!page || page.trashed_at !== null) return fail(inaccessibleKnowledgePage(args.pageId));
          readInto(session, page);
          const formatted = formatKnowledgeRead({
            page,
            path: scope ? knowledge.scopedPath(page.id, scope.allowedPageIds) : knowledge.path(page.id),
            ...(args.section !== undefined ? { section: args.section } : {}),
            ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
            knowledge,
            now: now(),
            ...(scope ? { allowedPageIds: scope.allowedPageIds } : {}),
          });
          return ok(formatted.textOutput, formatted.structured);
        });
      },
    },
  );

  const search = policyTool(
    catalog,
    {
      actionClass: "read_internal",
      connector: KNOWLEDGE_CONNECTOR,
      operation: "search",
      summary: (a: { query: string }) => `Search Knowledge: ${clip(String(a.query ?? ""), 80)}`,
    },
    {
      name: "knowledge_search",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Use before starting research, planning or project work, and when the user mentions prior work, a project or a decision by name. Searches Knowledge page titles, descriptions and sections by shared words and, when meaning search is on, by similar meaning, in any language. under limits it to a page and its descendants; tags requires every supplied tag. Omit query to browse filtered pages by update time. Returns page path › section · snippet with page ids; hits marked (by meaning) share no words with the query. Read the page to verify. In a script it returns { hits: [{ pageId, title, path, section, snippet, ... }], note? }.",
      parameters: obj({
        query: opt(str()),
        tags: opt(arr(str(), { maxItems: 20 })),
        under: opt(str({ description: "Only this page and the pages under it." })),
        limit: opt(int({ minimum: 1, maximum: 20, description: "Default 8." })),
      }),
      structuredOutputSchema: KnowledgeSearchOutput,
      replay: "safe",
      execute: async (args, api) => {
        const session = callerOf(api.conversationId);
        if (!session) return fail("This session is no longer available.");
        const scope = scopeOf(session);
        if (scope && args.under !== undefined && !scope.allowedPageIds.has(args.under)) {
          return fail(inaccessibleKnowledgePage(args.under));
        }
        return guardAsync(async () => {
          const hits = await knowledge.find(args.query ?? "", {
            ...(args.tags ? { tags: args.tags } : {}),
            ...(args.under ? { under: args.under } : {}),
            limit: args.limit ?? 8,
            ...(scope ? { allowedPageIds: scope.allowedPageIds } : {}),
          });
          if (hits.length === 0) {
            const none =
              "No matching pages. Try other words, browse the tree, or check chat history with search_history.";
            return ok(none, { hits: [], note: none });
          }
          for (const h of hits) {
            const p = knowledge.page(h.pageId);
            if (p) readInto(session, p);
          }
          const byMeaning = (h: (typeof hits)[number]): boolean =>
            h.matched.includes("meaning") && !h.matched.includes("keyword");
          const pathOf = (h: (typeof hits)[number]): string =>
            scope ? knowledge.scopedPath(h.pageId, scope.allowedPageIds) : h.path;
          return ok(
            hits
              .map(
                (h, i) =>
                  `${i + 1}. ${pathOf(h)} (${h.pageId})${h.section ? ` › ${h.section}` : ""} · ${age(now() - h.updatedAt)}${byMeaning(h) ? " (by meaning)" : ""}: ${h.snippet}`,
              )
              .join("\n"),
            {
              hits: hits.map((h, i) => ({
                rank: i + 1,
                pageId: h.pageId,
                title: h.title,
                path: pathOf(h),
                section: h.section,
                snippet: h.snippet,
                updatedAt: h.updatedAt,
                byMeaning: byMeaning(h),
                matched: h.matched,
              })),
            },
          );
        });
      },
    },
  );

  return defineExtension({
    name: "knowledge",
    namespace: { name: "knowledge", description: "The user's Knowledge pages: browse, read, search and write." },
    tools: [browse, read, search],
    sections: [
      section("knowledge", (input) => {
        const session = callerOf(input.conversationId);
        const mode = session ? store.agentCapabilities(session.agent_id).knowledge : "read_write";
        const scope = session ? scopeOf(session) : null;
        const baseNote = mode === "read" ? KNOWLEDGE_READ_ONLY_NOTE : KNOWLEDGE_NOTE;
        const note = scope
          ? `${baseNote} Your Knowledge access is scoped to the allowed folders below${mode === "read_write" ? " (creating top-level pages and moving or archiving granted root folders are not permitted)" : ""}.`
          : baseNote;
        try {
          const pointer = knowledge.pointer(now(), scope);
          return pointer ? `${note}\n${pointer}` : note;
        } catch {
          return note;
        }
      }),
    ],
  });
}

export function createKnowledgeWriteExtension(deps: KnowledgeToolsDeps): Extension {
  const { treeId, store, knowledge, catalog } = deps;
  const callerOf = (conversationId: unknown): SessionRow | undefined =>
    store.sessionByConversation(treeId, String(conversationId));
  const writerOf = (session: SessionRow, callId: string | undefined): Writer => {
    const run = store.runningRun(session.id);
    let taint: TaintLabel[] = [];
    try {
      taint = JSON.parse(session.taint) as TaintLabel[];
    } catch {
      taint = [];
    }
    return {
      actor: session.agent_id,
      sessionId: session.id,
      runId: run?.id ?? null,
      taint,
      ...(callId ? { callKey: `${session.id}:${callId}` } : {}),
    };
  };
  const scopeOf = (session: SessionRow): KnowledgeScope | null => {
    const roots = store.agentAllowedKnowledgePageIds(session.agent_id);
    return roots === null ? null : knowledge.resolveScope(roots);
  };
  /** Section links this write left pointing nowhere: other pages' links to removed headings, and this page's own. */
  const linkReport = (pageId: string, before: string | null, allowedPageIds?: ReadonlySet<string>): string =>
    formatLinkReport(pageId, before, knowledge, allowedPageIds);
  const explain = (error: unknown): ToolText => {
    if (error instanceof KnowledgeConflict)
      return fail(
        `${error.message}\n---\n${clip(error.current, 3_000)}\n---\nRetry with baseRevision: ${error.revision}.`,
      );
    if (error instanceof KnowledgeMetadataError || error instanceof HttpError) return fail(error.message);
    throw error;
  };
  const guard = (run: () => ToolText): ToolText => {
    try {
      return run();
    } catch (error) {
      return explain(error);
    }
  };

  const OpSchema = KnowledgeEditOpSchema;

  const write = policyTool(
    catalog,
    {
      actionClass: "write_internal",
      connector: KNOWLEDGE_CONNECTOR,
      operation: "write",
      summary: (a: { action?: string; title?: string; pageId?: string }) =>
        a.action === "create"
          ? `Create Knowledge page "${clip(String(a.title ?? ""), 60)}"`
          : `${a.action === "move" ? "Move" : a.action === "archive" ? "Move to Trash" : "Edit"} Knowledge page ${a.pageId ?? ""}`.trim(),
    },
    {
      name: "knowledge_write",
      callers: MODEL_AND_SCRIPTS,
      description: [
        'Use to keep lasting results (research, plans, decisions, how-tos, project state) and to update pages that have gone stale; search first so you edit instead of duplicating. action create: parentId (a page id, or "top"), title, description (one line), body (Markdown). action edit: pageId, ops (applied in order), baseRevision from your last read — append and set_task work without it, everything else needs it and fails with the current text if the page moved on. Tags: set_metadata with metadata.tags replaces all tags; add_tags/remove_tags with tags edits individual tags. Optional metadata on create. Alternatively sourceMarkdown supplies the complete YAML header (title, description, tags) and Markdown body without typed fields or ops. Full-source omissions clear description/tags. action move: pageId, parentId (or "top"). action archive: pageId (moves it and its children to Trash; the user can restore).',
        "Markdown extras: tasks `- [ ] item` (optional @agent and 📅 2026-11-20), callouts `> [!NOTE]` (TIP, WARNING, IMPORTANT, CAUTION; `> [!NOTE]- Title` folds), page links `[text](page:<pageId>)` and section links `[text](page:<pageId>#<slug>)` (slugs are in knowledge_read's outline), Library files `[name](file:<fileId>)` (latest) or `file:<fileId>@<versionId>` (pinned) and images `![alt](file:<fileId>)`. To put a workspace file on a page, publish_files first and link the fileId it returns.",
      ].join(" "),
      parameters: obj({
        action: StringEnum(["create", "edit", "move", "archive"]),
        pageId: opt(str()),
        parentId: opt(str({ description: 'create/move: a page id, or "top" for the top level.' })),
        title: opt(str()),
        description: opt(str()),
        body: opt(str()),
        metadata: opt(obj({ tags: arr(str(), { maxItems: 20 }) })),
        sourceMarkdown: opt(
          str({
            description:
              "Complete YAML header (title, description, tags) plus body; mutually exclusive with typed fields and ops.",
          }),
        ),
        baseRevision: opt(int()),
        ops: opt(arr(OpSchema, { maxItems: 20 })),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const session = callerOf(api.conversationId);
        if (!session) return fail("This session is no longer available.");
        const scope = scopeOf(session);
        const w = writerOf(session, api.callId);
        const prior = knowledge.replayed(w.callKey);
        if (prior !== undefined) return ok(prior);
        return guard(() => {
          let answer: string;
          let touched: string | undefined = args.pageId;
          switch (args.action) {
            case "create": {
              if (args.parentId === undefined || args.parentId.trim() === "")
                return fail(
                  scope
                    ? "Creating top-level pages is not permitted; pass an allowed parentId."
                    : 'create needs parentId: the id of the page to put it under (browse first), or "top". Use Inbox\'s id when nothing fits.',
                );
              if (scope && args.parentId.trim() === "top") {
                return fail("Creating top-level pages is not permitted; pass an allowed parentId.");
              }
              if (!args.title && args.sourceMarkdown === undefined)
                return fail("create needs a title or sourceMarkdown.");
              const rawParentId = args.parentId.trim();
              const parentId = rawParentId === "top" ? null : rawParentId;
              if (scope) {
                if (!parentId || !scope.allowedPageIds.has(parentId))
                  return fail(inaccessibleKnowledgePage(rawParentId));
                const parent = knowledge.page(parentId);
                if (!parent || parent.trashed_at !== null) return fail(inaccessibleKnowledgePage(parentId));
              }
              let titleForSimilar = args.title ?? "";
              let bodyForLinks = args.body ?? "";
              if (args.sourceMarkdown !== undefined) {
                if ([args.title, args.description, args.body, args.metadata].some((v) => v !== undefined)) {
                  return fail("Use sourceMarkdown alone, without title, description, body or metadata.");
                }
                const parsed = parseKnowledgeSource(args.sourceMarkdown);
                titleForSimilar = parsed.title;
                bodyForLinks = parsed.body;
              }
              if (scope) {
                const badLink = checkKnowledgePageLinks(bodyForLinks, null, null, scope.allowedPageIds);
                if (badLink) return fail(badLink);
              }
              const similar = knowledge
                .similar(titleForSimilar)
                .filter((p) => !scope || scope.allowedPageIds.has(p.id));
              const page = knowledge.create(
                {
                  parentId,
                  ...(args.title !== undefined ? { title: args.title } : {}),
                  ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
                  ...(args.sourceMarkdown !== undefined ? { sourceMarkdown: args.sourceMarkdown } : {}),
                  ...(args.description !== undefined ? { description: args.description } : {}),
                  ...(args.body !== undefined ? { body: args.body } : {}),
                },
                w,
              );
              touched = page.id;
              const nextScope = scope ? new Set([...scope.allowedPageIds, page.id]) : undefined;
              const path = nextScope ? knowledge.scopedPath(page.id, nextScope) : knowledge.path(page.id);
              answer = `Created ${path} (${page.id}) · revision ${page.revision}.\n${pageLink(page)}`;
              answer += linkReport(page.id, null, nextScope);
              if (similar.length > 0)
                answer += `\nSimilar pages already exist — consider editing one instead next time: ${similar.map((p) => `${nextScope ? knowledge.scopedPath(p.id, nextScope) : knowledge.path(p.id)} (${p.id})`).join("; ")}.`;
              break;
            }
            case "edit": {
              if (!args.pageId) return fail("edit needs pageId.");
              const editId = args.pageId;
              if (scope) {
                if (!scope.allowedPageIds.has(editId)) return fail(inaccessibleKnowledgePage(editId));
                const existing = knowledge.page(editId);
                if (!existing || existing.trashed_at !== null) return fail(inaccessibleKnowledgePage(editId));
              }
              const editWriter: Writer = scope
                ? {
                    ...w,
                    validateBody: (body, previousBody) => {
                      const badLink = checkKnowledgePageLinks(
                        body,
                        editId,
                        new Set(refs(previousBody).pages),
                        scope.allowedPageIds,
                      );
                      if (badLink) throw new Invalid(badLink);
                    },
                  }
                : w;
              const allowed = scope?.allowedPageIds;
              if (args.sourceMarkdown !== undefined || args.metadata !== undefined) {
                if (args.ops !== undefined) return fail("Use sourceMarkdown or metadata without ops.");
                if (args.baseRevision === undefined) return fail("This edit needs baseRevision.");
                const before = knowledge.live(editId).body;
                const page = knowledge.replace(
                  editId,
                  {
                    ...(args.sourceMarkdown !== undefined ? { sourceMarkdown: args.sourceMarkdown } : {}),
                    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
                    ...(args.title !== undefined ? { title: args.title } : {}),
                    ...(args.description !== undefined ? { description: args.description } : {}),
                    ...(args.body !== undefined ? { body: args.body } : {}),
                  },
                  args.baseRevision,
                  editWriter,
                );
                const path = allowed ? knowledge.scopedPath(page.id, allowed) : knowledge.path(page.id);
                answer = `Saved ${path} (${page.id}) · revision ${page.revision}.`;
                answer += linkReport(page.id, before, allowed);
                break;
              }
              if (!args.ops || args.ops.length === 0) return fail("edit needs ops, metadata or sourceMarkdown.");
              const before = knowledge.live(editId).body;
              const result = knowledge.edit(editId, args.ops as EditOp[], editWriter, args.baseRevision);
              const path = allowed ? knowledge.scopedPath(result.page.id, allowed) : knowledge.path(result.page.id);
              answer = `Saved ${path} (${result.page.id}) · revision ${result.page.revision}.`;
              answer += linkReport(result.page.id, before, allowed);
              if (result.changed) answer += `\n---\n${clip(result.changed, 800)}`;
              break;
            }
            case "move": {
              if (!args.pageId || args.parentId === undefined)
                return fail('move needs pageId and parentId (or "top").');
              const rawParentId = args.parentId.trim();
              if (scope) {
                if (!scope.allowedPageIds.has(args.pageId)) return fail(inaccessibleKnowledgePage(args.pageId));
                if (scope.grantedRootIds.has(args.pageId)) {
                  return fail(`Cannot move granted root folder ${args.pageId}.`);
                }
                if (!rawParentId || rawParentId === "top") {
                  return fail("Moving pages to the top level is not permitted; specify an allowed parentId.");
                }
                if (!scope.allowedPageIds.has(rawParentId)) return fail(inaccessibleKnowledgePage(rawParentId));
              }
              const page = knowledge.move(args.pageId, rawParentId === "top" ? null : rawParentId, w);
              const path = scope ? knowledge.scopedPath(page.id, scope.allowedPageIds) : knowledge.path(page.id);
              answer = `Moved to ${path} (${page.id}).\n${pageLink(page)}`;
              break;
            }
            case "archive": {
              if (!args.pageId) return fail("archive needs pageId.");
              if (scope) {
                if (!scope.allowedPageIds.has(args.pageId)) return fail(inaccessibleKnowledgePage(args.pageId));
                if (scope.grantedRootIds.has(args.pageId)) {
                  return fail(
                    `Cannot archive granted root folder ${args.pageId}; only descendant pages inside allowed folders can be moved to Trash.`,
                  );
                }
                const target = knowledge.page(args.pageId);
                if (!target || target.trashed_at !== null) return fail(inaccessibleKnowledgePage(args.pageId));
              }
              const title = knowledge.live(args.pageId).title;
              const n = knowledge.trashPage(
                args.pageId,
                w,
                scope
                  ? (pages) => {
                      if (pages.some((p) => !scope.allowedPageIds.has(p.id) || scope.grantedRootIds.has(p.id))) {
                        throw new Invalid("This subtree contains a page that this agent cannot move to Trash.");
                      }
                    }
                  : undefined,
              );
              answer = `Moved "${title}"${n > 1 ? ` and ${n - 1} page${n === 2 ? "" : "s"} under it` : ""} to Trash. The user can restore it for 30 days.`;
              break;
            }
            default:
              return fail("action must be create, edit, move or archive.");
          }
          knowledge.remember(w.callKey, answer, touched);
          return ok(answer);
        });
      },
    },
  );

  return defineExtension({
    name: "knowledge_write",
    namespace: { name: "knowledge", description: "The user's Knowledge pages: browse, read, search and write." },
    tools: [write],
  });
}
