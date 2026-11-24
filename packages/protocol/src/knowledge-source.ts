/** Knowledge's supported interchange format. No runtime permissions come from these properties. */
import { isAlias, isMap, isScalar, isSeq, Lexer, LineCounter, parseDocument, stringify, visit } from "yaml";

export interface KnowledgeMetadata {
  tags: string[];
}
export interface KnowledgeSource {
  title: string;
  description: string;
  metadata: KnowledgeMetadata;
  body: string;
}
export class KnowledgeMetadataError extends Error {
  readonly field: string;
  readonly code: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
  constructor(field: string, code: string, message: string, line?: number, column?: number) {
    super(`${field}: ${message}${line ? ` (line ${line}, column ${column})` : ""}`);
    this.field = field;
    this.code = code;
    this.line = line;
    this.column = column;
  }
}
const invalid = (field: string, code: string, message: string): never => {
  throw new KnowledgeMetadataError(field, code, message);
};
const controls = /[\p{Cc}\p{Cf}]/u;
export const tagKey = (tag: string): string => tag.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return invalid("tags", "type", "Use a list of strings.");
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return invalid("tags", "type", "Each tag must be a string.");
    if (controls.test(entry)) return invalid("tags", "control_character", "Tags cannot contain control characters.");
    const label = entry.replace(/\s+/gu, " ").trim();
    const key = tagKey(label);
    if (!key || [...key].length > 40)
      return invalid("tags", "length", "Each normalized tag must contain 1–40 Unicode characters.");
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(label);
    }
  }
  if (tags.length > 20) return invalid("tags", "limit", "Use at most 20 tags.");
  return tags;
}
export function normalizeMetadata(value: unknown): KnowledgeMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("metadata", "type", "Use an object containing tags.");
  for (const key of Object.keys(value))
    if (key !== "tags") return invalid(key, "unsupported_field", "Supported metadata field: tags.");
  return {
    tags: normalizeTags((value as { tags?: unknown }).tags === undefined ? [] : (value as { tags?: unknown }).tags),
  };
}
export function parseKnowledgeSource(source: string): KnowledgeSource {
  const text = source.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n"))
    return invalid(
      "sourceMarkdown",
      "missing_header",
      "Start with a YAML header delimited by --- and containing title.",
    );
  const end = text.indexOf("\n---", 4);
  if (end < 0 || !/^\n---(?:\n|$)/.test(text.slice(end)))
    return invalid("sourceMarkdown", "missing_header", "Close the YAML header with --- on its own line.");
  const header = text.slice(4, end);
  if (new TextEncoder().encode(header).length > 16 * 1024)
    return invalid("sourceMarkdown", "limit", "The YAML header must be at most 16 KiB.");
  // Bound parser work and nesting before composing any YAML nodes. Strings/comments remain single lexer tokens.
  let tokens = 0;
  for (const token of new Lexer().lex(header)) {
    if (token.trim() && ++tokens > 256)
      return invalid(
        "sourceMarkdown",
        "limit",
        "The header contains too many YAML tokens; use simple properties and at most 20 tags.",
      );
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(header, { version: "1.2", uniqueKeys: true, lineCounter, strict: true });
  const failAt = (field: string, code: string, message: string, offset = 0): never => {
    const pos = lineCounter.linePos(offset);
    throw new KnowledgeMetadataError(field, code, message, pos.line + 1, pos.col);
  };
  const err = doc.errors[0] ?? doc.warnings[0];
  if (err) failAt("sourceMarkdown", err.code, err.message, err.pos[0]);
  if (!isMap(doc.contents)) return failAt("sourceMarkdown", "type", "The header must be a mapping.");
  visit(doc, (_key, node) => {
    if (isAlias(node) || ((isScalar(node) || isMap(node) || isSeq(node)) && (node.anchor || node.tag)))
      failAt(
        "sourceMarkdown",
        "unsupported_yaml",
        "YAML anchors, aliases and explicit tags are not supported.",
        node.range?.[0],
      );
  });
  const values: Record<string, unknown> = {};
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string")
      return failAt("sourceMarkdown", "type", "Property names must be strings.");
    const key = pair.key.value;
    if (!["title", "description", "tags"].includes(key))
      return failAt(key, "unsupported_field", "Supported fields: title, description, tags.", pair.key.range?.[0]);
    const value = pair.value;
    if (key === "tags") {
      if (!isSeq(value) || value.items.some((item) => !isScalar(item) || typeof item.value !== "string"))
        return failAt(key, "type", "Use a list of strings.", value?.range?.[0]);
      values[key] = value.items.map((item) => (isScalar(item) ? item.value : null));
    } else {
      if (!isScalar(value) || typeof value.value !== "string")
        return failAt(key, "type", "Use a string.", value?.range?.[0]);
      values[key] = value.value;
    }
  }
  if (typeof values.title !== "string" || !values.title.trim())
    return failAt("title", "required", "A title is required.");
  for (const [key, max] of [
    ["title", 200],
    ["description", 300],
  ] as const) {
    const value = values[key] as string | undefined;
    if (value && (controls.test(value) || [...value].length > max))
      return failAt(key, "length", `Use one line of at most ${max} characters.`);
  }
  let tags: string[];
  try {
    tags = normalizeTags(values.tags ?? []);
  } catch (error) {
    if (!(error instanceof KnowledgeMetadataError)) throw error;
    const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === "tags");
    return failAt(error.field, error.code, error.message, pair?.value?.range?.[0]);
  }
  const rest = text.slice(end + 4);
  return {
    title: values.title.trim().replace(/\s+/gu, " "),
    description: ((values.description ?? "") as string).trim().replace(/\s+/gu, " "),
    metadata: { tags },
    body: rest.startsWith("\n") ? rest.slice(1) : rest,
  };
}
export function serializeKnowledgeSource(
  page: { title: string; description: string; metadata: KnowledgeMetadata },
  body: string,
): string {
  const header = stringify(
    { title: page.title, ...(page.description ? { description: page.description } : {}), tags: page.metadata.tags },
    { version: "1.2", lineWidth: 0 },
  );
  return `---\n${header}---\n${body}`;
}
