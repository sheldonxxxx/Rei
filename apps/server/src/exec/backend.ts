// What the tools and the workspace lifecycle need from the place commands run in (the exec container over ssh, or a local
// folder in faux mode). Implemented in src/node/ (ssh and child processes are Node only).
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export interface ExecBackend {
  readonly mode: "ssh" | "local";
  /** Where a workspace is, as the sandbox sees it (`/workspace/<id>`). Raw backends accept agent workspace ids. */
  cwd(treeId: string): string;
  /** The environment for a tree; cheap, no I/O (Pi builds it at every model call and tool use). Throws on a bad tree id. */
  env(treeId: string): ExecutionEnv;
  /** Before a tool call: the sandbox answers, and the workspace exists. Throws an Error whose message is for the model. */
  ready(treeId: string): Promise<void>;
  /** Drops the connection to the sandbox and starts a fresh one (a call that did not answer; the old one is gone). */
  reset(): void;
  /** Removes a workspace (rm -rf). Throws when the sandbox cannot be reached. */
  purge(treeId: string): Promise<void>;
  close(): Promise<void>;
}

/** Tree ids are our own, but they go into a path, so they are checked first. */
export const TREE_ID = /^[A-Za-z0-9_-]+$/;
export function checkTreeId(treeId: string): string {
  if (!TREE_ID.test(treeId)) throw new Error("invalid tree id");
  return treeId;
}

export const UNAVAILABLE = "The sandbox is not available right now.";
export const PREPARE_FAILED = "The sandbox workspace could not be prepared.";
