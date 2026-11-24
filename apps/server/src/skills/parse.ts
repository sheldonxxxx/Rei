// The Agent Skills format (agentskills.io), checked: SKILL.md with YAML frontmatter, and the files around it. Every
// failure is an `Invalid` whose message names the rule that failed, since it is shown to the user or the model.
import { SKILL_LIMITS, type SkillFile } from "@rei/protocol";
import { parse, stringify } from "yaml";
import { Invalid } from "../util/errors.ts";

export const SKILL_MD = "SKILL.md";
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_PATH = 200;

export interface ParsedSkill {
  name: string;
  description: string;
  /** The tools it says it needs (`allowed-tools`); shown on a trigger's card and grants nothing. */
  allowedTools: string[];
  body: string;
}

/** The frontmatter as written (unknown keys kept) and the text after it. */
export function readFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const source = text.replace(/^﻿/, "");
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (!open)
    throw new Invalid(
      "SKILL.md must start with a frontmatter block: a line of ---, then name and description, then a line of ---.",
    );
  const rest = source.slice(open[0].length);
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) throw new Invalid("SKILL.md's frontmatter is not closed: add a line of --- after the description.");
  let data: unknown;
  try {
    // Plain YAML only: the core schema has no custom tags, and aliases are capped.
    data = parse(rest.slice(0, close.index), { schema: "core", maxAliasCount: 20 });
  } catch (error) {
    const first = error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
    throw new Invalid(`SKILL.md's frontmatter is not valid YAML${first ? ` (${first})` : ""}.`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new Invalid("SKILL.md's frontmatter must be name and description (and optional fields), written as YAML.");
  return {
    data: data as Record<string, unknown>,
    body: rest.slice(close.index + close[0].length).replace(/^\r?\n/, ""),
  };
}

export function parseSkillMd(text: string): ParsedSkill {
  if (text.length > SKILL_LIMITS.skillMdChars)
    throw new Invalid(`SKILL.md can be at most ${SKILL_LIMITS.skillMdChars} characters.`);
  const { data, body } = readFrontmatter(text);
  const name = data.name;
  if (typeof name !== "string" || name === "") throw new Invalid("The frontmatter needs a name.");
  if (name.length > SKILL_LIMITS.nameChars || !NAME.test(name)) {
    throw new Invalid(
      `The skill name "${name}" is not allowed: use 1 to ${SKILL_LIMITS.nameChars} lowercase letters, digits and single hyphens, not starting or ending with a hyphen (for example "weekly-report").`,
    );
  }
  const description = data.description;
  if (typeof description !== "string" || description.trim() === "")
    throw new Invalid("The frontmatter needs a description: say what the skill does and when to use it.");
  if (description.length > SKILL_LIMITS.descriptionChars)
    throw new Invalid(`The description can be at most ${SKILL_LIMITS.descriptionChars} characters.`);
  if (data.license !== undefined && typeof data.license !== "string") throw new Invalid("license must be text.");
  if (
    data.compatibility !== undefined &&
    (typeof data.compatibility !== "string" || data.compatibility.length > SKILL_LIMITS.compatibilityChars)
  ) {
    throw new Invalid(`compatibility must be text of at most ${SKILL_LIMITS.compatibilityChars} characters.`);
  }
  if (data.metadata !== undefined) {
    const m = data.metadata;
    if (
      typeof m !== "object" ||
      m === null ||
      Array.isArray(m) ||
      !Object.values(m).every((v) => typeof v === "string")
    )
      throw new Invalid("metadata must map names to text.");
  }
  const tools = data["allowed-tools"];
  let allowedTools: string[] = [];
  if (typeof tools === "string") allowedTools = tools.split(/[\s,]+/).filter(Boolean);
  else if (Array.isArray(tools) && tools.every((t) => typeof t === "string"))
    allowedTools = tools.map((t) => t.trim()).filter(Boolean);
  else if (tools !== undefined) throw new Invalid("allowed-tools must be a space-separated list of tool names.");
  return { name, description: description.trim(), allowedTools, body };
}

/** SKILL.md for a skill the agent wrote: name and description in frontmatter, then the body. `keep` carries over the optional fields of an earlier version. */
export function buildSkillMd(input: {
  name: string;
  description: string;
  body: string;
  keep?: Record<string, unknown>;
}): string {
  const front: Record<string, unknown> = { name: input.name, description: input.description.trim() };
  for (const key of ["license", "compatibility", "metadata", "allowed-tools"])
    if (input.keep?.[key] !== undefined) front[key] = input.keep[key];
  return `---\n${stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n\n${input.body.trim()}\n`;
}

const encoder = new TextEncoder();

/** The size of a file as stored: text as UTF-8, binary as bytes. */
export function fileBytes(file: SkillFile): number {
  if (file.encoding === "text") return encoder.encode(file.content).length;
  return Math.floor((file.content.replace(/=+$/, "").length * 3) / 4);
}

export function checkPath(path: unknown): string {
  if (typeof path !== "string" || path === "") throw new Invalid("A file in the skill has no path.");
  if (path.length > MAX_PATH)
    throw new Invalid(`The path "${path.slice(0, 40)}…" is longer than ${MAX_PATH} characters.`);
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\\"))
    throw new Invalid(`The path "${path}" must be relative, written with "/" (for example "scripts/fetch.py").`);
  const parts = path.split("/");
  if (parts.some((p) => p === "")) throw new Invalid(`The path "${path}" has an empty part.`);
  if (parts.some((p) => p === "." || p === ".."))
    throw new Invalid(`The path "${path}" must not contain "." or ".." parts.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) throw new Invalid(`The path "${path}" has a control character.`);
  return path;
}

/** The files of a skill, checked against the format's and our limits. SKILL.md comes first, the rest by path. */
export function validateFiles(input: unknown): { files: SkillFile[]; bytes: number } {
  if (!Array.isArray(input) || input.length === 0) throw new Invalid("A skill needs at least a SKILL.md.");
  if (input.length > SKILL_LIMITS.files) throw new Invalid(`A skill can have at most ${SKILL_LIMITS.files} files.`);
  const seen = new Set<string>();
  const files: SkillFile[] = [];
  let bytes = 0;
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) throw new Invalid("Each file needs a path, an encoding and content.");
    const f = raw as Partial<SkillFile>;
    const path = checkPath(f.path);
    if (seen.has(path)) throw new Invalid(`The path "${path}" appears twice.`);
    seen.add(path);
    if (f.encoding !== "text" && f.encoding !== "base64")
      throw new Invalid(`The file "${path}" must be "text" or "base64".`);
    if (typeof f.content !== "string") throw new Invalid(`The file "${path}" has no content.`);
    if (f.encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(f.content.replace(/\s+/g, "")))
      throw new Invalid(`The file "${path}" is not valid base64.`);
    const file: SkillFile = {
      path,
      encoding: f.encoding,
      content: f.encoding === "base64" ? f.content.replace(/\s+/g, "") : f.content,
    };
    if (file.encoding === "text" && file.content.includes("�"))
      throw new Invalid(`The file "${path}" is not valid UTF-8 text; binary files must be base64.`);
    bytes += fileBytes(file);
    files.push(file);
  }
  if (bytes > SKILL_LIMITS.totalBytes)
    throw new Invalid(`A skill can be at most ${Math.round(SKILL_LIMITS.totalBytes / 1_000_000)} MB in all.`);
  const skillMd = files.find((f) => f.path === SKILL_MD);
  if (!skillMd) throw new Invalid("SKILL.md must be at the top of the skill (not in a folder).");
  if (skillMd.encoding !== "text") throw new Invalid("SKILL.md must be text.");
  files.sort((a, b) =>
    a.path === SKILL_MD ? -1 : b.path === SKILL_MD ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return { files, bytes };
}

/** A file's bytes (base64 decoded). */
export function bytesOf(file: SkillFile): Uint8Array {
  if (file.encoding === "text") return encoder.encode(file.content);
  const bin = atob(file.content);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Bytes as a skill file: text when they are valid UTF-8 without NUL bytes, else base64. */
export function fileFromBytes(path: string, bytes: Uint8Array): SkillFile {
  if (!bytes.includes(0)) {
    try {
      return { path, encoding: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      // not text
    }
  }
  return { path, encoding: "base64", content: toBase64(bytes) };
}
