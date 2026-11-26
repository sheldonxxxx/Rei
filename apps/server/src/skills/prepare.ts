// Preparing skills for the model: the shared loader behind both `use_skill` (the model asks) and a selected skill (the
// user chose it with `/` for one message). A selected skill is resolved to an exact id and version, checked against
// what the session's agent may use now, and turned into a block of the message's model input, before the message is
// admitted. Reading a skill grants nothing: every tool call it leads to is decided by the policy as usual.

import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  type MessageSkill,
  SELECTED_SKILLS_MAX,
  type SelectedSkill,
  type SessionSkillOption,
  type SkillFile,
} from "@rei/protocol";
import type { WorkspaceManager } from "../exec/workspaces.ts";
import type { PluginService } from "../plugins/service.ts";
import { HttpError } from "../util/errors.ts";
import { bytesOf, parseSkillMd, SKILL_MD } from "./parse.ts";
import type { SkillStore } from "./store.ts";

/** A selected skill checked against the agent and loaded: the exact version's instructions and files. */
export interface ResolvedSkill extends MessageSkill {
  /** The SKILL.md instructions, without the frontmatter. */
  body: string;
  files: SkillFile[];
}

/** The plain-language reason a skill chip cannot be used; the whole send is refused with it. */
const unavailable = (what: string) =>
  new HttpError(409, "skill_unavailable", `${what} Remove it from the message to send without it.`);

/** The text of SKILL.md without its frontmatter (the raw text for a version that no longer parses). */
export function skillBody(files: readonly SkillFile[]): string {
  const md = files.find((f) => f.path === SKILL_MD)?.content ?? "";
  try {
    return parseSkillMd(md).body.trim();
  } catch {
    return md.trim();
  }
}

/** Characters of a skill's SKILL.md, as the `/` list reports them. */
export const skillChars = (files: readonly SkillFile[]): number => skillBody(files).length;

/** A directory name that cannot leave `.skills/`, for a skill id. */
const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "skill";

/**
 * Writes a skill version's files under `dir` of the sandbox, replacing what was there. Throws on any failure: callers
 * say in words why the scripts are not available instead.
 */
export async function writeSkillFiles(
  env: ExecutionEnv,
  dir: string,
  files: readonly SkillFile[],
  context: Context,
): Promise<void> {
  await env.remove(dir, { recursive: true, force: true }, context);
  const made = await env.createDir(dir, { recursive: true }, context);
  if (!made.ok) throw new Error("mkdir");
  for (const f of files) {
    const slash = f.path.lastIndexOf("/");
    if (slash > 0) await env.createDir(`${dir}/${f.path.slice(0, slash)}`, { recursive: true }, context);
    const wrote = await env.writeFile(`${dir}/${f.path}`, f.encoding === "text" ? f.content : bytesOf(f), context);
    if (!wrote.ok) throw new Error("write");
  }
}

