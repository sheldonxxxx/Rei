import { useEffect, useId, useState } from "react";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/primitives/field.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import type { PushEnv, PushSupport } from "../lib/push.ts";
import { browserPush, PushDenied } from "../lib/push.ts";

type NotifyApi = Pick<
  Api,
  | "getPushKey"
  | "registerChannel"
  | "getDevices"
  | "removeChannel"
  | "getNotifications"
  | "updatePreview"
  | "testNotifications"
>;

const WHY_NOT: Record<Exclude<PushSupport, "ok">, string> = {
  needs_home_screen: "Add Rei to your Home Screen to get notifications here.",
  unsupported: "This browser can't show notifications from Rei.",
  denied: "Notifications are blocked for Rei. Allow them in your browser's settings, then come back.",
};

/** Settings → General: browser notifications and their preview settings. */
export function NotificationSettings({ api, push = browserPush }: { api: NotifyApi; push?: PushEnv }) {
  return (
    <>
      <DeviceNotifications api={api} push={push} />
      <PreviewSetting api={api} />
    </>
  );
}

function DeviceNotifications({ api, push }: { api: NotifyApi; push: PushEnv }) {
  const labelId = useId();
  const helpId = useId();
  const [support, setSupport] = useState<PushSupport>(() => push.support());
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void push.subscribed().then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, [push]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (on) {
        await push.disable(api);
        setOn(false);
      } else {
        await push.enable(api);
        setOn(true);
        // Say hi on this device. Best effort: the switch is already on even if the message fails.
        await api.testNotifications().catch(() => undefined);
      }
    } catch (e) {
      if (e instanceof PushDenied) setSupport("denied");
      else setError(e instanceof Error && !("code" in e) ? e.message : describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field
      orientation="horizontal"
      className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t"
    >
      <FieldContent className="setting-text min-w-0">
        <FieldTitle id={labelId} className="setting-label text-sm font-medium">
          Notifications on this device
        </FieldTitle>
        <FieldDescription id={helpId} className="setting-help m-0 max-w-xl text-sm text-muted-foreground">
          {support === "ok" ? "When something needs you" : WHY_NOT[support]}
        </FieldDescription>
        {error && (
          <p className="field-hint m-0 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </FieldContent>
      {support === "ok" && (
        <Switch
          checked={on}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          aria-busy={busy}
          disabled={busy}
          onCheckedChange={() => void toggle()}
        />
      )}
    </Field>
  );
}

/** Whether notifications say what happened. Off, they keep the title and say only what kind of thing it was. */
function PreviewSetting({ api }: { api: NotifyApi }) {
  const labelId = useId();
  const helpId = useId();
  const [preview, setPreview] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => api.getNotifications())
      .then(
        (s) => live && setPreview((current) => current ?? s.preview),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [api]);
  const change = async (next: boolean) => {
    setError(null);
    setPreview(next);
    try {
      setPreview((await api.updatePreview(next)).preview);
    } catch (e) {
      setPreview(!next);
      setError(describeError(e));
    }
  };
  return (
    <Field
      orientation="horizontal"
      className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t"
    >
      <FieldContent className="setting-text min-w-0">
        <FieldTitle id={labelId} className="setting-label text-sm font-medium">
          Show previews
        </FieldTitle>
        <FieldDescription id={helpId} className="setting-help m-0 max-w-xl text-sm text-muted-foreground">
          Off, notifications on every device keep the chat title and leave out what was said
        </FieldDescription>
        {error && (
          <p className="field-hint m-0 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </FieldContent>
      <Switch
        checked={preview ?? true}
        disabled={preview === null}
        aria-labelledby={labelId}
        aria-describedby={helpId}
        onCheckedChange={(v) => void change(v)}
      />
    </Field>
  );
}
