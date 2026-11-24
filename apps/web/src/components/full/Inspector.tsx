import type { Agent, Message, RunTrace, Session, Surface } from "@rei/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { cn } from "@/lib/utils.ts";
import type { Api } from "../../api/client.ts";
import type { ApprovalOutcomes } from "../../lib/activity.ts";
import { approvalOutcomes } from "../../lib/quiet.ts";
import { sessionHref } from "../../lib/route.ts";
import { formatWhen } from "../../lib/time.ts";
import { duration } from "../../lib/trace.ts";
import type { TraceState } from "../../lib/useTrace.ts";
import { ActivityRow } from "../ActivityRow.tsx";
import { Icon } from "../Icon.tsx";
import { FULL_SHEET, PANEL_HEAD, PANEL_TITLE, SHEET_SCRIM, SIDE_PANEL } from "../panelStyles.ts";
import { Tip } from "../Tip.tsx";
import { FACTS, QUIET, SECTION } from "./factStyles.ts";
import { SessionInspect } from "./SessionInspect.tsx";
import { StepDetail } from "./StepDetail.tsx";
import { SurfaceInspect } from "./SurfaceInspect.tsx";
import { Tabs } from "./Tabs.tsx";

export interface InspectFocus {
  /** Rises on each request, so asking again for the same run still re-opens it. */
  nonce: number;
  runId: string | null;
  stepId: string | null;
  /** Opens the Surfaces tab at this surface. */
  surfaceId?: string | null;
}

interface Props {
  id: string;
  api: Api;
  session: Session;
  agent: Agent | undefined;
  sessions: Session[] | undefined;
  trace: TraceState;
  messages: Message[];
  focus: InspectFocus;
  onClose: () => void;
}

type View = "run" | "surfaces" | "session";

const RUN_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Full mode's inspector: a side panel on wide screens, a full-screen sheet on phones. Run header, its steps, and one step in
 * full. The Session tab says what the chat is made of.
 */
export function Inspector({ id, api, session, agent, sessions, trace, messages, focus, onClose }: Props) {
  const [view, setView] = useState<View>(focus.surfaceId ? "surfaces" : "run");
  const [surfaceId, setSurfaceId] = useState<string | null>(focus.surfaceId ?? null);
  // The chat's surfaces, each as its newest part.
  const surfaces = useMemo(() => {
    const byId = new Map<string, Surface>();
    for (const m of messages)
      for (const p of m.parts ?? []) if (p.type === "surface") byId.set(p.surface.surfaceId, p.surface);
    return [...byId.values()];
  }, [messages]);
  // What became of each approval in the chat, so a step reads "Approved" here as it does in the chat.
  const outcomes = useMemo(() => approvalOutcomes(messages), [messages]);
  const [runId, setRunId] = useState<string | null>(focus.runId);
  const [stepId, setStepId] = useState<string | null>(focus.stepId);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtn.current?.focus();
  }, []);

  const run: RunTrace | undefined = useMemo(
    () => trace.runs.find((r) => r.run.id === runId) ?? (runId === null ? trace.runs[0] : undefined),
    [trace.runs, runId],
  );
  const step = run?.steps.find((s) => s.id === stepId);
  // A script's calls: found by call id, and counted with their statuses so its call list reloads as they finish.
  const findStep = (toolCallId: string) => {
    for (const r of trace.runs) for (const s of r.steps) if (s.toolCallId === toolCallId) return s;
    return undefined;
  };
  const nested = step
    ? (run?.steps ?? []).reduce((n, s) => (s.parentStepId === step.id ? n + (s.status === "running" ? 1 : 2) : n), 0)
    : 0;
  const detailOpen = (view === "run" && !!step) || (view === "surfaces" && surfaceId !== null);

  return (
    <>
      <div className={SHEET_SCRIM} aria-hidden="true" onClick={onClose} />
      <aside
        className={cn(
          "inspector-panel min-w-85 flex-[0_0_min(33rem,45%)]",
          SIDE_PANEL,
          FULL_SHEET,
          "max-md:pb-[var(--safe-b)]",
        )}
        id={id}
        aria-labelledby={`${id}-h`}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className={cn(PANEL_HEAD, "justify-start gap-1.5 px-4 max-md:[&_button]:size-11")}>
          {detailOpen && (
            <Tip label={view === "surfaces" ? "Back to surfaces" : "Back to steps"}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={view === "surfaces" ? "Back to surfaces" : "Back to steps"}
                onClick={() => (view === "surfaces" ? setSurfaceId(null) : setStepId(null))}
              >
                <Icon name="back" />
              </Button>
            </Tip>
          )}
          <h3 id={`${id}-h`} className={cn(PANEL_TITLE, "flex-1 text-base tracking-tight")}>
            Inspect
          </h3>
          <Tip label="Close">
            <Button
              ref={closeBtn}
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label="Close inspector"
              onClick={onClose}
            >
              <Icon name="close" />
            </Button>
          </Tip>
        </div>
        <div className="inspector-body min-h-0 flex-1 overflow-y-auto px-4 pb-5 [scrollbar-width:thin]">
          <Tabs<View>
            label="Inspector"
            value={view}
            onChange={setView}
            tabs={[
              { id: "run", label: "Run" },
              ...(surfaces.length > 0 ? [{ id: "surfaces" as const, label: "Surfaces" }] : []),
              { id: "session", label: "Session" },
            ]}
          >
            {view === "surfaces" ? (
              <SurfaceInspect
                api={api}
                sessionId={session.id}
                surfaces={surfaces}
                selected={surfaceId}
                onSelect={setSurfaceId}
                onOpenCall={(toolCallId) => {
                  const owner = trace.runs.find((r) => r.steps.some((s) => s.toolCallId === toolCallId));
                  const found = owner?.steps.find((s) => s.toolCallId === toolCallId);
                  if (!owner || !found) return false;
                  setView("run");
                  setRunId(owner.run.id);
                  setStepId(found.id);
                  return true;
                }}
              />
            ) : view === "session" ? (
              <SessionInspect
                session={session}
                agent={agent}
                sessions={sessions}
                runCount={trace.runs.length}
                moreRuns={trace.hasOlder}
              />
            ) : (
              <>
                {trace.error && (
                  <p className="form-error" role="alert">
                    {trace.error}
                  </p>
                )}
                {!trace.loaded && !trace.error && (
                  <p className={QUIET} role="status">
                    Loading…
                  </p>
                )}
                {trace.loaded && trace.runs.length === 0 && <p className={QUIET}>No runs recorded yet.</p>}
                {run && !detailOpen && (
                  <RunView
                    run={run}
                    runs={trace.runs}
                    sessionId={session.id}
                    outcomes={outcomes}
                    onPickRun={(r) => {
                      setRunId(r);
                      setStepId(null);
                    }}
                    onOpenStep={setStepId}
                    hasOlder={trace.hasOlder}
                    loadingOlder={trace.loadingOlder}
                    onLoadOlder={trace.loadOlder}
                  />
                )}
                {step && (
                  <StepDetail
                    api={api}
                    sessionId={session.id}
                    step={step}
                    messages={messages}
                    outcomes={outcomes}
                    findStep={findStep}
                    revision={nested}
                    onOpenStep={(id) => {
                      const owner = trace.runs.find((r) => r.steps.some((s) => s.id === id));
                      if (owner) setRunId(owner.run.id);
                      setStepId(id);
                    }}
                  />
                )}
                {runId !== null && trace.loaded && !run && (
                  <p className={QUIET}>This run isn't in the loaded trace yet.</p>
                )}
              </>
            )}
          </Tabs>
        </div>
      </aside>
    </>
  );
}

