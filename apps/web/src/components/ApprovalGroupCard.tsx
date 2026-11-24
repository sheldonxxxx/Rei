import type { Approval, DecideApprovalGroupRequest } from "@rei/protocol";
import { useId, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Card, CardContent } from "@/components/primitives/card.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/primitives/native-select.tsx";
import { describeError } from "../api/client.ts";
import { approvalDescription, executionLabels } from "../lib/approvals.ts";
import { useArrival } from "../lib/motion.tsx";
import { sessionHref } from "../lib/route.ts";
import { ACTIONS, DONE, HEAD, NEEDS_YOU } from "./approvalStyles.ts";
import { Icon } from "./Icon.tsx";

export type DecideGroupFn = (id: string, request: DecideApprovalGroupRequest) => Promise<Approval[]>;
type Decision = DecideApprovalGroupRequest["decisions"][number]["decision"];

const labels = {
  pending: "Awaiting decision",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
};

export function ApprovalGroupCard({
  id,
  approvals,
  chatSessionId,
  agentName,
  messageId,
  onDecide,
}: {
  id: string;
  approvals: Approval[];
  chatSessionId: string;
  agentName?: string | undefined;
  messageId?: string | undefined;
  onDecide: DecideGroupFn;
}) {
  const [choices, setChoices] = useState<Record<string, Decision | undefined>>({});
  const [local, setLocal] = useState<Approval[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const arrival = useArrival("card");
  const shown = approvals
    .map((approval) =>
      approval.status === "pending" ? (local.find((a) => a.id === approval.id) ?? approval) : approval,
    )
    .sort((a, b) => a.number - b.number);
  const pending = shown.filter((approval) => approval.status === "pending");
  const waiting = pending.length > 0;
  const owner = shown[0];

  const submit = async (allowAll: boolean) => {
    const decisions = pending.flatMap((a) => {
      const decision = allowAll ? "approve" : choices[a.id];
      return decision ? [{ id: a.id, decision }] : [];
    });
    if (busy || !decisions.length || decisions.length !== pending.length) return;
    setBusy(true);
    setError(null);
    try {
      setLocal(await onDecide(id, { decisions }));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className="msg msg-approval"
      data-msg-id={messageId}
      data-status={waiting ? "pending" : "decided"}
      data-enter={arrival}
    >
      <Card size="sm" role="article" className={waiting ? NEEDS_YOU : DONE} aria-labelledby={headingId}>
        <CardContent className="flex flex-col gap-2 max-md:px-3.5">
          <p className={HEAD}>
            {waiting && (
              <span className="text-attention-text">
                <Icon name="shield" size={18} />
              </span>
            )}
            <strong id={headingId}>
              {waiting
                ? `Review ${pending.length} connector ${pending.length === 1 ? "read" : "reads"}`
                : "Connector read approvals"}
            </strong>
          </p>
          {owner && (agentName || owner.sessionId !== chatSessionId) && (
            <p className="m-0 text-sm text-muted-foreground">
              {agentName}
              {agentName && owner.sessionId !== chatSessionId ? " · " : ""}
              {owner.sessionId !== chatSessionId && (
                <a className="underline" href={sessionHref(owner.sessionId)}>
                  {owner.sessionTitle}
                </a>
              )}
            </p>
          )}
          <ul className="m-0 list-none divide-y p-0">
            {shown.map((approval) => {
              const { action, target } = approvalDescription(approval);
              return (
                <li key={approval.id} className="flex flex-col gap-1.5 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
                      <span className="font-medium">{action}</span>
                      {target && <span className="block text-muted-foreground">{target}</span>}
                    </div>
                    {approval.status === "pending" ? (
                      <NativeSelect
                        aria-label={`Decision for #${approval.number} ${action}${target ? `, ${target}` : ""}`}
                        value={choices[approval.id] ?? ""}
                        disabled={busy}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          setChoices((old) => ({
                            ...old,
                            [approval.id]: value === "approve" || value === "deny" ? value : undefined,
                          }));
                        }}
                      >
                        <NativeSelectOption value="">Choose…</NativeSelectOption>
                        <NativeSelectOption value="approve">Allow once</NativeSelectOption>
                        <NativeSelectOption value="deny">Deny</NativeSelectOption>
                      </NativeSelect>
                    ) : (
                      <span
                        className={
                          approval.execution && approval.execution !== "ran"
                            ? "text-sm text-destructive"
                            : "text-sm text-muted-foreground"
                        }
                        role="status"
                      >
                        {labels[approval.status]}
                        {approval.execution && ` · ${executionLabels[approval.execution]}`}
                      </span>
                    )}
                  </div>
                  <details className="min-w-0 text-sm text-muted-foreground">
                    <summary className="w-fit cursor-pointer">Arguments</summary>
                    <pre className="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl border bg-muted p-2 font-mono text-xs">
                      {approval.argsPreview}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
          {error && (
            <p className="m-0 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {waiting && (
            <div className={ACTIONS}>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || pending.some((request) => choices[request.id] === "deny")}
                onClick={() => void submit(true)}
              >
                Allow all once
              </Button>
              <Button
                size="sm"
                disabled={busy || pending.some((request) => !choices[request.id])}
                onClick={() => void submit(false)}
              >
                Apply decisions
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </li>
  );
}
