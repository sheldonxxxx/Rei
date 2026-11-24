import type { Agent, EventSourceView, Trigger } from "@rei/protocol";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Empty, EmptyDescription } from "@/components/primitives/empty.tsx";
import { Item } from "@/components/primitives/item.tsx";
import type { Api } from "../api/client.ts";
import { describeSetupError } from "../api/client.ts";
import { navigate, TRIGGERS_PATH, triggerHref } from "../lib/route.ts";
import { formatWhen } from "../lib/time.ts";
import { formatNextRun, runStatusText, statusChip, TRIGGER_BADGE_VARIANT } from "../lib/triggers.ts";
import { useNow } from "../lib/useNow.ts";
import { Icon } from "./Icon.tsx";
import { PageShell } from "./PageShell.tsx";
import { TriggerDetail } from "./TriggerDetail.tsx";
import { TriggerForm } from "./TriggerForm.tsx";

interface Props {
  api: Api;
  agents: Agent[];
  /** The open trigger; null shows the list. */
  id: string | null;
  /** From the global stream: rises when a trigger or its runs changed. */
  rev: number;
  /** After a trigger is deleted: the list. */
  onClosed: () => void;
}

/** The Triggers page: what runs on its own, and a trigger's settings and run history. */
export function TriggersPage({ api, agents, id, rev, onClosed }: Props) {
  if (id)
    return (
      <TriggerDetail
        key={id}
        api={api}
        agents={agents}
        id={id}
        rev={rev}
        onBack={() => navigate(TRIGGERS_PATH)}
        onDeleted={onClosed}
      />
    );
  return <TriggerList api={api} agents={agents} rev={rev} />;
}

function TriggerList({ api, agents, rev }: Pick<Props, "api" | "agents" | "rev">) {
  const [creating, setCreating] = useState(false);
  const [triggers, setTriggers] = useState<Trigger[] | null>(null);
  const [sources, setSources] = useState<EventSourceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const load = useCallback(() => {
    // The sources are a side list: when they cannot be read the triggers still show.
    Promise.resolve()
      .then(() => api.getEventSources())
      .then(
        (r) => setSources(r.sources),
        () => setSources([]),
      );
    api.getTriggers().then(
      (r) => {
        setTriggers(r.triggers);
        setError(null);
      },
      (e) => setError(describeSetupError(e)),
    );
  }, [api]);
  useEffect(() => {
    load();
  }, [load, rev]);

  if (creating && agents.length > 0) {
    return (
      <PageShell title="New trigger" className="triggers-page">
        <TriggerForm
          api={api}
          agents={agents}
          sources={sources}
          onCancel={() => setCreating(false)}
          onSaved={(trigger) => navigate(triggerHref(trigger.id))}
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Triggers"
      className="triggers-page"
      actions={
        <Button size="sm" type="button" disabled={agents.length === 0} onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} />
          New trigger
        </Button>
      }
    >
      {error && (
        <div
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          <span>{error}</span>
          <Button variant="ghost" size="sm" type="button" onClick={load}>
            Try again
          </Button>
        </div>
      )}
      {!triggers && !error && <span className="spinner" role="status" aria-label="Loading" />}
      {triggers && triggers.length === 0 && (
        <Empty className="page-empty border px-5 py-8">
          <EmptyDescription>No triggers yet.</EmptyDescription>
        </Empty>
      )}
      {sources.length > 0 && <EventSourceList sources={sources} now={now} />}
      {triggers && triggers.length > 0 && (
        <ul className="cfg-list m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-label="Triggers">
          {triggers.map((t) => (
            <li key={t.id}>
              <TriggerRow
                trigger={t}
                agentName={agents.length > 1 ? agents.find((a) => a.id === t.agentId)?.name : undefined}
                now={now}
              />
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}

/** The senders that may start triggers: read-only here; they are made and rotated with `./rei sources`. */
function EventSourceList({ sources, now }: { sources: EventSourceView[]; now: number }) {
  return (
    <section className="cfg-section flex min-w-0 flex-col gap-3" aria-labelledby="event-sources-h">
      <h4 id="event-sources-h" className="memory-h m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
        Event sources
      </h4>
      <ul className="cfg-list m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-label="Event sources">
        {sources.map((s) => (
          <li key={s.id}>
            <Item
              variant="outline"
              className="cfg-item flex min-w-0 flex-col items-stretch gap-1.5 rounded-2xl px-4 py-3"
            >
              <span className="cfg-item-top flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="cfg-item-name min-w-0 flex-[1_1_8rem] text-sm font-medium [overflow-wrap:anywhere]">
                  {s.name}
                  {s.name !== s.id && <span className="text-muted-foreground"> ({s.id})</span>}
                </span>
                <Badge variant={s.status === "active" ? "success" : "secondary"}>
                  {s.status === "active" ? "Active" : "Disabled"}
                </Badge>
              </span>
              <span className="cfg-item-meta flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                <span>
                  {s.lastEventAt === null ? "No events yet" : `Last event: ${formatWhen(s.lastEventAt, now)}`}
                </span>
                {s.types.length > 0 && <span>Types: {s.types.join(", ")}</span>}
              </span>
            </Item>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TriggerRow({ trigger: t, agentName, now }: { trigger: Trigger; agentName: string | undefined; now: number }) {
  const chip = statusChip(t);
  return (
    <Item asChild variant="outline">
      <a
        className="cfg-item relative flex min-w-0 flex-col items-stretch gap-1.5 rounded-2xl px-4 py-3 text-foreground no-underline [overflow-wrap:anywhere] [&:is(a)]:pr-10 [&:is(a)]:hover:bg-muted"
        href={triggerHref(t.id)}
      >
        <span className="cfg-item-top flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="cfg-item-name inline-flex min-w-0 flex-[1_1_8rem] items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
            {t.name}
          </span>
          <Badge variant={TRIGGER_BADGE_VARIANT[chip.tone]}>{chip.label}</Badge>
        </span>
        <span className="cfg-item-line text-sm text-muted-foreground [overflow-wrap:anywhere]">{t.startText}</span>
        <span className="cfg-item-meta flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere] [&_[data-tone=bad]]:text-destructive">
          {t.nextRunAt !== null && <span>Next: {formatNextRun(t.nextRunAt, now)}</span>}
          {t.lastRun && (
            <span data-tone={t.lastRun.status === "failed" ? "bad" : undefined}>
              Last: {runStatusText(t.lastRun)} · {formatWhen(t.lastRun.scheduledAt, now)}
            </span>
          )}
          {t.start.kind === "event" && (
            <span>{t.lastEventAt === null ? "No events yet" : `Last event: ${formatWhen(t.lastEventAt, now)}`}</span>
          )}
          {!t.lastRun && <span>Hasn't run yet</span>}
          {agentName && <span>{agentName}</span>}
        </span>
        <span
          className="cfg-item-action absolute top-1/2 right-3 inline-grid -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        >
          <Icon name="forward" size={16} />
        </span>
      </a>
    </Item>
  );
}
