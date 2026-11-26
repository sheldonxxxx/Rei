import type {
  CreateKnowledgeMcpTokenRequest,
  KnowledgeMcpAllowedPage,
  KnowledgeMcpSecretResponse,
  KnowledgeMcpToken,
  UpdateKnowledgeMcpTokenRequest,
} from "@rei/protocol";
import type { Db } from "../db/db.ts";
import type { Clock } from "../util/clock.ts";
import { randomBytes, sha256Hex, toBase64Url } from "../util/encoding.ts";
import { badRequest, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import type { Logger } from "../util/log.ts";
import type { KnowledgeService, PageRow } from "./service.ts";

export const KNOWLEDGE_MCP_TOKEN_PREFIX = "rei_kmcp_";
export const KNOWLEDGE_MCP_ENDPOINT_PATH = "/api/mcp/knowledge";
const SLIDE_AFTER_MS = 60_000;
const NAME_MAX_CHARS = 80;
const MAX_ALLOWED_ROOTS = 100;

interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  can_read: number;
  can_write: number;
  can_delete: number;
  disabled_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export interface AuthenticatedMcpToken {
  id: string;
  name: string;
  tokenPrefix: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface KnowledgeMcpScope {
  /** All configured root page IDs on the token (including any trashed or missing pages). */
  grantedRootIds: Set<string>;
  /** Configured root page IDs that currently exist and are live. */
  liveRootIds: Set<string>;
  /** Live root page IDs not descended from another live root on this token, ordered by activity. */
  effectiveRootIds: string[];
  /** Union of every live root and all of its live descendants. */
  allowedPageIds: Set<string>;
}

export interface KnowledgeMcpTokenStoreDeps {
  db: Db;
  knowledge: KnowledgeService;
  clock: Clock;
  log: Logger;
}

function validateName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "" || [...name].length > NAME_MAX_CHARS)
    throw badRequest("bad_request", `Token name must be 1 to ${NAME_MAX_CHARS} characters.`);
  return name;
}

function normalizeRootIds(raw: readonly string[] | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of raw) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!trimmed) throw badRequest("bad_request", "Allowed folder IDs must be non-empty strings.");
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  if (out.length > MAX_ALLOWED_ROOTS)
    throw badRequest("bad_request", `At most ${MAX_ALLOWED_ROOTS} allowed folders may be assigned per token.`);
  return out;
}

async function generateSecret(): Promise<{ secret: string; hash: string; prefix: string }> {
  const secret = `${KNOWLEDGE_MCP_TOKEN_PREFIX}${toBase64Url(randomBytes(32))}`;
  const hash = await sha256Hex(secret);
  const prefix = secret.slice(0, 15);
  return { secret, hash, prefix };
}

export class KnowledgeMcpTokenStore {
  readonly #db: Db;
  readonly #knowledge: KnowledgeService;
  readonly #clock: Clock;
  readonly #log: Logger;

  constructor(deps: KnowledgeMcpTokenStoreDeps) {
    this.#db = deps.db;
    this.#knowledge = deps.knowledge;
    this.#clock = deps.clock;
    this.#log = deps.log;
    this.#knowledge.mcpActorLabel = (tokenId) => this.actorLabel(tokenId);
  }

