import type { Connector } from "./api.ts";
import type { SkillFile } from "./skills.ts";

/** Portable content. Credentials and installed permissions never belong in a package. */
export interface PluginPackage {
  formatVersion: 1;
  name: string;
  description: string;
  skills: { name: string; files: SkillFile[] }[];
  mcp: { name: string; url: string; auth: "none" | "token" | "oauth"; skills: string[] }[];
}
export interface PluginRevision {
  revision: number;
  author: "user" | "agent";
  sessionId: string | null;
  createdAt: number;
}
export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  revision: number;
  enabled: boolean;
  agents: string[] | null;
  builtIn: boolean;
  skillCount: number;
  connectionCount: number;
}
export interface PluginDetail extends PluginSummary {
  package: PluginPackage;
  selectedRevision: number;
  revisions: PluginRevision[];
  skills: { name: string; id: string; reference: string }[];
  connections: {
    name: string;
    connectorId: string | null;
    status: "pending" | "needs_auth" | "ready" | "error";
    error: string | null;
    connector?: Connector;
  }[];
}
export interface PluginPreview {
  kind: "plugin";
  op: "create" | "update";
  name: string;
  package: PluginPackage;
  fromRevision?: number;
  diff?: string;
}
export interface SavePluginRequest {
  package: PluginPackage;
  /** Required for update. */
  expectedRevision?: number;
}
export interface PluginInstallationRequest {
  enabled?: boolean;
  agents?: string[] | null;
}
