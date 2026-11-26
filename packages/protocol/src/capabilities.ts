export const READ_WRITE_ACCESS = ["off", "read", "read_write"] as const;
export type ReadWriteAccess = (typeof READ_WRITE_ACCESS)[number];

export const SCOPE_ACCESS = ["off", "own", "all"] as const;
export type ScopeAccess = (typeof SCOPE_ACCESS)[number];

/** Per-agent switches controlling which tools, context layers, and side effects the agent may use. */
export interface AgentCapabilities {
  sandbox: boolean;
  web: boolean;
  browser: boolean;
  library: ReadWriteAccess;
  images: boolean;
  knowledge: ReadWriteAccess;
  memory: ReadWriteAccess;
  chatHistory: ScopeAccess;
  triggers: ScopeAccess;
  delegation: ScopeAccess;
}

export type AgentCapabilitiesPatch = Partial<AgentCapabilities>;

export const DEFAULT_AGENT_CAPABILITIES: Readonly<AgentCapabilities> = {
  sandbox: true,
  web: true,
  browser: true,
  library: "read_write",
  images: true,
  knowledge: "read_write",
  memory: "read_write",
  chatHistory: "all",
  triggers: "own",
  delegation: "all",
};

/** Resolves stored or partial capabilities with defaults and the legacy cross-agent trigger flag. */
export function resolveAgentCapabilities(
  capabilities?: AgentCapabilitiesPatch | null,
  legacyCanCreateTriggersForOtherAgents?: boolean,
): AgentCapabilities {
  return {
    sandbox: capabilities?.sandbox ?? DEFAULT_AGENT_CAPABILITIES.sandbox,
    web: capabilities?.web ?? DEFAULT_AGENT_CAPABILITIES.web,
    browser: capabilities?.browser ?? DEFAULT_AGENT_CAPABILITIES.browser,
    library: capabilities?.library ?? DEFAULT_AGENT_CAPABILITIES.library,
    images: capabilities?.images ?? DEFAULT_AGENT_CAPABILITIES.images,
    knowledge: capabilities?.knowledge ?? DEFAULT_AGENT_CAPABILITIES.knowledge,
    memory: capabilities?.memory ?? DEFAULT_AGENT_CAPABILITIES.memory,
    chatHistory: capabilities?.chatHistory ?? DEFAULT_AGENT_CAPABILITIES.chatHistory,
    triggers:
      capabilities?.triggers ??
      (legacyCanCreateTriggersForOtherAgents === true ? "all" : DEFAULT_AGENT_CAPABILITIES.triggers),
    delegation: capabilities?.delegation ?? DEFAULT_AGENT_CAPABILITIES.delegation,
  };
}
