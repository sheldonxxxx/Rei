// The "skills" extension: use_skill and read_skill_file read what is saved, save_skill proposes a new version on a
// card, and two prompt sections tell the model what exists and when to suggest saving one. A skill grants nothing: what
// its instructions say to do is decided by the policy like anything else the model does.

import type { Context } from "@earendil-works/chord/context";
import type { Extension } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { arr, num, obj, opt, str } from "@earendil-works/pi-schema";
import { SKILL_LIMITS, type SkillFile, type SkillPreview } from "@rei/protocol";
import { MODEL_AND_SCRIPTS, MODEL_ONLY } from "../pi/callers.ts";
import { policyTool, type ToolCatalog, type ToolPolicy } from "../pi/policy-ext.ts";
import type { AppStore, SessionRow } from "../store/store.ts";
import { Invalid } from "../util/errors.ts";
import { unifiedDiff } from "./diff.ts";
import { buildSkillMd, fileBytes, parseSkillMd, readFrontmatter, SKILL_MD, validateFiles } from "./parse.ts";
import { writeSkillFiles } from "./prepare.ts";
import type { SkillStore } from "./store.ts";

export const SKILLS_CONNECTOR = "skills";
/** Under the point where the tool-output limit would cut the text without saying how to go on. */
export const READ_FILE_CHARS = 40_000;

type ToolText = { output: { type: "text"; text: string }[]; isError?: true };
const ok = (text: string): ToolText => ({ output: [{ type: "text", text }] });
const fail = (text: string): ToolText => ({ isError: true, output: [{ type: "text", text }] });
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

export const SKILL_SAVING_NOTE =
  "After a multi-step task that worked, or when the user corrects how you did something, offer in one sentence to save it as a skill with save_skill.";

export interface SkillToolsDeps {
  treeId: string;
  store: AppStore;
  skills: SkillStore;
  catalog: ToolCatalog;
}

