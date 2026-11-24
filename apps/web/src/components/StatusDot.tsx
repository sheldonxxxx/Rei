import type { SessionStatus } from "@rei/protocol";
import { cn } from "@/lib/utils.ts";
import { Tip } from "./Tip.tsx";

const LABEL: Partial<Record<SessionStatus, string>> = {
  running: "Running",
  failed: "Failed",
  waiting_for_user: "Waiting for you",
};

/** The word for a status the dot shows (nothing for idle, completed and cancelled). */
export function statusLabel(status: SessionStatus): string | undefined {
  return LABEL[status];
}

const LOOK: Partial<Record<SessionStatus, string>> = {
  running: "size-3 animate-spin border-2 border-input border-t-primary",
  failed: "bg-destructive",
  waiting_for_user: "bg-warning ring-[3px] ring-attention-soft",
};

/** Status indicator for the session list; renders nothing for idle, completed and cancelled sessions.
 *  The label is always its accessible name; `tip={false}` leaves the hover text to a tooltip on the whole row. */
export function StatusDot({ status, tip = true }: { status: SessionStatus; tip?: boolean }) {
  const label = LABEL[status];
  if (!label) return null;
  const dot = (
    <span
      className={cn("status-dot inline-block size-2 shrink-0 rounded-full", `status-${status}`, LOOK[status])}
      role="img"
      aria-label={label}
    />
  );
  return tip ? <Tip label={label}>{dot}</Tip> : dot;
}
