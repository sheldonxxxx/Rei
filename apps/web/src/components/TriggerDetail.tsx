import type { Agent, Trigger, TriggerRunSummary } from "@rei/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Empty, EmptyDescription } from "@/components/primitives/empty.tsx";
import { Item } from "@/components/primitives/item.tsx";
import type { Api } from "../api/client.ts";
import { ApiError, describeSetupError } from "../api/client.ts";
import { sessionHref } from "../lib/route.ts";
import { formatWhen } from "../lib/time.ts";
import {
  formatDuration,
  formatNextRun,
  runStatusText,
  runTone,
  statusChip,
  TRIGGER_BADGE_VARIANT,
} from "../lib/triggers.ts";
import { useNow } from "../lib/useNow.ts";
import { ConfirmDialog, NATIVE_CHECK } from "./dialogParts.tsx";
import { Icon } from "./Icon.tsx";
import { PageShell } from "./PageShell.tsx";
import { TriggerForm } from "./TriggerForm.tsx";

interface Props {
  api: Api;
  agents: Agent[];
  id: string;
  rev: number;
  onBack: () => void;
  onDeleted: () => void;
}

/** Runs shown at first, and how many more each "Show older runs" reveals. */
const RUNS_STEP = 5;

/** One trigger: its controls, its settings form and its run history. */
export function TriggerDetail({ api, agents, id, rev, onBack, onDeleted }: Props) {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [runs, setRuns] = useState<TriggerRunSummary[]>([]);
  const [shown, setShown] = useState(RUNS_STEP);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<"run" | "pause" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => {
    api.getTrigger(id).then(
      (r) => {
        setTrigger(r.trigger);
        setRuns(r.runs);
        setNext(r.next);
        setError(null);
      },
      (e) => {
        if (e instanceof ApiError && e.code === "not_found") setMissing(true);
        else setError(describeSetupError(e));
      },
    );
  }, [api, id]);
  useEffect(() => {
    load();
  }, [load, rev]);

  async function more() {
    // Reveal the runs already loaded first; fetch the next page only when they are all shown.
    if (shown < runs.length) {
      setShown((s) => s + RUNS_STEP);
      return;
    }
    if (!next) return;
    try {
      const r = await api.getTrigger(id, next);
      setRuns((cur) => [...cur, ...r.runs.filter((x) => !cur.some((y) => y.id === x.id))]);
      setNext(r.next);
      setShown((s) => s + RUNS_STEP);
    } catch (e) {
      setError(describeSetupError(e));
    }
  }

  async function runNow() {
    setBusy("run");
    setNote(null);
    setError(null);
    try {
      const { run } = await api.runTrigger(id);
      setNote(
        run.status === "skipped"
          ? `Not started: ${run.reason === "overlap" ? "the last run is still going" : (run.reason ?? "skipped")}.`
          : run.status === "queued"
            ? "Queued: it starts when the last run ends."
            : "Started a run.",
      );
      load();
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setBusy(null);
    }
  }

  async function setPaused(paused: boolean) {
    setBusy("pause");
    setNote(null);
    setError(null);
    try {
      const r = await api.updateTrigger(id, { paused });
      setTrigger(r.trigger);
      load();
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setBusy(null);
    }
  }

  const back = { onBack, backLabel: "Back to Triggers" };
  if (missing) {
    return (
      <PageShell title="Trigger" {...back}>
        <Empty className="page-empty border px-5 py-8">
          <EmptyDescription>This trigger no longer exists.</EmptyDescription>
        </Empty>
      </PageShell>
    );
  }
  if (!trigger) {
    return (
      <PageShell title="Trigger" {...back}>
        {error ? (
          <div
            role="alert"
            className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            <span>{error}</span>
            <Button variant="ghost" size="sm" type="button" onClick={load}>
              Try again
            </Button>
          </div>
        ) : (
          <span className="spinner" role="status" aria-label="Loading" />
        )}
      </PageShell>
    );
  }

  const chip = statusChip(trigger);
  const agent = agents.find((a) => a.id === trigger.agentId);
  return (
    <PageShell title={trigger.name} {...back} className="trigger-page">
      <div className="cfg-summary flex flex-col gap-2">
        <p className="cfg-summary-line m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm font-medium [overflow-wrap:anywhere]">
          <Badge variant={TRIGGER_BADGE_VARIANT[chip.tone]}>{chip.label}</Badge>
          <span>{trigger.startText}</span>
        </p>
        <TriggerNext trigger={trigger} agentName={agents.length > 1 ? agent?.name : undefined} />
        {trigger.status === "paused" && trigger.pausedReason === "failures" && (
          <p className="cfg-warn m-0 flex items-start gap-2 rounded-2xl bg-attention-soft px-3 py-2.5 text-sm text-attention-text [&_.icon]:mt-0.5">
            <Icon name="alert" size={16} />
            <span>Paused after {trigger.failures} failed runs in a row. Resume to try again.</span>
          </p>
        )}
      </div>

      <div className="cfg-actions flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={busy !== null}
          aria-busy={busy === "run"}
          onClick={() => void runNow()}
        >
          <Icon name="forward" size={16} />
          Run now
        </Button>
        {trigger.status !== "done" && (
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={busy !== null}
            aria-busy={busy === "pause"}
            onClick={() => void setPaused(trigger.status === "active")}
          >
            {trigger.status === "active" ? "Pause" : "Resume"}
          </Button>
        )}
        <Button
          variant="destructive"
          size="sm"
          type="button"
          className="danger-text text-destructive"
          onClick={() => setConfirmDelete(true)}
        >
          <Icon name="trash" size={16} />
          Delete
        </Button>
        {note && (
          <span role="status" className="cfg-note text-sm text-muted-foreground">
            {note}
          </span>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}

      <section className="cfg-section flex min-w-0 flex-col gap-3 border-t pt-5" aria-labelledby="trigger-runs-h">
        <h4 id="trigger-runs-h" className="memory-h m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
          Run history
        </h4>
        {runs.length === 0 ? (
          <Empty className="page-empty border px-5 py-8">
            <EmptyDescription>No runs yet.</EmptyDescription>
          </Empty>
        ) : (
          <ul className="cfg-list m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-label="Runs">
            {runs.slice(0, shown).map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        )}
        {(shown < runs.length || next) && (
          <div>
            <Button variant="outline" size="sm" type="button" onClick={() => void more()}>
              Show older runs
            </Button>
          </div>
        )}
      </section>

      <TriggerForm api={api} trigger={trigger} onSaved={(t) => setTrigger(t)} />

      {confirmDelete && (
        <DeleteTriggerDialog
          api={api}
          trigger={trigger}
          onCancel={() => setConfirmDelete(false)}
          onDeleted={onDeleted}
        />
      )}
    </PageShell>
  );
}

function TriggerNext({ trigger, agentName }: { trigger: Trigger; agentName: string | undefined }) {
  const now = useNow();
  return (
    <p className="cfg-summary-meta m-0 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
      {trigger.nextRunAt !== null && <span>Next run: {formatNextRun(trigger.nextRunAt, now)}</span>}
      {trigger.start.kind === "event" && (
        <span>
          {trigger.lastEventAt === null ? "No events yet" : `Last event: ${formatWhen(trigger.lastEventAt, now)}`}
        </span>
      )}
      {trigger.status === "done" && <span>Has run, nothing more is scheduled</span>}
      {agentName && <span>Agent: {agentName}</span>}
    </p>
  );
}

function RunRow({ run }: { run: TriggerRunSummary }) {
  const duration =
    run.startedAt !== null && run.finishedAt !== null ? formatDuration(run.finishedAt - run.startedAt) : null;
  return (
    <Item asChild variant="outline">
      <li className="cfg-item relative flex min-w-0 flex-col items-stretch gap-1.5 rounded-2xl px-4 py-3 text-foreground no-underline [overflow-wrap:anywhere] [&:is(a)]:pr-10 [&:is(a)]:hover:bg-muted run-item">
        <span className="cfg-item-top flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <Badge variant={TRIGGER_BADGE_VARIANT[runTone(run.status)]}>{runStatusText(run)}</Badge>
          <time
            className="cfg-item-when text-xs whitespace-nowrap text-muted-foreground"
            dateTime={new Date(run.scheduledAt).toISOString()}
          >
            {formatWhen(run.scheduledAt)}
          </time>
        </span>
        <span className="cfg-item-meta flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere] [&_[data-tone=bad]]:text-destructive">
          {run.manual && <span>Run now</span>}
          {duration && <span>Took {duration}</span>}
          {run.attempt > 0 && <span>Attempt {run.attempt + 1}</span>}
          {run.skillVersion !== null && <span>Skill v{run.skillVersion}</span>}
        </span>
        {run.events.length > 0 && (
          <ul
            className="run-events m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-muted-foreground"
            aria-label="Events"
          >
            {run.events.map((e) => (
              <li key={e.id}>
                {e.type}: {e.ref} · {formatWhen(e.receivedAt)}
              </li>
            ))}
            {run.droppedEvents > 0 && (
              <li>
                {run.droppedEvents} earlier event{run.droppedEvents === 1 ? "" : "s"} not kept
              </li>
            )}
          </ul>
        )}
        {run.report && <span className="run-report text-sm [overflow-wrap:anywhere]">{run.report}</span>}
        {run.sessionId && (
          <a className="card-link" href={sessionHref(run.sessionId)}>
            Open chat
            <Icon name="external" size={14} />
          </a>
        )}
      </li>
    </Item>
  );
}

function DeleteTriggerDialog({
  api,
  trigger,
  onCancel,
  onDeleted,
}: {
  api: Api;
  trigger: Trigger;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [withSessions, setWithSessions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionsId = useId();

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteTrigger(trigger.id, { withSessions });
      onDeleted();
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") onDeleted();
      else {
        setError(describeSetupError(e));
        setBusy(false);
      }
    }
  }

  return (
    <ConfirmDialog
      title="Delete this trigger?"
      description={<p>“{trigger.name}” will stop running and its run history is removed. This can't be undone.</p>}
      error={error}
      busy={busy}
      confirmLabel="Delete"
      busyLabel="Deleting…"
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    >
      <label htmlFor={sessionsId} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm">
        <input
          id={sessionsId}
          type="checkbox"
          className={NATIVE_CHECK}
          checked={withSessions}
          disabled={busy}
          onChange={(e) => setWithSessions(e.target.checked)}
        />
        Also delete its chats
      </label>
    </ConfirmDialog>
  );
}
