import type {
  Agent,
  CreateTriggerRequest,
  EventSourceView,
  ReportSetting,
  SkillSummary,
  Trigger,
  TriggerAction,
  TriggerAllow,
  TriggerStart,
  UpdateTriggerRequest,
} from "@rei/protocol";
import { TRIGGER_LIMITS } from "@rei/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import type { Api } from "../api/client.ts";
import { describeSetupError } from "../api/client.ts";
import { CLASS_LABEL, PROFILE_HELP, PROFILE_LABEL, PROFILES } from "../lib/policy.ts";
import {
  CATCH_UP_LABEL,
  draftFromSchedule,
  LANDING_LABEL,
  OVERLAP_LABEL,
  REPORT_LABEL,
  type ScheduleDraft,
  scheduleFromDraft,
} from "../lib/triggers.ts";
import { Icon } from "./Icon.tsx";
import { ScheduleEditor } from "./ScheduleEditor.tsx";
import { Tip } from "./Tip.tsx";

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

/** A new trigger's runs start on the agent's default level, YOLO included. */
function triggerProfile(agent: Agent | undefined): Trigger["profile"] {
  return agent?.defaultProfile ?? "standard";
}

function newForm(agent: Agent | undefined): Form {
  return {
    name: "",
    startKind: "schedule",
    schedule: draftFromSchedule(null),
    source: "",
    types: "*",
    kind: "prompt",
    text: "",
    skill: "",
    args: "",
    landing: "new",
    report: "on_change",
    lateness: "",
    catchUp: "once",
    overlap: "skip",
    profile: triggerProfile(agent),
    allow: [],
  };
}

