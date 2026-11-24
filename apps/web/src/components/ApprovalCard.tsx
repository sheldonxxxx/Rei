import type { Approval, DecideApprovalRequest, GrantLength } from "@rei/protocol";
import { useId, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Card, CardContent } from "@/components/primitives/card.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { cn } from "@/lib/utils.ts";
import { ApiError, describeError } from "../api/client.ts";
import { approvalDescription, executionLabels } from "../lib/approvals.ts";
import { mcpTarget, useConnectorNames } from "../lib/connectors.tsx";
import { useArrival } from "../lib/motion.tsx";
import { CLASS_LABEL, decisionLabel, taintWarning } from "../lib/policy.ts";
import { connectorHref } from "../lib/route.ts";
import { formatWhen, timeLeft } from "../lib/time.ts";
import { useNow } from "../lib/useNow.ts";
import { ApprovalPreview } from "./ApprovalPreview.tsx";
import { ACTIONS, DONE, FACTS, HEAD, NEEDS_YOU, SUMMARY } from "./approvalStyles.ts";
import type { IconName } from "./Icon.tsx";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

const sessionHref = (id: string) => `/s/${encodeURIComponent(id)}`;

export type DecideFn = (approvalId: string, req: DecideApprovalRequest) => Promise<Approval>;

interface Props {
  approval: Approval;
  agentName?: string | undefined;
  /** The chat this card is shown in; a card for another session (the parent-chat mirror) says where it is from. */
  chatSessionId: string;
  /** Omit to show the card read-only. */
  onDecide?: DecideFn | undefined;
}

const LENGTH_LABEL: Record<GrantLength, string> = {
  once: "Just this once",
  session: "For this chat",
  web_session: "All web for this chat",
  agent: "For this agent",
  hours: "For a number of hours",
  always: "Always",
  trigger: "For this trigger",
};
const MAX_HOURS = 168;

/** In a trigger's run the server adds "trigger" last; it is the likeliest choice after "once", so it goes right after it. */
function grantOrder(lengths: GrantLength[]): GrantLength[] {
  if (!lengths.includes("trigger")) return lengths;
  const rest = lengths.filter((l) => l !== "trigger");
  const at = rest.indexOf("once") + 1;
  return [...rest.slice(0, at), "trigger", ...rest.slice(at)];
}

/**
 * A blocked call waiting for you, or what became of it. This is the app's own UI, not model text: it is drawn from
 * structured fields only, and the tool's arguments are shown as plain text.
 */
export function ApprovalCard({ approval, agentName, chatSessionId, onDecide }: Props) {
  const arrival = useArrival("card");
  // What this device decided, kept so the card is right at once, before the stream catches up.
  const [local, setLocal] = useState<Approval | null>(null);
  const shown = approval.status === "pending" && local ? local : approval;
  const pending = shown.status === "pending";
  return (
    <li className="msg msg-approval" data-status={shown.status} data-enter={arrival}>
      {pending ? (
        <PendingCard
          approval={shown}
          agentName={agentName}
          chatSessionId={chatSessionId}
          onDecide={onDecide}
          onDecided={setLocal}
        />
      ) : (
        <DecidedCard approval={shown} agentName={agentName} chatSessionId={chatSessionId} />
      )}
    </li>
  );
}

function Facts({ approval, agentName, chatSessionId }: Pick<Props, "approval" | "agentName" | "chatSessionId">) {
  const elsewhere = approval.sessionId !== chatSessionId;
  const names = useConnectorNames();
  const mcp = approval.connector === "mcp" ? mcpTarget(approval.destination, names) : null;
  return (
    <dl className={FACTS}>
      <div>
        <dt>Requested by</dt>
        <dd>{agentName ?? approval.agentId}</dd>
      </div>
      {mcp ? (
        <>
          <div>
            <dt>App</dt>
            <dd>{mcp.app}</dd>
          </div>
          <div>
            <dt>Tool</dt>
            <dd>{mcp.tool}</dd>
          </div>
        </>
      ) : (
        <div>
          <dt>Action</dt>
          <dd>
            {approval.connector} · {approval.operation}
          </dd>
        </div>
      )}
      {!mcp && approval.destination && (
        <div>
          <dt>Destination</dt>
          <dd>{approval.destination}</dd>
        </div>
      )}
      {approval.parentCallId && (
        <div>
          <dt>Asked by</dt>
          <dd>A script</dd>
        </div>
      )}
      {elsewhere && (
        <div>
          <dt>Chat</dt>
          <dd>
            In <a href={sessionHref(approval.sessionId)}>{approval.sessionTitle}</a>
          </dd>
        </div>
      )}
    </dl>
  );
}

