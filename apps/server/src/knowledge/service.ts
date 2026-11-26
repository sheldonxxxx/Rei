// Knowledge (GLOSSARY.md): shared, long-term pages that the user and every agent browse, read and write.
//
// The service validates, versions, links and indexes. It never decides where a page goes, never moves or creates a page
// on its own, and never distils anything from chats (docs/adr/0002): every write here is a deliberate call by the user
// or by an agent's tool. Page text and its revisions live in SQLite (docs/adr/0001).
import type {
  KnowledgeActor,
  KnowledgeOverview,
  KnowledgePage,
  KnowledgePageDetail,
  KnowledgeRevision,
  KnowledgeSearchHit,
  KnowledgeTreeNode,
  TaintLabel,
} from "@rei/protocol";
import { findSlug } from "@rei/protocol";
import {
  type KnowledgeMetadata,
  KnowledgeMetadataError,
  normalizeMetadata,
  normalizeTags,
  parseKnowledgeSource,
  tagKey,
} from "@rei/protocol/knowledge-source";
import { bigramTokens, ftsText, queryTerms } from "../memory/keyword.ts";
import { estimateTokens } from "../memory/text.ts";
import { GLOBAL_STREAM } from "../store/events.ts";
import type { AppStore } from "../store/store.ts";
import { HttpError, Invalid, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import {
  appendText,
  appendToSection,
  chunks,
  findSection,
  insertSectionAfter,
  refs,
  replaceSection,
  replaceText,
  type Section,
  sectionText,
  setTask,
  slugs,
} from "./markdown.ts";
import { type KnowledgeMeaning, sectionKey } from "./meaning.ts";

/** A page's Markdown body is capped at this many bytes (UTF-8). */
export const PAGE_MAX_BYTES = 256 * 1024;
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 300;
/** Writes by the same actor in the same session this close together are one revision in the history. */
export const COALESCE_MS = 10 * 60_000;
/** Trash keeps a page this long before it is deleted for good. */
export const TRASH_KEEP_MS = 30 * 86_400_000;
export const INBOX = "inbox";

export interface PageRow {
  id: string;
  parent_id: string | null;
  title: string;
  description: string;
  body: string;
  metadata_json: string;
  revision: number;
  locked: number;
  pinned: number;
  system: string | null;
  taint: string;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
  activity_at: number;
  trashed_at: number | null;
  trash_root: string | null;
}

interface RevisionRow {
  page_id: string;
  revision: number;
  title: string;
  description: string;
  body: string;
  metadata_json: string;
  actor: string;
  session_id: string | null;
  run_id: string | null;
  external: number;
  note: string | null;
  created_at: number;
  updated_at: number;
}

/** Who is writing, and from where. `actor` is "user" or an agent id. */
export interface Writer {
  actor: string;
  sessionId?: string | null;
  runId?: string | null;
  /** The session's taint labels: "external" marks the revision, and every label sticks to the page. */
  taint?: readonly TaintLabel[];
  /** A replayed tool call with this key returns the first call's answer instead of writing again. */
  callKey?: string;
  /** Checks the final Markdown against the previous body before persisting an edit. */
  validateBody?: (body: string, previousBody: string) => void;
}

export type EditOp =
  | { op: "append"; text: string }
  /** Internal whole-document save; not exposed by the agent operation schema. */
  | { op: "set_body"; body: string }
  | { op: "append_to_section"; section: string; text: string }
  | { op: "replace_section"; section: string; text: string }
  | { op: "insert_section_after"; section: string; text: string }
  | { op: "replace_text"; old: string; new: string }
  | { op: "set_task"; task?: string; index?: number; done: boolean }
  | { op: "set_metadata"; metadata: KnowledgeMetadata }
  | { op: "add_tags" | "remove_tags"; tags: string[] }
  | { op: "set_title"; title: string }
  | { op: "set_description"; description: string };

/** Ops that commute with any concurrent change, so they need no base revision. */
const BASELESS = new Set<EditOp["op"]>(["append", "set_task"]);

export interface EditResult {
  page: PageRow;
  /** The section the last section op touched, as it reads now (for a short tool answer). */
  changed: string | null;
}

/** A write based on an older revision. `current` is the affected section's text now (or the page's, cut short). */
export class KnowledgeConflict extends HttpError {
  readonly revision: number;
  readonly current: string;
  constructor(revision: number, current: string, what: string) {
    super(
      409,
      "conflict",
      `The page changed since revision you based this on; it is now revision ${revision}. ${what}`,
    );
    this.revision = revision;
    this.current = current;
  }
}

/**
 * Words too common to say anything about a page: a question like "how to cook pasta" would otherwise match every page
 * that has a "to". Only Knowledge drops them (history search keeps its own matching); Chinese, Japanese and Korean
 * text is never touched, and a query made only of these words is searched as typed.
 */
const STOPWORDS = new Set(
  (
    "a about after all also am an and any are as at be been being but by can could did do does for from had has have he her " +
    "here hers him his how i if in into is it its just me my no nor not of on or our out over she should so some than that " +
    "the their them then there these they this those to too up us was we were what when where which who whom why will with " +
    "would you your"
  ).split(" "),
);

/** The MATCH expression for a Knowledge query: an OR of its meaningful terms (BM25 ranks), null when it has none. */
export function knowledgeMatchExpr(query: string): string | null {
  const terms = queryTerms(query);
  const meaningful = terms.filter((t) => !STOPWORDS.has(t));
  const used = meaningful.length > 0 ? meaningful : terms;
  return used.length === 0 ? null : used.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export interface KnowledgeInput {
  title?: string;
  description?: string;
  body?: string;
  metadata?: Partial<KnowledgeMetadata>;
  sourceMarkdown?: string;
}
export interface KnowledgeSearchOptions {
  under?: string;
  tags?: string[];
  limit?: number;
  allowedPageIds?: ReadonlySet<string>;
}
/** Shared source validation errors remain structured over HTTP. */
function validated<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof KnowledgeMetadataError)) throw error;
    throw new HttpError(400, error.code, error.message, [
      {
        path: `/${error.field}`,
        message: error.message,
        ...(error.line !== undefined ? { line: error.line } : {}),
        ...(error.column !== undefined ? { column: error.column } : {}),
      },
    ]);
  }
}
function inputFields(input: KnowledgeInput): KnowledgeInput {
  return validated(() => {
    if (input.sourceMarkdown === undefined) return input;
    if ([input.title, input.description, input.body, input.metadata].some((v) => v !== undefined))
      throw new KnowledgeMetadataError(
        "sourceMarkdown",
        "exclusive_input",
        "Use sourceMarkdown alone, without title, description, body or metadata.",
      );
    return parseKnowledgeSource(input.sourceMarkdown);
  });
}
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const bytes = (s: string): number => new TextEncoder().encode(s).length;
const parseTaint = (json: string): TaintLabel[] => {
  try {
    return JSON.parse(json) as TaintLabel[];
  } catch {
    return ["private"];
  }
};

