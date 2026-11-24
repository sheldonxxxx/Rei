import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Input } from "@/components/primitives/input.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { QrCode } from "./SetupFlow.tsx";

export function AccountSecurity({ api }: { api: Api }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrol, setEnrol] = useState<{ totpUri: string; totpSecret: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.getAuthState())
      .then((s) => {
        if (live) setEnabled(s.totpEnabled);
      })
      .catch((e) => {
        if (live) setError(describeError(e));
      });
    return () => {
      live = false;
    };
  }, [api]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (enabled) {
        await api.disableTotp(password, code);
        setEnabled(false);
      } else if (enrol) {
        await api.confirmTotp(password, code);
        setEnabled(true);
      } else {
        setEnrol(await api.startTotp(password));
        return;
      }
      setEnrol(null);
      setPassword("");
      setCode("");
      setEditing(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  function cancel() {
    setEditing(false);
    setEnrol(null);
    setPassword("");
    setCode("");
    setError("");
  }
  return (
    <section className="border-t py-5 space-y-3" aria-label="Account security">
      <h3 className="text-sm font-medium">Two-factor authentication</h3>
      <p className="text-sm text-muted-foreground">
        {enabled === null
          ? "Loading…"
          : enabled
            ? "Enabled. Sign in with your password and an authenticator code."
            : "Off. Sign in with your password. Add an authenticator for an extra sign-in step."}
      </p>
      {!editing && enabled !== null && (
        <Button variant="outline" onClick={() => setEditing(true)}>
          {enabled ? "Disable two-factor authentication" : "Set up authenticator"}
        </Button>
      )}
      {editing && (
        <form onSubmit={submit} className="space-y-3 max-w-sm">
          <label className="block text-sm">
            Current password
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {enrol && (
            <>
              <QrCode value={enrol.totpUri} />
              <p className="text-sm text-muted-foreground">Scan with your authenticator, or enter this key:</p>
              <code className="block break-all select-all">{enrol.totpSecret}</code>
              <p className="text-sm text-muted-foreground">
                Two-factor authentication stays off until you confirm a code.
              </p>
            </>
          )}
          {(enabled || enrol) && (
            <label className="block text-sm">
              6-digit code
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                maxLength={6}
                required
              />
            </label>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !password || ((enabled || !!enrol) && code.length !== 6)}>
              {busy ? "Saving…" : enabled ? "Disable authenticator" : enrol ? "Enable authenticator" : "Continue"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>
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
