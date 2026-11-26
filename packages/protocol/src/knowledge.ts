import type { KnowledgeMetadata } from "./knowledge-source.ts";

export type { KnowledgeMetadata } from "./knowledge-source.ts";
// Knowledge (GLOSSARY.md): shared long-term pages. Nested pages only; the body is Markdown.

/** Who wrote something: the user, an agent, or an external MCP token (named as it is now; a removed actor keeps its id). */
export interface KnowledgeActor {
  kind: "user" | "agent" | "mcp";
  id: string | null;
  name: string;
}

export interface KnowledgePage {
  metadata: KnowledgeMetadata;
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  revision: number;
  /** Locked for agents: they may only append. */
  locked: boolean;
  pinned: boolean;
  inbox: boolean;
  /** Some revision was written by a session that had read outside content. */
  external: boolean;
  createdBy: KnowledgeActor;
  createdAt: number;
  updatedBy: KnowledgeActor;
  updatedAt: number;
  /** Latest activity anywhere in the page's subtree: the order every listing uses. */
  activityAt: number;
  trashedAt: number | null;
}

/** A page without its body, for trees and lists. */
export interface KnowledgeTreeNode {
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  activityAt: number;
  updatedAt: number;
  updatedBy: KnowledgeActor;
  locked: boolean;
  pinned: boolean;
  inbox: boolean;
  childCount: number;
  path?: string;
  trashedAt?: number | null;
}

export interface KnowledgeRevision {
  metadata: KnowledgeMetadata;
  revision: number;
  title: string;
  description: string;
  actor: KnowledgeActor;
  sessionId: string | null;
  sessionTitle: string | null;
  runId: string | null;
  external: boolean;
  /** "created", "restored revision N", or null for an ordinary edit. */
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgePageDetail {
  page: KnowledgePage;
  body: string;
  ancestors: { id: string; title: string }[];
  children: KnowledgeTreeNode[];
  backlinks: { id: string; title: string; path: string }[];
  files: {
    fileId: string;
    /** The pinned version, or null for "the latest". */
    versionId: string | null;
    name: string | null;
    available: boolean;
    /** The version a reader opens (pinned or current), and its media type. */
    contentVersionId: string | null;
    mediaType: string | null;
  }[];
  revisions: KnowledgeRevision[];
}

export interface KnowledgeSearchHit {
  pageId: string;
  title: string;
  path: string;
  /** Heading path of the best-matching section ("" for the title and description). */
  section: string;
  snippet: string;
  updatedAt: number;
  /** Which rankings found the page: shared words ("keyword"), similar meaning ("meaning"), or both. */
  matched: ("keyword" | "meaning")[];
}

/** How far meaning search has caught up with the pages. */
export interface KnowledgeMeaningStatus {
  /** off: no embedding model is on; indexing: sections are waiting; ready: every section has a vector; down: the model is not answering. */
  state: "off" | "indexing" | "ready" | "down";
  sections: number;
  embedded: number;
  lastError: string | null;
}

export interface KnowledgeOverview {
  pinned: KnowledgeTreeNode[];
  recent: KnowledgeTreeNode[];
  /** Pages created and edited in the last 7 days, per actor. */
  week: { actor: KnowledgeActor; created: number; edited: number }[];
  inbox: { id: string; count: number; newest: KnowledgeTreeNode[] };
  /** Pages written by sessions that had read outside content. */
  external: KnowledgeTreeNode[];
  locked: KnowledgeTreeNode[];
  trashCount: number;
  pageCount: number;
  meaning: KnowledgeMeaningStatus;
}

/** A page referenced from a chat message. The agent reads the latest revision. */
export interface PageReference {
  pageId: string;
}

export interface KnowledgeMcpPermissions {
  read: boolean;
  write: boolean;
  delete: boolean;
}

export interface KnowledgeMcpAllowedPage {
  pageId: string;
  title: string | null;
  path: string | null;
  status: "live" | "trashed" | "missing";
}

export interface KnowledgeMcpToken {
  id: string;
  name: string;
  tokenPrefix: string;
  enabled: boolean;
  permissions: KnowledgeMcpPermissions;
  allowedPages: KnowledgeMcpAllowedPage[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface KnowledgeMcpTokensResponse {
  endpointPath: string;
  tokens: KnowledgeMcpToken[];
}

export interface CreateKnowledgeMcpTokenRequest {
  name: string;
  permissions?: { read?: boolean; write?: boolean; delete?: boolean };
  allowedPageIds?: string[];
}

export interface UpdateKnowledgeMcpTokenRequest {
  name?: string;
  enabled?: boolean;
  permissions?: { read?: boolean; write?: boolean; delete?: boolean };
  allowedPageIds?: string[];
}

export interface KnowledgeMcpSecretResponse {
  token: KnowledgeMcpToken;
  secret: string;
}
