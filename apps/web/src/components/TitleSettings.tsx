import type { ModelsResponse, TitleSettings as Settings } from "@rei/protocol";
import { useEffect, useId, useState } from "react";
import { Field, FieldContent } from "@/components/primitives/field.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";

type TitleApi = Pick<Api, "getTitleSettings" | "updateTitleSettings" | "getModels">;

/** The select's values for "no model, use the first message" and "the server's default title model". */
const OFF = "\u0000off";
const DEFAULT = "";

/** Settings > General: who writes the title of a chat you start. One control: Off, the default model, or a model. */
export function TitleSettings({ api }: { api: TitleApi }) {
  const labelId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [s, m] = await Promise.all([api.getTitleSettings(), api.getModels().catch(() => null)]);
        if (!live) return;
        setSettings(s);
        setCatalog(m);
      } catch (e) {
        if (live) setError(describeError(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);

  const value = !settings ? DEFAULT : !settings.enabled ? OFF : (settings.model ?? DEFAULT);
  const options = catalog?.models ?? [];

  const change = async (next: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(
        await api.updateTitleSettings(
          next === OFF ? { enabled: false } : { enabled: true, model: next === DEFAULT ? null : next },
        ),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field
      orientation="vertical"
      className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t setting-stack items-stretch"
    >
      <FieldContent className="setting-text min-w-0">
        <Label htmlFor={labelId} className="setting-label text-sm font-medium">
          Chat titles
        </Label>
      </FieldContent>
      <div className="setting-line flex min-w-0 flex-wrap items-center gap-3">
        <NativeSelect
          id={labelId}
          className="setting-select min-w-0 max-w-full shrink-0 max-sm:w-full"
          value={value}
          disabled={!settings || busy}
          onChange={(e) => void change(e.target.value)}
        >
          <option value={OFF}>Off: use the first message</option>
          <option value={DEFAULT} disabled={!settings || !options.includes(settings.default)}>
            {settings && options.includes(settings.default) ? `Default (${settings.default})` : "Default unavailable"}
          </option>
          {settings?.model && !options.includes(settings.model) && (
            <option value={settings.model} disabled>
              Current model unavailable
            </option>
          )}
          {options.map((m) => (
            <option key={m} value={m}>
              {catalog?.labels?.[m] ?? m}
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
