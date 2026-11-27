import type { StepSummary } from "@rei/protocol";
import type { ReactNode } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { enterIndex, useArrival } from "@/lib/motion.tsx";
import { cn } from "@/lib/utils.ts";
import type { ApprovalOutcomes, ParkedCalls } from "../lib/activity.ts";
import { activityIcon, activityLabel, activityStatus, decidedWord, isApprovedStep } from "../lib/activity.ts";
import { callsText } from "../lib/script.ts";
import { stepLine } from "../lib/trace.ts";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

/** Blocked steps ask for attention, failed ones are red; the rest stay quiet. */
const TONE: Partial<Record<StepSummary["status"], string>> = {
  running: "text-foreground/80",
  blocked: "text-attention-text",
  error: "text-destructive",
};

/** The same description, icon and status in chat and Inspect; technical metadata is secondary in Full mode. */
export function ActivityRow({
  step,
  index = 0,
  onOpen,
  outcomes,
  waitingForApproval,
  parked,
  status: statusOverride,
  calls,
  disabled = false,
  expand,
  children,
}: {
  step: StepSummary;
  index?: number;
  onOpen?: (() => void) | undefined;
  /** What became of each approval in this chat, so a step that was blocked on one reads "Approved", not "Needs approval". */
  outcomes?: ApprovalOutcomes | undefined;
  waitingForApproval?: boolean | undefined;
  /** Calls of the live run that are parked: they read as waiting, not running. */
  parked?: ParkedCalls | undefined;
  /** A status word worked out from more than this step (a script that waits on one of its calls). */
  status?: string | undefined;
  /** For a script: how many calls it made, once known. Said after the label, "· 2 calls". */
  calls?: number | undefined;
  /** A row that is shown but has nothing to open yet (a nested call the trace has not recorded). */
  disabled?: boolean | undefined;
  /** For a row that holds others (a script's nested calls): the toggle that shows or hides them. */
  expand?:
    | { open: boolean; onToggle: (trigger?: HTMLElement | null) => void; controls: string; label: string }
    | undefined;
  /** What sits under the row: its nested calls and approval cards. */
  children?: ReactNode;
}) {
  const arrival = useArrival("fade");
  const label = activityLabel(step);
  const status = statusOverride ?? activityStatus(step, outcomes, waitingForApproval, parked);
  const count = calls === undefined ? "" : callsText(calls);
  const named = count ? `${label} · ${count}` : label;
  // A decided approval stops being a call for attention: approved goes green, the rest go quiet.
  const tone = decidedWord(step, outcomes) ? (isApprovedStep(step, outcomes) ? "text-success" : "") : TONE[step.status];
  const content = (
    <>
      <Icon name={activityIcon(step, outcomes)} size={16} />
      <span className="activity-content min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <Tip label={label}>
            <span className="activity-label block min-w-0 truncate">{label}</span>
          </Tip>
          {count && (
            <span className="activity-calls shrink-0 text-xs tabular-nums text-muted-foreground">· {count}</span>
          )}
          {onOpen && step.page && <PageChip page={step.page} />}
          {onOpen && step.web && <WebChip web={step.web} />}
        </span>
        {onOpen && (
          <span className="activity-meta mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {stepLine(step)}
            {step.sideEffect && (
              <span className="step-effect shrink-0 rounded-full bg-attention-soft px-1.5 text-[0.6875rem] font-semibold text-attention-text">
                acted outside
              </span>
            )}
          </span>
        )}
      </span>
      {step.status !== "ok" && (
        // Keyed by status so the row never jumps: the old word goes, the new one eases in.
        <span key={status} className="activity-status ml-auto shrink-0 text-xs" data-enter="fade">
          {status}
        </span>
      )}
      {onOpen && !disabled && <Icon name="forward" size={14} />}
    </>
  );
  const row =
    "activity-row flex min-w-0 items-center gap-2 text-sm leading-normal text-muted-foreground [&>svg]:shrink-0";
  if (!onOpen) {
    return (
      <li
        className={cn(!children && row, tone)}
        data-status={step.status}
        aria-label={`${named} — ${status}`}
        data-enter={arrival}
        style={enterIndex(index)}
      >
        {children ? (
          <>
            <div className={row}>{content}</div>
            {children}
          </>
        ) : (
          content
        )}
      </li>
    );
  }
  const open = (
    <button
      type="button"
      className={cn(
        row,
        "activity-open w-full rounded-lg px-2 py-1 text-left outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-inherit",
        tone,
      )}
      data-status={step.status}
      disabled={disabled}
      onClick={onOpen}
      aria-label={disabled ? `${named} — ${status}` : `Inspect step: ${named} — ${status}`}
    >
      {content}
    </button>
  );
  return (
    <li data-enter={arrival} style={enterIndex(index)}>
      {expand ? (
        <div className="flex min-w-0 items-center gap-0.5">
          <span className="min-w-0 flex-1">{open}</span>
          <Tip label={expand.label}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground [&>svg]:-rotate-90 [&[aria-expanded=true]>svg]:rotate-0"
              aria-label={expand.label}
              aria-expanded={expand.open}
              aria-controls={expand.controls}
              onClick={(e) => expand.onToggle(e.currentTarget)}
            >
              <Icon name="chevron" size={14} />
            </Button>
          </Tip>
        </div>
      ) : (
        open
      )}
      {children}
    </li>
  );
}

/** The Knowledge page a step read or wrote, shown in Detail mode. Inside Inspect's row button it is a label, not a link. */
function PageChip({ page }: { page: NonNullable<StepSummary["page"]> }) {
  const cls =
    "activity-page inline-flex min-w-0 max-w-56 shrink items-center gap-1 rounded-full border px-1.5 text-xs text-foreground no-underline";
  return (
    <span className={cls} title={page.trashed ? "In Trash" : undefined}>
      <Icon name="page" size={12} className="shrink-0" />
      <span className={cn("truncate", page.trashed && "line-through")}>{page.title}</span>
    </span>
  );
}

/** The page a web_fetch read: its title and host, in Detail mode. */
function WebChip({ web }: { web: NonNullable<StepSummary["web"]> }) {
  return (
    <span
      className="activity-web inline-flex min-w-0 max-w-64 shrink items-center gap-1 rounded-full border px-1.5 text-xs text-foreground"
      title={`${web.title} — ${web.host}`}
    >
      <Icon name="globe" size={12} className="shrink-0" />
      <span className="min-w-6 truncate">{web.title}</span>
      {/* The host gives way first, so a narrow row keeps some of the title. */}
      <span className="min-w-0 shrink-[4] truncate text-muted-foreground">{web.host}</span>
    </span>
  );
}
