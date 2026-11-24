// The pages web_fetch has read, kept per agent: a page is fetched once and then re-read (another slice, later a section
// or passages) from here without the network, across that agent's sessions and restarts. Another agent never sees
// them: which URLs an agent read can carry private data.
//
// Bounded three ways: a time to live (default 24 hours), a number of pages and a number of characters per agent (least
// recently used out first). Expired rows are dropped on every write and by `purgeExpired` on start. Rows also go with
// their agent (AppStore.removeAgentRows) and with the session that last fetched them (AppStore.purgeSessions).
// Readable text only, never raw HTML; never written to traces, memory or retrieval. Portable: the app store's Db.

import type { ReadExtractor } from "@rei/protocol";
import type { Db } from "../db/db.ts";
import { ftsText, matchExpr, queryTerms } from "../memory/keyword.ts";
import { sha256Hex } from "../util/encoding.ts";
import { newId } from "../util/ids.ts";
import type { CachedPage } from "./cache.ts";
import {
  countTokens,
  PASSAGE_BUDGET_TOKENS,
  type Passage,
  passagesOf,
  type RankedPassage,
  type Selection,
  selectPassages,
} from "./passages.ts";
import type { Section } from "./sections.ts";
import type { PageQuality } from "./types.ts";

export const DOCUMENT_TTL_MS = 24 * 60 * 60_000;
export const MAX_DOCUMENTS_PER_AGENT = 200;
/** About 40 MB of UTF-8 for Latin text; one page is at most 2,000,000 characters (extract.ts). */
export const MAX_CHARS_PER_AGENT = 20_000_000;

export interface WebDocument extends CachedPage {
  id: string;
  agentId: string;
  /** The address asked for (the key); `url` is where it ended up after redirects. */
  requestedUrl: string;
  quality: PageQuality;
  extractor: ReadExtractor;
  sections: Section[];
  /** SHA-256 of the text: the same page fetched again is the same document (passages need no new index). */
  contentHash: string;
  fetchedAt: number;
  expiresAt: number;
}

interface Row {
  id: string;
  agent_id: string;
  url: string;
  final_url: string;
  title: string;
  text: string;
  note: string | null;
  quality: string;
  extractor: string;
  method: string;
  sections_json: string;
  content_hash: string;
  fetched_at: number;
  expires_at: number;
}

/** Heading matches count this much more than body matches in bm25. */
const HEADING_WEIGHT = 3.0;
/** Ranked passages considered for a selection. */
const MAX_CANDIDATES = 60;

interface PassageRow {
  ord: number;
  section_id: string;
  heading_path: string;
  start: number;
  end: number;
  tokens: number;
}

const fromPassageRow = (r: PassageRow): Passage => ({
  ord: r.ord,
  sectionId: r.section_id,
  path: JSON.parse(r.heading_path) as string[],
  start: r.start,
  end: r.end,
  tokens: r.tokens,
});

const fromRow = (r: Row): WebDocument => ({
  id: r.id,
  agentId: r.agent_id,
  requestedUrl: r.url,
  url: r.final_url,
  title: r.title,
  text: r.text,
  ...(r.note !== null ? { note: r.note } : {}),
  quality: r.quality as PageQuality,
  extractor: r.extractor as ReadExtractor,
  method: r.method === "render" ? "render" : "http",
  sections: JSON.parse(r.sections_json) as Section[],
  contentHash: r.content_hash,
  fetchedAt: r.fetched_at,
  expiresAt: r.expires_at,
});

export interface DocumentStoreOptions {
  ttlMs?: number;
  maxDocuments?: number;
  maxChars?: number;
}

export class WebDocumentStore {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #maxDocuments: number;
  readonly #maxChars: number;

  constructor(db: Db, now: () => number, options: DocumentStoreOptions = {}) {
    this.#db = db;
    this.#now = now;
    this.#ttl = options.ttlMs ?? DOCUMENT_TTL_MS;
    this.#maxDocuments = options.maxDocuments ?? MAX_DOCUMENTS_PER_AGENT;
    this.#maxChars = options.maxChars ?? MAX_CHARS_PER_AGENT;
  }

