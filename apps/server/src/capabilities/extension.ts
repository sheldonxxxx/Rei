// The "capabilities" extension: the search_capabilities tool and the Capabilities index, the one prompt section that says
// what can be loaded (deferred tool groups, the agent's connectors, its skills). It replaces the separate skills,
// plugins, connectors and deferred-tools sections. Its text depends only on what capabilities exist, so it stays
// byte-identical between changes and the prompt cache holds.

import type { Extension } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { DEFAULT_AGENT_CAPABILITIES } from "@rei/protocol";
import { policyTool, type ToolCatalog } from "../pi/policy-ext.ts";
import { steadyText } from "../pi/steady-section.ts";
import { agentAllowsGroup } from "./agent-access.ts";
import { DEFERRED_GROUPS } from "./groups.ts";
import { type ConnectorToolLookup, type SearchDeps, searchCapabilitiesTool } from "./search.ts";

/** Skills shown in the index; the rest are found by search. */
export const INDEX_SKILLS = 30;
const SKILL_LINE = 100;

/** A connector as the index shows it. */
export interface IndexConnector {
  name: string;
  tools: number;
  /** Why it cannot be used now ("needs sign-in", "error"); absent when ready. */
  state?: string;
}

export interface ConnectorIndexSource extends ConnectorToolLookup {
  /** The connectors this agent may use, in a stable order. */
  forAgent(agentId: string): IndexConnector[];
}

export interface CapabilitiesDeps extends Omit<SearchDeps, "connectors"> {
  catalog: ToolCatalog;
  connectors?: ConnectorIndexSource;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

export function createCapabilitiesExtension(deps: CapabilitiesDeps): Extension {
  const { catalog, store, treeId, groups } = deps;
  const tool = searchCapabilitiesTool(deps);
  const search = policyTool(
    catalog,
    {
      actionClass: "read_internal",
      connector: "capabilities",
      operation: "search",
      summary: (a: { query?: unknown; load?: unknown }) =>
        typeof a.query === "string" && a.query.trim() !== ""
          ? `Search capabilities: "${clip(a.query, 120)}"`
          : `Load ${Array.isArray(a.load) ? a.load.join(", ") : "tools"}`,
    },
    tool as never,
  );

  /** The index for one agent; undefined when there is nothing to load. */
  const index = (agentId: string): string | undefined => {
    const parts: string[] = [];
    const caps = store.agentCapabilities?.(agentId) ?? DEFAULT_AGENT_CAPABILITIES;
    const present = groups.deferredGroups().filter((g) => agentAllowsGroup(caps, g));
    if (present.length > 0)
      parts.push(
        "Deferred tool groups (one search or load brings the whole group):",
        ...present.map((g) => `- ${g}: ${DEFERRED_GROUPS[g]}`),
      );
    const connectors = deps.connectors?.forAgent(agentId) ?? [];
    if (connectors.length > 0)
      parts.push(
        "Connectors (their tools load one by one; prefer them over the browser for the same app):",
        ...connectors.map(
          (c) => `- ${c.name}${c.state ? ` — ${c.state}` : ` (${c.tools} tool${c.tools === 1 ? "" : "s"})`}`,
        ),
      );
    const skills = deps.skills?.list(agentId) ?? [];
    if (skills.length > 0) {
      // Most used first when there are more than fit, then by name, so the text changes only when the set does.
      const uses = skills.length > INDEX_SKILLS ? (deps.skills?.useCounts() ?? new Map()) : new Map<string, number>();
      const named = skills.map((s) => ({
        name: deps.plugins?.skillInfo(s.id)?.reference ?? s.name,
        description: s.description,
        uses: uses.get(s.id) ?? 0,
      }));
      const shown = [...named]
        .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
        .slice(0, INDEX_SKILLS)
        .sort((a, b) => a.name.localeCompare(b.name));
      parts.push(
        "Skills (read one with use_skill when a task matches it):",
        ...shown.map((s) => `- ${s.name}: ${clip(flat(s.description), SKILL_LINE)}`),
        ...(named.length > shown.length
          ? [`(${named.length - shown.length} more skills: search_capabilities finds them.)`]
          : []),
      );
    }
    if (parts.length === 0) return undefined;
    // Pi wraps a section in a tag of its name, so the text has none of its own.
    return [
      'Not everything you can use is in your tool list. Use search_capabilities with a short description of the task (e.g. "read a file in a GitHub repo") to load what it needs, or load exact names. Loading grants nothing; approvals still apply.',
      ...parts,
    ].join("\n");
  };

  return defineExtension({
    name: "capabilities",
    tools: [search],
    sections: [
      section("capabilities", (input) => {
        try {
          const session = store.sessionByConversation(treeId, String(input.conversationId));
          return session ? steadyText(index(session.agent_id), "No deferred tools, connectors or skills.") : undefined;
        } catch {
          return undefined;
        }
      }),
    ],
  });
}
