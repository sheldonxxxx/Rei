import type { Agent, Companion } from "@rei/protocol";
import { useId, useState } from "react";
import { Field, FieldContent, FieldDescription } from "@/components/primitives/field.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";

/**
 * Settings > General: the companion agent, the one companion clients (a widget, quick-send, the floating icon) talk to.
 * The value comes from the global stream, so a change made on another device shows here too.
 */
export function CompanionSetting({
  api,
  agents,
  companion,
}: {
  api: Pick<Api, "updateCompanion">;
  agents: Agent[];
  companion: Companion | null;
}) {
  const id = useId();
  const helpId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown at once; the global stream's companion.changed confirms it.
  const [picked, setPicked] = useState<string | null>(null);
  const value = picked ?? companion?.agentId ?? "";

  const change = async (agentId: string) => {
    if (busy || !agentId || agentId === companion?.agentId) return;
    setBusy(true);
    setError(null);
    setPicked(agentId);
    try {
      await api.updateCompanion({ agentId });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setPicked(null);
      setBusy(false);
    }
  };

  return (
    <Field
      orientation="vertical"
      className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t setting-stack items-stretch"
    >
      <FieldContent className="setting-text min-w-0">
        <Label htmlFor={id} className="setting-label text-sm font-medium">
          Companion
        </Label>
        <FieldDescription id={helpId}>
          The agent that widgets and quick messages from other devices go to.
        </FieldDescription>
      </FieldContent>
      <div className="setting-line flex min-w-0 flex-wrap items-center gap-3">
        <NativeSelect
          id={id}
          aria-describedby={helpId}
          className="setting-select min-w-0 max-w-full shrink-0 max-sm:w-full"
          value={value}
          disabled={!companion || busy || agents.length === 0}
          onChange={(e) => void change(e.target.value)}
        >
          {!value && (
            <option value="" disabled>
              Loading…
            </option>
          )}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      {error && (
        <p className="field-hint m-0 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </Field>
  );
}
