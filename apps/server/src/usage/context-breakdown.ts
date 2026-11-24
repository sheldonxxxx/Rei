import type { ContextBreakdown, ContextTokenCategory } from "@rei/protocol";
import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import type { BlobStore } from "../blobs/blob-store.ts";

const CATEGORIES: [ContextTokenCategory, string][] = [
  ["prompt", "System prompt"],
  ["capabilities", "Capabilities index"],
  ["skills", "Skills"],
  ["tools", "Core tool definitions"],
  ["loaded_tools", "Loaded tool definitions"],
  ["conversation", "Conversation"],
  ["tool_calls", "Tool calls"],
  ["tool_results", "Tool results"],
  ["mcp_calls", "MCP calls"],
  ["mcp_results", "MCP results"],
  ["other", "Other context"],
];
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const name = (v: unknown, fallback: string) => (typeof v === "string" && v ? v.slice(0, 160) : fallback);
/** A connector tool: `<connector slug>__<tool>` (and a provider-side `mcp__…` tool). */
const isMcp = (n: string) => n.includes("__");

let tokenizer: Tiktoken | undefined;
/** Inspect only visible model input, excluding metadata, binary/base64 and encrypted reasoning.
 * o200k_base provides reproducible text counts, not provider-reported per-source attribution. `loaded` names the
 * request's tools that search_capabilities loaded, as the model call recorded them: a provider without native tool
 * search sends them in the request's own tools, after the core tools. */
