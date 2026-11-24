import type { LiveTool, Message, RunTrace, StepSummary } from "@rei/protocol";
import { Fragment, type ReactNode, useId, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import type { ApprovalOutcomes, ParkedCalls } from "../lib/activity.ts";
import { isParkedStep, isScriptStep, isSurfaceStep } from "../lib/activity.ts";
import { useArrival } from "../lib/motion.tsx";
import { isPlaceholder, rowKey, scriptTree, scriptWait } from "../lib/script.ts";
import { duration } from "../lib/trace.ts";
import { ActivityRow } from "./ActivityRow.tsx";
import { Icon } from "./Icon.tsx";

/** Simple mode, while a run is still working, shows only its latest rows; expanding the group by hand shows them all. */
const SIMPLE_LIVE_ROWS = 5;

/** Approval cards that scripts' calls asked for, by the script's call id, and how to draw one. */
export interface ScriptCards {
  byScript: ReadonlyMap<string, Message[]>;
  render: (message: Message) => ReactNode;
}

/** Shared chat activity. Full mode adds model calls, secondary metadata and Inspect to the same rows. */
export function ToolActivity({
  trace,
  onOpen,
  outcomes,
  waitingForApproval = false,
  parked,
  liveCalls,
  cards,
}: {
  trace: RunTrace;
  onOpen?: ((runId: string, stepId: string) => void) | undefined;
  outcomes?: ApprovalOutcomes | undefined;
  waitingForApproval?: boolean;
  /** Calls of the live run that are parked (waiting for something outside the run). */
  parked?: ParkedCalls | undefined;
  /** Calls a script of the live run is making now; one the trace has not recorded yet shows as a row under its script. */
  liveCalls?: readonly LiveTool[] | undefined;
  /** Approval cards a script's calls asked for: drawn under the script's row. */
  cards?: ScriptCards | undefined;
}) {
  const arrival = useArrival("rise");
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const listId = useId();
  // Simple mode: a shown surface is its own evidence, so only a refused surface call keeps a (quiet) row.
  const steps = onOpen
    ? trace.steps
    : trace.steps.filter((s) => s.type === "tool.call" && !(isSurfaceStep(s) && s.status !== "error"));
  // A script's calls are rows of the script, not of the run: the run's own rows are the ones that count and get capped.
  const tree = scriptTree(steps, liveCalls);
  const all = [...tree.top, ...[...tree.calls.values()].flat()];
  const live = trace.run.status === "running" || trace.run.status === "queued";
  // Simple mode: when the run ends, the trace goes back to its collapsed summary, even if the user opened it while it ran.
  // Reset during render, so the finished run never paints the list it was showing while working.
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    if (!live && !onOpen) setExpanded(null);
  }
  const open = expanded ?? live;
  // Simple mode while working: the latest rows only, until the user expands the group by hand.
  const capped = !onOpen && live && expanded === null;
  const shown = capped ? tree.top.slice(-SIMPLE_LIVE_ROWS) : tree.top;
  const acted = all.filter((s) => s.sideEffect).length;
  const { durationMs, approvalWaitMs = 0 } = trace.totals;
  if (tree.top.length === 0) return null;
  // A card whose script row is not drawn (the group is folded, or the row is among the older ones) stays visible below.
  const placed = new Set(open ? shown : []);
  const stray = (cards ? tree.top.filter((s) => isScriptStep(s) && !placed.has(s)) : []).flatMap(
    (s) => cards?.byScript.get(s.toolCallId ?? "") ?? [],
  );
  // A failed run the user went on from reads as interrupted: a later run answers it, so the failure is not its outcome.
  const interrupted = trace.run.status === "failed" && trace.continued === true;
  const verb = interrupted
    ? "Interrupted"
    : trace.run.status === "failed"
      ? "Failed"
      : trace.run.status === "cancelled"
        ? "Stopped"
        : "Worked";
  const heading = live
    ? waitingForApproval
      ? "Waiting for approval"
      : all.some((s) => isParkedStep(s, parked))
        ? "Waiting…"
        : "Working…"
    : verb;
  // "Worked for 4.0 s" but "Failed after 4.0 s": a failure is not something that lasted.
  const joiner = verb === "Worked" ? "for" : "after";
  return (
    <li
      className="msg msg-tool-activity -mt-2 text-sm text-muted-foreground"
      data-run={trace.run.id}
      data-enter={arrival}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="activity-summary -ml-3 tabular-nums text-muted-foreground [&>svg]:-rotate-90 [&[aria-expanded=true]>svg]:rotate-0"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setExpanded(!open)}
      >
        <span>
          {heading}
          {!live && durationMs !== null && (trace.run.status !== "cancelled" || approvalWaitMs === 0)
            ? ` ${joiner} ${duration(Math.max(0, durationMs - approvalWaitMs))}`
            : ""}
        </span>
        <Icon name="chevron" size={14} />
      </Button>
      {!live && approvalWaitMs > 0 && (
        <span className="ml-1 text-xs tabular-nums text-muted-foreground">
          Waited for approval {duration(approvalWaitMs)}
        </span>
      )}
      {onOpen && open && (
        <span className="activity-run-meta ml-1 text-xs text-muted-foreground">
          {all.length} {all.length === 1 ? "step" : "steps"}
          {acted > 0 ? ` · ${acted} acted outside` : ""}
        </span>
      )}
      {open && (
        <ul
          id={listId}
          className="activity-list m-0 flex list-none flex-col gap-1.5 pt-2 pb-0.5 pl-0"
          aria-label="Tool activity"
        >
          {shown.map((s, i) =>
            isScriptStep(s) ? (
              <ScriptRow
                key={rowKey(s)}
                step={s}
                index={i}
                calls={tree.calls.get(s.id) ?? []}
                outcomes={outcomes}
                waitingForApproval={waitingForApproval}
                parked={parked}
                cards={cards}
                onOpen={onOpen ? (stepId) => onOpen(trace.run.id, stepId) : undefined}
              />
            ) : (
              <ActivityRow
                key={s.id}
                step={s}
                index={i}
                outcomes={outcomes}
                waitingForApproval={waitingForApproval}
                parked={parked}
                onOpen={onOpen ? () => onOpen(trace.run.id, s.id) : undefined}
              />
            ),
          )}
        </ul>
      )}
      {stray.length > 0 && cards && <CardList cards={stray} render={cards.render} />}
    </li>
  );
}

