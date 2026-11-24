// Skills and their versions, in the app store. A version is immutable: an edit, an import of a skill that exists, a
// restore or an agent's save makes the next one. `skills.changed` follows every change, in the same transaction.
import type { SkillFile, SkillResponse, SkillSummary, SkillVersionSummary } from "@rei/protocol";
import { GLOBAL_STREAM } from "../store/events.ts";
import type { AppStore } from "../store/store.ts";
import { Invalid, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { browserSkill, isBuiltInId, isBuiltInName, knowledgeSkill } from "./builtins.ts";
import { parseSkillMd, SKILL_MD, validateFiles } from "./parse.ts";

interface SkillRow {
  id: string;
  name: string;
  description: string;
  current_version: number;
  agents_json: string | null;
  created_at: number;
  updated_at: number;
}
interface VersionRow {
  skill_id: string;
  version: number;
  files_json: string;
  bytes: number;
  author: string;
  session_id: string | null;
  note: string;
  created_at: number;
}

export interface SaveInput {
  files: unknown;
  author: "user" | "agent";
  sessionId?: string | null;
  note: string;
  /** A user's change is logged (the edit log is the user's); an agent's goes through an approval. */
  log: boolean;
  /** Set when editing a skill: the name must stay. */
  expectId?: string;
  storageName?: string;
}

export class SkillStore {
  readonly app: AppStore;
  readonly #builtins: SkillResponse[];
  available: ((skillId: string, agentId?: string) => boolean) | undefined;
  onSaved: ((skillId: string) => void) | undefined;

  constructor(app: AppStore, options: { browser?: boolean } = {}) {
    this.app = app;
    this.#builtins = [...(options.browser ? [browserSkill()] : []), knowledgeSkill()];
  }
  get #db() {
    return this.app.db;
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  #row(id: string): SkillRow | undefined {
    return this.#db.get<SkillRow>("SELECT * FROM skills WHERE id = ?", id);
  }
  #version(id: string, version: number): VersionRow | undefined {
    return this.#db.get<VersionRow>("SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?", id, version);
  }
  #summary(r: SkillRow): SkillSummary {
    const v = this.#version(r.id, r.current_version)!;
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      version: r.current_version,
      agents: r.agents_json === null ? null : (JSON.parse(r.agents_json) as string[]),
      fileCount: (JSON.parse(v.files_json) as SkillFile[]).length,
      author: v.author as "user" | "agent",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  #visible(r: SkillRow, agentId: string | undefined): boolean {
    if (agentId === undefined || r.agents_json === null) return true;
    return (JSON.parse(r.agents_json) as string[]).includes(agentId);
  }

  /** Newest first. With an agent id: only what that agent sees. */
  list(agentId?: string): SkillSummary[] {
    const saved = this.#db
      .all<SkillRow>("SELECT * FROM skills ORDER BY updated_at DESC, id DESC")
      .filter((r) => this.#visible(r, agentId) && (agentId === undefined || this.available?.(r.id, agentId) !== false))
      .map((r) => this.#summary(r));
    return [...this.#builtins.map((s) => ({ ...s.skill })), ...saved];
  }
  get(id: string, version?: number): SkillResponse | undefined {
    const builtin = this.#builtins.find((s) => s.skill.id === id);
    if (builtin) return version === undefined || version === builtin.version ? structuredClone(builtin) : undefined;
    const row = this.#row(id);
    if (!row) return undefined;
    const v = this.#version(id, version ?? row.current_version);
    if (!v) return undefined;
    const versions = this.#db
      .all<VersionRow>("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC", id)
      .map(toVersionSummary);
    return { skill: this.#summary(row), version: v.version, files: JSON.parse(v.files_json) as SkillFile[], versions };
  }
  /**
   * A skill by name as an agent sees it (an unknown name and a hidden one look alike); with its current version's files.
   * The exact name wins: a standalone skill's own name, or a plugin skill's "plugin/skill". A plugin skill's bare name
   * resolves only when nothing has that exact name and one visible plugin skill has it. `exact` turns the fallback off
   * (save_skill: a bare name is a standalone skill).
   */
  byName(
    name: string,
    agentId?: string,
    options: { exact?: boolean } = {},
  ): { id: string; name: string; description: string; version: number; files: SkillFile[] } | undefined {
    const builtin = this.#builtins.find((s) => s.skill.name === name);
    if (builtin) return { ...builtin.skill, files: structuredClone(builtin.files) };
    const visible = (r: SkillRow) =>
      this.#visible(r, agentId) && (agentId === undefined || this.available?.(r.id, agentId) !== false);
    const exact = this.#db.all<SkillRow>(
      `SELECT DISTINCT s.* FROM skills s LEFT JOIN plugin_skills ps ON s.id = ps.skill_id LEFT JOIN plugins p ON p.id = ps.plugin_id WHERE s.name = ? OR p.name || '/' || ps.name = ?`,
      name,
      name,
    );
    let candidates = exact.filter(visible);
    // A hidden exact match still owns its name: the bare-name fallback never reaches past it.
    if (!candidates.length && !exact.length && !options.exact)
      candidates = this.#db
        .all<SkillRow>("SELECT s.* FROM skills s JOIN plugin_skills ps ON s.id = ps.skill_id WHERE ps.name = ?", name)
        .filter(visible);
    const row = candidates.length === 1 ? candidates[0] : undefined;
    if (!row) return undefined;
    const v = this.#version(row.id, row.current_version)!;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      version: row.current_version,
      files: JSON.parse(v.files_json) as SkillFile[],
    };
  }
  /** For the trigger rules: the skill, its version and what it says it needs. */
  find(agentId: string, name: string): { name: string; version: number; allowedTools: string[] } | undefined {
    const s = this.byName(name, agentId);
    if (!s) return undefined;
    let allowedTools: string[] = [];
    try {
      allowedTools = parseSkillMd(s.files.find((f) => f.path === SKILL_MD)?.content ?? "").allowedTools;
    } catch {
      // a version that was valid when saved
    }
    return { name: s.name, version: s.version, allowedTools };
  }
  names(agentId?: string): string[] {
    return this.list(agentId).map((s) => s.name);
  }

  // ---- changes -----------------------------------------------------------------------------------------------------

  #changed(): void {
    this.app.events.append(GLOBAL_STREAM, { type: "skills.changed" });
  }
  #log(skillId: string, field: string, before: string | null, after: string | null): void {
    const now = this.app.clock.now();
    this.#db.run(
      "INSERT INTO edit_log (id, at, author, target_kind, target_id, field, before_text, after_text) VALUES (?, ?, 'user', 'skill', ?, ?, ?, ?)",
      newId("edt", now),
      now,
      skillId,
      field,
      before,
      after,
    );
  }

  /**
   * Saves a skill: a new one, or the next version of the one with this name (an unchanged save makes no version).
   * Throws `Invalid` for anything the format or the limits refuse.
   */
  save(input: SaveInput): { skill: SkillSummary; created: boolean; changed: boolean } {
    const { files, bytes } = validateFiles(input.files);
    const parsed = parseSkillMd(files[0]!.content);
    if (isBuiltInName(parsed.name))
      throw new Invalid(
        `"${parsed.name}" is a built-in skill and cannot be overwritten. Save your skill with another name.`,
      );
    if (isBuiltInId(input.expectId)) throw new Invalid("Built-in skills are read-only.");
    const storageName = input.storageName ?? parsed.name;
    const result = this.app.tx(() => {
      const now = this.app.clock.now();
      const existing = this.#db.get<SkillRow>("SELECT * FROM skills WHERE name = ?", storageName);
      if (input.expectId !== undefined && existing?.id !== input.expectId)
        throw new Invalid("The skill's name can't be changed here: it must stay the same in SKILL.md.");
      if (!existing) {
        const id = newId("skl", now);
        this.#db.run(
          "INSERT INTO skills (id, name, description, current_version, agents_json, created_at, updated_at) VALUES (?, ?, ?, 1, NULL, ?, ?)",
          id,
          storageName,
          parsed.description,
          now,
          now,
        );
        this.#db.run(
          "INSERT INTO skill_versions (skill_id, version, files_json, bytes, author, session_id, note, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
          id,
          JSON.stringify(files),
          bytes,
          input.author,
          input.sessionId ?? null,
          input.note,
          now,
        );
        this.#changed();
        return { skill: this.#summary(this.#row(id)!), created: true, changed: true };
      }
      const current = this.#version(existing.id, existing.current_version)!;
      if (current.files_json === JSON.stringify(files))
        return { skill: this.#summary(existing), created: false, changed: false };
      const next = existing.current_version + 1;
      this.#db.run(
        "INSERT INTO skill_versions (skill_id, version, files_json, bytes, author, session_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        existing.id,
        next,
        JSON.stringify(files),
        bytes,
        input.author,
        input.sessionId ?? null,
        input.note,
        now,
      );
      this.#db.run(
        "UPDATE skills SET description = ?, current_version = ?, updated_at = ? WHERE id = ?",
        parsed.description,
        next,
        now,
        existing.id,
      );
      if (input.log) this.#log(existing.id, "files", `v${existing.current_version}`, `v${next}`);
      this.#changed();
      return { skill: this.#summary(this.#row(existing.id)!), created: false, changed: true };
    });
    this.onSaved?.(result.skill.id);
    return result;
  }

  /** A new version made from an old one. */
  restore(id: string, version: number): SkillSummary {
    if (isBuiltInId(id)) throw new Invalid("Built-in skills are read-only.");
    return this.app.tx(() => {
      const row = this.#row(id);
      if (!row) throw notFound("That skill does not exist.");
      const old = this.#version(id, version);
      if (!old) throw new Invalid(`The skill has no version ${version}.`);
      if (version === row.current_version) return this.#summary(row);
      const parsed = parseSkillMd(
        (JSON.parse(old.files_json) as SkillFile[]).find((f) => f.path === SKILL_MD)?.content ?? "",
      );
      const now = this.app.clock.now();
      const next = row.current_version + 1;
      this.#db.run(
        "INSERT INTO skill_versions (skill_id, version, files_json, bytes, author, session_id, note, created_at) VALUES (?, ?, ?, ?, 'user', NULL, ?, ?)",
        id,
        next,
        old.files_json,
        old.bytes,
        `Restored from v${version}`,
        now,
      );
      this.#db.run(
        "UPDATE skills SET description = ?, current_version = ?, updated_at = ? WHERE id = ?",
        parsed.description,
        next,
        now,
        id,
      );
      this.#log(id, "restore", `v${row.current_version}`, `v${version} (as v${next})`);
      this.#changed();
      return this.#summary(this.#row(id)!);
    });
  }

  /** Who sees the skill: null is every agent. */
  setAgents(id: string, agents: string[] | null): SkillSummary {
    if (isBuiltInId(id))
      throw new Invalid("Built-in skills are available to every agent while their capability is enabled.");
    return this.app.tx(() => {
      const row = this.#row(id);
      if (!row) throw notFound("That skill does not exist.");
      let next: string[] | null = null;
      if (agents !== null) {
        if (!Array.isArray(agents) || !agents.every((a) => typeof a === "string"))
          throw new Invalid("agents must be a list of agent ids, or null for every agent.");
        const known = new Set(this.app.listAgents().map((a) => a.id));
        const unknown = agents.find((a) => !known.has(a));
        if (unknown !== undefined) throw new Invalid(`There is no agent with id ${unknown}.`);
        next = [...new Set(agents)];
      }
      const before =
        row.agents_json === null ? "all agents" : (JSON.parse(row.agents_json) as string[]).join(", ") || "none";
      const after = next === null ? "all agents" : next.join(", ") || "none";
      if (before !== after) {
        this.#db.run(
          "UPDATE skills SET agents_json = ?, updated_at = ? WHERE id = ?",
          next === null ? null : JSON.stringify(next),
          this.app.clock.now(),
          id,
        );
        this.#log(id, "agents", before, after);
        this.#changed();
      }
      return this.#summary(this.#row(id)!);
    });
  }

  remove(id: string): boolean {
    if (isBuiltInId(id)) throw new Invalid("Built-in skills cannot be deleted.");
    return this.app.tx(() => {
      const row = this.#row(id);
      if (!row) return false;
      this.#db.run("DELETE FROM skill_uses WHERE skill_id = ?", id);
      this.#db.run("DELETE FROM skill_versions WHERE skill_id = ?", id);
      this.#db.run("DELETE FROM skills WHERE id = ?", id);
      this.#log(id, "delete", row.name, null);
      this.#changed();
      return true;
    });
  }

  /** How many runs used each skill, by skill id. */
  useCounts(): Map<string, number> {
    return new Map(
      this.#db
        .all<{ skill_id: string; n: number }>("SELECT skill_id, COUNT(*) AS n FROM skill_uses GROUP BY skill_id")
        .map((r) => [r.skill_id, r.n]),
    );
  }

  /** The version a run used (the last use of a skill in a run wins). */
  recordUse(runId: string, skillId: string, version: number): void {
    this.#db.run(
      "INSERT OR REPLACE INTO skill_uses (run_id, skill_id, version, at) VALUES (?, ?, ?, ?)",
      runId,
      skillId,
      version,
      this.app.clock.now(),
    );
  }
}

const toVersionSummary = (v: VersionRow): SkillVersionSummary => ({
  version: v.version,
  author: v.author as "user" | "agent",
  sessionId: v.session_id,
  note: v.note,
  createdAt: v.created_at,
});
