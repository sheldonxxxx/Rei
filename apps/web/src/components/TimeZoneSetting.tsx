import type { TimeZoneSettings as Settings } from "@rei/protocol";
import { useEffect, useId, useMemo, useState } from "react";
import { Field, FieldContent, FieldDescription } from "@/components/primitives/field.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { timeZones } from "../lib/triggers.ts";

type TimeZoneApi = Pick<Api, "getTimeZone" | "updateTimeZone">;

/** This browser's IANA time zone, or undefined where the browser does not report one. */
export function browserTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
}

/**
 * The first time the app opens, the browser's zone becomes the user's, unless one is already saved. A failure is ignored:
 * the zone can still be chosen in Settings > General.
 */
export async function saveBrowserTimeZoneIfUnset(api: TimeZoneApi): Promise<void> {
  try {
    const saved = await api.getTimeZone();
    const detected = browserTimeZone();
    if (saved.timeZone === null && detected) await api.updateTimeZone({ timeZone: detected });
  } catch {
    // Not saved yet; the next open tries again.
  }
}

/** Settings > General: the time zone for today's date and the clock times in chats. */
export function TimeZoneSetting({ api }: { api: TimeZoneApi }) {
  const labelId = useId();
  const helpId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(timeZones, []);

  useEffect(() => {
    let live = true;
    api
      .getTimeZone()
      .then((s) => live && setSettings(s))
      .catch((e) => live && setError(describeError(e)));
    return () => {
      live = false;
    };
  }, [api]);

  const change = async (timeZone: string) => {
    if (busy || !timeZone) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.updateTimeZone({ timeZone }));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const value = settings?.timeZone ?? "";
  // The browser's own zone and the saved one always show, even where the browser lists no zones.
  const options = [...new Set([...zones, browserTimeZone(), "UTC", value].filter((z): z is string => !!z))].sort();

  return (
    <Field
      orientation="vertical"
      className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t setting-stack items-stretch"
    >
      <FieldContent className="setting-text min-w-0">
        <Label htmlFor={labelId} className="setting-label text-sm font-medium">
          Time zone
        </Label>
        <FieldDescription id={helpId}>Sets today's date and clock times for the assistant.</FieldDescription>
      </FieldContent>
      <div className="setting-line flex min-w-0 flex-wrap items-center gap-3">
        <NativeSelect
          id={labelId}
          aria-describedby={helpId}
          className="setting-select min-w-0 max-w-full shrink-0 max-sm:w-full"
          value={value}
          disabled={!settings || busy}
          onChange={(e) => void change(e.target.value)}
        >
          {!value && (
            <option value="" disabled>
              Not set
            </option>
          )}
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
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
