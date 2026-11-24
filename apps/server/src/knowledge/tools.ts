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
import { estimateTokens } from "../memory/text.ts";
import { MODEL_AND_SCRIPTS } from "../pi/callers.ts";
import { policyTool, type ToolCatalog } from "../pi/policy-ext.ts";
import { toJson } from "../pi/structured.ts";
import type { AppStore, SessionRow } from "../store/store.ts";
import { HttpError } from "../util/errors.ts";
import { findSection, outline, sections, sectionText } from "./markdown.ts";
import { age, type EditOp, KnowledgeConflict, type KnowledgeService, type PageRow, type Writer } from "./service.ts";

export const KNOWLEDGE_CONNECTOR = "knowledge";

export const KNOWLEDGE_NOTE = [
  "Knowledge is the shared long-term layer above chat history: nested pages that you, the other agents and the user keep. Chat history is day-to-day; Knowledge is where lasting learning goes.",
  "Read before you start. Before research, planning or project work that may have come up before, run knowledge_search and build on what is there; skip it for self-contained questions.",
  "Write on your own initiative when something is worth keeping beyond this chat: research results, plans, decisions and their reasons, how-tos learned the hard way, project state to resume later. Facts and preferences about the user go to memory instead; passing details of one task go nowhere.",
  "Before creating a page, browse or search and prefer editing an existing page. You choose where a page goes (an existing page, a new parent you create, or Inbox when nothing fits); nothing is filed for you. Give pages a clear title and a one-line description so others can find them by browsing. Load the rei-knowledge skill before creating a page or restructuring one.",
  "Find things by browsing from the list below first (knowledge_browse, then knowledge_read with a section), and use knowledge_search when the place is unclear.",
].join(" ");

