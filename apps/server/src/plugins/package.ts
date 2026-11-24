import { type PluginPackage, SKILL_LIMITS, type SkillFile } from "@rei/protocol";
import { parseSkillMd, validateFiles } from "../skills/parse.ts";
import { exportZip, importZip } from "../skills/zip.ts";
import { Invalid } from "../util/errors.ts";

const slug = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
    throw new Invalid("Names must use lowercase letters, digits and single hyphens (up to 64 characters).");
  return value;
};
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Invalid("Expected an object.");
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some((key) => !keys.includes(key)))
    throw new Invalid("Unknown package fields. Keep credentials and permission settings outside the package.");
  return o;
}
export function validatePackage(value: unknown): PluginPackage {
  const o = object(value, ["formatVersion", "name", "description", "skills", "mcp"]);
  const name = slug(o.name);
  if (o.formatVersion !== 1) throw new Invalid("Unsupported plugin formatVersion; use 1.");
  if (typeof o.description !== "string" || !o.description.trim() || o.description.length > 1024)
    throw new Invalid("A description of 1 to 1024 characters is required.");
  if (!Array.isArray(o.skills) || !Array.isArray(o.mcp) || (!o.skills.length && !o.mcp.length))
    throw new Invalid("A plugin needs skills and mcp arrays with at least one component.");
  if (o.skills.length > 20 || o.mcp.length > 20)
    throw new Invalid("A plugin supports up to 20 skills and 20 connections.");
  let bytes = 0;
  let count = 1;
  const skills = o.skills.map((raw) => {
    const s = object(raw, ["name", "files"]);
    const name = slug(s.name);
    const checked = validateFiles(s.files);
    if (parseSkillMd(checked.files[0]!.content).name !== name)
      throw new Invalid("Each skill name must match its SKILL.md frontmatter.");
    bytes += checked.bytes;
    count += checked.files.length;
    return { name, files: checked.files };
  });
  const mcp = o.mcp.map((raw) => {
    const c = object(raw, ["name", "url", "auth", "skills"]);
    const name = slug(c.name);
    if (typeof c.url !== "string" || c.url.length > 2000) throw new Invalid("An MCP URL is required.");
    let url: URL;
    try {
      url = new URL(c.url);
    } catch {
      throw new Invalid("Invalid MCP URL.");
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Invalid("Use an HTTP(S) MCP URL without credentials, query parameters or a fragment.");
    if (c.auth !== "none" && c.auth !== "oauth" && c.auth !== "token")
      throw new Invalid("Unknown authentication method.");
    if (!Array.isArray(c.skills) || c.skills.some((n) => typeof n !== "string" || !skills.some((s) => s.name === n)))
      throw new Invalid("Connection skills must reference skills in this plugin.");
    return {
      name,
      url: url.href,
      auth: c.auth as "none" | "token" | "oauth",
      skills: [...new Set(c.skills as string[])],
    };
  });
  if (new Set(skills.map((s) => s.name)).size !== skills.length || new Set(mcp.map((c) => c.name)).size !== mcp.length)
    throw new Invalid("Component names must be unique within each component type.");
  bytes += new TextEncoder().encode(JSON.stringify({ name, description: o.description, mcp })).length;
  if (bytes > SKILL_LIMITS.totalBytes || count > SKILL_LIMITS.files)
    throw new Invalid("A plugin supports at most 100 files and 1 MB of unpacked content.");
  return { formatVersion: 1, name, description: o.description.trim(), skills, mcp };
}
export function packageFiles(pkg: PluginPackage): SkillFile[] {
  return [
    {
      path: "plugin.json",
      encoding: "text",
      content: JSON.stringify({ ...pkg, skills: pkg.skills.map((s) => ({ name: s.name })) }, null, 2),
    },
    ...pkg.skills.flatMap((s) => s.files.map((f) => ({ ...f, path: `skills/${s.name}/${f.path}` }))),
  ];
}
export function importPlugin(files: SkillFile[]): PluginPackage {
  const manifest = files.find((f) => f.path === "plugin.json");
  if (manifest?.encoding !== "text") throw new Invalid("The package needs plugin.json.");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(manifest.content);
  } catch {
    throw new Invalid("plugin.json must contain valid JSON.");
  }
  if (!raw || !Array.isArray(raw.skills)) throw new Invalid("plugin.json needs a skills array.");
  const used = new Set(["plugin.json"]);
  const skills = raw.skills.map((value: unknown) => {
    const s = object(value, ["name"]);
    const name = slug(s.name);
    const prefix = `skills/${name}/`;
    return {
      name,
      files: files
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => {
          used.add(f.path);
          return { ...f, path: f.path.slice(prefix.length) };
        }),
    };
  });
  if (files.some((f) => !used.has(f.path)) || used.size !== files.length)
    throw new Invalid("The package contains duplicate or undeclared files.");
  return validatePackage({ ...raw, skills });
}
export const importPluginZip = (bytes: Uint8Array) => importPlugin(importZip(bytes, "plugin.json"));
export const exportPluginZip = (pkg: PluginPackage, at: number) => exportZip(pkg.name, packageFiles(pkg), at);
