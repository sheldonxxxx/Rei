/** The function tool that OpenAI's built-in search replaces when native search is on. */
export const NATIVE_SEARCH_REPLACES = "web_search";
const SOURCES = "web_search_call.action.sources";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * An OpenAI Responses request that searches with OpenAI's built-in `web_search` tool: the function tool of the same name
 * is dropped so the model sees one search tool, and the sources are requested. Anything else is returned unchanged.
 */
export function withNativeSearch(payload: unknown): unknown {
  if (!isObj(payload)) return payload;
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const kept = tools.filter((t) => !(isObj(t) && t.type === "function" && t.name === NATIVE_SEARCH_REPLACES));
  if (!kept.some((t) => isObj(t) && t.type === "web_search")) kept.push({ type: "web_search" });
  const include = Array.isArray(payload.include) ? payload.include : [];
  return { ...payload, tools: kept, include: include.includes(SOURCES) ? include : [...include, SOURCES] };
}