function Args({ text, id }: { text: string; id: string }) {
  return (
    <pre
      id={id}
      className="approval-args m-0 max-h-64 overflow-auto rounded-xl border bg-muted p-3 font-mono text-xs leading-relaxed [.float-cards_&]:max-h-36"
      tabIndex={0}
      role="group"
      aria-label="Exact arguments"
    >
      <code className="font-[inherit] whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</code>
    </pre>
  );
}

function PendingCard({
  approval,
  agentName,
  chatSessionId,
  onDecide,
  onDecided,
}: Omit<Props, "onDecide"> & {
  onDecide: DecideFn | undefined;
  onDecided: (a: Approval) => void;
}) {
  const now = useNow(30_000);
  const headId = useId();
  const argsId = useId();
  const lengthName = useId();
  const [showArgs, setShowArgs] = useState(false);
  const [length, setLength] = useState<GrantLength>("once");
  const [hoursText, setHoursText] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lengths = approval.connector !== "mcp" && approval.lengths.length > 1 ? grantOrder(approval.lengths) : [];
  const destinationLabel = lengths.includes("web_session")
    ? "This destination for this chat"
    : approval.connector === "browser" && approval.operation === "type"
      ? "This site for this chat"
      : LENGTH_LABEL.session;
  const hours = Number(hoursText);
  const hoursOk = Number.isInteger(hours) && hours >= 1 && hours <= MAX_HOURS;
  const canApprove = !busy && !!onDecide && (length !== "hours" || hoursOk);

  async function decide(decision: "approve" | "deny") {
    if (!onDecide) return;
    setBusy(true);
    setError(null);
    const req: DecideApprovalRequest =
      decision === "deny" ? { decision } : { decision, length, ...(length === "hours" ? { hours } : {}) };
    try {
      const done = await onDecide(approval.id, req);
      onDecided(done);
    } catch (e) {
      setError(e instanceof ApiError && e.code === "not_found" ? "This request no longer exists." : describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="sm" role="article" className={NEEDS_YOU} aria-labelledby={headId}>
      <CardContent className="flex flex-col gap-2.5 max-md:px-3.5">
        <p className={HEAD}>
          <span className="approval-icon inline-grid shrink-0 text-attention-text" aria-hidden="true">
            <Icon name="shield" size={18} />
          </span>
          <strong id={headId} className="font-semibold">
            Approval needed
          </strong>
          <span className="approval-num text-xs tabular-nums text-muted-foreground">#{approval.number}</span>
          <Badge variant="secondary" className="class-chip bg-attention-soft text-attention-text">
            {CLASS_LABEL[approval.actionClass]}
          </Badge>
          <span className="approval-expiry ml-auto text-xs text-muted-foreground max-md:ml-0 max-md:basis-full [.float-cards_&]:ml-0 [.float-cards_&]:basis-full">
            Expires in {timeLeft(approval.expiresAt, now)}
          </span>
        </p>
        {approval.parentCallId && (
          <p className="approval-script m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name="code" size={14} />
            Asked by a script
          </p>
        )}
        <RequestSummary approval={approval} agentName={agentName} chatSessionId={chatSessionId} />
        {/* No taint chips in Simple mode: the one sentence says why to look closely. */}
        {approval.taint.length > 0 && (
          <p className="approval-warn m-0 flex items-start gap-2 text-sm text-attention-text">
            {taintWarning(approval.taint, approval.actionClass)}
          </p>
        )}
        {approval.actionClass === "memory_write" && (
          <p className="approval-note m-0 text-sm text-muted-foreground">
            {approval.destination?.startsWith("agent:")
              ? "This memory belongs to the requesting assistant."
              : "Profile memory is shared with every assistant."}
          </p>
        )}
        {approval.actionClass === "configure" && (
          <p className="approval-note m-0 text-sm text-muted-foreground">
            Change it later on the{" "}
            {approval.preview?.kind === "trigger"
              ? "Triggers page"
              : approval.preview?.kind === "skill"
                ? "Skills page"
                : "Triggers or Skills page"}
            .
          </p>
        )}
        {approval.actionClass === "irreversible" && (
          <p className="m-0 flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive">
            <Icon name="alert" size={16} />
            <span>This can't be undone.</span>
          </p>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="disclosure -ml-2 self-start text-muted-foreground [&[aria-expanded=true]>svg]:rotate-180"
          aria-expanded={showArgs}
          aria-controls={argsId}
          onClick={() => setShowArgs((v) => !v)}
        >
          <Icon name="chevron" size={14} />
          Details
        </Button>
        {showArgs && (
          <div id={argsId} className="flex flex-col gap-2">
            {approval.preview?.kind === "mcp-provider" && <ApprovalPreview preview={approval.preview} />}
            <Args text={approval.argsPreview} id={`${argsId}-raw`} />
          </div>
        )}

        {lengths.length > 0 && (
          <fieldset className="approval-length m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0" disabled={busy}>
            <legend className="mb-1 p-0 text-xs font-medium text-muted-foreground">Allow</legend>
            {lengths.map((l) => (
              <div key={l} className="choice-row flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="choice flex min-h-9 cursor-pointer items-center gap-2.5 rounded-xl px-2 text-sm has-checked:bg-attention-soft max-md:min-h-11">
                  <input
                    type="radio"
                    className="m-0 size-4 shrink-0 accent-primary"
                    name={lengthName}
                    value={l}
                    checked={length === l}
                    onChange={() => setLength(l)}
                  />
                  <span className={l === "always" ? "font-semibold" : undefined}>
                    {l === "session" ? destinationLabel : LENGTH_LABEL[l]}
                  </span>
                </label>
                {l === "hours" && length === "hours" && (
                  <span className="hours-field inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Input
                      type="number"
                      inputMode="numeric"
                      className="h-8 w-20 px-3"
                      min={1}
                      max={MAX_HOURS}
                      step={1}
                      value={hoursText}
                      aria-label="Hours"
                      aria-invalid={!hoursOk}
                      onChange={(e) => setHoursText(e.target.value)}
                    />
                    <span aria-hidden="true">hours</span>
                  </span>
                )}
              </div>
            ))}
            {length !== "once" && (
              <p className="m-0 mt-1 px-2 text-sm text-attention-text">
                Matching actions can run without asking while this grant is active.
              </p>
            )}
            {length === "web_session" && (
              <p className="m-0 text-sm text-muted-foreground">
                Search queries and page URLs may contain information from this chat.
              </p>
            )}
            {length === "hours" && !hoursOk && (
              <p className="field-hint m-0 text-sm text-destructive">Enter 1 to {MAX_HOURS} hours.</p>
            )}
          </fieldset>
        )}

        {error && (
          <p role="alert" className="form-error m-0">
            {error}
          </p>
        )}
        <div className={ACTIONS}>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !onDecide}
            aria-busy={busy}
            onClick={() => void decide("deny")}
          >
            Deny
          </Button>
          <Button type="button" disabled={!canApprove} aria-busy={busy} onClick={() => void decide("approve")}>
            {approval.connector === "mcp" ? "Allow once" : "Approve"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RequestSummary({
  approval,
  agentName,
  chatSessionId,
}: Pick<Props, "approval" | "agentName" | "chatSessionId">) {
  const { action, target } = approvalDescription(approval);
  const preview = approval.preview;
  return (
    <>
      <p className={SUMMARY}>{action}</p>
      {target && <p className="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">{target}</p>}
      {(preview?.kind !== "mcp-provider" || approval.sessionId !== chatSessionId) && (
        <Facts approval={approval} agentName={agentName} chatSessionId={chatSessionId} />
      )}
      {preview?.kind === "mcp-provider" ? (
        <p className="approval-note m-0 text-sm text-muted-foreground">
          Only this exact call. <a href={connectorHref(preview.connectorId)}>Review connector permissions</a>.
        </p>
      ) : preview ? (
        <ApprovalPreview preview={preview} />
      ) : null}
    </>
  );
}

const DECIDED_ICON: Record<Approval["status"], IconName> = {
  pending: "shield",
  approved: "check",
  denied: "close",
  expired: "clock",
  cancelled: "square",
};
const DECIDED_TONE: Partial<Record<Approval["status"], string>> = {
  approved: "text-success",
  denied: "text-destructive",
};

function DecidedCard({ approval, agentName, chatSessionId }: Omit<Props, "onDecide">) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const argsId = useId();
  const [showRaw, setShowRaw] = useState(false);
  const when = approval.decidedAt ?? approval.createdAt;
  const { action, target } = approvalDescription(approval);
  const failed = approval.execution === "failed";
  const needsAttention = approval.execution === "interrupted" || approval.execution === "needs_approval";
  const icon = failed || needsAttention ? "alert" : DECIDED_ICON[approval.status];
  const tone = failed ? "text-destructive" : needsAttention ? "text-attention-text" : DECIDED_TONE[approval.status];
  const withdrawn = approval.status === "cancelled" && approval.cancelReason === "script_ended";
  const outcome = withdrawn
    ? "The script that asked for this ended"
    : approval.execution
      ? executionLabels[approval.execution]
      : approval.resumesTool && approval.status === "approved"
        ? "Resuming"
        : null;
  return (
    <Card
      size="sm"
      role="article"
      className={cn(DONE, `approval-${approval.status}`)}
      aria-label={`${decisionLabel(approval)}: ${approval.summary}`}
    >
      <CardContent className="px-3">
        <div className="approval-done-line flex items-start gap-2 text-sm text-foreground/80">
          <span
            className={cn("approval-icon mt-0.5 inline-grid shrink-0 text-muted-foreground", tone)}
            aria-hidden="true"
          >
            <Icon name={icon} size={16} />
          </span>
          <span className="approval-done-text min-w-0 flex-1 pt-px [overflow-wrap:anywhere]">
            <strong className="font-semibold text-foreground">{decisionLabel(approval)}</strong>
            {outcome && (
              <span role="status" className={failed || needsAttention ? tone : undefined}>
                {" "}
                · {outcome}
              </span>
            )}
            <span className="approval-done-summary text-muted-foreground">
              {" "}
              · {action}
              {target ? ` · ${target}` : ""}
              {approval.parentCallId ? " · Asked by a script" : ""}
            </span>
          </span>
          <time
            className="approval-time shrink-0 pt-0.5 text-xs whitespace-nowrap text-muted-foreground"
            dateTime={new Date(when).toISOString()}
          >
            {formatWhen(when)}
          </time>
          <Tip label="Details">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-my-0.5 text-muted-foreground [&[aria-expanded=true]>svg]:rotate-180"
              aria-label="Details"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((v) => !v)}
            >
              <Icon name="chevron" size={16} />
            </Button>
          </Tip>
        </div>
        {open && (
          <div id={panelId} className="approval-done-body mt-2 flex flex-col gap-2.5 border-t pt-2.5 pl-6">
            <Facts approval={approval} agentName={agentName} chatSessionId={chatSessionId} />
            {approval.preview && <ApprovalPreview preview={approval.preview} />}
            {approval.preview ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="disclosure -ml-2 self-start text-muted-foreground [&[aria-expanded=true]>svg]:rotate-180"
                  aria-expanded={showRaw}
                  aria-controls={argsId}
                  onClick={() => setShowRaw((v) => !v)}
                >
                  <Icon name="chevron" size={14} />
                  Raw arguments
                </Button>
                {showRaw && <Args text={approval.argsPreview} id={argsId} />}
              </>
            ) : (
              <Args text={approval.argsPreview} id={argsId} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