export function createSkillsExtension(deps: SkillToolsDeps): Extension {
  const { treeId, store, skills, catalog } = deps;
  const callerOf = (conversationId: unknown): SessionRow | undefined =>
    store.sessionByConversation(treeId, String(conversationId));
  const read = (operation: string, summary: ToolPolicy["summary"]): ToolPolicy => ({
    actionClass: "read_internal",
    connector: SKILLS_CONNECTOR,
    operation,
    summary,
  });

  /** What save_skill would save: the files of the next version, checked; and the version it builds on. */
  const prepare = (
    args: { name?: unknown; description?: unknown; body?: unknown; files?: unknown },
    session: SessionRow,
  ) => {
    if (typeof args.name !== "string" || typeof args.description !== "string" || typeof args.body !== "string")
      throw new Invalid("name, description and body are all required text.");
    // Exact names only: a bare name is a standalone skill, "plugin/skill" that plugin's skill.
    const existing = skills.byName(args.name, session.agent_id, { exact: true });
    if (existing?.id.startsWith("builtin_"))
      throw new Invalid("Built-in skills are read-only. Save your skill with another name.");
    // The name is unique across agents: one this agent can't see can't be added to.
    if (!existing && skills.byName(args.name, undefined, { exact: true }) !== undefined)
      throw new Invalid(
        `A skill named "${args.name}" already exists and is not available to this agent; pick another name.`,
      );
    let keep: Record<string, unknown> | undefined;
    try {
      keep = existing
        ? readFrontmatter(existing.files.find((f) => f.path === SKILL_MD)?.content ?? "").data
        : undefined;
    } catch {
      keep = undefined;
    }
    const skillMd = buildSkillMd({
      name: existing ? parseSkillMd(existing.files[0]!.content).name : args.name,
      description: args.description,
      body: args.body,
      ...(keep ? { keep } : {}),
    });
    let others: SkillFile[];
    if (args.files === undefined || args.files === null)
      others = existing ? existing.files.filter((f) => f.path !== SKILL_MD) : [];
    else {
      if (!Array.isArray(args.files)) throw new Invalid("files must be a list of { path, content }.");
      others = args.files.map((f: { path?: unknown; content?: unknown }) => {
        if (typeof f?.path !== "string" || typeof f.content !== "string")
          throw new Invalid("Each file needs a path and text content.");
        if (f.path === SKILL_MD)
          throw new Invalid("SKILL.md is built from name, description and body; leave it out of files.");
        return { path: f.path, encoding: "text" as const, content: f.content };
      });
    }
    const { files } = validateFiles([{ path: SKILL_MD, encoding: "text", content: skillMd }, ...others]);
    const parsed = parseSkillMd(skillMd);
    return { files, parsed, existing, skillMd, others: files.slice(1) };
  };

  /** The skill each session loaded last with use_skill, so read_skill_file can default to it. */
  const lastLoaded = new Map<string, { id: string; version: number; name: string }>();

  const useSkill = policyTool(
    catalog,
    read("skill.use", (a: { name?: unknown }) => `Use the skill ${typeof a.name === "string" ? a.name : ""}`.trim()),
    {
      name: "use_skill",
      callers: MODEL_ONLY,
      description:
        "Load a built-in or saved skill: returns its instructions (SKILL.md) and file list, and copies its files into the sandbox when there is one so its scripts can be run. Call it before doing a task a skill covers.",
      parameters: obj({ name: str({ description: "The skill's name, from your list of skills." }) }),
      replay: "safe",
      execute: async (args, api, context) => {
        const session = callerOf(api.conversationId);
        if (!session) return fail("This session is no longer available.");
        const skill = skills.byName(args.name, session.agent_id);
        if (!skill) {
          const names = skills.names(session.agent_id);
          return fail(
            `There is no skill named "${args.name}". ${names.length > 0 ? `Available skills: ${names.join(", ")}.` : "No skills are saved yet."}`,
          );
        }
        const md = skill.files.find((f) => f.path === SKILL_MD);
        let body = "";
        try {
          body = parseSkillMd(md?.content ?? "").body.trim();
        } catch {
          body = (md?.content ?? "").trim();
        }
        const run = store.runningRun(session.id);
        if (run) skills.recordUse(run.id, skill.id, skill.version);
        lastLoaded.set(session.id, { id: skill.id, version: skill.version, name: skill.name });
        const other = skill.files.find((f) => f.path !== SKILL_MD && f.encoding === "text");
        const lines = [
          `Skill "${skill.name}" (version ${skill.version})`,
          "",
          body,
          "",
          `Files: ${skill.files.map((f) => f.path).join(", ")}`,
          ...(other
            ? [
                `Read one with read_skill_file({ name: ${JSON.stringify(skill.name)}, path: ${JSON.stringify(other.path)} }).`,
              ]
            : []),
        ];
        lines.push(await mirror(skill, session, api.env, context));
        return ok(lines.join("\n").trim());
      },
    },
  );

  /** Copies the skill's files into the sandbox (when there is one); says where, or why not. Never throws. */
  async function mirror(
    skill: { name: string; files: SkillFile[] },
    session: SessionRow,
    env: ExecutionEnv | undefined,
    context: Context,
  ): Promise<string> {
    if (!env || !store.agentCapabilities(session.agent_id).sandbox)
      return "There is no sandbox, so its scripts can't be run; read its other files with read_skill_file.";
    // Workers share the workspace, but loading/updating a skill must not remove another worker's running scripts.
    const dir = `${env.cwd}/.skills/${skill.name}/${session.id}`;
    try {
      await writeSkillFiles(env, dir, skill.files, context);
    } catch {
      return "Its files could not be copied into the sandbox, so its scripts can't be run this time; read its other files with read_skill_file.";
    }
    return `Its files are copied to ${dir}, so scripts can be run with bash from there (for example: bash -c 'cd ${dir} && ...').`;
  }

  const readSkillFile = policyTool(
    catalog,
    read(
      "skill.read_file",
      (a: { name?: unknown; id?: unknown; path?: unknown }) =>
        `Read ${String(a.path ?? "")} of the skill ${String(a.name ?? a.id ?? "")}`,
    ),
    {
      name: "read_skill_file",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Read one text file of a saved skill (for example references/api.md), as listed by use_skill. A skill the user selected for a message names its id and version: pass them to read exactly that version.",
      parameters: obj({
        name: opt(
          str({
            description:
              "The skill's name (its latest version). Optional: defaults to the skill you loaded last with use_skill.",
          }),
        ),
        id: opt(str({ description: "The skill's id, as given with a selected skill." })),
        version: opt(num({ description: "With id: the version to read, as given with a selected skill." })),
        path: str({ description: "The file's path inside the skill, e.g. references/api.md." }),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const session = callerOf(api.conversationId);
        if (!session) return fail("This session is no longer available.");
        let skill: { files: SkillFile[] } | undefined;
        if (typeof args.id === "string" && args.id !== "") {
          // A pinned read: the exact version a selected skill gave the model, while the agent may still use the skill.
          const listed = skills.list(session.agent_id).some((s) => s.id === args.id);
          const wanted = typeof args.version === "number" ? args.version : undefined;
          const found = listed ? skills.get(args.id, wanted) : undefined;
          if (!found)
            return fail(
              `The skill ${args.id}${wanted === undefined ? "" : ` version ${wanted}`} is not available to this agent.`,
            );
          skill = found;
        } else {
          let name = typeof args.name === "string" && args.name !== "" ? args.name : undefined;
          if (name === undefined) {
            // No name given: the skill this session loaded last.
            name = lastLoaded.get(session.id)?.name;
            if (name === undefined)
              return fail(
                "Give the skill's name (or its id and version); no skill has been loaded with use_skill in this session yet.",
              );
          }
          skill = skills.byName(name, session.agent_id);
          if (!skill)
            return fail(
              `There is no skill named "${name}". Available skills: ${skills.names(session.agent_id).join(", ") || "none"}.`,
            );
        }
        const file = skill.files.find((f) => f.path === args.path);
        if (!file)
          return fail(`The skill has no file "${args.path}". Its files: ${skill.files.map((f) => f.path).join(", ")}.`);
        if (file.encoding !== "text")
          return fail(
            `"${file.path}" is a binary file (${fileBytes(file)} bytes); it can't be read as text. With a sandbox, use_skill copies it there.`,
          );
        const more = file.content.length > READ_FILE_CHARS;
        return ok(
          more
            ? `${file.content.slice(0, READ_FILE_CHARS)}\n… (cut at ${READ_FILE_CHARS} characters of ${file.content.length})`
            : file.content,
        );
      },
    },
  );

  const saveSkill = policyTool(
    catalog,
    {
      actionClass: "configure",
      pluginConfiguration: true,
      connector: SKILLS_CONNECTOR,
      operation: "skill.save",
      summary: (a: { name?: unknown }) =>
        `Save the skill ${typeof a.name === "string" ? clip(flat(a.name), 60) : ""}`.trim(),
      preview: (args, _facts, session): SkillPreview => {
        const { parsed, existing, skillMd, others, files } = prepare(args, session);
        const before = existing?.files.find((f) => f.path === SKILL_MD)?.content;
        const diff = before !== undefined ? unifiedDiff(before, files[0]!.content, `v${existing!.version}`, "new") : "";
        return {
          kind: "skill",
          op: existing ? "update" : "create",
          name: parsed.name,
          description: parsed.description,
          skillMd,
          files: others.map((f) => f.path),
          ...(existing ? { fromVersion: existing.version } : {}),
          ...(existing && diff !== "" ? { diff } : {}),
        };
      },
    },
    {
      name: "save_skill",
      callers: MODEL_ONLY,
      description:
        "Save a skill, or a new version of one that has the same name. Give a name (lowercase letters, digits and hyphens), a description of what it does and when to use it, and the instructions as the body of SKILL.md. The user sees a card with the result (and, for a new version, what changed) and must approve it. Write SKILL.md from what actually worked, not from what you meant to do: the steps in order, the pitfalls you ran into, how to decide between options, and what to do when something fails.",
      parameters: obj({
        name: str({ description: 'Lowercase letters, digits and single hyphens, e.g. "weekly-report".' }),
        description: str({
          description: `What it does and when to use it (at most ${SKILL_LIMITS.descriptionChars} characters).`,
        }),
        body: str({
          description: "The instructions: the steps, the pitfalls, how to decide, what to do when something fails.",
        }),
        files: opt(
          arr(
            obj({
              path: str({ description: 'e.g. "scripts/fetch.py" or "references/api.md"' }),
              content: str(),
            }),
            {
              description:
                "Other text files of the skill. When given, they replace the other files of the saved version; when missing, they are kept.",
            },
          ),
        ),
      }),
      execute: async (args, api) => {
        const session = callerOf(api.conversationId);
        if (!session) return fail("This session is no longer available.");
        try {
          const { files, existing } = prepare(args, session);
          const saved = skills.save({
            files,
            ...(existing ? { storageName: existing.name } : {}),
            author: "agent",
            sessionId: session.id,
            note: "Saved from chat",
            log: false,
          });
          if (!saved.changed)
            return ok(
              `The skill "${saved.skill.name}" is already saved as this (version ${saved.skill.version}); nothing changed.`,
            );
          return ok(`Saved the skill "${saved.skill.name}" as version ${saved.skill.version}.`);
        } catch (error) {
          if (error instanceof Invalid) return fail(error.message);
          throw error;
        }
      },
    },
  );

  return defineExtension({
    name: "skills",
    namespace: { name: "skills", description: "Skills: reusable instructions and the files they bring." },
    tools: [useSkill, readSkillFile, saveSkill],
    sections: [section("skill_saving", () => SKILL_SAVING_NOTE)],
  });
}
