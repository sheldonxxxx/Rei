import type { Approval, Message, Session, Takeover } from "@rei/protocol";
import { hostOf } from "./browser.ts";

/** The agent's newest reply in this chat (still streaming or not). */
export function latestAssistant(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return m;
  }
  return undefined;
}

/** What waits for you in this chat: blocked calls to approve and the agent's request to take over the browser. */
export function waitingFor(
  messages: Message[],
  session: Session | null,
): { approvals: Approval[]; takeover: Takeover | null } {
  const approvals: Approval[] = [];
  let takeover: Takeover | null = null;
  for (const m of messages) {
    if (m.role === "approval" && m.approval?.status === "pending") approvals.push(m.approval);
    if (m.role === "takeover" && m.takeover?.status === "pending" && m.takeover.requestedBy === "agent")
      takeover = m.takeover;
  }
  const open = session?.browser?.takeover;
  if (!takeover && open?.status === "pending" && open.requestedBy === "agent") takeover = open;
  return { approvals, takeover };
}

export interface AssistantStatus {
  kind: "needs" | "working" | "idle";
  /** "Working…", "Needs you", "Idle". */
  label: string;
  /** What it is doing right now, when known. */
  detail: string | null;
}

/**
 * The one-line state of the agent. The protocol carries no tool-call parts, so "what it is doing" is the page its
 * browser window is on while a run is going.
 */
export function assistantStatus(opts: { waiting: number; running: boolean; session: Session | null }): AssistantStatus {
  if (opts.waiting > 0) return { kind: "needs", label: "Needs you", detail: null };
  if (opts.running) {
    const host = hostOf(opts.session?.browser?.url);
    return { kind: "working", label: "Working…", detail: host ? `on ${host}` : null };
  }
  return { kind: "idle", label: "Idle", detail: null };
}

/** The first non-empty line of a reply with the markdown marks that make it read badly in a bubble taken off. */
export function firstLine(text: string | undefined): string {
  for (const raw of (text ?? "").split("\n")) {
    const line = raw
      .replace(/^\s*(#{1,6}|[-*+>]|\d+[.)])\s+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (line) return line;
  }
  return "";
}
