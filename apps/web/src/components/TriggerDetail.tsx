import type {
  Agent,
  ProfileName,
  ReportSetting,
  Trigger,
  TriggerAction,
  TriggerAllow,
  TriggerRunSummary,
  UpdateTriggerRequest,
} from "@rei/protocol";
import { TRIGGER_LIMITS } from "@rei/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Empty, EmptyDescription } from "@/components/primitives/empty.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Item } from "@/components/primitives/item.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import type { Api } from "../api/client.ts";
import { ApiError, describeSetupError } from "../api/client.ts";
import { CLASS_LABEL, PROFILE_HELP, PROFILE_LABEL } from "../lib/policy.ts";
import { sessionHref } from "../lib/route.ts";
import { formatWhen } from "../lib/time.ts";
import type { ScheduleDraft } from "../lib/triggers.ts";
import {
  CATCH_UP_LABEL,
  draftFromSchedule,
  formatDuration,
  formatNextRun,
  LANDING_LABEL,
  OVERLAP_LABEL,
  REPORT_LABEL,
  runStatusText,
  runTone,
  scheduleFromDraft,
  statusChip,
  TRIGGER_BADGE_VARIANT,
} from "../lib/triggers.ts";
import { useNow } from "../lib/useNow.ts";
import { ConfirmDialog, NATIVE_CHECK } from "./dialogParts.tsx";
import { Icon } from "./Icon.tsx";
import { PageShell } from "./PageShell.tsx";
import { ScheduleEditor } from "./ScheduleEditor.tsx";
import { Tip } from "./Tip.tsx";

interface Props {
  api: Api;
  agents: Agent[];
  id: string;
  rev: number;
  onBack: () => void;
  onDeleted: () => void;
}

const PROFILES: Exclude<ProfileName, "yolo">[] = ["strict", "standard", "relaxed"];

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

// ---- the settings form ---------------------------------------------------------------------------------------------------

const KIND_LABEL: Record<TriggerAction["kind"], string> = {
  notify: "Posts a message",
  prompt: "Runs a prompt",
  skill: "Runs a skill",
};

interface Form {
  name: string;
  startKind: Trigger["start"]["kind"];
  schedule: ScheduleDraft;
  /** Event start: the source id and the types, separated by spaces or commas (`*` for every type). */
  source: string;
  types: string;
  kind: TriggerAction["kind"];
  /** The notify message or the prompt (one text for both: switching between them keeps it). */
  text: string;
  skill: string;
  args: string;
  landing: Trigger["landing"];
  report: ReportSetting;
  lateness: string;
  catchUp: Trigger["catchUp"];
  overlap: Trigger["overlap"];
  profile: Trigger["profile"];
  allow: Trigger["allow"];
}

function formFromTrigger(t: Trigger): Form {
  const a = t.action;
  return {
    name: t.name,
    startKind: t.start.kind,
    schedule: draftFromSchedule(t.start.kind === "schedule" ? t.start.schedule : null),
    source: t.start.kind === "event" ? t.start.source : "",
    types: t.start.kind === "event" ? t.start.types.join(" ") : "",
    kind: a.kind,
    text: a.kind === "notify" ? a.message : a.kind === "prompt" ? a.prompt : "",
    skill: a.kind === "skill" ? a.skill : "",
    args: a.kind === "skill" ? (a.args ?? "") : "",
    landing: t.landing,
    report: t.report,
    lateness: String(t.latenessMinutes),
    catchUp: t.catchUp,
    overlap: t.overlap,
    profile: t.profile,
    allow: t.allow,
  };
}