type ToolText = { output: { type: "text"; text: string }[]; isError?: true; structuredOutput?: JsonValue };
const ok = (text: string, structuredOutput?: unknown): ToolText => ({
  output: [{ type: "text", text }],
  ...(structuredOutput !== undefined ? { structuredOutput: toJson(structuredOutput) } : {}),
});
const fail = (text: string): ToolText => ({ isError: true, output: [{ type: "text", text }] });
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
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
  const readInto = (session: SessionRow, page: PageRow): void => {
    const labels = knowledge.taintOf(page);
    if (labels.length > 0) store.addTaint(session.id, labels);
  };
  const now = () => store.clock.now();
  const line = (p: PageRow, indent: number): string => {
    const n = knowledge.childCount(p.id);
    const flags = [p.system === "inbox" ? "inbox" : "", p.locked ? "locked" : "", p.pinned ? "pinned" : ""].filter(
      Boolean,
    );
    return `${"  ".repeat(indent)}${p.title} (${p.id})${p.description ? ` — ${clip(flat(p.description), 100)}` : ""}${n > 0 ? ` · ${n} ${n === 1 ? "child" : "children"}` : ""} · ${age(now() - p.updated_at)} by ${knowledge.actorName(p.updated_by)}${flags.length ? ` · ${flags.join(", ")}` : ""}`;
  };
  /** Section links this write left pointing nowhere: other pages' links to removed headings, and this page's own. */
  const linkReport = (pageId: string, before: string | null): string => {
    const notes: string[] = [];
    const broken = before === null ? [] : knowledge.sectionLinksBrokenBy(pageId, before);
    if (broken.length > 0)
      notes.push(
        `Section links that now point nowhere (the heading was renamed or removed; they open the page at the top): ${broken
          .map((b) => `${knowledge.path(b.page.id)} (${b.page.id}) → ${b.anchors.map((a) => `#${a}`).join(", ")}`)
          .join("; ")}. Fix those pages, or keep a heading with that text.`,
      );
    const dangling = knowledge.danglingSectionLinks(pageId);
    if (dangling.length > 0)
      notes.push(
        `These links name a section the target page does not have, so they open its top: ${dangling
          .map((d) => `page:${d.pageId}#${d.anchor}`)
          .join(", ")}. Read the target's outline for its #slugs.`,
      );
    return notes.length > 0 ? `\n${notes.join("\n")}` : "";
  };
  const explain = (error: unknown): ToolText => {
    if (error instanceof KnowledgeConflict)
      return fail(
        `${error.message}\n---\n${clip(error.current, 3_000)}\n---\nRetry with baseRevision: ${error.revision}.`,
      );
    if (error instanceof HttpError) return fail(error.message);
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
        return guard(() => {
          const parent = args.pageId ? knowledge.live(args.pageId) : null;
          const depth = args.depth ?? 1;
          const limit = args.limit ?? 30;
          const offset = args.offset ?? 0;
          const out: string[] = [parent ? `${knowledge.path(parent.id)} (${parent.id}):` : "Knowledge top level:"];
          const walk = (id: string | null, level: number, skip: number): void => {
            const rows = knowledge.children(id, limit + 1, skip);
            for (const row of rows.slice(0, limit)) {
              if (out.length >= MAX_LINES) return;
              out.push(line(row, level));
              if (level + 1 < depth) walk(row.id, level + 1, 0);
            }
            if (rows.length > limit && out.length < MAX_LINES) {
              const total = id === null ? knowledge.children(null).length : knowledge.childCount(id);
              out.push(
                `${"  ".repeat(level)}… ${total - skip - limit} more${level === 0 ? ` (offset: ${skip + limit})` : ""}`,
              );
            }
          };
          walk(parent?.id ?? null, 0, offset);
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
        return guard(() => {
          const page = knowledge.live(args.pageId);
          readInto(session, page);
          const budget = args.maxTokens ?? 1_500;
          const head = [
            `${knowledge.path(page.id)} (${page.id}) · revision ${page.revision} · updated ${age(now() - page.updated_at)} by ${knowledge.actorName(page.updated_by)}${page.locked ? " · locked for agents (append only)" : ""}`,
          ];
          head.push(`Tags: ${(JSON.parse(page.metadata_json) as { tags: string[] }).tags.join(", ") || "(none)"}`);
          if (page.description) head.push(`Description: ${page.description}`);
          const outlineLines = outline(page.body);
          if (outlineLines.length > 0) head.push(`Outline: ${outlineLines.map((l) => l.trim()).join(" · ")}`);
          let text: string;
          let tail = "";
          if (args.section) {
            const s = findSection(page.body, args.section);
            text = sectionText(page.body, s);
          } else {
            text = page.body;
          }
          if (estimateTokens(text) > budget) {
            if (args.section) {
              const cut = cutToBudget(text, budget);
              text = cut;
              tail = "[cut: the section is longer than maxTokens; raise maxTokens to read the rest]";
            } else {
              const all = sections(page.body);
              const parts: string[] = [];
              let used = 0;
              let next: (typeof all)[number] | undefined;
              for (const s of all) {
                const own = page.body.split("\n").slice(s.start, s.ownEnd).join("\n");
                const cost = estimateTokens(own);
                if (used + cost > budget && parts.length > 0) {
                  next = s;
                  break;
                }
                parts.push(used + cost > budget ? cutToBudget(own, budget - used) : own);
                used += cost;
              }
              text = parts.join("\n");
              tail = next
                ? `[cut at §${next.index} ${next.heading} — read on with section: "§${next.index}"]`
                : "[cut: raise maxTokens to read the rest]";
            }
          }
          const children = knowledge.children(page.id, 15);
          const moreChildren = knowledge.childCount(page.id) > children.length;
          const out = [...head, "---", text.trim() === "" ? "(empty page)" : text.trim()];
          if (tail) out.push(tail);
          if (children.length > 0)
            out.push(
              "---",
              `Child pages: ${children.map((c) => `${c.title} (${c.id})`).join(" · ")}${moreChildren ? " · …" : ""}`,
            );
          return ok(out.join("\n"), {
            pageId: page.id,
            path: knowledge.path(page.id),
            title: page.title,
            revision: page.revision,
            updatedAt: page.updated_at,
            updatedBy: knowledge.actorName(page.updated_by),
            locked: !!page.locked,
            tags: (JSON.parse(page.metadata_json) as { tags: string[] }).tags,
            description: page.description ?? "",
            outline: outlineLines.map((l) => l.trim()),
            text: text.trim(),
            truncated: tail !== "",
            ...(tail ? { note: tail } : {}),
            children: children.map((c) => ({ id: c.id, title: c.title })),
            moreChildren,
          });
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
        return guardAsync(async () => {
          const hits = await knowledge.find(args.query ?? "", {
            ...(args.tags ? { tags: args.tags } : {}),
            ...(args.under ? { under: args.under } : {}),
            limit: args.limit ?? 8,
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
          return ok(
            hits
              .map(
                (h, i) =>
                  `${i + 1}. ${h.path} (${h.pageId})${h.section ? ` › ${h.section}` : ""} · ${age(now() - h.updatedAt)}${byMeaning(h) ? " (by meaning)" : ""}: ${h.snippet}`,
              )
              .join("\n"),
            {
              hits: hits.map((h, i) => ({
                rank: i + 1,
                pageId: h.pageId,
                title: h.title,
                path: h.path,
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

  const OpSchema = obj({
    op: StringEnum([
      "append",
      "append_to_section",
      "replace_section",
      "insert_section_after",
      "replace_text",
      "set_task",
      "set_title",
      "set_description",
      "set_metadata",
      "add_tags",
      "remove_tags",
    ]),
    text: opt(str({ description: "append, append_to_section, replace_section, insert_section_after." })),
    section: opt(str({ description: '§n, #slug, heading text, or path; "top" is the text before the first heading.' })),
    old: opt(str({ description: "replace_text: the exact text now on the page (must occur once)." })),
    new: opt(str({ description: "replace_text: what replaces it." })),
    task: opt(str({ description: "set_task: the task's text (or a unique part of it)." })),
    done: opt(bool({ description: "set_task: true ticks, false unticks." })),
    title: opt(str()),
    description: opt(str()),
    metadata: opt(obj({ tags: arr(str(), { maxItems: 20 }) })),
    tags: opt(arr(str(), { maxItems: 20 })),
  });

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
                  'create needs parentId: the id of the page to put it under (browse first), or "top". Use Inbox\'s id when nothing fits.',
                );
              if (!args.title && args.sourceMarkdown === undefined)
                return fail("create needs a title or sourceMarkdown.");
              const parentId = args.parentId === "top" ? null : args.parentId;
              const similar = knowledge.similar(args.title ?? "");
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
              answer = `Created ${knowledge.path(page.id)} (${page.id}) · revision ${page.revision}.\n${pageLink(page)}`;
              answer += linkReport(page.id, null);
              if (similar.length > 0)
                answer += `\nSimilar pages already exist — consider editing one instead next time: ${similar.map((p) => `${knowledge.path(p.id)} (${p.id})`).join("; ")}.`;
              break;
            }
            case "edit": {
              if (!args.pageId) return fail("edit needs pageId.");
              if (args.sourceMarkdown !== undefined || args.metadata !== undefined) {
                if (args.ops !== undefined) return fail("Use sourceMarkdown or metadata without ops.");
                if (args.baseRevision === undefined) return fail("This edit needs baseRevision.");
                const before = knowledge.live(args.pageId).body;
                const page = knowledge.replace(
                  args.pageId,
                  {
                    ...(args.sourceMarkdown !== undefined ? { sourceMarkdown: args.sourceMarkdown } : {}),
                    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
                    ...(args.title !== undefined ? { title: args.title } : {}),
                    ...(args.description !== undefined ? { description: args.description } : {}),
                    ...(args.body !== undefined ? { body: args.body } : {}),
                  },
                  args.baseRevision,
                  w,
                );
                answer = `Saved ${knowledge.path(page.id)} (${page.id}) · revision ${page.revision}.`;
                answer += linkReport(page.id, before);
                break;
              }
              if (!args.ops || args.ops.length === 0) return fail("edit needs ops, metadata or sourceMarkdown.");
              const before = knowledge.live(args.pageId).body;
              const result = knowledge.edit(args.pageId, args.ops as EditOp[], w, args.baseRevision);
              answer = `Saved ${knowledge.path(result.page.id)} (${result.page.id}) · revision ${result.page.revision}.`;
              answer += linkReport(result.page.id, before);
              if (result.changed) answer += `\n---\n${clip(result.changed, 800)}`;
              break;
            }
            case "move": {
              if (!args.pageId || args.parentId === undefined)
                return fail('move needs pageId and parentId (or "top").');
              const page = knowledge.move(args.pageId, args.parentId === "top" ? null : args.parentId, w);
              answer = `Moved to ${knowledge.path(page.id)} (${page.id}).\n${pageLink(page)}`;
              break;
            }
            case "archive": {
              if (!args.pageId) return fail("archive needs pageId.");
              const title = knowledge.live(args.pageId).title;
              const n = knowledge.trashPage(args.pageId, w);
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
    name: "knowledge",
    namespace: { name: "knowledge", description: "The user's Knowledge pages: browse, read, search and write." },
    tools: [browse, read, search, write],
    sections: [
      section("knowledge", () => {
        try {
          const pointer = knowledge.pointer(now());
          return pointer ? `${KNOWLEDGE_NOTE}\n${pointer}` : KNOWLEDGE_NOTE;
        } catch {
          return KNOWLEDGE_NOTE;
        }
      }),
    ],
  });
}

/** The first part of `text` that fits `budget` estimated tokens, ending at a line break where possible. */
function cutToBudget(text: string, budget: number): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo);
  const nl = cut.lastIndexOf("\n");
  return `${nl > cut.length * 0.6 ? cut.slice(0, nl) : cut}…`;
}
