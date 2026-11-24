import type { Agent } from "@rei/protocol";

/** Which agents may use a skill or connector, in a few words: null is every agent. */
export function agentsLine(ids: readonly string[] | null, agents: readonly Agent[]): string {
  if (ids === null) return "All agents";
  const names = agents.filter((a) => ids.includes(a.id)).map((a) => a.name);
  if (names.length === 0) return "No agents";
  if (agents.length > 1 && names.length === agents.length) return "All agents";
  return names.join(", ");
}

/** The agents whose connector setting lets them use this connector. */
export const connectorAgentIds = (connectorId: string, agents: readonly Agent[]): string[] | null =>
  agents.every((a) => a.allowedConnectorIds == null)
    ? null
    : agents
        .filter((a) => a.allowedConnectorIds == null || a.allowedConnectorIds.includes(connectorId))
        .map((a) => a.id);