function buildSubmission(
  f: Form,
  agentId: string,
  trigger?: Trigger,
): { create: CreateTriggerRequest } | { patch: UpdateTriggerRequest } | { error: string } {
  const patch: UpdateTriggerRequest = {};
  const name = f.name.trim();
  if (!name) return { error: "Give the trigger a name." };
  if (name.length > TRIGGER_LIMITS.nameChars)
    return { error: `The name can be at most ${TRIGGER_LIMITS.nameChars} characters.` };
  if (name !== trigger?.name) patch.name = name;

  let start: TriggerStart;

  if (f.startKind === "event") {
    const source = f.source.trim();
    if (!source) return { error: "Name the event source." };
    const types = [...new Set(f.types.split(/[\s,]+/).filter(Boolean))];
    if (types.length === 0) return { error: "Name at least one event type, or * for every type." };
    if (types.length > TRIGGER_LIMITS.eventTypes)
      return { error: `Listen to at most ${TRIGGER_LIMITS.eventTypes} event types.` };
    start = { kind: "event", source, types };
    if (JSON.stringify(start) !== JSON.stringify(trigger?.start)) patch.start = start;
  } else {
    const now = scheduleFromDraft(f.schedule);
    if ("error" in now) return now;
    start = { kind: "schedule", schedule: now.schedule };
    const previous =
      trigger?.start.kind === "schedule" ? scheduleFromDraft(draftFromSchedule(trigger.start.schedule)) : null;
    if (!previous || !("schedule" in previous) || JSON.stringify(previous.schedule) !== JSON.stringify(now.schedule))
      patch.start = start;
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
  if (JSON.stringify(action) !== JSON.stringify(trigger?.action)) patch.action = action;

  // Lateness, catch-up and overlap are for schedules; an event trigger leaves them alone.
  if (f.startKind === "schedule") {
    if (trigger || f.lateness !== "") {
      const lateness = Number(f.lateness);
      if (!Number.isInteger(lateness) || lateness < 1 || lateness > TRIGGER_LIMITS.maxLatenessMinutes)
        return { error: `Lateness is 1 to ${TRIGGER_LIMITS.maxLatenessMinutes} minutes.` };
      if (lateness !== trigger?.latenessMinutes) patch.latenessMinutes = lateness;
    }
    if (f.catchUp !== trigger?.catchUp) patch.catchUp = f.catchUp;
    if (f.overlap !== trigger?.overlap) patch.overlap = f.overlap;
  }

  if (f.landing !== trigger?.landing) patch.landing = f.landing;
  if (f.report !== trigger?.report) patch.report = f.report;
  if (f.profile !== trigger?.profile) patch.profile = f.profile;
  if (!trigger) {
    if (!agentId) return { error: "Choose an agent." };
    const { landing, report, profile, latenessMinutes, catchUp, overlap } = patch;
    return { create: { agentId, name, start, action, landing, report, profile, latenessMinutes, catchUp, overlap } };
  }

  if (f.allow.length !== trigger.allow.length)
    patch.allow = f.allow.map(
      ({ tool, destination }): TriggerAllow => (destination ? { tool, destination } : { tool }),
    );
  return { patch };
}

type Props = { api: Api; onSaved: (trigger: Trigger) => void } & (
  | { trigger: Trigger; agents?: never; sources?: never; onCancel?: never }
  | { trigger?: never; agents: Agent[]; sources: EventSourceView[]; onCancel: () => void }
);

export function TriggerForm({ api, trigger, agents, sources, onSaved, onCancel }: Props) {
  const creating = trigger === undefined;
  const [selectedAgent, setSelectedAgent] = useState(agents?.[0]?.id ?? "");
  const agentId = trigger?.agentId ?? selectedAgent;
  const [form, setForm] = useState(() => (trigger ? formFromTrigger(trigger) : newForm(agents?.[0])));
  const [synced, setSynced] = useState(trigger);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const availableSkills =
    skills?.filter((s) => s.agents === null || s.agents.includes(agentId)).map((s) => s.name) ?? [];
  const ids = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) nameInput.current?.focus();
  }, [creating]);

  // The agent's saved skills, for the skill field: fetched once, when the action is (or becomes) a skill.
  useEffect(() => {
    if (form.kind !== "skill" || skills !== null) return;
    let live = true;
    Promise.resolve()
      .then(() => api.getSkills())
      .then(
        (r) => live && setSkills(r.skills),
        () => live && setSkills([]),
      );
    return () => {
      live = false;
    };
  }, [api, form.kind, skills]);

  // The server's copy changed (a run finished, someone paused it): follow it unless you are in the middle of an edit.
  if (trigger && synced && trigger !== synced) {
    if (JSON.stringify(form) === JSON.stringify(formFromTrigger(synced))) setForm(formFromTrigger(trigger));
    setSynced(trigger);
  }

  const set = (patch: Partial<Form>) => {
    setSaved(false);
    setForm((f) => ({ ...f, ...patch }));
  };
  const built = buildSubmission(form, agentId, trigger);
  const dirty = !("patch" in built) || Object.keys(built.patch).length > 0;

  async function save() {
    if ("error" in built) return;
    setBusy(true);
    setError(null);
    try {
      if ("create" in built) {
        const { trigger: created } = await api.createTrigger(built.create);
        onSaved(created);
      } else if (trigger) {
        const r = await api.updateTrigger(trigger.id, built.patch);
        setForm(formFromTrigger(r.trigger));
        setSynced(r.trigger);
        onSaved(r.trigger);
        setSaved(true);
      }
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setBusy(false);
    }
  }

  const kind = form.kind;
  return (
    <form
      className={`cfg-form flex min-w-0 flex-col gap-5 ${creating ? "" : "border-t pt-5"}`}
      aria-label={creating ? "New trigger" : "Settings"}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !busy) void save();
      }}
    >
      {!creating && (
        <h4 className="memory-h m-0 flex items-center gap-2 text-base font-semibold tracking-tight">Settings</h4>
      )}
      {agents && (
        <Field>
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-agent`}>
            Agent
            <NativeSelect
              id={`${ids}-agent`}
              value={agentId}
              disabled={busy}
              onChange={(e) => {
                const nextAgent = agents.find((a) => a.id === e.target.value);
                setSelectedAgent(e.target.value);
                set({ skill: "", profile: triggerProfile(nextAgent) });
              }}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        </Field>
      )}
      <Field>
        <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-name`}>
          Name
          <Input
            id={`${ids}-name`}
            ref={nameInput}
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
              <option value="event" disabled={sources?.length === 0}>
                When an event arrives
              </option>
            </NativeSelect>
          </label>
        </Field>
        {form.startKind === "event" && (
          <div className="cfg-row flex flex-wrap gap-3 [&>[data-slot=field]]:min-w-0 [&>[data-slot=field]]:flex-[1_1_9rem]">
            <Field>
              <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${ids}-source`}>
                Event source
                {sources ? (
                  <NativeSelect
                    id={`${ids}-source`}
                    value={form.source}
                    onChange={(e) => set({ source: e.target.value })}
                  >
                    <option value="">Choose an event source…</option>
                    {sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name === source.id ? source.name : `${source.name} (${source.id})`}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    id={`${ids}-source`}
                    type="text"
                    value={form.source}
                    autoComplete="off"
                    onChange={(e) => set({ source: e.target.value })}
                  />
                )}
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
                  {availableSkills.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  {form.skill !== "" && !availableSkills.includes(form.skill) && (
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
                  placeholder={creating ? "Automatic" : undefined}
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
        {kind !== "notify" &&
          (form.profile === "yolo" ? (
            <p className="cfg-hint approval-warn yolo-warn m-0 flex items-center gap-2 rounded-2xl bg-attention-soft px-3 py-2.5 text-xs text-attention-text">
              <Icon name="alert" size={16} />
              <span>
                {PROFILE_HELP.yolo} Content its runs read on the web could talk the agent into things you wouldn't
                choose.
              </span>
            </p>
          ) : (
            <p className="cfg-hint m-0 text-xs text-muted-foreground">{PROFILE_HELP[form.profile]}</p>
          ))}
      </fieldset>

      {!creating && kind !== "notify" && (
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
        {"error" in built && dirty && (!creating || form.name.trim() !== "") && (
          <span className="cfg-problem flex-[1_1_12rem] text-xs text-destructive">{built.error}</span>
        )}
        {saved && !dirty && (
          <span role="status" className="cfg-note text-sm text-muted-foreground">
            Saved.
          </span>
        )}
        {onCancel && (
          <Button variant="ghost" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button variant="default" type="submit" disabled={!dirty || "error" in built || busy} aria-busy={busy}>
          {creating ? (busy ? "Creating…" : "Create trigger") : busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