  #activeRow(id: string): TokenRow {
    const row = this.#db.get<TokenRow>("SELECT * FROM knowledge_mcp_tokens WHERE id = ? AND revoked_at IS NULL", id);
    if (!row) throw notFound("That Knowledge MCP token does not exist.");
    return row;
  }

  #rootIds(tokenId: string): string[] {
    return this.#db
      .all<{ page_id: string }>(
        "SELECT page_id FROM knowledge_mcp_token_roots WHERE token_id = ? ORDER BY created_at ASC, page_id ASC",
        tokenId,
      )
      .map((r) => r.page_id);
  }

  #resolveAllowedPage(pageId: string): KnowledgeMcpAllowedPage {
    const page = this.#knowledge.page(pageId);
    if (!page) return { pageId, title: null, path: null, status: "missing" };
    if (page.trashed_at !== null)
      return { pageId, title: page.title, path: this.#knowledge.path(page.id), status: "trashed" };
    return { pageId, title: page.title, path: this.#knowledge.path(page.id), status: "live" };
  }

  #toToken(row: TokenRow): KnowledgeMcpToken {
    return {
      id: row.id,
      name: row.name,
      tokenPrefix: row.token_prefix,
      enabled: row.disabled_at === null,
      permissions: {
        read: row.can_read === 1,
        write: row.can_write === 1,
        delete: row.can_delete === 1,
      },
      allowedPages: this.#rootIds(row.id).map((id) => this.#resolveAllowedPage(id)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    };
  }

  list(): KnowledgeMcpToken[] {
    return this.#db
      .all<TokenRow>("SELECT * FROM knowledge_mcp_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC, id DESC")
      .map((row) => this.#toToken(row));
  }

  get(id: string): KnowledgeMcpToken | undefined {
    const row = this.#db.get<TokenRow>("SELECT * FROM knowledge_mcp_tokens WHERE id = ? AND revoked_at IS NULL", id);
    return row ? this.#toToken(row) : undefined;
  }

  async create(input: CreateKnowledgeMcpTokenRequest): Promise<KnowledgeMcpSecretResponse> {
    const name = validateName(input.name);
    const rootIds = normalizeRootIds(input.allowedPageIds);
    for (const pageId of rootIds) {
      const page = this.#knowledge.page(pageId);
      if (!page || page.trashed_at !== null)
        throw badRequest("bad_request", `Page ${pageId} is not a live Knowledge page.`);
    }
    const { secret, hash, prefix } = await generateSecret();
    const now = this.#clock.now();
    const id = newId("kmcp", now);
    const canRead = input.permissions?.read === true ? 1 : 0;
    const canWrite = input.permissions?.write === true ? 1 : 0;
    const canDelete = input.permissions?.delete === true ? 1 : 0;

    this.#db.transaction(() => {
      this.#db.run(
        `INSERT INTO knowledge_mcp_tokens
         (id, name, token_hash, token_prefix, can_read, can_write, can_delete, disabled_at, revoked_at, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
        id,
        name,
        hash,
        prefix,
        canRead,
        canWrite,
        canDelete,
        now,
        now,
      );
      for (const pageId of rootIds) {
        this.#db.run(
          "INSERT INTO knowledge_mcp_token_roots (token_id, page_id, created_at) VALUES (?, ?, ?)",
          id,
          pageId,
          now,
        );
      }
    });

    this.#log.info("knowledge_mcp.token_created", { tokenId: id });
    return { token: this.#toToken(this.#activeRow(id)), secret };
  }

  update(id: string, patch: UpdateKnowledgeMcpTokenRequest): KnowledgeMcpToken {
    const row = this.#activeRow(id);
    const now = this.#clock.now();
    const name = patch.name !== undefined ? validateName(patch.name) : row.name;
    const disabledAt =
      patch.enabled !== undefined ? (patch.enabled ? null : (row.disabled_at ?? now)) : row.disabled_at;
    const canRead = patch.permissions?.read !== undefined ? (patch.permissions.read ? 1 : 0) : row.can_read;
    const canWrite = patch.permissions?.write !== undefined ? (patch.permissions.write ? 1 : 0) : row.can_write;
    const canDelete = patch.permissions?.delete !== undefined ? (patch.permissions.delete ? 1 : 0) : row.can_delete;

    const nextRoots = patch.allowedPageIds !== undefined ? normalizeRootIds(patch.allowedPageIds) : undefined;
    if (nextRoots) {
      const existing = new Set(this.#rootIds(id));
      for (const pageId of nextRoots) {
        if (existing.has(pageId)) continue;
        const page = this.#knowledge.page(pageId);
        if (!page || page.trashed_at !== null)
          throw badRequest("bad_request", `Page ${pageId} is not a live Knowledge page.`);
      }
    }

    this.#db.transaction(() => {
      this.#db.run(
        `UPDATE knowledge_mcp_tokens
         SET name = ?, disabled_at = ?, can_read = ?, can_write = ?, can_delete = ?, updated_at = ?
         WHERE id = ?`,
        name,
        disabledAt,
        canRead,
        canWrite,
        canDelete,
        now,
        id,
      );
      if (nextRoots) {
        this.#db.run("DELETE FROM knowledge_mcp_token_roots WHERE token_id = ?", id);
        for (const pageId of nextRoots) {
          this.#db.run(
            "INSERT INTO knowledge_mcp_token_roots (token_id, page_id, created_at) VALUES (?, ?, ?)",
            id,
            pageId,
            now,
          );
        }
      }
    });

    this.#log.info("knowledge_mcp.token_updated", { tokenId: id });
    return this.#toToken(this.#activeRow(id));
  }

  async rotate(id: string): Promise<KnowledgeMcpSecretResponse> {
    this.#activeRow(id);
    const { secret, hash, prefix } = await generateSecret();
    const now = this.#clock.now();
    this.#db.run(
      "UPDATE knowledge_mcp_tokens SET token_hash = ?, token_prefix = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
      hash,
      prefix,
      now,
      id,
    );
    this.#log.info("knowledge_mcp.token_rotated", { tokenId: id });
    return { token: this.#toToken(this.#activeRow(id)), secret };
  }

  revoke(id: string): void {
    this.#activeRow(id);
    const now = this.#clock.now();
    this.#db.transaction(() => {
      this.#db.run(
        "UPDATE knowledge_mcp_tokens SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
        now,
        now,
        id,
      );
      this.#db.run("DELETE FROM knowledge_mcp_token_roots WHERE token_id = ?", id);
    });
    this.#log.info("knowledge_mcp.token_revoked", { tokenId: id });
  }

  async authenticate(rawToken: string): Promise<AuthenticatedMcpToken | undefined> {
    if (!rawToken.startsWith(KNOWLEDGE_MCP_TOKEN_PREFIX) || rawToken.length < 20 || rawToken.length > 256)
      return undefined;
    const hash = await sha256Hex(rawToken);
    const row = this.#db.get<TokenRow>(
      "SELECT * FROM knowledge_mcp_tokens WHERE token_hash = ? AND disabled_at IS NULL AND revoked_at IS NULL",
      hash,
    );
    if (!row) return undefined;
    const now = this.#clock.now();
    let lastUsedAt = row.last_used_at;
    if (lastUsedAt === null || now - lastUsedAt >= SLIDE_AFTER_MS) {
      this.#db.run("UPDATE knowledge_mcp_tokens SET last_used_at = ? WHERE id = ?", now, row.id);
      lastUsedAt = now;
    }
    return {
      id: row.id,
      name: row.name,
      tokenPrefix: row.token_prefix,
      canRead: row.can_read === 1,
      canWrite: row.can_write === 1,
      canDelete: row.can_delete === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt,
    };
  }

  resolveScope(tokenId: string): KnowledgeMcpScope {
    const grantedRootIds = new Set(this.#rootIds(tokenId));
    const liveRoots: PageRow[] = [];
    const liveRootIds = new Set<string>();
    for (const id of grantedRootIds) {
      const page = this.#knowledge.page(id);
      if (page && page.trashed_at === null) {
        liveRootIds.add(id);
        liveRoots.push(page);
      }
    }
    if (liveRootIds.size === 0) {
      return {
        grantedRootIds,
        liveRootIds,
        effectiveRootIds: [],
        allowedPageIds: new Set(),
      };
    }

    const effectiveRootIds = liveRoots
      .filter((root) => {
        const properAncestors = this.#knowledge.ancestry(root.id).slice(0, -1);
        return !properAncestors.some((a) => liveRootIds.has(a.id));
      })
      .sort((a, b) => b.activity_at - a.activity_at || b.id.localeCompare(a.id))
      .map((r) => r.id);

    const rows = this.#db.all<{ id: string }>(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM knowledge_pages WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at IS NULL
         UNION
         SELECT p.id FROM knowledge_pages p JOIN sub ON p.parent_id = sub.id WHERE p.trashed_at IS NULL
       )
       SELECT id FROM sub`,
      JSON.stringify([...liveRootIds]),
    );

    return {
      grantedRootIds,
      liveRootIds,
      effectiveRootIds,
      allowedPageIds: new Set(rows.map((r) => r.id)),
    };
  }

  actorLabel(tokenId: string): string {
    const row = this.#db.get<{ name: string; revoked_at: number | null }>(
      "SELECT name, revoked_at FROM knowledge_mcp_tokens WHERE id = ?",
      tokenId,
    );
    if (!row) return "Removed token";
    return row.revoked_at !== null ? `${row.name} (revoked)` : row.name;
  }
}
