// MCP tool results and tool lists as the gateway returns them.
import type { McpCallResult, McpResultMedia, McpToolInfo } from "@rei/protocol";

export const RESULT_MAX_BYTES = 100 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

/** At most `max` bytes of UTF-8, cut on a character boundary. */
export function clipBytes(text: string, max: number): { text: string; truncated: boolean } {
  const bytes = enc.encode(text);
  if (bytes.length <= max) return { text, truncated: false };
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--; // back up to the start of the cut character
  return { text: dec.decode(bytes.subarray(0, end)), truncated: true };
}

interface Block {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; mimeType?: string; blob?: string; text?: string };
}

/** Text blocks joined by a blank line; everything else becomes a placeholder naming its kind (and type or URI). */
export function flattenResult(result: {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}): McpCallResult {
  const blocks = Array.isArray(result.content) ? (result.content as Block[]) : [];
  const parts = blocks.map((b) => {
    switch (b?.type) {
      case "text":
        return typeof b.text === "string" ? b.text : "";
      case "image":
        return b.mimeType ? `[image: ${b.mimeType}]` : "[image]";
      case "audio":
        return b.mimeType ? `[audio: ${b.mimeType}]` : "[audio]";
      case "resource":
        return b.resource?.uri ? `[resource: ${b.resource.uri}]` : "[resource]";
      case "resource_link":
        return b.uri ? `[resource: ${b.uri}]` : "[resource]";
      default:
        return `[${typeof b?.type === "string" ? b.type.replace(/[^\w-]/g, "") : "unknown"}]`;
    }
  });
  const clipped = clipBytes(parts.join("\n\n"), RESULT_MAX_BYTES);
  let structured: unknown = result.structuredContent ?? null;
  let truncated = clipped.truncated;
  if (structured !== null && enc.encode(JSON.stringify(structured)).length > RESULT_MAX_BYTES) {
    structured = null; // cutting JSON would make it invalid; the flattened text still carries what the server sent
    truncated = true;
  }
  const media: McpResultMedia[] = [];
  let mediaBytes = 0;
  for (const b of blocks) {
    const embedded = b?.type === "resource" ? b.resource : undefined;
    const data = embedded?.blob ?? b?.data,
      text = embedded?.text;
    const mimeType =
      embedded?.mimeType ??
      b?.mimeType ??
      (embedded ? (typeof text === "string" ? "text/plain" : "application/octet-stream") : undefined);
    if (
      !["image", "audio", "resource"].includes(b?.type ?? "") ||
      typeof mimeType !== "string" ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType) ||
      (typeof data !== "string" && typeof text !== "string")
    )
      continue;
    const size =
      typeof data === "string"
        ? Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
        : enc.encode(text!).length;
    if (size > 25 * 1024 * 1024 || mediaBytes + size > 100 * 1024 * 1024 || media.length >= 10) {
      truncated = true;
      continue;
    }
    mediaBytes += size;
    media.push({
      type: b.type as McpResultMedia["type"],
      mimeType,
      ...(typeof data === "string" ? { data } : { text }),
      ...(embedded?.uri ? { uri: embedded.uri } : {}),
    });
  }
  return {
    isError: result.isError === true,
    text: clipped.text,
    structured,
    truncated,
    ...(media.length ? { media } : {}),
  };
}

interface RawTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: object;
  outputSchema?: object;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export function toToolInfo(tool: RawTool): McpToolInfo {
  const a = tool.annotations ?? {};
  const annotations: McpToolInfo["annotations"] = {};
  for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const)
    if (typeof a[hint] === "boolean") annotations[hint] = a[hint];
  return {
    name: tool.name,
    title: tool.title ?? a.title ?? null,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? { type: "object" },
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations,
  };
}