/** What to PATCH: only the fields that differ from the trigger, or the sentence saying what is wrong. */
export function buildPatch(t: Trigger, f: Form): { patch: UpdateTriggerRequest } | { error: string } {
  const patch: UpdateTriggerRequest = {};
  const name = f.name.trim();
  if (!name) return { error: "Give the trigger a name." };
  if (name.length > TRIGGER_LIMITS.nameChars)
    return { error: `The name can be at most ${TRIGGER_LIMITS.nameChars} characters.` };
  if (name !== t.name) patch.name = name;

  if (f.startKind === "event") {
    const source = f.source.trim();
    if (!source) return { error: "Name the event source." };
    const types = [...new Set(f.types.split(/[\s,]+/).filter(Boolean))];
    if (types.length === 0) return { error: "Name at least one event type, or * for every type." };
    if (types.length > TRIGGER_LIMITS.eventTypes)
      return { error: `Listen to at most ${TRIGGER_LIMITS.eventTypes} event types.` };
    const same =
      t.start.kind === "event" && t.start.source === source && JSON.stringify(t.start.types) === JSON.stringify(types);
    if (!same) patch.start = { kind: "event", source, types };
  } else {
    const now = scheduleFromDraft(f.schedule);
    if ("error" in now) return now;
    const was =
      t.start.kind === "schedule" ? scheduleFromDraft(draftFromSchedule(t.start.schedule)) : { error: "event" };
    if (!("schedule" in was) || JSON.stringify(was.schedule) !== JSON.stringify(now.schedule))
      patch.start = { kind: "schedule", schedule: now.schedule };
  }

  let action: TriggerAction;
  if (f.kind === "skill") {
    const skill = f.skill.trim();
    if (!skill) return { error: "Choose the skill to run." };
    const args = f.args.trim();
    if (args.length > TRIGGER_LIMITS.textChars)
      return { error: `The arguments are too long (over ${TRIGGER_LIMITS.textChars} characters).` };
    action = { kind: "skill", skill, ...(args ? { args } : {}) };
  } else {
    const text = f.text.trim();
    if (!text) return { error: f.kind === "notify" ? "Write the message to post." : "Write the prompt to run." };
    if (text.length > TRIGGER_LIMITS.textChars)
      return { error: `That is too long (over ${TRIGGER_LIMITS.textChars} characters).` };
    action = f.kind === "notify" ? { kind: "notify", message: text } : { kind: "prompt", prompt: text };
  }
  if (JSON.stringify(action) !== JSON.stringify(t.action)) patch.action = action;

  // Lateness, catch-up and overlap are for schedules; an event trigger leaves them alone.
  if (f.startKind === "schedule") {
    const lateness = Number(f.lateness);
    if (!Number.isInteger(lateness) || lateness < 1 || lateness > TRIGGER_LIMITS.maxLatenessMinutes)
      return { error: `Lateness is 1 to ${TRIGGER_LIMITS.maxLatenessMinutes} minutes.` };
    if (lateness !== t.latenessMinutes) patch.latenessMinutes = lateness;
    if (f.catchUp !== t.catchUp) patch.catchUp = f.catchUp;
    if (f.overlap !== t.overlap) patch.overlap = f.overlap;
  }

  if (f.landing !== t.landing) patch.landing = f.landing;
  if (f.report !== t.report) patch.report = f.report;
  if (f.profile !== t.profile) patch.profile = f.profile;
  if (f.allow.length !== t.allow.length)
    patch.allow = f.allow.map(
      ({ tool, destination }): TriggerAllow => (destination ? { tool, destination } : { tool }),
    );
  return { patch };
}