export function contextBreakdown(payload: unknown, loaded: ReadonlySet<string> = new Set()): ContextBreakdown | null {
  const p = obj(payload);
  // Exact OpenAI Responses request captured by onPayload. Unknown formats stay unknown.
  if (!Array.isArray(p.input) && typeof p.input !== "string") return null;
  const counts = new Map<ContextTokenCategory, Map<string, number>>();
  let opaque = false;
  const visible = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(visible).join("\n");
    const v = obj(value);
    if (["input_image", "image", "input_audio", "input_file"].includes(String(v.type))) {
      opaque = true;
      return "";
    }
    if (v.encrypted_content) opaque = true;
    if (typeof v.text === "string") return v.text;
    if (v.content !== undefined) return visible(v.content);
    return "";
  };
  const add = (category: ContextTokenCategory, label: string, text: string) => {
    if (!text) return;
    // Special-token-shaped user text is ordinary text, never an instruction to the tokenizer.
    const tokens = (tokenizer ??= new Tiktoken(o200k)).encode(text, [], []).length;
    const details = counts.get(category) ?? new Map<string, number>();
    details.set(label, (details.get(label) ?? 0) + tokens);
    counts.set(category, details);
  };
  /** A user message: the skills the user chose for it count as Skills, the rest as the conversation. */
  const userText = (text: string) => {
    let rest = text;
    for (const m of text.matchAll(/<selected-skill name="([^"]*)"[^>]*>[\s\S]*?<\/selected-skill>/g)) {
      add("skills", `Selected skill: ${name(m[1]?.replace(/&#\d+;/g, " "), "skill")}`, m[0]);
      rest = rest.replace(m[0], "");
    }
    add("conversation", "User messages", rest.trim());
  };
  const prompt = (text: string) => {
    let cursor = 0;
    for (const m of text.matchAll(/<([a-zA-Z_][\w.-]*)>\n?([\s\S]*?)<\/\1>/g)) {
      add("prompt", "Base instructions", text.slice(cursor, m.index));
      const key = m[1]!;
      const category = key === "skill_saving" ? "skills" : key === "capabilities" ? "capabilities" : "prompt";
      add(category, key.replaceAll("_", " "), m[0]);
      cursor = m.index! + m[0].length;
    }
    add("prompt", "Base instructions", text.slice(cursor));
  };
  prompt(visible(p.instructions));
  // Core tools are declared up front: the request's own tools, or Pi's first additional_tools item. Every later
  // declaration (an additional_tools item or a tool search result), and every tool the call recorded as loaded, is a
  // tool search_capabilities loaded.
  const toolDefinitions = (tools: unknown, category: "tools" | "loaded_tools") => {
    for (const tool of list(tools)) {
      const t = obj(tool),
        f = t.type === "function" || t.type === "custom" ? t : obj(t.function);
      const label = name(f.name ?? t.name, "Provider tool");
      add(loaded.has(label) ? "loaded_tools" : category, label, JSON.stringify(tool));
    }
  };
  toolDefinitions(p.tools, "tools");
  let declared = false;
  const input = typeof p.input === "string" ? [{ role: "user", content: p.input }] : list(p.input);
  const calls = new Map<string, { tool: string; label: string }>();
  for (const item of input) {
    const m = obj(item);
    if (m.type !== "function_call" && m.type !== "custom_tool_call") continue;
    const tool = name(m.name, "Unknown tool");
    let args: Record<string, unknown> = {};
    try {
      args = typeof m.arguments === "string" ? obj(JSON.parse(m.arguments)) : obj(m.arguments);
    } catch {
      /* malformed arguments remain attributed to their tool */
    }
    const label =
      tool === "read_skill_file"
        ? `${tool}: ${name(args.name, "skill")} / ${name(args.path, "file")}`
        : tool === "use_skill"
          ? `${tool}: ${name(args.name, "skill")}`
          : tool;
    calls.set(String(m.call_id), { tool, label });
  }
  for (const item of input) {
    const m = obj(item);
    if (m.type === "function_call" || m.type === "custom_tool_call") {
      const call = calls.get(String(m.call_id))!;
      add(
        isMcp(call.tool) ? "mcp_calls" : "tool_calls",
        call.label,
        JSON.stringify({ name: m.name, arguments: m.arguments, input: m.input }),
      );
    } else if (m.type === "function_call_output" || m.type === "custom_tool_call_output") {
      const call = calls.get(String(m.call_id));
      const tool = call?.tool ?? "Unknown tool",
        label = call?.label ?? tool;
      const category =
        tool === "use_skill" || tool === "read_skill_file" ? "skills" : isMcp(tool) ? "mcp_results" : "tool_results";
      add(category, label, visible(m.output));
    } else if (m.type === "additional_tools" || m.type === "tool_search_output") {
      toolDefinitions(m.tools, m.type === "additional_tools" && !declared ? "tools" : "loaded_tools");
      declared = true;
    } else if (m.type === "tool_search_call") {
      add("other", "Tool discovery protocol", JSON.stringify(m.arguments ?? {}));
    } else if (m.role === "system" || m.role === "developer") {
      prompt(visible(m.content));
    } else if (m.role === "user" || m.role === "assistant") {
      if (m.role === "user") userText(visible(m.content));
      else add("conversation", "Assistant messages", visible(m.content));
    } else if (m.type === "reasoning") {
      if (m.encrypted_content) opaque = true;
      add("other", "Visible reasoning history", visible(m.summary));
    } else {
      add("other", name(m.type, "Other input"), visible(m.content));
    }
  }
  const categories = CATEGORIES.map(([id, label]) => {
    const details = [...(counts.get(id) ?? [])]
      .map(([label, tokens]) => ({ label, estimatedTokens: tokens }))
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens);
    return { id, label, estimatedTokens: details.reduce((n, d) => n + d.estimatedTokens, 0), details };
  });
  return {
    method: "o200k_base",
    estimatedTokens: categories.reduce((n, c) => n + c.estimatedTokens, 0),
    hasOpaqueContent: opaque,
    categories,
  };
}

/** The loaded tool names a model call step recorded (`steps.loaded_tools`); none when it recorded nothing readable. */
export function loadedNames(row: { loaded_tools: string | null }): string[] {
  if (!row.loaded_tools) return [];
  try {
    const names = JSON.parse(row.loaded_tools) as unknown;
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

// Cache only derived counters/labels, never source prompts. Immutable content-addressed
// refs make repeat refreshes cheap; each BlobStore (and test fixture) owns its cache.
const caches = new WeakMap<BlobStore, Map<string, Promise<ContextBreakdown | null>>>();
export async function readContextBreakdown(
  blobs: BlobStore,
  ref: string,
  loaded: readonly string[] = [],
): Promise<ContextBreakdown | null> {
  let cache = caches.get(blobs);
  if (!cache) {
    cache = new Map();
    caches.set(blobs, cache);
  }
  const key = loaded.length === 0 ? ref : `${ref}\u0000${loaded.join("\u0000")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = (async () => {
    try {
      const bytes = await blobs.get(ref);
      return bytes ? contextBreakdown(JSON.parse(new TextDecoder().decode(bytes)), new Set(loaded)) : null;
    } catch {
      return null;
    }
  })();
  cache.set(key, pending);
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  const result = await pending;
  if (result === null) cache.delete(key); // A request blob may still be arriving.
  return result;
}