  /** The agent's fresh copy of `url`, marked as just used; undefined when there is none or it has expired. */
  get(agentId: string, url: string): WebDocument | undefined {
    const now = this.#now();
    const row = this.#db.get<Row>(
      "SELECT * FROM web_documents WHERE agent_id = ? AND url = ? AND expires_at > ?",
      agentId,
      url,
      now,
    );
    if (!row) return undefined;
    this.#db.run("UPDATE web_documents SET used_at = ? WHERE id = ?", now, row.id);
    return fromRow(row);
  }

  /** Whether the agent has a fresh copy of `url` (does not count as a use). */
  has(agentId: string, url: string): boolean {
    return (
      this.#db.get<{ n: number }>(
        "SELECT 1 AS n FROM web_documents WHERE agent_id = ? AND url = ? AND expires_at > ?",
        agentId,
        url,
        this.#now(),
      ) !== undefined
    );
  }

  /**
   * Keeps what a fetch of `url` read, for the agent, replacing an older copy (it keeps its id); then drops the agent's
   * expired pages and the least recently used beyond the caps. Returns the stored document.
   */
  async put(agentId: string, sessionId: string, url: string, page: CachedPage): Promise<WebDocument> {
    const contentHash = await sha256Hex(page.text);
    const now = this.#now();
    const sections = page.sections ?? [];
    return this.#db.transaction(() => {
      const before = this.#db.get<{ id: string; content_hash: string }>(
        "SELECT id, content_hash FROM web_documents WHERE agent_id = ? AND url = ?",
        agentId,
        url,
      );
      this.#db.run(
        `INSERT INTO web_documents (id, agent_id, session_id, url, final_url, title, text, note, quality, extractor,
           method, sections_json, content_hash, chars, fetched_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, url) DO UPDATE SET session_id = excluded.session_id, final_url = excluded.final_url,
           title = excluded.title, text = excluded.text, note = excluded.note, quality = excluded.quality,
           extractor = excluded.extractor, method = excluded.method, sections_json = excluded.sections_json, content_hash = excluded.content_hash,
           chars = excluded.chars, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at,
           used_at = excluded.used_at`,
        newId("wdoc", now),
        agentId,
        sessionId,
        url,
        page.url,
        page.title,
        page.text,
        page.note ?? null,
        page.quality ?? "success",
        page.extractor ?? "text",
        page.method ?? "http",
        JSON.stringify(sections),
        contentHash,
        page.text.length,
        now,
        now + this.#ttl,
        now,
      );
      this.#prune(agentId, now);
      const row = this.#db.get<Row>("SELECT * FROM web_documents WHERE agent_id = ? AND url = ?", agentId, url);
      // The same text keeps its passages; new text is cut and indexed again.
      if (row && (before?.content_hash !== contentHash || !this.#hasPassages(row.id))) {
        this.#db.run("DELETE FROM web_passages WHERE document_id = ?", row.id);
        this.#index(row.id, page.title, page.text, sections);
      }
      // The page itself can be over the character cap alone: then it is not kept, and the caller still has it.
      return row ? fromRow(row) : this.#unsaved(agentId, url, page, contentHash, sections, now);
    });
  }

  /** The document's passages, in page order. */
  passages(documentId: string): Passage[] {
    return this.#db
      .all<PassageRow>("SELECT * FROM web_passages WHERE document_id = ? ORDER BY ord", documentId)
      .map(fromPassageRow);
  }

  /**
   * The document's passages that best match `query`, within `budget` o200k tokens (passages.ts selectPassages), and which
   * query terms they contain. No passage matches: an empty selection.
   */
  search(
    doc: WebDocument,
    query: string,
    budget: number = PASSAGE_BUDGET_TOKENS,
  ): Selection & { termsFound: number; terms: number } {
    const expr = matchExpr(query);
    const terms = queryTerms(query);
    if (!expr) return { passages: [], moreSections: [], termsFound: 0, terms: 0 };
    const ranked = this.#db
      .all<PassageRow & { score: number }>(
        `SELECT p.*, bm25(web_passages_fts, ${HEADING_WEIGHT}, 1.0) AS score FROM web_passages_fts
           JOIN web_passages p ON p.id = web_passages_fts.rowid
         WHERE web_passages_fts MATCH ? AND p.document_id = ?
         ORDER BY score LIMIT ${MAX_CANDIDATES}`,
        expr,
        doc.id,
      )
      .map((r): RankedPassage => ({ ...fromPassageRow(r), score: r.score }));
    const selection = selectPassages(ranked, (p) => countTokens(doc.text.slice(p.start, p.end)), budget);
    const shown = new Set(selection.passages.flatMap((p) => ftsText(doc.text.slice(p.start, p.end)).split(" ")));
    return { ...selection, termsFound: terms.filter((t) => shown.has(t)).length, terms: terms.length };
  }

  /** Remembers which document a web_fetch call read, for the trace (its chip and "open the stored copy"). Idempotent. */
  recordCall(sessionId: string, callId: string, doc: WebDocument): void {
    this.#db.run(
      "INSERT OR REPLACE INTO web_calls (key, session_id, document_id, title, url, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      `${sessionId}:${callId}`,
      sessionId,
      doc.id,
      doc.title,
      doc.url,
      this.#now(),
    );
  }

  /** The page a call read: its title and final URL, kept after the document itself expires. */
  callOf(sessionId: string, callId: string): { documentId: string; title: string; url: string } | undefined {
    const row = this.#db.get<{ document_id: string; title: string; url: string }>(
      "SELECT document_id, title, url FROM web_calls WHERE key = ?",
      `${sessionId}:${callId}`,
    );
    return row ? { documentId: row.document_id, title: row.title, url: row.url } : undefined;
  }

  /** A stored document by id, fresh or not (people may look at what the agent read until it is dropped). */
  byId(id: string): WebDocument | undefined {
    const row = this.#db.get<Row>("SELECT * FROM web_documents WHERE id = ?", id);
    return row ? fromRow(row) : undefined;
  }

  /** Drops every expired page (on start; writes drop their own agent's). Returns how many. */
  purgeExpired(): number {
    return this.#db.run("DELETE FROM web_documents WHERE expires_at <= ?", this.#now()).changes;
  }

  /** The agent's pages, most recently used first (for tests and diagnostics; text left out). */
  list(agentId: string): { url: string; chars: number; usedAt: number; expiresAt: number }[] {
    return this.#db
      .all<{ url: string; chars: number; used_at: number; expires_at: number }>(
        "SELECT url, chars, used_at, expires_at FROM web_documents WHERE agent_id = ? ORDER BY used_at DESC, rowid DESC",
        agentId,
      )
      .map((r) => ({ url: r.url, chars: r.chars, usedAt: r.used_at, expiresAt: r.expires_at }));
  }

  #hasPassages(documentId: string): boolean {
    return this.#db.get("SELECT 1 AS n FROM web_passages WHERE document_id = ? LIMIT 1", documentId) !== undefined;
  }

  /** The heading column holds the page title and the passage's heading path: both say what every line under them is about. */
  #index(documentId: string, title: string, text: string, sections: Section[]): void {
    for (const p of passagesOf(text, sections)) {
      this.#db.run(
        "INSERT INTO web_passages (document_id, ord, section_id, heading_path, start, end, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
        documentId,
        p.ord,
        p.sectionId,
        JSON.stringify(p.path),
        p.start,
        p.end,
        p.tokens,
      );
      const { id } = this.#db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!;
      this.#db.run(
        "INSERT INTO web_passages_fts (rowid, heading, body) VALUES (?, ?, ?)",
        id,
        ftsText([title, ...p.path].join(" ")),
        ftsText(text.slice(p.start, p.end)),
      );
    }
  }

  #prune(agentId: string, now: number): void {
    this.#db.run("DELETE FROM web_documents WHERE agent_id = ? AND expires_at <= ?", agentId, now);
    const rows = this.#db.all<{ id: string; chars: number }>(
      "SELECT id, chars FROM web_documents WHERE agent_id = ? ORDER BY used_at DESC, rowid DESC",
      agentId,
    );
    let count = 0;
    let chars = 0;
    const drop: string[] = [];
    // Most recent first: keep each page that still fits; one too big on its own is dropped without pushing others out.
    for (const r of rows) {
      if (count + 1 > this.#maxDocuments || chars + r.chars > this.#maxChars) {
        drop.push(r.id);
        continue;
      }
      count++;
      chars += r.chars;
    }
    if (drop.length > 0)
      this.#db.run("DELETE FROM web_documents WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(drop));
  }

  #unsaved(
    agentId: string,
    url: string,
    page: CachedPage,
    contentHash: string,
    sections: Section[],
    now: number,
  ): WebDocument {
    return {
      ...page,
      id: "",
      agentId,
      requestedUrl: url,
      quality: page.quality ?? "success",
      extractor: page.extractor ?? "text",
      sections,
      contentHash,
      fetchedAt: now,
      expiresAt: now,
    };
  }
}