function TriggerForm({ api, trigger, onSaved }: { api: Api; trigger: Trigger; onSaved: (t: Trigger) => void }) {
  const [form, setForm] = useState(() => formFromTrigger(trigger));
  const [synced, setSynced] = useState(trigger);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [skills, setSkills] = useState<string[] | null>(null);
  const ids = useId();

  // The agent's saved skills, for the skill field: fetched once, when the action is (or becomes) a skill.
  useEffect(() => {
    if (form.kind !== "skill" || skills !== null) return;
    let live = true;
    Promise.resolve()
      .then(() => api.getSkills())
      .then(
        (r) =>
          live &&
          setSkills(r.skills.filter((s) => s.agents === null || s.agents.includes(trigger.agentId)).map((s) => s.name)),
        () => live && setSkills([]),
      );
    return () => {
      live = false;
    };
  }, [api, form.kind, skills, trigger.agentId]);

  // The server's copy changed (a run finished, someone paused it): follow it unless you are in the middle of an edit.
  if (trigger !== synced) {
    if (JSON.stringify(form) === JSON.stringify(formFromTrigger(synced))) setForm(formFromTrigger(trigger));
    setSynced(trigger);
  }

  const set = (patch: Partial<Form>) => {
    setSaved(false);
    setForm((f) => ({ ...f, ...patch }));
  };
  const built = buildPatch(trigger, form);
  const dirty = "error" in built || Object.keys(built.patch).length > 0;

  async function save() {
    if ("error" in built) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.updateTrigger(trigger.id, built.patch);
      setForm(formFromTrigger(r.trigger));
      setSynced(r.trigger);
      onSaved(r.trigger);
      setSaved(true);
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setBusy(false);
    }
  }

  const kind = form.kind;
  return (
    <form
      className="cfg-form flex min-w-0 flex-col gap-5 border-t pt-5"
      aria-label="Settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !busy) void save();
      }}
    >
      <h4 className="memory-h m-0 flex items-center gap-2 text-base font-semibold tracking-tight">Settings</h4>
      <Field>
        <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-name`}>
          Name
          <Input
            id={`${ids}-name`}
            type="text"
            value={form.name}
            maxLength={TRIGGER_LIMITS.nameChars}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
      </Field>

      <fieldset
        className="cfg-group m-0 flex min-w-0 flex-col gap-3 border-0 p-0 [&_legend]:mb-3 [&_legend]:p-0 [&_legend]:text-sm [&_legend]:font-medium"
        disabled={busy}
      >
        <legend>When it starts</legend>
        <Field>
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-start`}>
            Starts
            <NativeSelect
              id={`${ids}-start`}
              value={form.startKind}
              onChange={(e) => set({ startKind: e.target.value as Form["startKind"] })}
            >
              <option value="schedule">On a schedule</option>
              <option value="event">When an event arrives</option>
            </NativeSelect>
          </label>
        </Field>
        {form.startKind === "event" && (
          <div className="cfg-row flex flex-wrap gap-3 [&>[data-slot=field]]:min-w-0 [&>[data-slot=field]]:flex-[1_1_9rem]">
            <Field>
              <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-source`}>
                Event source
                <Input
                  id={`${ids}-source`}
                  type="text"
                  value={form.source}
                  autoComplete="off"
                  onChange={(e) => set({ source: e.target.value })}
                />
              </label>
            </Field>
            <Field>
              <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-types`}>
                Event types
                <Input
                  id={`${ids}-types`}
                  type="text"
                  value={form.types}
                  autoComplete="off"
                  placeholder="items.new items.changed, or *"
                  onChange={(e) => set({ types: e.target.value })}
                />
              </label>
            </Field>
          </div>
        )}
      </fieldset>
      {form.startKind === "schedule" && (
        <ScheduleEditor draft={form.schedule} disabled={busy} onChange={(schedule) => set({ schedule })} />
      )}

      <fieldset
        className="cfg-group m-0 flex min-w-0 flex-col gap-3 border-0 p-0 [&_legend]:mb-3 [&_legend]:p-0 [&_legend]:text-sm [&_legend]:font-medium"
        disabled={busy}
      >
        <legend>What it does</legend>
        <Field>
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-kind`}>
            Action
            <NativeSelect
              id={`${ids}-kind`}
              value={form.kind}
              onChange={(e) => set({ kind: e.target.value as Form["kind"] })}
            >
              {(["notify", "prompt", "skill"] as const).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </NativeSelect>
          </label>
        </Field>
        {kind === "skill" ? (
          <>
            <Field>
              <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-skill`}>
                Skill
                <NativeSelect id={`${ids}-skill`} value={form.skill} onChange={(e) => set({ skill: e.target.value })}>
                  {form.skill === "" && <option value="">Choose a skill…</option>}
                  {(skills ?? []).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  {form.skill !== "" && !(skills ?? []).includes(form.skill) && (
                    <option value={form.skill}>{skills === null ? form.skill : `${form.skill} (missing)`}</option>
                  )}
                </NativeSelect>
              </label>
            </Field>
            <Field>
              <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-args`}>
                Arguments (optional)
                <Textarea
                  id={`${ids}-args`}
                  rows={2}
                  value={form.args}
                  onChange={(e) => set({ args: e.target.value })}
                />
              </label>
            </Field>
          </>
        ) : (
          <Field>
            <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-text`}>
              {kind === "notify" ? "Message" : "Prompt"}
              <Textarea
                id={`${ids}-text`}
                rows={kind === "notify" ? 2 : 4}
                value={form.text}
                onChange={(e) => set({ text: e.target.value })}
              />
            </label>
          </Field>
        )}
      </fieldset>

      <fieldset
        className="cfg-group m-0 flex min-w-0 flex-col gap-3 border-0 p-0 [&_legend]:mb-3 [&_legend]:p-0 [&_legend]:text-sm [&_legend]:font-medium"
        disabled={busy}
      >
        <legend>Runs</legend>
        <div className="cfg-row flex flex-wrap gap-3 [&>[data-slot=field]]:min-w-0 [&>[data-slot=field]]:flex-[1_1_9rem]">
          {kind !== "notify" && (
            <Field>
              <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-landing`}>
                Where it runs
                <NativeSelect
                  id={`${ids}-landing`}
                  value={form.landing}
                  onChange={(e) => set({ landing: e.target.value as Form["landing"] })}
                >
                  {(["new", "ongoing"] as const).map((l) => (
                    <option key={l} value={l}>
                      {LANDING_LABEL[l]}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </Field>
          )}
          <Field>
            <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-report`}>
              Report to your chat
              <NativeSelect
                id={`${ids}-report`}
                value={form.report}
                onChange={(e) => set({ report: e.target.value as ReportSetting })}
              >
                {(["always", "on_change", "never"] as const).map((r) => (
                  <option key={r} value={r}>
                    {REPORT_LABEL[r]}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </Field>
        </div>
        <div className="cfg-row flex flex-wrap gap-3 [&>[data-slot=field]]:min-w-0 [&>[data-slot=field]]:flex-[1_1_9rem]">
          {form.startKind === "schedule" && (
            <Field>
              <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-late`}>
                Skip if late by (minutes)
                <Input
                  id={`${ids}-late`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={TRIGGER_LIMITS.maxLatenessMinutes}
                  step={1}
                  value={form.lateness}
                  onChange={(e) => set({ lateness: e.target.value })}
                />
              </label>
            </Field>
          )}
          {kind !== "notify" && (
            <Field>
              <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-profile`}>
                Permissions for its runs
                <NativeSelect
                  id={`${ids}-profile`}
                  value={form.profile}
                  onChange={(e) => set({ profile: e.target.value as Form["profile"] })}
                >
                  {PROFILES.map((p) => (
                    <option key={p} value={p}>
                      {PROFILE_LABEL[p]}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </Field>
          )}
        </div>
        {form.startKind === "schedule" && (
          <div className="cfg-row flex flex-wrap gap-3 [&>[data-slot=field]]:min-w-0 [&>[data-slot=field]]:flex-[1_1_9rem]">
            <Field>
              <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-catchup`}>
                If a run is missed
                <NativeSelect
                  id={`${ids}-catchup`}
                  value={form.catchUp}
                  onChange={(e) => set({ catchUp: e.target.value as Form["catchUp"] })}
                >
                  {(["once", "skip"] as const).map((c) => (
                    <option key={c} value={c}>
                      {CATCH_UP_LABEL[c]}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </Field>
            {kind !== "notify" && (
              <Field>
                <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-overlap`}>
                  If the last run is still going
                  <NativeSelect
                    id={`${ids}-overlap`}
                    value={form.overlap}
                    onChange={(e) => set({ overlap: e.target.value as Form["overlap"] })}
                  >
                    {(["skip", "queue"] as const).map((o) => (
                      <option key={o} value={o}>
                        {OVERLAP_LABEL[o]}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              </Field>
            )}
          </div>
        )}
        {kind !== "notify" && (
          <p className="cfg-hint m-0 text-xs text-muted-foreground">{PROFILE_HELP[form.profile]}</p>
        )}
      </fieldset>

      {kind !== "notify" && (
        <fieldset
          className="cfg-group m-0 flex min-w-0 flex-col gap-3 border-0 p-0 [&_legend]:mb-3 [&_legend]:p-0 [&_legend]:text-sm [&_legend]:font-medium"
          disabled={busy}
        >
          <legend>Allowed without asking</legend>
          {form.allow.length === 0 ? (
            <p className="cfg-hint m-0 text-xs text-muted-foreground">None</p>
          ) : (
            <ul
              className="cfg-allow m-0 flex list-none flex-col gap-2 p-0 [&>li]:flex [&>li]:items-center [&>li]:gap-2 [&>li]:rounded-xl [&>li]:border [&>li]:p-3"
              aria-label="Allowed without asking"
            >
              {form.allow.map((a, i) => (
                <li key={`${a.tool}\n${a.destination ?? ""}`}>
                  <span className="cfg-allow-main flex min-w-0 flex-1 flex-col gap-1">
                    <span className="cfg-allow-tool flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium [overflow-wrap:anywhere]">
                      {a.label}
                      <Badge className="class-chip">{CLASS_LABEL[a.actionClass]}</Badge>
                    </span>
                    <span className="cfg-allow-meta text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {a.tool}
                      {a.destination ? ` to ${a.destination}` : " to any destination"}
                    </span>
                  </span>
                  <Tip label={`Remove ${a.label}${a.destination ? ` to ${a.destination}` : ""}`}>
                    <Button
                      size="icon-sm"
                      variant="outline"
                      type="button"
                      aria-label={`Remove ${a.label}${a.destination ? ` to ${a.destination}` : ""}`}
                      onClick={() => set({ allow: form.allow.filter((_, j) => j !== i) })}
                    >
                      <Icon name="close" size={16} />
                    </Button>
                  </Tip>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}

      {error && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      <div className="cfg-save flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        {"error" in built && dirty && (
          <span className="cfg-problem flex-[1_1_12rem] text-xs text-destructive">{built.error}</span>
        )}
        {saved && !dirty && (
          <span role="status" className="cfg-note text-sm text-muted-foreground">
            Saved.
          </span>
        )}
        <Button variant="default" type="submit" disabled={!dirty || "error" in built || busy} aria-busy={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
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
