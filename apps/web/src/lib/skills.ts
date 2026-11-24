import type { ImportSkillRequest, SkillFile } from "@rei/protocol";

/** A SKILL.md split into its frontmatter fields (for a small table) and the instructions below it. No YAML library: the server parses for real. */
export function splitSkillMd(text: string): { fields: [string, string][]; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: [], body: text };
  const fields: [string, string][] = [];
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields.push([kv[1]!, kv[2]!.replace(/^["']|["']$/g, "")]);
    else if (fields.length > 0 && line.trim()) {
      const last = fields[fields.length - 1]!;
      last[1] = `${last[1]} ${line.trim()}`.trim();
    }
  }
  return { fields, body: text.slice(m[0].length) };
}

/** A skill's SKILL.md text (the first file; SKILL.md is always at the top). */
export function skillMdOf(files: SkillFile[]): SkillFile | undefined {
  return files.find((f) => f.path === "SKILL.md");
}

export const skillExportHref = (id: string, version?: number) =>
  `/api/skills/${encodeURIComponent(id)}/export${version ? `?version=${version}` : ""}`;

function readBuffer(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsArrayBuffer(file);
  });
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A picked file as an import request: a .zip is sent whole, a lone SKILL.md becomes a one-file skill. */
export async function importRequestFor(file: File): Promise<ImportSkillRequest> {
  const bytes = new Uint8Array(await readBuffer(file));
  if (/\.zip$/i.test(file.name) || file.type === "application/zip") return { zip: toBase64(bytes) };
  return { files: [{ path: "SKILL.md", encoding: "text", content: new TextDecoder().decode(bytes) }] };
}
