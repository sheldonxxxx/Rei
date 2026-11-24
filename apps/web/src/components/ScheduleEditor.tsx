import type { Weekday } from "@rei/protocol";
import { TRIGGER_LIMITS } from "@rei/protocol";
import { useId, useMemo } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/primitives/toggle-group.tsx";
import type { ScheduleDraft } from "../lib/triggers.ts";
import { timeZones, WEEKDAYS } from "../lib/triggers.ts";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

const KINDS: { id: ScheduleDraft["kind"]; label: string }[] = [
  { id: "once", label: "Once" },
  { id: "daily", label: "Every day or on some weekdays" },
  { id: "monthly", label: "Once a month" },
  { id: "interval", label: "Every few minutes or hours" },
];

interface Props {
  draft: ScheduleDraft;
  onChange: (draft: ScheduleDraft) => void;
  disabled?: boolean;
}

/** The four schedule kinds as a form. The draft keeps every kind's fields, so switching kinds loses nothing. */
export function ScheduleEditor({ draft, onChange, disabled = false }: Props) {
  const id = useId();
  const zones = useMemo(timeZones, []);
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...draft, ...patch });
  const setTime = (i: number, v: string) => set({ times: draft.times.map((t, j) => (j === i ? v : t)) });

  return (
    <fieldset
      className="cfg-group m-0 flex min-w-0 flex-col gap-3 border-0 p-0 [&_legend]:mb-3 [&_legend]:p-0 [&_legend]:text-sm [&_legend]:font-medium"
      disabled={disabled}
    >
      <legend>Schedule</legend>
      <Field>
        <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${id}-kind`}>
          Repeats
          <NativeSelect
            id={`${id}-kind`}
            value={draft.kind}
            onChange={(e) => set({ kind: e.target.value as ScheduleDraft["kind"] })}
          >
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </NativeSelect>
        </label>
      </Field>

      {draft.kind === "once" && (
        <Field>
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${id}-at`}>
            Date and time
            <Input
              id={`${id}-at`}
              type="datetime-local"
              value={draft.at}
              onChange={(e) => set({ at: e.target.value })}
            />
          </label>
        </Field>
      )}

      {draft.kind === "monthly" && (
        <Field>
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${id}-day`}>
            Day of the month
            <NativeSelect id={`${id}-day`} value={draft.day} onChange={(e) => set({ day: e.target.value })}>
              {Array.from({ length: 31 }, (_, i) => (
                <option key={i} value={String(i + 1)}>
                  {i + 1}
                </option>
              ))}
              <option value="last">Last day</option>
            </NativeSelect>
          </label>
        </Field>
      )}

      {(draft.kind === "daily" || draft.kind === "monthly") && (
        <div className="cfg-times flex flex-col gap-2">
          <span className="cfg-label text-sm font-medium" id={`${id}-times`}>
            {draft.kind === "daily" ? "At" : "At these times"}
          </span>
          <ul
            className="cfg-time-list m-0 flex list-none flex-col gap-2 p-0 [&>li]:flex [&>li]:items-center [&>li]:gap-2 [&_input]:w-auto"
            aria-labelledby={`${id}-times`}
          >
            {draft.times.map((t, i) => (
              <li key={i}>
                <Input
                  type="time"
                  value={t}
                  aria-label={`Time ${i + 1}`}
                  onChange={(e) => setTime(i, e.target.value)}
                />
                {draft.times.length > 1 && (
                  <Tip label={`Remove time ${i + 1}`}>
                    <Button
                      size="icon-sm"
                      variant="outline"
                      type="button"
                      aria-label={`Remove time ${i + 1}`}
                      onClick={() => set({ times: draft.times.filter((_, j) => j !== i) })}
                    >
                      <Icon name="close" size={16} />
                    </Button>
                  </Tip>
                )}
              </li>
            ))}
          </ul>
          {draft.times.length < TRIGGER_LIMITS.timesPerDay && (
            <div>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => set({ times: [...draft.times, "12:00"] })}
              >
                <Icon name="plus" size={16} />
                Add a time
              </Button>
            </div>
          )}
        </div>
      )}

      {draft.kind === "interval" && (
        <div className="cfg-row flex flex-wrap gap-3 [&>[data-slot=field]]:min-w-0 [&>[data-slot=field]]:flex-[1_1_9rem]">
          <Field>
            <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${id}-every`}>
              Every (minutes)
              <Input
                id={`${id}-every`}
                type="number"
                inputMode="numeric"
                min={TRIGGER_LIMITS.minIntervalMinutes}
                max={1440}
                step={1}
                value={draft.everyMinutes}
                onChange={(e) => set({ everyMinutes: e.target.value })}
              />
            </label>
          </Field>
          <Field>
            <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${id}-from`}>
              From
              <Input id={`${id}-from`} type="time" value={draft.from} onChange={(e) => set({ from: e.target.value })} />
            </label>
          </Field>
          <Field>
            <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${id}-until`}>
              Until
              <Input
                id={`${id}-until`}
                type="time"
                value={draft.until}
                onChange={(e) => set({ until: e.target.value })}
              />
            </label>
          </Field>
        </div>
      )}

      {(draft.kind === "daily" || draft.kind === "interval") && (
        <div className="cfg-days flex flex-col gap-2">
          <span className="cfg-label text-sm font-medium" id={`${id}-days`}>
            On
          </span>
          <ToggleGroup
            type="multiple"
            variant="outline"
            spacing={1}
            value={draft.days}
            disabled={disabled}
            onValueChange={(days) => set({ days: days as Weekday[] })}
            className="agent-picker flex-wrap"
            aria-labelledby={`${id}-days`}
          >
            {WEEKDAYS.map((d) => (
              <Tip key={d.id} label={d.label}>
                <ToggleGroupItem value={d.id} aria-label={d.label} className="cfg-day min-w-10">
                  {d.label}
                </ToggleGroupItem>
              </Tip>
            ))}
          </ToggleGroup>
        </div>
      )}

      <Field>
        <label className="flex min-w-0 flex-col gap-2 text-sm font-medium" htmlFor={`${id}-zone`}>
          Time zone
          <Input
            id={`${id}-zone`}
            type="text"
            list={zones.length > 0 ? `${id}-zones` : undefined}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={draft.timeZone}
            onChange={(e) => set({ timeZone: e.target.value })}
          />
          {zones.length > 0 && (
            <datalist id={`${id}-zones`}>
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          )}
        </label>
      </Field>
    </fieldset>
  );
}
