import type { MemoryExtractionSettings as Settings } from "@rei/protocol";
import { useEffect, useId, useState } from "react";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";

type ExtractionApi = Pick<Api, "getMemoryExtraction" | "updateMemoryExtraction">;

/**
 * Settings > Memory: whether finished chats are reviewed in the background to save durable facts. Off by default, because
 * each review is a model call on the agent's own model. The agents' memory tools work either way.
 */
export function MemoryExtractionSettings({ api }: { api: ExtractionApi }) {
  const labelId = useId();
  const helpId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const s = await api.getMemoryExtraction();
        if (live) setSettings(s);
      } catch (e) {
        if (live) setError(describeError(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);

  const change = async (patch: { enabled?: boolean; everyNTurns?: number }) => {
    if (busy || !settings) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.updateMemoryExtraction(patch));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field orientation="horizontal" className="setting-row min-w-0 items-center justify-between gap-5 border-b py-5">
        <FieldContent className="setting-text min-w-0">
          <FieldTitle id={labelId} className="setting-label text-sm font-medium">
            Background memory review
          </FieldTitle>
          <FieldDescription id={helpId}>
            Off by default. Rei privately reviews each chat after the chosen number of completed replies. It uses
            conversation context to interpret your words and saves only durable information supported by your new
            messages. A review can finish with no changes, or add, update or remove unprotected memory. Counting starts
            when enabled; earlier messages are not backfilled. Each review uses the source reply’s model and adds token
            cost.
          </FieldDescription>
          {error && (
            <p className="field-hint m-0 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </FieldContent>
        <Switch
          checked={settings?.enabled ?? false}
          disabled={!settings || busy}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          onCheckedChange={(on) => void change({ enabled: on })}
        />
      </Field>
      <Field orientation="horizontal" className="setting-row items-center justify-between gap-5 border-b py-5">
        <FieldContent>
          <label htmlFor={`${labelId}-cadence`} className="text-sm font-medium">
            Review every N replies
          </label>
          <FieldDescription>
            Global setting for all agents. Each chat keeps its own count. Default 5; choose 2–100.
          </FieldDescription>
        </FieldContent>
        {settings && (
          <Input
            key={settings.everyNTurns}
            id={`${labelId}-cadence`}
            className="w-24"
            type="number"
            min={2}
            max={100}
            step={1}
            defaultValue={settings.everyNTurns}
            disabled={busy}
            onBlur={(event) => {
              const n = Number(event.target.value);
              if (!Number.isInteger(n) || n < 2 || n > 100) {
                setError("Choose a whole number from 2 to 100.");
                return;
              }
              if (n !== settings.everyNTurns) void change({ everyNTurns: n });
            }}
          />
        )}
      </Field>
    </>
  );
}
