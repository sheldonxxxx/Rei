import { defineExtension, section } from "@earendil-works/pi-durable";
import type { AppStore } from "../store/store.ts";

/** Which layers this tree/agent has: the router names only tools the agent can call. */
export interface RecallLayers {
  memory: boolean;
  history?: boolean;
  knowledge: boolean;
}

/**
 * The last prompt section about recall: where each kind of thing goes, and a check before the final answer. It sits
 * after the memory and Knowledge notes, which each stay about their own layer. Undefined when there is nothing to route.
 */
export function recallRouterText({ memory, history = memory, knowledge }: RecallLayers): string | undefined {
  const routes: string[] = [];
  if (memory) routes.push("facts and preferences about the user: memory_add");
  if (history) routes.push("what was said earlier: search_history");
  if (knowledge) routes.push("research, plans, decisions and how-tos worth keeping: knowledge_write");
  if (routes.length === 0) return undefined;
  return `Where things go: ${routes.join("; ")}. Before you give your final answer, ask yourself whether anything from this conversation is worth saving, and save it first.`;
}

export function createRecallRouterExtension(layers: RecallLayers & { treeId?: string; store?: AppStore }) {
  return defineExtension({
    name: "recall_router",
    sections: [
      section("recall_router", (input) => {
        if (!layers.treeId || !layers.store) return recallRouterText(layers);
        const session = layers.store.sessionByConversation(layers.treeId, String(input.conversationId));
        if (!session) return recallRouterText(layers);
        const caps = layers.store.agentCapabilities(session.agent_id);
        return recallRouterText({
          memory: layers.memory && caps.memory === "read_write",
          history: layers.memory && caps.chatHistory !== "off",
          knowledge: layers.knowledge && caps.knowledge === "read_write",
        });
      }),
    ],
  });
}
