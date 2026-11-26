import type { AgentCapabilities } from "@rei/protocol";

const BROWSER_TOOLS = new Set([
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_upload",
  "browser_type",
  "browser_select",
  "browser_press",
  "browser_wait",
  "browser_scroll",
  "browser_hover",
  "browser_check",
  "browser_batch",
  "browser_back",
  "browser_screenshot",
  "browser_takeover",
]);

const SANDBOX_TOOLS = new Set(["read", "write", "edit", "bash"]);
const WEB_TOOLS = new Set(["web_search", "web_fetch"]);
const LIBRARY_READ_TOOLS = new Set(["search_library", "read_library_file"]);
const KNOWLEDGE_READ_TOOLS = new Set(["knowledge_browse", "knowledge_read", "knowledge_search"]);
const MEMORY_WRITE_TOOLS = new Set(["memory_add", "memory_replace", "memory_remove", "memory_confirm"]);
const CHAT_HISTORY_TOOLS = new Set(["search_history", "history_context", "read_chat"]);
const TRIGGER_MANAGE_TOOLS = new Set(["list_triggers", "create_trigger", "update_trigger", "delete_trigger"]);
const DELEGATION_TOOLS = new Set(["start_session", "message_session", "cancel_session", "list_sessions"]);

/** Whether a built-in tool is enabled for an agent with `caps`. */
export function agentAllowsTool(caps: AgentCapabilities, toolName: string): boolean {
  if (SANDBOX_TOOLS.has(toolName)) return caps.sandbox;
  if (WEB_TOOLS.has(toolName)) return caps.web;
  if (BROWSER_TOOLS.has(toolName)) return caps.browser;
  if (LIBRARY_READ_TOOLS.has(toolName)) return caps.library !== "off";
  if (toolName === "publish_files") return caps.library === "read_write";
  if (toolName === "image_generate") return caps.images;
  if (KNOWLEDGE_READ_TOOLS.has(toolName)) return caps.knowledge !== "off";
  if (toolName === "knowledge_write") return caps.knowledge === "read_write";
  if (MEMORY_WRITE_TOOLS.has(toolName)) return caps.memory === "read_write";
  if (CHAT_HISTORY_TOOLS.has(toolName)) return caps.chatHistory !== "off";
  if (TRIGGER_MANAGE_TOOLS.has(toolName)) return caps.triggers !== "off";
  if (DELEGATION_TOOLS.has(toolName)) return caps.delegation !== "off";
  return true;
}

/** Whether a deferred built-in tool group is enabled for an agent with `caps`. */
export function agentAllowsGroup(caps: AgentCapabilities, groupName: string): boolean {
  if (groupName === "browser") return caps.browser;
  if (groupName === "triggers") return caps.triggers !== "off";
  return true;
}

/** Extension names dropped for an agent due to its capability switches. */
export function capabilityDroppedExtensions(caps: AgentCapabilities): string[] {
  const drop: string[] = [];
  if (!caps.sandbox) drop.push("sandbox");
  if (!caps.web) drop.push("web");
  if (!caps.browser) drop.push("browser");
  if (caps.library === "off") drop.push("library", "library_write");
  else if (caps.library === "read") drop.push("library_write");
  if (!caps.images) drop.push("codex-images");
  if (caps.knowledge === "off") drop.push("knowledge", "knowledge_write");
  else if (caps.knowledge === "read") drop.push("knowledge_write");
  if (caps.memory === "off") drop.push("memory", "memory_write");
  else if (caps.memory === "read") drop.push("memory_write");
  if (caps.chatHistory === "off") drop.push("history", "chat_references");
  if (caps.triggers === "off") drop.push("triggers");
  if (caps.delegation === "off") drop.push("sessions");
  return drop;
}
