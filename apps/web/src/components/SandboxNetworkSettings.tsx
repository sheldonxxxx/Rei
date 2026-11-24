import type { SandboxNetworkSettings as Settings } from "@rei/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Field, FieldDescription } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { useDirtyBaseline, useReportUnsaved } from "../lib/unsaved.tsx";
import { SaveStatus } from "./SaveStatus.tsx";

type SandboxApi = Pick<Api, "getSandboxNetwork" | "updateSandboxNetwork">;

/** The most entries the server keeps. */
const MAX_ENTRIES = 200;

/**
 * The sandbox whitelist: the destinations a Whitelist agent reaches without asking. The server checks and normalizes
 * the list on save; a bad entry is refused with its reason and the saved list stays as it was.
 */
export function SandboxNetworkSettings({ api }: { api: SandboxApi }) {
  const id = useId();
  const [defaults, setDefaults] = useState<string[]>([]);
  const [entries, setEntries] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dirty, markSaved } = useDirtyBaseline({ entries });
  useReportUnsaved(dirty);

  const load = useCallback(
    (s: Settings) => {
      setDefaults(s.defaults);
      setEntries(s.whitelist);
      markSaved({ entries: s.whitelist });
    },
    [markSaved],
  );
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.getSandboxNetwork())
      .then(
        (s) => {
          if (live) load(s);
        },
        (e) => {
          if (live) setError(describeError(e));
        },
      );
    return () => {
      live = false;
    };
  }, [api, load]);

  const add = () => {
    const text = draft.trim();
    if (text === "" || entries === null) return;
    if (entries.some((entry) => entry.toLowerCase() === text.toLowerCase()))
      return setError(`“${text}” is already on the list.`);
    if (entries.length >= MAX_ENTRIES) return setError(`The list holds at most ${MAX_ENTRIES} entries.`);
    setEntries([...entries, text]);
    setDraft("");
    setSaved(false);
    setError(null);
  };
  const remove = (entry: string) => {
    setEntries((list) => list?.filter((e) => e !== entry) ?? list);
    setSaved(false);
  };
  const run = async (call: () => Promise<Settings>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      load(await call());
      setSaved(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(() => api.updateSandboxNetwork({ whitelist: entries ?? [] }));
  const reset = () => run(() => api.updateSandboxNetwork({ reset: true }));
  const isDefault = entries !== null && JSON.stringify(entries) === JSON.stringify(defaults);

  return (
    <div className="grid max-w-2xl gap-4">
      <p className="m-0 text-sm text-muted-foreground">
        Whitelist agents reach these sites on ports 80 and 443 without asking. Use a host name (pypi.org), a wildcard
        for subdomains (*.github.com), an IP address, or a network (10.0.0.0/8).
      </p>
      <p className="m-0 text-sm text-muted-foreground">
        <strong className="font-medium text-foreground">Local network:</strong> an address on your local network is
        reachable only when both its host name and the address are on this list. For example, add wiki.lan and
        10.0.0.0/8 together. A name alone does not open its address, and an address alone does not open a name. An agent
        set to Any reaches your local network without this list.
      </p>
      {entries === null && !error && <p className="m-0 text-sm text-muted-foreground">Loading the whitelist…</p>}
      {entries !== null && (
        <>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Field className="min-w-0 flex-1 gap-2">
              <Label htmlFor={`${id}-entry`}>Add a site or network</Label>
              <Input
                id={`${id}-entry`}
                value={draft}
                disabled={busy}
                placeholder="example.com"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="secondary" disabled={busy || draft.trim() === ""}>
              Add
            </Button>
          </form>
          {entries.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              The list is empty. Whitelist agents ask before reaching any site.
            </p>
          ) : (
            <ul aria-label="Sandbox whitelist" className="m-0 flex list-none flex-col divide-y rounded-xl border p-0">
              {entries.map((entry) => (
                <li key={entry} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 break-all font-mono text-sm">{entry}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove ${entry}`}
                    onClick={() => remove(entry)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <FieldDescription>
            {entries.length} of {MAX_ENTRIES} entries. Changes apply to the next request each agent makes.
          </FieldDescription>
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
      {entries !== null && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="button" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save whitelist"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy || isDefault} onClick={() => void reset()}>
            Restore defaults
          </Button>
          <SaveStatus dirty={dirty} saved={saved} message="Saved. Applies to the next request." />
        </div>
      )}
    </div>
  );
}
