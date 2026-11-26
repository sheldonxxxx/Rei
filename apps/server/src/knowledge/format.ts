import { StringEnum } from "@earendil-works/pi-ai";
import { arr, bool, obj, opt, str } from "@earendil-works/pi-schema";
import { estimateTokens } from "../memory/text.ts";
import { findSection, outline, refs, sections, sectionText } from "./markdown.ts";
import { age, type KnowledgeService, type PageRow } from "./service.ts";

export const KNOWLEDGE_CLIP = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
export const KNOWLEDGE_FLAT = (text: string): string => text.replace(/\s+/g, " ").trim();

export const inaccessibleKnowledgePage = (pageId: string): string =>
  `Page ${pageId} is not accessible or does not exist.`;

/** Rejects newly introduced `page:` links pointing outside `allowedPageIds` without revealing target existence. */
export function checkKnowledgePageLinks(
  body: string,
  selfId: string | null,
  existingLinks: ReadonlySet<string> | null,
  allowedPageIds: ReadonlySet<string>,
): string | undefined {
  for (const id of refs(body).pages) {
    if (id === selfId) continue;
    if (existingLinks?.has(id)) continue;
    if (!allowedPageIds.has(id)) return inaccessibleKnowledgePage(id);
  }
  return undefined;
}

/** Shared operation schema for section/tag/property Knowledge edits (used by agent tools and MCP). */
export const KnowledgeEditOpSchema = obj({
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

/** The first part of `text` that fits `budget` estimated tokens, ending at a line break where possible. */
export function cutToBudget(text: string, budget: number): string {
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

/** One browse listing line for a Knowledge page. */
export function formatKnowledgePageLine(p: PageRow, indent: number, knowledge: KnowledgeService, now: number): string {
  const n = knowledge.childCount(p.id);
  const flags = [p.system === "inbox" ? "inbox" : "", p.locked ? "locked" : "", p.pinned ? "pinned" : ""].filter(
    Boolean,
  );
  return `${"  ".repeat(indent)}${p.title} (${p.id})${p.description ? ` — ${KNOWLEDGE_CLIP(KNOWLEDGE_FLAT(p.description), 100)}` : ""}${n > 0 ? ` · ${n} ${n === 1 ? "child" : "children"}` : ""} · ${age(now - p.updated_at)} by ${knowledge.actorName(p.updated_by)}${flags.length ? ` · ${flags.join(", ")}` : ""}`;
}

/** Section links a write left pointing nowhere, optionally filtered to `allowedPageIds`. */
export function formatLinkReport(
  pageId: string,
  before: string | null,
  knowledge: KnowledgeService,
  allowedPageIds?: ReadonlySet<string>,
): string {
  const notes: string[] = [];
  const broken =
    before === null
      ? []
      : knowledge.sectionLinksBrokenBy(pageId, before).filter((b) => !allowedPageIds || allowedPageIds.has(b.page.id));
  if (broken.length > 0)
    notes.push(
      `Section links that now point nowhere (the heading was renamed or removed; they open the page at the top): ${broken
        .map((b) => {
          const path = allowedPageIds ? knowledge.scopedPath(b.page.id, allowedPageIds) : knowledge.path(b.page.id);
          return `${path} (${b.page.id}) → ${b.anchors.map((a) => `#${a}`).join(", ")}`;
        })
        .join("; ")}. Fix those pages, or keep a heading with that text.`,
    );
  const dangling = knowledge
    .danglingSectionLinks(pageId)
    .filter((d) => !allowedPageIds || allowedPageIds.has(d.pageId));
  if (dangling.length > 0)
    notes.push(
      `These links name a section the target page does not have, so they open its top: ${dangling
        .map((d) => `page:${d.pageId}#${d.anchor}`)
        .join(", ")}. Read the target's outline for its #slugs.`,
    );
  return notes.length > 0 ? `\n${notes.join("\n")}` : "";
}

export interface FormattedKnowledgeRead {
  textOutput: string;
  structured: {
    pageId: string;
    path: string;
    title: string;
    revision: number;
    updatedAt: number;
    updatedBy: string;
    locked: boolean;
    tags: string[];
    description: string;
    outline: string[];
    text: string;
    truncated: boolean;
    note?: string;
    children: { id: string; title: string }[];
    moreChildren: boolean;
  };
}

/** Formats a page (or one section) within a token budget for agent and MCP read tools. */
export function formatKnowledgeRead(options: {
  page: PageRow;
  path: string;
  section?: string;
  maxTokens?: number;
  knowledge: KnowledgeService;
  now: number;
  allowedPageIds?: ReadonlySet<string>;
}): FormattedKnowledgeRead {
  const { page, path, section, knowledge, now, allowedPageIds } = options;
  const budget = options.maxTokens ?? 1_500;
  const tags = (JSON.parse(page.metadata_json) as { tags: string[] }).tags;
  const head = [
    `${path} (${page.id}) · revision ${page.revision} · updated ${age(now - page.updated_at)} by ${knowledge.actorName(page.updated_by)}${page.locked ? " · locked for agents (append only)" : ""}`,
    `Tags: ${tags.join(", ") || "(none)"}`,
  ];
  if (page.description) head.push(`Description: ${page.description}`);
  const outlineLines = outline(page.body).map((l) => l.trim());
  if (outlineLines.length > 0) head.push(`Outline: ${outlineLines.join(" · ")}`);

  let text = section ? sectionText(page.body, findSection(page.body, section)) : page.body;
  let tail = "";
  if (estimateTokens(text) > budget) {
    if (section) {
      text = cutToBudget(text, budget);
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

  const allChildren = knowledge.children(page.id).filter((c) => !allowedPageIds || allowedPageIds.has(c.id));
  const children = allChildren.slice(0, 15);
  const moreChildren = allChildren.length > children.length;
  const trimmed = text.trim();
  const out = [...head, "---", trimmed === "" ? "(empty page)" : trimmed];
  if (tail) out.push(tail);
  if (children.length > 0)
    out.push(
      "---",
      `Child pages: ${children.map((c) => `${c.title} (${c.id})`).join(" · ")}${moreChildren ? " · …" : ""}`,
    );

  return {
    textOutput: out.join("\n"),
    structured: {
      pageId: page.id,
      path,
      title: page.title,
      revision: page.revision,
      updatedAt: page.updated_at,
      updatedBy: knowledge.actorName(page.updated_by),
      locked: !!page.locked,
      tags,
      description: page.description ?? "",
      outline: outlineLines,
      text: trimmed,
      truncated: tail !== "",
      ...(tail ? { note: tail } : {}),
      children: children.map((c) => ({ id: c.id, title: c.title })),
      moreChildren,
    },
  };
}