/** Approval cards in a list: under a script's row, or below the activity when the row is not drawn. */
function CardList({ cards, render }: { cards: Message[]; render: (message: Message) => ReactNode }) {
  return (
    <ul
      className="script-cards m-0 mt-2 flex list-none flex-col gap-2 p-0 text-foreground"
      aria-label="Asked by a script"
    >
      {cards.map((m) => (
        <Fragment key={m.id}>{render(m)}</Fragment>
      ))}
    </ul>
  );
}

/**
 * A script's row: the script as one row, with its calls shown under it in Full mode and the cards it asked for. The calls open
 * while the script works, and stay as they were when it ends, so nothing under it moves; you can fold them any time.
 */
function ScriptRow({
  step,
  index,
  calls,
  outcomes,
  waitingForApproval,
  parked,
  cards,
  onOpen,
}: {
  step: StepSummary;
  index: number;
  calls: StepSummary[];
  outcomes: ApprovalOutcomes | undefined;
  waitingForApproval: boolean;
  parked: ParkedCalls | undefined;
  cards: ScriptCards | undefined;
  /** Inspect one step of this run (Full mode); undefined in Simple mode, where the calls are not shown. */
  onOpen: ((stepId: string) => void) | undefined;
}) {
  const listId = useId();
  const asked = cards?.byScript.get(step.toolCallId ?? "") ?? [];
  const pending = asked.filter((m) => m.approval?.status === "pending").length;
  const [chosen, setChosen] = useState<boolean | null>(null);
  const working = step.status === "running";
  // Opens when it is first seen working and then stays, so finishing never closes it under the pointer.
  const [auto, setAuto] = useState(working);
  if (working && !auto) setAuto(true);
  const open = chosen ?? auto;
  const full = onOpen !== undefined;
  const known = calls.length > 0 || step.status === "ok";
  const wait = scriptWait(step, calls, pending, outcomes, waitingForApproval, parked);
  return (
    <ActivityRow
      step={step}
      index={index}
      outcomes={outcomes}
      waitingForApproval={waitingForApproval}
      parked={parked}
      status={wait ?? undefined}
      calls={known ? calls.length : undefined}
      onOpen={onOpen ? () => onOpen(step.id) : undefined}
      expand={
        full && calls.length > 0
          ? {
              open,
              onToggle: () => setChosen(!open),
              controls: listId,
              label: open ? "Hide the script's calls" : "Show the script's calls",
            }
          : undefined
      }
    >
      {full && open && calls.length > 0 && (
        <ul
          id={listId}
          className="activity-nested m-0 mt-1 ml-3 flex list-none flex-col gap-1 border-l pl-3"
          aria-label="Calls made by the script"
        >
          {calls.map((c, i) => (
            <ActivityRow
              key={rowKey(c)}
              step={c}
              index={i}
              outcomes={outcomes}
              waitingForApproval={waitingForApproval}
              parked={parked}
              disabled={isPlaceholder(c)}
              onOpen={onOpen ? () => onOpen(c.id) : undefined}
            />
          ))}
        </ul>
      )}
      {asked.length > 0 && cards && <CardList cards={asked} render={cards.render} />}
    </ActivityRow>
  );
}
