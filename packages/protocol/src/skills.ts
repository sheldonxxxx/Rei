// Skills: how to do something, in the open Agent Skills format (agentskills.io): a folder with a
// SKILL.md (YAML frontmatter with `name` and `description`, then instructions), plus optional scripts/, references/ and
// assets/. Only each skill's name and description are in the model's context until it calls use_skill. A skill grants
// nothing: what it says it needs (`allowed-tools`) is shown on a trigger's card, and the policy decides as usual.
import type { AgentId, SessionId } from "./entities.ts";

export type SkillId = string;

/** Limits the server checks. */
export const SKILL_LIMITS = {
  /** Lowercase letters, digits and single hyphens, not at either end (the spec's rule). */
  nameChars: 64,
  descriptionChars: 1_024,
  compatibilityChars: 500,
  /** SKILL.md itself. */
  skillMdChars: 200_000,
  files: 100,
  /** All files together, as stored (text as UTF-8, binary as bytes). */
  totalBytes: 1_000_000,
  /** Skills listed in the model's context (by name), newest first; the rest are found with use_skill's error list. */
  inContext: 50,
} as const;

/** One file of a skill. Paths are relative to the skill folder, "/"-separated, without "..", e.g. "scripts/fetch.py". */
export interface SkillFile {
  path: string;
  /** "text": UTF-8 content. "base64": a binary file. */
  encoding: "text" | "base64";
  content: string;
}

/** The plugin a skill or connector belongs to. A component with no owner is standalone. */
export interface ComponentOwner {
  id: string;
  name: string;
  enabled: boolean;
}

export interface SkillSummary {
  id: SkillId;
  name: string;
  description: string;
  /** The current version (1, 2, ...). */
  version: number;
  /** Null: every agent sees it (default). Otherwise only these agents. */
  agents: AgentId[] | null;
  fileCount: number;
  /** Who made the current version. */
  author: "user" | "agent";
  /** Shipped by the application; read-only and available when its capability is enabled. */
  builtIn?: boolean;
  /** The plugin that owns it; null when it is standalone. Set by GET /api/skills (absent on built-in skills). */
  plugin?: ComponentOwner | null;
  createdAt: number;
  updatedAt: number;
}

/** GET /api/skills */
export interface SkillsResponse {
  skills: SkillSummary[];
}

export interface SkillVersionSummary {
  version: number;
  author: "user" | "agent";
  /** The session where the agent proposed it, for agent versions. */
  sessionId: SessionId | null;
  /** The approval or edit note, e.g. "Saved from chat", "Edited on the Skills page", "Imported". */
  note: string;
  createdAt: number;
}

/** GET /api/skills/:id[?version=n]: a version's files (SKILL.md first) and the version list. Errors: "not_found". */
export interface SkillResponse {
  skill: SkillSummary;
  version: number;
  files: SkillFile[];
  versions: SkillVersionSummary[];
}

/**
 * POST /api/skills: import. Either `files` (a folder's files, SKILL.md at the top) or `zip` (base64 of a .zip whose
 * SKILL.md is at the top or inside one folder). A skill with the same name gets a new version. Errors: "bad_request"
 * (the message says which rule failed: frontmatter, name, size...).
 */
export interface ImportSkillRequest {
  files?: SkillFile[];
  zip?: string;
}
export interface SkillSavedResponse {
  skill: SkillSummary;
}

/**
 * PATCH /api/skills/:id: edit from the trusted UI. `files` replaces the current version's files and makes a new version
 * (SKILL.md must still parse; its name can't change here); `restore` makes a new version from an old one; `agents` sets
 * who sees it. Each change goes to the edit log. Errors: "not_found", "bad_request".
 */
export interface UpdateSkillRequest {
  files?: SkillFile[];
  restore?: number;
  agents?: AgentId[] | null;
}

/** GET /api/skills/:id/export[?version=n]: the version as a .zip with one folder named after the skill. */
/** DELETE /api/skills/:id: removes the skill and its versions. Triggers using it fail with a clear reason until edited. */

/**
 * What a save_skill card shows: the SKILL.md as it would be saved, its other files' paths, and for a new version of an
 * existing skill a unified diff of SKILL.md against the current version.
 */
export interface SkillPreview {
  kind: "skill";
  op: "create" | "update";
  name: string;
  description: string;
  skillMd: string;
  files: string[];
  /** For update: the current version and the diff ("--- v3", "+++ new"). */
  fromVersion?: number;
  diff?: string;
}

/** Most skills one message can carry (the chips of the composer). */
export const SELECTED_SKILLS_MAX = 5;

/**
 * A skill the user chose with `/` for one message, as it is sent: the stable skill id and the immutable version the
 * chip was last refreshed to. The server uses exactly this version (never the latest) when it is still available.
 */
export interface SelectedSkill {
  id: SkillId;
  version: number;
}

/** A selected skill as a message shows it: the chip's label is the name the skill had when the message was admitted. */
export interface MessageSkill extends SelectedSkill {
  name: string;
}

/** One skill in the composer's `/` list: only what a picker needs, never the instructions or files. */
export interface SessionSkillOption {
  id: SkillId;
  /** What `/` shows and the chip says: the plugin's qualified name ("plugin/skill") or the standalone name. */
  name: string;
  description: string;
  /** The current version, which a new chip pins. */
  version: number;
  /** Characters of SKILL.md, so a picker can warn before the model's context window is exceeded. */
  bodyChars: number;
  builtIn?: boolean;
  plugin?: { id: string; name: string; enabled: boolean } | null;
}

/**
 * GET /api/sessions/:id/skills: the skills this session's agent can use now (enabled, and visible to the agent), newest
 * first. Not a security boundary on its own: a send re-checks every chip. Errors: "not_found".
 */
export interface SessionSkillsResponse {
  skills: SessionSkillOption[];
}
