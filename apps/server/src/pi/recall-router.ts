import { defineExtension, section } from "@earendil-works/pi-durable";

/** Which layers this tree has: the router names only tools the agent can call. */
export interface RecallLayers {
  memory: boolean;
  knowledge: boolean;
}

/**
 * The last prompt section about recall: where each kind of thing goes, and a check before the final answer. It sits
 * after the memory and Knowledge notes, which each stay about their own layer. Undefined when there is nothing to route.
 */
export function recallRouterText({ memory, knowledge }: RecallLayers): string | undefined {
  const routes: string[] = [];
  if (memory) routes.push("facts and preferences about the user: memory_add", "what was said earlier: search_history");
  if (knowledge) routes.push("research, plans, decisions and how-tos worth keeping: knowledge_write");
  if (routes.length === 0) return undefined;
  return `Where things go: ${routes.join("; ")}. Before you give your final answer, ask yourself whether anything from this conversation is worth saving, and save it first.`;
}

export function createRecallRouterExtension(layers: RecallLayers) {
  const text = recallRouterText(layers);
  return defineExtension({
    name: "recall_router",
    sections: text === undefined ? [] : [section("recall_router", () => text)],
  });
}