/** Keeps a skill's own text from closing the block that holds it. */
const inert = (text: string): string => text.replace(/<(\/?)selected-skill/gi, "<$1​selected-skill");
const attr = (text: string): string => text.replace(/[&<>"\n\r]/g, (c) => `&#${c.charCodeAt(0)};`);

/** About how many tokens text takes (a quarter of a character each: only a fit check needs it). */
export const roughTokens = (chars: number): number => Math.ceil(chars / 4);

export interface SkillPreparerDeps {
  skills: SkillStore;
  plugins?: PluginService | undefined;
  workspaces?: WorkspaceManager | undefined;
}

export class SkillPreparer {
  readonly #d: SkillPreparerDeps;
  constructor(deps: SkillPreparerDeps) {
    this.#d = deps;
  }

  /** What `/` and the chip call a skill: a plugin skill's qualified name, otherwise its own. */
  displayName(id: string, name: string): string {
    return this.#d.plugins?.skillInfo(id)?.reference ?? name;
  }

  /** The skills the agent can use now, newest first, as the composer lists them. */
  options(agentId: string): SessionSkillOption[] {
    return this.#d.skills.list(agentId).flatMap((s) => {
      const found = this.#d.skills.get(s.id, s.version);
      if (!found) return [];
      const owner = s.builtIn ? null : (this.#d.plugins?.owner("skill", s.id) ?? null);
      return [
        {
          id: s.id,
          name: this.displayName(s.id, s.name),
          description: s.description,
          version: s.version,
          bodyChars: skillChars(found.files),
          ...(s.builtIn ? { builtIn: true } : {}),
          ...(s.builtIn ? {} : { plugin: owner }),
        },
      ];
    });
  }

  /** Checks the shape of a request's `selectedSkills`; the list is returned in chip order. Throws a 400. */
  parse(raw: unknown): SelectedSkill[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new HttpError(400, "bad_request", "selectedSkills must be a list.");
    if (raw.length > SELECTED_SKILLS_MAX)
      throw new HttpError(400, "too_many_skills", `A message can carry at most ${SELECTED_SKILLS_MAX} skills.`);
    const out: SelectedSkill[] = [];
    for (const item of raw) {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        Object.keys(item).some((k) => k !== "id" && k !== "version")
      )
        throw new HttpError(400, "bad_request", "Each selected skill is { id, version }.");
      const { id, version } = item as { id?: unknown; version?: unknown };
      if (typeof id !== "string" || id === "" || id.length > 200)
        throw new HttpError(400, "bad_request", "A selected skill needs an id.");
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
        throw new HttpError(400, "bad_request", "A selected skill needs a version (a whole number from 1).");
      if (out.some((s) => s.id === id)) throw new HttpError(400, "bad_request", "A skill can be selected only once.");
      out.push({ id, version });
    }
    return out;
  }

  /**
   * Loads each chip's exact version if the agent may use the skill now. Never substitutes the current version. Throws
   * "skill_unavailable" (409) naming the skills at fault, or "skills_too_large" (413) when the instructions alone would
   * not fit the model's context window (`contextWindow` unknown: the run-time guard remains the only check).
   */
  resolve(agentId: string, selected: readonly SelectedSkill[], contextWindow?: number | null): ResolvedSkill[] {
    if (selected.length > SELECTED_SKILLS_MAX)
      throw new HttpError(400, "too_many_skills", `A message can carry at most ${SELECTED_SKILLS_MAX} skills.`);
    const visible = new Map(this.#d.skills.list(agentId).map((s) => [s.id, s]));
    const missing: string[] = [];
    const out: ResolvedSkill[] = [];
    for (const { id, version } of selected) {
      const listed = visible.get(id);
      const found = listed ? this.#d.skills.get(id, version) : undefined;
      if (!listed || !found) {
        missing.push(listed ? `${this.displayName(id, listed.name)} (version ${version})` : id);
        continue;
      }
      out.push({
        id,
        version,
        name: this.displayName(id, listed.name),
        body: skillBody(found.files),
        files: found.files,
      });
    }
    if (missing.length)
      throw unavailable(
        missing.length === 1
          ? `The skill ${missing[0]} is not available to this agent any more.`
          : `These skills are not available to this agent any more: ${missing.join(", ")}.`,
      );
    if (contextWindow && roughTokens(out.reduce((n, s) => n + s.body.length, 0)) > contextWindow)
      throw new HttpError(
        413,
        "skills_too_large",
        `The chosen skills are too large for the model's context window (${contextWindow} tokens): ${out
          .map((s) => `${s.name} ${s.body.length} characters`)
          .join(", ")}. Remove one to send.`,
      );
    return out;
  }

  /**
   * The model-input blocks of resolved skills, in order, each with its supporting files copied into the sandbox under
   * `.skills/<id>/v<version>/<runId>/` when there is one. A missing sandbox or a failed copy degrades that skill (the
   * block says so and the files stay readable with read_skill_file): it never fails the message.
   */
  async prepare(
    resolved: readonly ResolvedSkill[],
    where: { treeId: string; runId: string; sandbox?: boolean },
  ): Promise<string[]> {
    let env: ExecutionEnv | undefined;
    const needsEnv = where.sandbox !== false && resolved.some((s) => s.files.length > 1);
    if (needsEnv && this.#d.workspaces) {
      try {
        const backend = this.#d.workspaces.forTree(where.treeId);
        await backend.ready(where.treeId);
        env = backend.env(where.treeId);
      } catch {
        env = undefined;
      }
    }
    const blocks: string[] = [];
    for (const skill of resolved) {
      blocks.push(await this.#block(skill, env, where.runId, needsEnv));
    }
    return blocks;
  }

  async #block(skill: ResolvedSkill, env: ExecutionEnv | undefined, runId: string, needsEnv: boolean): Promise<string> {
    const others = skill.files.filter((f) => f.path !== SKILL_MD);
    const lines = [
      `<selected-skill name="${attr(skill.name)}" version="${skill.version}" id="${attr(skill.id)}">`,
      "The user chose this skill for this message only. Follow its instructions for this request. It grants no tools or approvals: every tool call is still decided by the usual policy.",
      "",
      inert(skill.body),
    ];
    if (others.length) {
      lines.push("", `Files: ${others.map((f) => f.path).join(", ")}`);
      const read = `read_skill_file with id "${skill.id}" and version ${skill.version}`;
      if (needsEnv && env) {
        const dir = `${env.cwd}/.skills/${safe(skill.id)}/v${skill.version}/${safe(runId)}`;
        try {
          await writeSkillFiles(env, dir, skill.files, BACKGROUND_CONTEXT);
          lines.push(
            `Its files are copied to ${dir} (this version only; nothing was run). Text files can also be read with ${read}.`,
          );
        } catch {
          lines.push(
            `Its files could not be copied into the sandbox, so its scripts were not copied. Read text files with ${read}.`,
          );
        }
      } else {
        lines.push(`There is no sandbox, so its scripts were not copied. Read text files with ${read}.`);
      }
    }
    lines.push("</selected-skill>");
    return lines.join("\n");
  }

  /** Records that a run used each skill (the version it was given), once the message is admitted. */
  recordUse(runId: string, skills: readonly SelectedSkill[]): void {
    for (const s of skills) this.#d.skills.recordUse(runId, s.id, s.version);
  }
}