function RunView({
  run,
  runs,
  sessionId,
  outcomes,
  onPickRun,
  onOpenStep,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: {
  run: RunTrace;
  runs: RunTrace[];
  sessionId: string;
  outcomes: ApprovalOutcomes;
  onPickRun: (id: string) => void;
  onOpenStep: (id: string) => void;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  const t = run.totals;
  return (
    <div className="run-view flex min-w-0 flex-col gap-2.5">
      <label className="run-pick flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
        Run
        <NativeSelect
          value={run.run.id}
          size="sm"
          className="w-full text-foreground"
          onChange={(e) => onPickRun(e.target.value)}
        >
          {runs.map((r, i) => (
            <option key={r.run.id} value={r.run.id}>
              {`${i === 0 ? "Latest · " : ""}${formatWhen(r.run.startedAt)} · ${RUN_LABEL[r.run.status] ?? r.run.status}`}
            </option>
          ))}
        </NativeSelect>
      </label>
      {hasOlder && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-ml-2 self-start text-muted-foreground"
          disabled={loadingOlder}
          onClick={onLoadOlder}
        >
          {loadingOlder ? "Loading…" : "Load older runs"}
        </Button>
      )}
      <dl className={cn(FACTS, "run-head rounded-2xl border bg-card p-3")}>
        <div>
          <dt>Status</dt>
          <dd>{RUN_LABEL[run.run.status] ?? run.run.status}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{duration(t.durationMs)}</dd>
        </div>
        <div>
          <dt>Totals</dt>
          <dd>
            {t.modelCalls} model {t.modelCalls === 1 ? "call" : "calls"} · {t.toolCalls} tool{" "}
            {t.toolCalls === 1 ? "call" : "calls"} · {t.tokens.toLocaleString()} tokens
          </dd>
        </div>
        {run.triggerMessageId && (
          <div>
            <dt>Started by</dt>
            <dd>
              <a href={sessionHref(sessionId, run.triggerMessageId)}>The message that started it</a>
            </dd>
          </div>
        )}
        {run.run.error && (
          <div>
            <dt>Error</dt>
            <dd>{run.run.error.message}</dd>
          </div>
        )}
      </dl>
      <h4 className={SECTION}>Steps · {run.steps.length}</h4>
      {run.steps.length === 0 ? (
        <p className={QUIET}>No steps recorded for this run.</p>
      ) : (
        <ol className="activity-list m-0 flex list-none flex-col gap-1 p-0">
          {run.steps.map((s) => (
            <ActivityRow key={s.id} step={s} outcomes={outcomes} onOpen={() => onOpenStep(s.id)} />
          ))}
        </ol>
      )}
    </div>
  );
}
