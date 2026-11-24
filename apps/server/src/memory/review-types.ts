import type { MemoryDoc } from "@rei/protocol";

/** Created by the scheduler from first-party rows, never from tool arguments. */
export interface ReviewSource {
  runId: string;
  id: string;
  sessionId: string;
  agentId: string;
  text: string;
  createdAt: number;
}
export interface ReviewAuthority {
  agentId: string;
  revision: number;
  sources: readonly ReviewSource[];
  jobId?: string;
  /** A durable background attempt validates immutable Pi source references and its cancellation fence. */
  validateSources?: () => boolean;
  commitOutcome?: (applied: boolean) => void;
}
export interface ReviewChange {
  op: "add" | "replace" | "remove" | "confirm";
  doc: MemoryDoc;
  id?: string;
  text?: string;
  sourceMessageId: string;
}
export type ReviewResult =
  | {
      ok: true;
      applied: boolean;
      revision: number;
      remaining: { user: number; agent: number };
    }
  | {
      ok: false;
      code: string;
      requiredFreeTokens?: { user: number; agent: number };
      remaining?: { user: number; agent: number };
    };
