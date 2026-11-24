import type { SessionStatus } from "@rei/protocol";
import { Badge } from "@/components/primitives/badge.tsx";
import { cn } from "@/lib/utils.ts";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

const LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Running",
  waiting_for_user: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const HELP: Record<SessionStatus, string> = {
  idle: "Ready for a message",
  running: "Working on it now",
  waiting_for_user: "Needs an approval or you in the browser",
  completed: "Finished",
  failed: "Stopped with an error",
  cancelled: "Stopped before it finished",
};

/** A session's state as a labelled pill (the sessions panel); the text always says it, colour only backs it up. The tooltip adds a gloss. */
export function StatusChip({ status }: { status: SessionStatus }) {
  return (
    <Tip label={HELP[status]}>
      <Badge
        variant={status === "failed" ? "destructive" : "secondary"}
        className={cn(
          `chip chip-${status}`,
          status === "waiting_for_user" && "bg-attention-soft text-attention-text",
          status === "completed" && "[&>svg]:text-success",
        )}
      >
        {status === "running" ? (
          <span
            className="status-dot status-running size-2.5 shrink-0 animate-spin rounded-full border-2 border-input border-t-primary"
            aria-hidden="true"
          />
        ) : status === "waiting_for_user" ? (
          <span
            className="status-dot status-waiting_for_user size-2 shrink-0 rounded-full bg-warning"
            aria-hidden="true"
          />
        ) : status === "completed" ? (
          <Icon name="check" size={12} />
        ) : status === "failed" ? (
          <Icon name="alert" size={12} />
        ) : status === "cancelled" ? (
          <Icon name="square" size={12} />
        ) : null}
        {LABEL[status]}
      </Badge>
    </Tip>
  );
}
