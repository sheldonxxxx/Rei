import type { Passkey } from "@rei/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Input } from "@/components/primitives/input.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { addPasskey, PasskeyCancelled, passkeysSupported } from "../lib/passkeys.ts";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });

/** Passkeys: sign in with the device's screen lock or a security key, in place of the password and code. */
export function PasskeySettings({ api }: { api: Api }) {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const passwordId = useId();
  const labelId = useId();

  const load = useCallback(async () => {
    try {
      setPasskeys((await api.listPasskeys()).passkeys);
    } catch (e) {
      setPasskeys([]);
      setError(describeError(e));
    }
  }, [api]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  function reset() {
    setAdding(false);
    setPassword("");
    setLabel("");
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await addPasskey(api, password, label);
      reset();
      await load();
    } catch (err) {
      if (!(err instanceof PasskeyCancelled)) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove(p: Passkey) {
    setError("");
    try {
      await api.removePasskey(p.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const supported = passkeysSupported();
  return (
    <section className="border-t py-5 space-y-3" aria-label="Passkeys">
      <h3 className="text-sm font-medium">Passkeys</h3>
      <p className="text-sm text-muted-foreground">
        {passkeys !== null && passkeys.length > 0
          ? "Sign in with your device's screen lock or a security key. A passkey replaces the password and the authenticator code."
          : "Sign in with your device's screen lock or a security key instead of typing a password."}
      </p>
      {passkeys !== null && passkeys.length > 0 && (
        <ul className="space-y-1 max-w-sm">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {p.label}
                <span className="text-muted-foreground">
                  {" "}
                  · added {day(p.createdAt)}
                  {p.synced ? " · synced" : ""}
                </span>
              </span>
              <Tip label="Remove">
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${p.label}`} onClick={() => void remove(p)}>
                  <Icon name="trash" size={16} />
                </Button>
              </Tip>
            </li>
          ))}
        </ul>
      )}
      {!supported && <p className="text-sm text-muted-foreground">This browser can't create passkeys.</p>}
      {supported && !adding && passkeys !== null && (
        <Button variant="outline" onClick={() => setAdding(true)}>
          Add a passkey
        </Button>
      )}
      {adding && (
        <form onSubmit={submit} className="space-y-3 max-w-sm">
          <label htmlFor={passwordId} className="flex min-w-0 flex-col gap-2 text-sm font-medium">
            <span>Current password</span>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <label htmlFor={labelId} className="flex min-w-0 flex-col gap-2 text-sm font-medium">
            <span>Name (optional)</span>
            <Input
              id={labelId}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
              placeholder="MacBook, YubiKey…"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !password}>
              {busy ? "Waiting for your device…" : "Create passkey"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
