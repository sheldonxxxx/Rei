import type { Agent, Attachment } from "@rei/protocol";
import { createContext, useContext } from "react";
import type { Api } from "../api/client.ts";
export const LibraryContext = createContext<{
  api: Api;
  agents: Agent[];
  defaultAgentId: string;
  reuse?: (file: Attachment, agentId?: string) => Promise<void>;
  ask: (file: Attachment, question: string, sessionId?: string, agentId?: string) => Promise<void>;
} | null>(null);
export const useLibrary = () => useContext(LibraryContext);
