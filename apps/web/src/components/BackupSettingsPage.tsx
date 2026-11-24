import type { BackupRun, BackupSettings } from "@rei/protocol";
import { BACKUP_RETENTION_MAX } from "@rei/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Checkbox } from "@/components/primitives/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog.tsx";
import { Field, FieldContent, FieldDescription } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { formatWhen } from "../lib/time.ts";
import { useDirtyBaseline, useReportUnsaved } from "../lib/unsaved.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { PageShell } from "./PageShell.tsx";
import { SaveStatus } from "./SaveStatus.tsx";

type BackupApi = Pick<
  Api,
  | "getBackups"
  | "updateBackups"
  | "generateBackupPassword"
  | "setBackupRepository"
  | "forgetBackupRepository"
  | "runBackup"
>;

const POLL_MS = 2000;

const size = (bytes: number | null): string => {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

interface Draft {
  time: string;
  daily: string;
  weekly: string;
  monthly: string;
}

const draftOf = (s: BackupSettings): Draft => ({
  time: s.time,
  daily: String(s.retention.daily),
  weekly: String(s.retention.weekly),
  monthly: String(s.retention.monthly),
});

/** The row of one run: when, how it started, what it did; a failure shows its message. */
function RunRow({ run }: { run: BackupRun }) {
  const label = run.status === "running" ? "Running…" : run.status === "ok" ? "Done" : "Failed";
  return (
    <li className="flex min-w-0 flex-col gap-1 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tabular-nums">{formatWhen(run.startedAt)}</span>
        <span className={run.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{label}</span>
        <span className="text-muted-foreground">{run.trigger === "manual" ? "Started by you" : "Scheduled"}</span>
        {run.status === "ok" && run.bytesAdded !== null && (
          <span className="text-muted-foreground tabular-nums">{size(run.bytesAdded)} added</span>
        )}
        {run.maintenance && <span className="text-muted-foreground">{run.maintenance}</span>}
      </div>
      {run.error && <p className="m-0 text-xs whitespace-pre-wrap text-destructive">{run.error}</p>}
    </li>
  );
}

/** Settings > Backups: where Rei's data is copied every day, how long copies are kept, and the history of runs. */
export function BackupSettingsPage({ api }: { api: BackupApi }) {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectPassword, setConnectPassword] = useState("");
  const [forgetting, setForgetting] = useState(false);
  const { dirty, markSaved } = useDirtyBaseline(draft);
  useReportUnsaved(dirty);
  const timeId = useId();
  const retentionId = useId();
  const savedId = useId();

  // Every answer to a change is the new state: the form shows it.
  const accept = useCallback(
    (next: BackupSettings) => {
      setSettings(next);
      setDraft(draftOf(next));
      markSaved(draftOf(next));
    },
    [markSaved],
  );

  useEffect(() => {
    let live = true;
    api
      .getBackups()
      .then((next) => live && accept(next))
      .catch((e) => live && setError(describeError(e)));
    return () => {
      live = false;
    };
  }, [api, accept]);

  const running = settings?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      api
        .getBackups()
        .then((next) => setSettings(next))
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [api, running]);

  const act = async (work: () => Promise<BackupSettings | undefined>, done?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await work();
      if (next) accept(next);
      done?.();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(
      async () => {
        if (!draft) return undefined;
        return api.updateBackups({
          time: draft.time,
          retention: { daily: Number(draft.daily), weekly: Number(draft.weekly), monthly: Number(draft.monthly) },
        });
      },
      () => setSaved(true),
    );

  const startCreate = () =>
    act(async () => {
      const made = await api.generateBackupPassword();
      setConfirmed(false);
      setPassword(made.password);
      return undefined;
    });

  if (!settings || !draft) {
    return (
      <PageShell title="Backups">
        {error ? (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p className="m-0 text-sm text-muted-foreground">Loading…</p>
        )}
      </PageShell>
    );
  }

  if (!settings.available) {
    return (
      <PageShell title="Backups">
        <p className="m-0 text-sm text-muted-foreground">
          Backups are not set up for this installation. Choose a folder for them by setting REI_BACKUP_DIR in the
          stack's .env file, then redeploy. See docs/backup-user.md.
        </p>
      </PageShell>
    );
  }

  const ready = settings.repository === "ready";
  const last = settings.lastRun;
  const numberOk = [draft.daily, draft.weekly, draft.monthly].every(
    (n) => /^\d+$/.test(n) && Number(n) <= BACKUP_RETENTION_MAX,
  );
  const retentionOk = numberOk && Number(draft.daily) + Number(draft.weekly) + Number(draft.monthly) >= 1;
  const timeOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time);

  return (
    <PageShell
      title="Backups"
      actions={
        ready ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || running}
            onClick={() => void act(() => api.runBackup())}
          >
            {running ? "Backing up…" : "Run now"}
          </Button>
        ) : undefined
      }
      className="[&>.page-col]:gap-0 [&>.page-col>*+*]:border-t"
    >
      {error && (
        <p role="alert" className="m-0 pb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {settings.stale && (
        <p role="status" className="m-0 pb-4 text-sm attention-text">
          The last backup that worked was more than a day and a half ago. Check the history below.
        </p>
      )}
      <Field orientation="vertical" className="min-w-0 gap-3 py-5 first:pt-0">
        <FieldContent className="min-w-0">
          <Label className="text-sm font-medium">Repository</Label>
          <FieldDescription>
            A folder on the computer that runs Rei ({settings.path}), encrypted with a password only you keep. Rei
            writes to it; it cannot read anything else on that computer.
          </FieldDescription>
        </FieldContent>
        {ready ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span>
              {settings.snapshots ?? 0} {settings.snapshots === 1 ? "backup" : "backups"}
              {settings.repositoryBytes !== null && `, ${size(settings.repositoryBytes)}`}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setForgetting(true)}
            >
              Forget repository
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button type="button" disabled={busy} onClick={() => void startCreate()}>
              Create repository
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setConnecting(true)}>
              Connect existing
            </Button>
          </div>
        )}
      </Field>

      {ready && (
        <>
          <Field orientation="horizontal" className="min-w-0 items-center justify-between gap-5 py-5">
            <FieldContent className="min-w-0">
              <Label htmlFor={`${timeId}-on`} className="text-sm font-medium">
                Back up every day
              </Label>
              <FieldDescription>
                {settings.enabled && settings.nextRunAt
                  ? `Next backup ${formatWhen(settings.nextRunAt)} (${settings.timeZone}).`
                  : "Off. Rei backs up only when you press Run now."}
              </FieldDescription>
            </FieldContent>
            <Switch
              id={`${timeId}-on`}
              checked={settings.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => void act(() => api.updateBackups({ enabled }))}
            />
          </Field>

          <Field orientation="vertical" className="min-w-0 gap-3 py-5">
            <div className="flex min-w-0 flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={timeId} className="text-sm font-medium">
                  Time
                </Label>
                <Input
                  id={timeId}
                  type="time"
                  className="w-32"
                  value={draft.time}
                  onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                />
              </div>
              <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" aria-labelledby={retentionId}>
                <span id={retentionId} className="text-sm font-medium">
                  Keep
                </span>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  {(["daily", "weekly", "monthly"] as const).map((key) => (
                    <div key={key} className="flex items-center gap-1.5">
                      <Input
                        id={`${retentionId}-${key}`}
                        type="number"
                        min={0}
                        max={BACKUP_RETENTION_MAX}
                        className="w-20"
                        aria-label={`Keep ${key} backups`}
                        value={draft[key]}
                        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                      />
                      <label htmlFor={`${retentionId}-${key}`}>{key}</label>
                    </div>
                  ))}
                </div>
              </fieldset>
              <Button type="button" disabled={busy || !dirty || !retentionOk || !timeOk} onClick={() => void save()}>
                Save
              </Button>
              <SaveStatus dirty={dirty} saved={saved} />
            </div>
            <FieldDescription>
              Rei keeps the newest backup of each of that many days, weeks and months. Time is in {settings.timeZone}.
            </FieldDescription>
            {!retentionOk && dirty && (
              <p className="m-0 text-xs text-destructive" role="alert">
                Use whole numbers from 0 to {BACKUP_RETENTION_MAX}, and keep at least one backup.
              </p>
            )}
          </Field>

          <Field orientation="vertical" className="min-w-0 gap-2 py-5">
            <Label className="text-sm font-medium">History</Label>
            {last === null ? (
              <FieldDescription>No backup has run yet.</FieldDescription>
            ) : (
              <ul className="m-0 flex list-none flex-col divide-y p-0" aria-label="Backup history">
                {settings.history.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </ul>
            )}
          </Field>
        </>
      )}

      <Dialog open={password !== null} onOpenChange={(open) => !open && setPassword(null)}>
        <DialogContent size="default" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Save this password</DialogTitle>
            <DialogDescription>
              It encrypts every backup. Rei shows it only now and cannot recover it: without it the backups cannot be
              opened. Keep it in your password manager.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-2 rounded-xl bg-muted px-3 py-2">
            <code className="min-w-0 flex-1 text-sm break-all select-all" data-testid="backup-password">
              {password}
            </code>
            <CopyButton text={password ?? ""} label="Copy password" />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Checkbox id={savedId} checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
            <label htmlFor={savedId}>I saved this password</label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPassword(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!confirmed || busy}
              onClick={() =>
                void act(
                  () => api.setBackupRepository({ mode: "create", confirmed: true }),
                  () => setPassword(null),
                )
              }
            >
              Create repository
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={connecting} onOpenChange={(open) => !open && setConnecting(false)}>
        <DialogContent size="default" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Connect an existing repository</DialogTitle>
            <DialogDescription>
              The folder already holds a repository from an earlier Rei. Enter the password it was made with.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            autoComplete="off"
            aria-label="Repository password"
            value={connectPassword}
            onChange={(e) => setConnectPassword(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConnecting(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!connectPassword || busy}
              onClick={() =>
                void act(
                  () => api.setBackupRepository({ mode: "connect", password: connectPassword }),
                  () => {
                    setConnecting(false);
                    setConnectPassword("");
                  },
                )
              }
            >
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={forgetting} onOpenChange={(open) => !open && setForgetting(false)}>
        <DialogContent size="default" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Forget this repository?</DialogTitle>
            <DialogDescription>
              Rei stops backing up and forgets the password. The backups stay in the folder, and you can connect to them
              again with the password.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setForgetting(false)}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void act(
                  () => api.forgetBackupRepository(),
                  () => setForgetting(false),
                )
              }
            >
              Forget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