/** One indexed section of a page: the unit both rankings work in. */
export interface KnowledgeSection {
  pageId: string;
  section: number;
  /** Heading path ("" for the title and description). */
  path: string;
  text: string;
}

export class KnowledgeService {
  readonly store: AppStore;
  /** Meaning search, when the server runs one (set after construction, like the Library's attachments). */
  meaning: KnowledgeMeaning | undefined;
  /** Resolves an external MCP token id (`mcp:<id>`) to its display label (including revoked tokens). */
  mcpActorLabel: ((tokenId: string) => string) | undefined;

  constructor(store: AppStore) {
    this.store = store;
  }
  get #db() {
    return this.store.db;
  }
  #now(): number {
    return this.store.clock.now();
  }

  // ---- setup -------------------------------------------------------------------------------------------------------

  /** Inbox always exists: a fresh installation makes it, and so does the first start after the upgrade. */
  ensureInbox(): PageRow {
    const existing = this.#db.get<PageRow>("SELECT * FROM knowledge_pages WHERE system = ?", INBOX);
    if (existing) return existing;
    return this.store.tx(() => {
      const now = this.#now();
      const id = newId("pg", now);
      const description = "Things not yet filed. Put something here deliberately when no page fits.";
      this.#db.run(
        `INSERT INTO knowledge_pages (id, parent_id, title, description, body, revision, system, created_by, created_at, updated_by, updated_at, activity_at)
         VALUES (?, NULL, 'Inbox', ?, '', 1, ?, 'user', ?, 'user', ?, ?)`,
        id,
        description,
        INBOX,
        now,
        now,
        now,
      );
      this.#db.run(
        "INSERT INTO knowledge_revisions (page_id, revision, title, description, body, actor, note, created_at, updated_at) VALUES (?, 1, 'Inbox', ?, '', 'user', 'created', ?, ?)",
        id,
        description,
        now,
        now,
      );
      return this.#row(id)!;
    });
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  #row(id: string): PageRow | undefined {
    return this.#db.get<PageRow>("SELECT * FROM knowledge_pages WHERE id = ?", id);
  }
  /** A live page (not in Trash), or a 404 the model can act on. */
  live(id: string): PageRow {
    const row = this.#row(id);
    if (!row || row.trashed_at !== null)
      throw notFound(row ? `Page ${id} is in Trash.` : `There is no page ${id}; browse or search for its id.`);
    return row;
  }
  page(id: string): PageRow | undefined {
    return this.#row(id);
  }
  children(parentId: string | null, limit = 1_000, offset = 0): PageRow[] {
    return parentId === null
      ? this.#db.all<PageRow>(
          "SELECT * FROM knowledge_pages WHERE parent_id IS NULL AND trashed_at IS NULL ORDER BY activity_at DESC, id DESC LIMIT ? OFFSET ?",
          limit,
          offset,
        )
      : this.#db.all<PageRow>(
          "SELECT * FROM knowledge_pages WHERE parent_id = ? AND trashed_at IS NULL ORDER BY activity_at DESC, id DESC LIMIT ? OFFSET ?",
          parentId,
          limit,
          offset,
        );
  }
  childCount(parentId: string): number {
    return this.#db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM knowledge_pages WHERE parent_id = ? AND trashed_at IS NULL",
      parentId,
    )!.n;
  }
  /** The page and its ancestors, outermost first. */
  ancestry(id: string): PageRow[] {
    const out: PageRow[] = [];
    const seen = new Set<string>();
    for (let at = this.#row(id); at && !seen.has(at.id); at = at.parent_id ? this.#row(at.parent_id) : undefined) {
      seen.add(at.id);
      out.unshift(at);
    }
    return out;
  }
  path(id: string): string {
    return this.ancestry(id)
      .map((p) => p.title)
      .join(" › ");
  }
  /** Path starting from the outermost contiguous in-scope ancestor, never revealing outside titles. */
  scopedPath(id: string, allowedPageIds: ReadonlySet<string>): string {
    const chain = this.ancestry(id);
    const out: PageRow[] = [];
    for (let i = chain.length - 1; i >= 0; i--) {
      const p = chain[i]!;
      if (!allowedPageIds.has(p.id)) break;
      out.unshift(p);
    }
    return out.map((p) => p.title).join(" › ");
  }
  #descendants(id: string, includeTrashed = false): PageRow[] {
    return this.#db.all<PageRow>(
      `WITH RECURSIVE sub(id) AS (SELECT id FROM knowledge_pages WHERE parent_id = ?
         UNION SELECT p.id FROM knowledge_pages p JOIN sub ON p.parent_id = sub.id)
       SELECT k.* FROM knowledge_pages k JOIN sub ON k.id = sub.id${includeTrashed ? "" : " WHERE k.trashed_at IS NULL"}`,
      id,
    );
  }
  revisions(id: string): RevisionRow[] {
    return this.#db.all<RevisionRow>("SELECT * FROM knowledge_revisions WHERE page_id = ? ORDER BY revision DESC", id);
  }
  revision(id: string, revision: number): RevisionRow | undefined {
    return this.#db.get<RevisionRow>(
      "SELECT * FROM knowledge_revisions WHERE page_id = ? AND revision = ?",
      id,
      revision,
    );
  }
  backlinks(id: string): PageRow[] {
    return this.#db.all<PageRow>(
      `SELECT p.* FROM knowledge_links l JOIN knowledge_pages p ON p.id = l.from_id
       WHERE l.kind = 'page' AND l.target = ? AND p.trashed_at IS NULL ORDER BY p.activity_at DESC`,
      id,
    );
  }
  /** Live pages that link to a Library file (any version). */
  pagesUsingFile(fileId: string): PageRow[] {
    return this.#db.all<PageRow>(
      `SELECT DISTINCT p.* FROM knowledge_links l JOIN knowledge_pages p ON p.id = l.from_id
       WHERE l.kind = 'file' AND (l.target = ? OR l.target LIKE ?) AND p.trashed_at IS NULL ORDER BY p.activity_at DESC`,
      fileId,
      `${fileId}@%`,
    );
  }
  /**
   * Section links on other live pages that pointed at a heading of this page in `before` and point nowhere now (the
   * heading was renamed or removed). Reported with the write, never blocking it.
   */
  sectionLinksBrokenBy(pageId: string, before: string): { page: PageRow; anchors: string[] }[] {
    const page = this.#row(pageId);
    if (!page) return [];
    const was = slugs(before);
    const now = slugs(page.body);
    const prefix = `${pageId}#`;
    const rows = this.#db.all<{ from_id: string; target: string }>(
      `SELECT l.from_id, l.target FROM knowledge_links l JOIN knowledge_pages p ON p.id = l.from_id
       WHERE l.kind = 'page' AND substr(l.target, 1, ?) = ? AND p.trashed_at IS NULL ORDER BY p.activity_at DESC`,
      prefix.length,
      prefix,
    );
    const out = new Map<string, { page: PageRow; anchors: string[] }>();
    for (const row of rows) {
      const anchor = row.target.slice(prefix.length);
      if (findSlug(was, anchor) < 0 || findSlug(now, anchor) >= 0) continue;
      const from = this.#row(row.from_id)!;
      const entry = out.get(from.id) ?? { page: from, anchors: [] };
      entry.anchors.push(anchor);
      out.set(from.id, entry);
    }
    return [...out.values()];
  }
  /** This page's own section links whose page exists but has no such heading (they open that page at the top). */
  danglingSectionLinks(pageId: string): { pageId: string; anchor: string }[] {
    const page = this.#row(pageId);
    if (!page) return [];
    return refs(page.body).anchors.filter((a) => {
      const target = a.pageId === pageId ? page : this.#row(a.pageId);
      return target !== undefined && findSlug(slugs(target.body), a.anchor) < 0;
    });
  }
  taintOf(page: PageRow): TaintLabel[] {
    return parseTaint(page.taint);
  }

  actorName(actor: string): string {
    if (actor === "user") return "you";
    if (actor.startsWith("mcp:")) return this.mcpActorLabel?.(actor.slice(4)) ?? "an MCP client";
    return this.store.getAgent(actor)?.name ?? "an agent";
  }
  #actor(actor: string): KnowledgeActor {
    if (actor === "user") return { kind: "user", id: null, name: "You" };
    if (actor.startsWith("mcp:")) {
      const id = actor.slice(4);
      return { kind: "mcp", id, name: this.mcpActorLabel?.(id) ?? "Removed token" };
    }
    return { kind: "agent", id: actor, name: this.store.getAgent(actor)?.name ?? "Removed agent" };
  }

  toPage(row: PageRow): KnowledgePage {
    return {
      id: row.id,
      parentId: row.parent_id,
      title: row.title,
      description: row.description,
      metadata: JSON.parse(row.metadata_json) as KnowledgeMetadata,
      revision: row.revision,
      locked: row.locked === 1,
      pinned: row.pinned === 1,
      inbox: row.system === INBOX,
      external: parseTaint(row.taint).includes("external"),
      createdBy: this.#actor(row.created_by),
      createdAt: row.created_at,
      updatedBy: this.#actor(row.updated_by),
      updatedAt: row.updated_at,
      activityAt: row.activity_at,
      trashedAt: row.trashed_at,
    };
  }
  #toRevision(r: RevisionRow): KnowledgeRevision {
    return {
      revision: r.revision,
      title: r.title,
      description: r.description,
      metadata: JSON.parse(r.metadata_json) as KnowledgeMetadata,
      actor: this.#actor(r.actor),
      sessionId: r.session_id,
      sessionTitle: r.session_id ? (this.store.getSession(r.session_id)?.title ?? null) : null,
      runId: r.run_id,
      external: r.external === 1,
      note: r.note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  detail(id: string): KnowledgePageDetail {
    const row = this.#row(id);
    if (!row) throw notFound("There is no such page.");
    const links = this.#db.all<{ target: string }>(
      "SELECT target FROM knowledge_links WHERE from_id = ? AND kind = 'file'",
      id,
    );
    return {
      page: this.toPage(row),
      body: row.body,
      ancestors: this.ancestry(id)
        .slice(0, -1)
        .map((p) => ({ id: p.id, title: p.title })),
      children: this.children(id).map((c) => this.#node(c)),
      backlinks: this.backlinks(id).map((p) => ({ id: p.id, title: p.title, path: this.path(p.id) })),
      files: links.map((l) => {
        const [fileId, versionId] = l.target.split("@") as [string, string | undefined];
        const file = this.#db.get<{ name: string; purged_at: number | null; current_version: string }>(
          "SELECT name, purged_at, current_version FROM library_files WHERE id = ?",
          fileId,
        );
        // The version a reader opens: the pinned one, or the file's current version.
        const resolved = file
          ? this.#db.get<{ id: string; media_type: string }>(
              "SELECT v.id, a.media_type FROM library_versions v JOIN attachments a ON a.id = v.attachment_id WHERE v.file_id = ? AND v.id = ?",
              fileId,
              versionId ?? file.current_version,
            )
          : undefined;
        return {
          fileId,
          versionId: versionId ?? null,
          name: file?.name ?? null,
          available: !!file && file.purged_at === null && !!resolved,
          contentVersionId: resolved?.id ?? null,
          mediaType: resolved?.media_type ?? null,
        };
      }),
      revisions: this.revisions(id).map((r) => this.#toRevision(r)),
    };
  }
  revisionDetail(id: string, revision: number): KnowledgeRevision & { body: string } {
    const r = this.revision(id, revision);
    if (!r) throw notFound("There is no such revision.");
    return { ...this.#toRevision(r), body: r.body };
  }

  #node(row: PageRow): KnowledgeTreeNode {
    return {
      id: row.id,
      parentId: row.parent_id,
      title: row.title,
      description: row.description,
      activityAt: row.activity_at,
      updatedAt: row.updated_at,
      updatedBy: this.#actor(row.updated_by),
      locked: row.locked === 1,
      pinned: row.pinned === 1,
      inbox: row.system === INBOX,
      childCount: this.childCount(row.id),
    };
  }
  /** Every live page without its body, for the sidebar tree; the client nests them by parentId. */
  tree(): KnowledgeTreeNode[] {
    const rows = this.#db.all<PageRow & { n: number }>(
      `SELECT p.*, (SELECT COUNT(*) FROM knowledge_pages c WHERE c.parent_id = p.id AND c.trashed_at IS NULL) AS n
       FROM knowledge_pages p WHERE p.trashed_at IS NULL ORDER BY p.activity_at DESC, p.id DESC`,
    );
    return rows.map((row) => ({ ...this.#node({ ...row }), childCount: row.n }));
  }
  /** Trash: the roots of each trash action, newest first. */
  trash(): KnowledgeTreeNode[] {
    return this.#db
      .all<PageRow>(
        "SELECT * FROM knowledge_pages WHERE trashed_at IS NOT NULL AND trash_root = id ORDER BY trashed_at DESC",
      )
      .map((row) => ({ ...this.#node(row), trashedAt: row.trashed_at }));
  }

  // ---- writes ------------------------------------------------------------------------------------------------------

  #changed(pageId: string | null): void {
    this.store.events.append(GLOBAL_STREAM, { type: "knowledge.changed", pageId });
  }

  /** The earlier answer to a replayed tool call, if this key already wrote. */
  replayed(callKey: string | undefined): string | undefined {
    if (!callKey) return undefined;
    return this.#db.get<{ result: string }>("SELECT result FROM knowledge_calls WHERE key = ?", callKey)?.result;
  }
  /** Keeps a write's answer for replays, and the page it touched (the chat's activity row links to it). */
  remember(callKey: string | undefined, result: string, pageId?: string): void {
    if (!callKey) return;
    this.#db.run(
      "INSERT OR IGNORE INTO knowledge_calls (key, result, page_id, created_at) VALUES (?, ?, ?, ?)",
      callKey,
      result,
      pageId ?? null,
      this.#now(),
    );
  }

  #checkTitle(title: string): string {
    const t = oneLine(title);
    if (t === "") throw new Invalid("A page needs a title.");
    if ([...t].length > TITLE_MAX) throw new Invalid(`Titles can be at most ${TITLE_MAX} characters.`);
    return t;
  }
  #checkDescription(description: string): string {
    const d = oneLine(description);
    if ([...d].length > DESCRIPTION_MAX)
      throw new Invalid(`Descriptions are one line of at most ${DESCRIPTION_MAX} characters.`);
    return d;
  }
  /** Size, and every page:/file: link must name something that exists. */
  #checkBody(body: string, selfId: string | null): void {
    if (bytes(body) > PAGE_MAX_BYTES)
      throw new Invalid(`A page can hold at most ${PAGE_MAX_BYTES / 1024} KB of Markdown; split it into child pages.`);
    const found = refs(body);
    for (const id of found.pages) {
      if (id === selfId) continue;
      if (!this.#row(id)) throw new Invalid(`The link page:${id} names no page; browse or search for the right id.`);
    }
    for (const f of found.files) {
      const file = this.#db.get<{ purged_at: number | null }>(
        "SELECT purged_at FROM library_files WHERE id = ?",
        f.fileId,
      );
      if (!file || file.purged_at !== null)
        throw new Invalid(
          `The link file:${f.fileId} names no Library file. Publish the file with publish_files first, then link it as [name](file:<fileId>).`,
        );
      if (
        f.versionId &&
        !this.#db.get("SELECT 1 AS x FROM library_versions WHERE id = ? AND file_id = ?", f.versionId, f.fileId)
      )
        throw new Invalid(`file:${f.fileId}@${f.versionId} names a version that file does not have.`);
    }
  }
  #parentOk(parentId: string | null, movingId: string | null): void {
    if (parentId === null) return;
    const parent = this.live(parentId);
    if (movingId && this.ancestry(parent.id).some((p) => p.id === movingId))
      throw new Invalid("A page cannot be moved inside itself.");
  }
  #touch(pageId: string, now: number): void {
    this.#db.run(
      `WITH RECURSIVE up(id) AS (SELECT ? UNION SELECT p.parent_id FROM knowledge_pages p JOIN up ON p.id = up.id WHERE p.parent_id IS NOT NULL)
       UPDATE knowledge_pages SET activity_at = MAX(activity_at, ?) WHERE id IN (SELECT id FROM up)`,
      pageId,
      now,
    );
  }
  #index(page: Pick<PageRow, "id" | "title" | "description" | "body" | "metadata_json">): void {
    this.#db.run("DELETE FROM knowledge_fts WHERE page_id = ?", page.id);
    const metadata = JSON.parse(page.metadata_json) as KnowledgeMetadata;
    this.#db.run("DELETE FROM knowledge_page_tags WHERE page_id = ?", page.id);
    for (const label of metadata.tags)
      this.#db.run(
        "INSERT INTO knowledge_page_tags (page_id, tag, label) VALUES (?, ?, ?)",
        page.id,
        tagKey(label),
        label,
      );
    const head = `${page.title}\n${page.description}`;
    const keys = [sectionKey(page.title, "", head)];
    this.#db.run(
      "INSERT INTO knowledge_fts (tokens, page_id, section, path, text) VALUES (?, ?, 0, '', ?)",
      ftsText(`${head} ${page.title} ${metadata.tags.join(" ")}`),
      page.id,
      head,
    );
    for (const c of chunks(page.body)) {
      const path = c.path.join(" › ");
      keys.push(sectionKey(page.title, path, c.text));
      this.#db.run(
        "INSERT INTO knowledge_fts (tokens, page_id, section, path, text) VALUES (?, ?, ?, ?, ?)",
        ftsText(`${page.title} ${c.path.join(" ")} ${c.text}`),
        page.id,
        c.sectionIndex,
        path,
        c.text,
      );
    }
    // Meaning vectors of sections this write changed or removed go with the write; unchanged sections keep theirs.
    this.#db.run(
      "DELETE FROM knowledge_vectors WHERE page_id = ? AND hash NOT IN (SELECT value FROM json_each(?))",
      page.id,
      JSON.stringify(keys),
    );
  }
  #unindex(pageId: string): void {
    this.#db.run("DELETE FROM knowledge_fts WHERE page_id = ?", pageId);
    this.#db.run("DELETE FROM knowledge_vectors WHERE page_id = ?", pageId);
  }
  #link(pageId: string, body: string): void {
    this.#db.run("DELETE FROM knowledge_links WHERE from_id = ?", pageId);
    const found = refs(body);
    for (const id of found.pages)
      if (id !== pageId) this.#db.run("INSERT OR IGNORE INTO knowledge_links VALUES (?, 'page', ?)", pageId, id);
    // A section link adds a `<pageId>#<anchor>` row beside the plain one, which backlinks keep using.
    for (const a of found.anchors)
      if (a.pageId !== pageId)
        this.#db.run("INSERT OR IGNORE INTO knowledge_links VALUES (?, 'page', ?)", pageId, `${a.pageId}#${a.anchor}`);
    for (const f of found.files)
      this.#db.run(
        "INSERT OR IGNORE INTO knowledge_links VALUES (?, 'file', ?)",
        pageId,
        f.versionId ? `${f.fileId}@${f.versionId}` : f.fileId,
      );
  }
  #mergeTaint(page: PageRow, w: Writer): string {
    const labels = new Set<TaintLabel>([...parseTaint(page.taint), ...(w.taint ?? [])]);
    return JSON.stringify([...labels].sort());
  }

  /** Records the page's new state as a revision, coalescing with the latest one when the same writer keeps going. */
  #revise(before: PageRow | undefined, after: PageRow, w: Writer, note: string | null): void {
    const now = after.updated_at;
    const latest = before
      ? this.#db.get<RevisionRow>(
          "SELECT * FROM knowledge_revisions WHERE page_id = ? ORDER BY revision DESC LIMIT 1",
          after.id,
        )
      : undefined;
    const external = (w.taint ?? []).includes("external") ? 1 : 0;
    if (
      latest &&
      latest.actor === w.actor &&
      (latest.session_id ?? null) === (w.sessionId ?? null) &&
      now - latest.created_at < COALESCE_MS &&
      latest.note === null &&
      note === null
    ) {
      this.#db.run(
        `UPDATE knowledge_revisions SET revision = ?, title = ?, description = ?, body = ?, metadata_json = ?, run_id = COALESCE(?, run_id),
           external = MAX(external, ?), updated_at = ? WHERE page_id = ? AND revision = ?`,
        after.revision,
        after.title,
        after.description,
        after.body,
        after.metadata_json,
        w.runId ?? null,
        external,
        now,
        after.id,
        latest.revision,
      );
      return;
    }
    this.#db.run(
      `INSERT INTO knowledge_revisions (page_id, revision, title, description, body, metadata_json, actor, session_id, run_id, external, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      after.id,
      after.revision,
      after.title,
      after.description,
      after.body,
      after.metadata_json,
      w.actor,
      w.sessionId ?? null,
      w.runId ?? null,
      external,
      note,
      now,
      now,
    );
  }

  create(payload: KnowledgeInput & { parentId: string | null }, w: Writer): PageRow {
    const input = { ...inputFields(payload), parentId: payload.parentId };
    return this.store.tx(() => {
      const title = this.#checkTitle(input.title ?? "");
      const description = this.#checkDescription(input.description ?? "");
      const body = (input.body ?? "").replace(/\r\n/g, "\n");
      this.#parentOk(input.parentId, null);
      this.#checkBody(body, null);
      const metadata = validated(() => normalizeMetadata(input.metadata ?? {}));
      const now = this.#now();
      const id = newId("pg", now);
      const taint = JSON.stringify([...new Set<TaintLabel>(["private", ...(w.taint ?? [])])].sort());
      this.#db.run(
        `INSERT INTO knowledge_pages (id, parent_id, title, description, body, metadata_json, revision, taint, created_by, created_at, updated_by, updated_at, activity_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        id,
        input.parentId,
        title,
        description,
        body,
        JSON.stringify(metadata),
        taint,
        w.actor,
        now,
        w.actor,
        now,
        now,
      );
      const row = this.#row(id)!;
      this.#revise(undefined, row, w, "created");
      this.#touch(id, now);
      this.#link(id, body);
      this.#index(row);
      this.#changed(id);
      return this.#row(id)!;
    });
  }

  /**
   * Applies `ops` in order to the page's current state. Every op except append and set_task needs `baseRevision` and
   * is refused when the page has moved on. An agent may only append to a locked page.
   */
  edit(pageId: string, ops: readonly EditOp[], w: Writer, baseRevision?: number): EditResult {
    if (ops.length === 0) throw new Invalid("Give at least one edit operation.");
    if (ops.length > 20) throw new Invalid("At most 20 operations per edit.");
    return this.store.tx(() => {
      const page = this.live(pageId);
      const needsBase = ops.some((o) => !BASELESS.has(o.op));
      if (w.actor !== "user" && page.locked === 1 && ops.some((o) => o.op !== "append"))
        throw new Invalid("The user locked this page for agents: you can only append to it (op: append).");
      if (needsBase && baseRevision === undefined)
        throw new Invalid(
          `This edit needs baseRevision (the page is at revision ${page.revision}); only append and set_task work without it.`,
        );
      if (baseRevision !== undefined && baseRevision !== page.revision) {
        const first = ops.find((o) => "section" in o) as { section: string } | undefined;
        let current = page.body.length > 4_000 ? `${page.body.slice(0, 4_000)}…` : page.body;
        let what = "Current page text follows; reapply your change to it.";
        if (first) {
          try {
            const s = findSectionSafe(page.body, first.section);
            if (s) {
              current = sectionText(page.body, s);
              what = `Current text of "${s.heading || "top"}" follows; reapply your change to it.`;
            }
          } catch {
            /* the full page is the fallback */
          }
        }
        throw new KnowledgeConflict(page.revision, current, what);
      }
      let { title, description, body } = page;
      let metadata = JSON.parse(page.metadata_json) as KnowledgeMetadata;
      let changed: Section | null = null;
      for (const o of ops) {
        switch (o.op) {
          case "set_body":
            body = o.body.replace(/\r\n/g, "\n");
            break;
          case "append":
            if (!o.text?.trim()) throw new Invalid("append needs text.");
            body = appendText(body, o.text);
            break;
          case "append_to_section": {
            const r = appendToSection(body, o.section, o.text ?? "");
            body = r.body;
            changed = r.section;
            break;
          }
          case "replace_section": {
            const r = replaceSection(body, o.section, o.text ?? "");
            body = r.body;
            changed = r.section;
            break;
          }
          case "insert_section_after": {
            const r = insertSectionAfter(body, o.section, o.text ?? "");
            body = r.body;
            changed = null;
            break;
          }
          case "replace_text":
            body = replaceText(body, o.old ?? "", o.new ?? "");
            break;
          case "set_task":
            body = setTask(
              body,
              o.index !== undefined ? { index: o.index } : { ...(o.task !== undefined ? { text: o.task } : {}) },
              !!o.done,
            ).body;
            break;
          case "set_metadata":
            metadata = validated(() => normalizeMetadata(o.metadata));
            break;
          case "add_tags":
            metadata = { tags: validated(() => normalizeTags([...metadata.tags, ...normalizeTags(o.tags)])) };
            break;
          case "remove_tags": {
            const remove = new Set(validated(() => normalizeTags(o.tags)).map(tagKey));
            metadata = { tags: metadata.tags.filter((tag) => !remove.has(tagKey(tag))) };
            break;
          }
          case "set_title":
            title = this.#checkTitle(o.title ?? "");
            break;
          case "set_description":
            description = this.#checkDescription(o.description ?? "");
            break;
          default:
            throw new Invalid(`Unknown edit op "${(o as { op: string }).op}".`);
        }
      }
      w.validateBody?.(body, page.body);
      this.#checkBody(body, page.id);
      if (
        title === page.title &&
        description === page.description &&
        body === page.body &&
        JSON.stringify(metadata) === page.metadata_json
      )
        return { page, changed: null };
      const now = this.#now();
      const revision = page.revision + 1;
      this.#db.run(
        "UPDATE knowledge_pages SET title = ?, description = ?, body = ?, metadata_json = ?, revision = ?, taint = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        title,
        description,
        body,
        JSON.stringify(metadata),
        revision,
        this.#mergeTaint(page, w),
        w.actor,
        now,
        page.id,
      );
      const after = this.#row(page.id)!;
      this.#revise(page, after, w, null);
      this.#touch(page.id, now);
      this.#link(page.id, body);
      this.#index(after);
      this.#changed(page.id);
      let changedText: string | null = null;
      if (changed) {
        const again = findSectionSafe(body, changed.heading || "top");
        if (again) changedText = sectionText(body, again);
      }
      return { page: after, changed: changedText };
    });
  }

  /** The user's editor: the whole title, description and body at once, against the revision the editor opened. */
  replace(pageId: string, payload: KnowledgeInput, baseRevision: number, w: Writer): PageRow {
    const input = inputFields(payload);
    return this.store.tx(() => {
      const page = this.live(pageId);
      if (baseRevision !== page.revision)
        throw new KnowledgeConflict(page.revision, page.body, "Reload the page and reapply your change.");
      const ops: EditOp[] = [];
      if (input.metadata !== undefined)
        ops.push({ op: "set_metadata", metadata: validated(() => normalizeMetadata(input.metadata)) });
      if (input.title !== undefined) ops.push({ op: "set_title", title: input.title });
      if (input.description !== undefined) ops.push({ op: "set_description", description: input.description });
      if (input.body !== undefined && input.body.replace(/\r\n/g, "\n") !== page.body)
        ops.push({ op: "set_body", body: input.body });
      if (ops.length === 0) return page;
      return this.edit(pageId, ops, w, baseRevision).page;
    });
  }

  move(pageId: string, parentId: string | null, w: Writer): PageRow {
    return this.store.tx(() => {
      const page = this.live(pageId);
      if (page.system === INBOX) throw new Invalid("Inbox stays at the top level.");
      if (w.actor !== "user" && page.locked === 1)
        throw new Invalid("The user locked this page for agents; it cannot be moved.");
      if (parentId === page.parent_id) return page;
      this.#parentOk(parentId, page.id);
      const now = this.#now();
      this.#db.run(
        "UPDATE knowledge_pages SET parent_id = ?, taint = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        parentId,
        w.taint?.length ? this.#mergeTaint(page, w) : page.taint,
        w.actor,
        now,
        page.id,
      );
      this.#touch(page.id, now);
      this.#changed(page.id);
      return this.#row(page.id)!;
    });
  }

  /** Moves the page and its live subtree to Trash, as one action that a restore undoes. */
  trashPage(pageId: string, w: Writer, validateSubtree?: (pages: readonly PageRow[]) => void): number {
    return this.store.tx(() => {
      const page = this.live(pageId);
      if (page.system === INBOX) throw new Invalid("Inbox cannot be moved to Trash.");
      if (w.actor !== "user" && page.locked === 1)
        throw new Invalid("The user locked this page for agents; it cannot be trashed.");
      const pages = [page, ...this.#descendants(page.id)];
      validateSubtree?.(pages);
      if (pages.some((p) => p.system === INBOX)) throw new Invalid("Inbox cannot be moved to Trash.");
      const now = this.#now();
      for (const p of pages) {
        if (w.taint?.length) {
          this.#db.run(
            "UPDATE knowledge_pages SET trashed_at = ?, trash_root = ?, taint = ?, updated_by = ?, updated_at = ? WHERE id = ?",
            now,
            page.id,
            this.#mergeTaint(p, w),
            w.actor,
            now,
            p.id,
          );
        } else {
          this.#db.run("UPDATE knowledge_pages SET trashed_at = ?, trash_root = ? WHERE id = ?", now, page.id, p.id);
        }
        this.#unindex(p.id);
      }
      this.#changed(page.id);
      return pages.length;
    });
  }

  /** Brings back one trash action; under its old parent if that is live, otherwise at the top level. */
  restorePage(pageId: string): PageRow {
    return this.store.tx(() => {
      const page = this.#row(pageId);
      if (!page || page.trashed_at === null || page.trash_root !== page.id)
        throw notFound("That page is not in Trash.");
      const parent = page.parent_id ? this.#row(page.parent_id) : undefined;
      const parentId = parent && parent.trashed_at === null ? parent.id : null;
      const group = this.#db.all<PageRow>("SELECT * FROM knowledge_pages WHERE trash_root = ?", page.id);
      for (const p of group) {
        this.#db.run("UPDATE knowledge_pages SET trashed_at = NULL, trash_root = NULL WHERE id = ?", p.id);
        this.#index(p);
      }
      this.#db.run("UPDATE knowledge_pages SET parent_id = ? WHERE id = ?", parentId, page.id);
      this.#touch(page.id, this.#now());
      this.#changed(page.id);
      return this.#row(page.id)!;
    });
  }

  /** Deletes a trash action for good: the pages, their revisions, links and index rows. */
  purge(pageId: string): number {
    return this.store.tx(() => {
      const page = this.#row(pageId);
      if (!page || page.trashed_at === null || page.trash_root !== page.id)
        throw new Invalid("Only a page in Trash can be deleted permanently.");
      const group = this.#db.all<{ id: string }>("SELECT id FROM knowledge_pages WHERE trash_root = ?", page.id);
      // Anything still parented under these (trashed separately, earlier) moves to the top so it is not orphaned.
      for (const g of group) {
        this.#db.run(
          "UPDATE knowledge_pages SET parent_id = NULL WHERE parent_id = ? AND (trash_root IS NULL OR trash_root <> ?)",
          g.id,
          page.id,
        );
        this.#db.run("DELETE FROM knowledge_revisions WHERE page_id = ?", g.id);
        this.#db.run("DELETE FROM knowledge_links WHERE from_id = ?", g.id);
        this.#db.run("DELETE FROM knowledge_mcp_token_roots WHERE page_id = ?", g.id);
        this.#unindex(g.id);
        this.#db.run("DELETE FROM knowledge_pages WHERE id = ?", g.id);
      }
      this.#changed(null);
      return group.length;
    });
  }

  /** Trash older than 30 days. Run with the other periodic sweeps. */
  purgeExpired(): number {
    const cutoff = this.#now() - TRASH_KEEP_MS;
    let n = 0;
    for (const r of this.#db.all<{ id: string }>(
      "SELECT id FROM knowledge_pages WHERE trashed_at IS NOT NULL AND trashed_at < ? AND trash_root = id",
      cutoff,
    ))
      n += this.purge(r.id);
    return n;
  }

  /** Lock for agents / pin: the user's switches. Neither is a revision. */
  setFlags(pageId: string, flags: { locked?: boolean; pinned?: boolean }): PageRow {
    return this.store.tx(() => {
      const page = this.live(pageId);
      if (flags.locked !== undefined)
        this.#db.run("UPDATE knowledge_pages SET locked = ? WHERE id = ?", flags.locked ? 1 : 0, page.id);
      if (flags.pinned !== undefined)
        this.#db.run("UPDATE knowledge_pages SET pinned = ? WHERE id = ?", flags.pinned ? 1 : 0, page.id);
      this.#changed(page.id);
      return this.#row(page.id)!;
    });
  }

  /** Makes an old revision current again, as a new revision (history is never rewritten). */
  restoreRevision(pageId: string, revision: number, baseRevision: number, w: Writer): PageRow {
    return this.store.tx(() => {
      const old = this.revision(pageId, revision);
      if (!old) throw notFound("There is no such revision.");
      const page = this.live(pageId);
      if (w.actor !== "user" && page.locked === 1)
        throw new Invalid("The user locked this page for agents: only append is allowed.");
      if (baseRevision !== page.revision)
        throw new KnowledgeConflict(page.revision, page.body, "Reload the page before restoring.");
      const body = old.body;
      this.#checkBody(body, page.id);
      const now = this.#now();
      this.#db.run(
        "UPDATE knowledge_pages SET title = ?, description = ?, body = ?, metadata_json = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        old.title,
        old.description,
        body,
        old.metadata_json,
        page.revision + 1,
        w.actor,
        now,
        page.id,
      );
      const after = this.#row(page.id)!;
      this.#revise(page, after, w, `restored revision ${revision}`);
      this.#touch(page.id, now);
      this.#link(page.id, body);
      this.#index(after);
      this.#changed(page.id);
      return after;
    });
  }

  /** Up to three live pages whose titles share most of their words with `title`: a hint against duplicates. */
  similar(title: string, excludeId?: string): PageRow[] {
    const want = new Set(bigramTokens(title));
    if (want.size === 0) return [];
    const scored: { row: PageRow; score: number }[] = [];
    for (const row of this.#db.all<PageRow>("SELECT * FROM knowledge_pages WHERE trashed_at IS NULL")) {
      if (row.id === excludeId) continue;
      const have = new Set(bigramTokens(row.title));
      let shared = 0;
      for (const t of want) if (have.has(t)) shared++;
      const score = shared / Math.max(1, Math.min(want.size, have.size));
      if (shared > 0 && score >= 0.6) scored.push({ row, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || b.row.activity_at - a.row.activity_at)
      .slice(0, 3)
      .map((s) => s.row);
  }

  // ---- search ------------------------------------------------------------------------------------------------------

  /** Keyword search over live page sections (Rei's CJK-aware tokens), best section per page, optionally in a subtree. */
  search(query: string, options: KnowledgeSearchOptions = {}): KnowledgeSearchHit[] {
    const limit = Math.max(1, Math.min(options.limit ?? 8, 30));
    const allowed = this.searchPages(options);
    if (allowed && allowed.size === 0) return [];
    if (!query.trim())
      return this.#db
        .all<PageRow>("SELECT * FROM knowledge_pages WHERE trashed_at IS NULL ORDER BY updated_at DESC, id DESC")
        .filter((p) => !allowed || allowed.has(p.id))
        .slice(0, limit)
        .map((p) => this.hitFor({ pageId: p.id, section: 0, path: "", text: p.description }, "", []));
    return this.keywordSections(query, allowed, limit).map((s) => this.hitFor(s, query, ["keyword"]));
  }

  /**
   * What agents and the search box use: keyword and meaning rankings fused when meaning search runs, keyword alone
   * otherwise (and whenever the model does not answer).
   */
  async find(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeSearchHit[]> {
    if (!this.meaning || !query.trim()) return this.search(query, options);
    return this.meaning.search(query, options);
  }

  /** The live pages a search may return: everything (undefined), or one page and its live subtree. */
  subtree(under: string | undefined): Set<string> | undefined {
    if (!under) return undefined;
    const root = this.live(under);
    return new Set([root.id, ...this.#descendants(root.id).map((p) => p.id)]);
  }

  /** Recomputed after asynchronous embedding too: SQLite owns liveness, subtree, tag and token-scope membership. */
  searchPages(options: KnowledgeSearchOptions): Set<string> | undefined {
    const scope = options.allowedPageIds;
    if (scope !== undefined && scope.size === 0) return new Set();
    const under = this.subtree(options.under);
    const allowed = scope ? (under ? new Set([...under].filter((id) => scope.has(id))) : new Set(scope)) : under;
    if (allowed !== undefined && allowed.size === 0) return allowed;
    const tags = validated(() => normalizeTags(options.tags ?? [])).map(tagKey);
    if (!tags.length) return allowed;
    const rows = this.#db.all<{ id: string }>(
      `SELECT p.id FROM knowledge_pages p WHERE p.trashed_at IS NULL AND
      (SELECT COUNT(*) FROM knowledge_page_tags t WHERE t.page_id = p.id AND t.tag IN (SELECT value FROM json_each(?))) = ?`,
      JSON.stringify(tags),
      tags.length,
    );
    return new Set(rows.filter((r) => !allowed || allowed.has(r.id)).map((r) => r.id));
  }
  tagSuggestions(): string[] {
    const rows = this.#db.all<{ tag: string; label: string }>(
      `SELECT t.tag, t.label FROM knowledge_page_tags t JOIN knowledge_pages p ON p.id = t.page_id WHERE p.trashed_at IS NULL ORDER BY p.updated_at DESC, p.id DESC`,
    );
    return [...new Map(rows.map((r) => [r.tag, r.label])).values()].sort((a, b) => a.localeCompare(b));
  }

  /** The keyword ranking, best section per live page, best first. */
  keywordSections(query: string, allowed: Set<string> | undefined, limit: number): KnowledgeSection[] {
    const expr = knowledgeMatchExpr(query);
    if (!expr) return [];
    const rows = this.#db.all<{ page_id: string; section: number; path: string; text: string; score: number }>(
      `SELECT page_id, section, path, text, bm25(knowledge_fts) AS score FROM knowledge_fts
       WHERE knowledge_fts MATCH ? AND page_id IN (SELECT id FROM knowledge_pages WHERE trashed_at IS NULL)
       ${allowed ? "AND page_id IN (SELECT value FROM json_each(?))" : ""} ORDER BY score`,
      expr,
      ...(allowed ? [JSON.stringify([...allowed])] : []),
    );
    const seen = new Set<string>();
    const out: KnowledgeSection[] = [];
    for (const r of rows) {
      if (seen.has(r.page_id) || (allowed && !allowed.has(r.page_id))) continue;
      const page = this.#row(r.page_id);
      if (!page || page.trashed_at !== null) continue;
      seen.add(r.page_id);
      out.push({ pageId: r.page_id, section: r.section, path: r.path, text: r.text });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Every indexed section of the live pages, with the key its meaning vector is stored under. */
  indexedSections(pageIds?: readonly string[]): (KnowledgeSection & { key: string; title: string })[] {
    const rows = this.#db.all<{ page_id: string; section: number; path: string; text: string; title: string }>(
      `SELECT f.page_id, f.section, f.path, f.text, p.title FROM knowledge_fts f
         JOIN knowledge_pages p ON p.id = f.page_id AND p.trashed_at IS NULL
        ${pageIds ? "WHERE f.page_id IN (SELECT value FROM json_each(?))" : ""}`,
      ...(pageIds ? [JSON.stringify(pageIds)] : []),
    );
    return rows.map((r) => ({
      pageId: r.page_id,
      section: r.section,
      path: r.path,
      text: r.text,
      title: r.title,
      key: sectionKey(r.title, r.path, r.text),
    }));
  }

  /** A search hit for one section, the snippet around the query's terms (or the section's start). */
  hitFor(s: KnowledgeSection, query: string, matched: KnowledgeSearchHit["matched"]): KnowledgeSearchHit {
    const page = this.live(s.pageId);
    return {
      pageId: page.id,
      title: page.title,
      path: this.path(page.id),
      section: s.path,
      snippet: snippet(s.text, [...new Set(bigramTokens(query))]),
      updatedAt: page.updated_at,
      matched,
    };
  }

  /** Rebuilds the keyword index from the pages (startup, if it is missing rows). */
  reindexAll(): void {
    this.store.tx(() => {
      this.#db.run("DELETE FROM knowledge_fts");
      this.#db.run(
        "DELETE FROM knowledge_vectors WHERE page_id NOT IN (SELECT id FROM knowledge_pages WHERE trashed_at IS NULL)",
      );
      for (const p of this.#db.all<PageRow>("SELECT * FROM knowledge_pages WHERE trashed_at IS NULL")) this.#index(p);
    });
  }
  indexLooksEmpty(): boolean {
    const pages = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_pages WHERE trashed_at IS NULL")!.n;
    if (pages === 0) return false;
    const indexed = this.#db.get<{ n: number }>("SELECT COUNT(DISTINCT page_id) AS n FROM knowledge_fts")!.n;
    return indexed < pages;
  }

  // ---- summaries ---------------------------------------------------------------------------------------------------

  /** The prompt pointer: top-level pages, then pinned and recently updated pages at any depth. About 500 tokens at most. */
  pointer(now: number): string {
    const top = this.children(null, 10);
    if (top.length === 0) return "";
    const lines = [
      "Knowledge — shared long-term pages (read and write with the knowledge_* tools):",
      `Top level: ${top.map((p) => (p.description ? `${p.title} (${p.id}) — ${clip(p.description, 80)}` : `${p.title} (${p.id})`)).join(" · ")}`,
    ];
    const pinned = this.#db.all<PageRow>(
      "SELECT * FROM knowledge_pages WHERE pinned = 1 AND trashed_at IS NULL ORDER BY updated_at DESC LIMIT 5",
    );
    const recent = this.#db.all<PageRow>(
      "SELECT * FROM knowledge_pages WHERE trashed_at IS NULL AND system IS NULL ORDER BY updated_at DESC LIMIT 12",
    );
    const listed = new Set<string>();
    const entries: string[] = [];
    for (const p of [...pinned, ...recent]) {
      if (listed.has(p.id) || entries.length >= 8 + pinned.length) continue;
      listed.add(p.id);
      entries.push(
        `- ${p.pinned === 1 ? "📌 " : ""}${this.path(p.id)} (${p.id}) · ${age(now - p.updated_at)} by ${this.actorName(p.updated_by)}`,
      );
    }
    if (entries.length > 0) lines.push("Pinned and recently updated:", ...entries);
    let text = lines.join("\n");
    while (estimateTokens(text) > 550 && lines.length > 3) {
      lines.pop();
      text = lines.join("\n");
    }
    return text;
  }

  overview(now: number): KnowledgeOverview {
    const weekAgo = now - 7 * 86_400_000;
    const inbox = this.ensureInbox();
    const activity = this.#db.all<{ actor: string; created: number; edited: number }>(
      `SELECT actor, SUM(CASE WHEN note = 'created' THEN 1 ELSE 0 END) AS created,
              COUNT(DISTINCT CASE WHEN note IS NULL OR note <> 'created' THEN page_id END) AS edited
       FROM knowledge_revisions WHERE updated_at >= ? GROUP BY actor ORDER BY created + edited DESC`,
      weekAgo,
    );
    const toNode = (row: PageRow) => this.#node(row);
    return {
      pinned: this.#db
        .all<PageRow>("SELECT * FROM knowledge_pages WHERE pinned = 1 AND trashed_at IS NULL ORDER BY updated_at DESC")
        .map(toNode),
      recent: this.#db
        .all<PageRow>("SELECT * FROM knowledge_pages WHERE trashed_at IS NULL ORDER BY updated_at DESC LIMIT 12")
        .map((row) => ({ ...toNode(row), path: this.path(row.id) })),
      week: activity.map((a) => ({ actor: this.#actor(a.actor), created: a.created, edited: a.edited })),
      inbox: {
        id: inbox.id,
        count: this.childCount(inbox.id),
        newest: this.children(inbox.id, 5).map(toNode),
      },
      external: this.#db
        .all<PageRow>(
          `SELECT * FROM knowledge_pages WHERE trashed_at IS NULL AND taint LIKE '%"external"%' ORDER BY updated_at DESC LIMIT 10`,
        )
        .map((row) => ({ ...toNode(row), path: this.path(row.id) })),
      locked: this.#db
        .all<PageRow>("SELECT * FROM knowledge_pages WHERE trashed_at IS NULL AND locked = 1 ORDER BY updated_at DESC")
        .map(toNode),
      trashCount: this.#db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM knowledge_pages WHERE trashed_at IS NOT NULL AND trash_root = id",
      )!.n,
      pageCount: this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_pages WHERE trashed_at IS NULL")!.n,
      meaning: this.meaning?.status() ?? { state: "off", sections: 0, embedded: 0, lastError: null },
    };
  }
}

function findSectionSafe(body: string, ref: string): Section | undefined {
  try {
    return findSection(body, ref);
  } catch {
    return undefined;
  }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (w < 9) return `${w}w ago`;
  return `${Math.round(d / 30)}mo ago`;
}

/** About 160 characters around the first matching term. */
function snippet(text: string, terms: string[]): string {
  // A section starts with its heading line; its "##" reads as noise in a one-line snippet.
  const flat = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at - 50);
  const out = flat.slice(start, start + 160);
  return `${start > 0 ? "…" : ""}${out}${start + 160 < flat.length ? "…" : ""}`;
}
