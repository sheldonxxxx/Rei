import type { Approval, Message } from "@rei/protocol";

export const executionLabels: Record<NonNullable<Approval["execution"]>, string> = {
  ran: "Ran",
  failed: "Failed",
  needs_approval: "Fresh approval needed",
  interrupted: "Interrupted · May have run",
};

const TARGET_FIELDS = ["to", "recipient", "destination", "query", "url", "path", "title", "name", "id"];

/** A short label for the stored, display-safe call. The full arguments remain available in Details. */
export function approvalDescription(approval: Approval): { action: string; target?: string } {
  const preview = approval.preview;
  if (preview?.kind !== "mcp-provider") return { action: approval.summary };
  const prefix = `${preview.connectorName.toLowerCase()}-`;
  const name = preview.tool.replaceAll("_", "-");
  const verb = (name.toLowerCase().startsWith(prefix) ? name.slice(prefix.length) : name).replaceAll("-", " ");
  const action = `${preview.connectorName} · ${verb.charAt(0).toUpperCase()}${verb.slice(1)}`;
  try {
    const args = (JSON.parse(approval.argsPreview) as { arguments?: Record<string, unknown> }).arguments ?? {};
    const entries = Object.entries(args);
    const first = TARGET_FIELDS.map((key) => entries.find(([field]) => field === key)).find(Boolean) ?? entries[0];
    if (!first) return { action };
    const [key, value] = first;
    const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : JSON.stringify(value);
    const short = text.length > 128 ? `${text.slice(0, 127)}…` : text;
    return { action, target: `${key.replaceAll("_", " ")} “${short}”` };
  } catch {
    return { action: approval.summary };
  }
}

export function approvalGroups(approvals: Approval[]): Map<string, Approval[]> {
  const groups = new Map<string, Approval[]>();
  for (const request of approvals) {
    const id = request.groupId;
    if (!id) continue;
    const group = groups.get(id);
    if (group) group.push(request);
    else groups.set(id, [request]);
  }
  return groups;
}

/**
 * A run's approval card belongs under its activity ("Worked for") and above the reply: you decide before reading the
 * answer that depended on the call. The server files the card after the run's last item, so move it just before that
 * run's reply. A card whose run has no reply in view stays where it is.
 */
export function liftApprovalCards(messages: Message[]): Message[] {
  const replyAt = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.runId !== null) replyAt.set(m.runId, i);
  });
  if (replyAt.size === 0) return messages;

  const lifted = new Set<Message>();
  const byRun = new Map<string, Message[]>();
  for (const m of messages) {
    if (m.role !== "approval" || m.runId === null || !replyAt.has(m.runId)) continue;
    lifted.add(m);
    byRun.set(m.runId, [...(byRun.get(m.runId) ?? []), m]);
  }
  if (lifted.size === 0) return messages;

  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.runId !== null && replyAt.get(m.runId) === i)
      out.push(...(byRun.get(m.runId) ?? []));
    if (!lifted.has(m)) out.push(m);
  }
  return out;
}
