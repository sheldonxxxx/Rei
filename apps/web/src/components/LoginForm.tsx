import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import type { Api } from "../api/client.ts";
import { ApiError, describeError } from "../api/client.ts";
import { PasskeyCancelled, passkeysSupported, signInWithPasskey } from "../lib/passkeys.ts";
import { clearSessionFlag, FIRST_TIME_SETUP_SESSION_KEY } from "../lib/storage.ts";
import { Icon } from "./Icon.tsx";
import { AuthCard } from "./SetupFlow.tsx";

export function LoginForm({
  api,
  totpEnabled = false,
  passkeys = false,
  onSignedIn,
}: {
  api: Api;
  totpEnabled?: boolean;
  /** A passkey is registered, so the page offers it. */
  passkeys?: boolean;
  onSignedIn: () => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.login({ password, ...(totpEnabled ? { totpCode: code } : {}) });
      clearSessionFlag(FIRST_TIME_SETUP_SESSION_KEY);
      onSignedIn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "bad_credentials" && !totpEnabled
          ? "Wrong password"
          : describeError(err),
      );
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPasskeyClick() {
    setError(null);
    setBusy(true);
    try {
      await signInWithPasskey(api);
      clearSessionFlag(FIRST_TIME_SETUP_SESSION_KEY);
      onSignedIn();
    } catch (err) {
      // Closing the browser's prompt is a choice, not a failure.
      if (!(err instanceof PasskeyCancelled)) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Welcome back">
      <form onSubmit={submit} noValidate>
        <Field>
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">
            <span>Password</span>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </label>
        </Field>
        {totpEnabled && (
          <>
            <Field>
              <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">
                <span>6-digit code</span>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="otp text-center font-mono text-xl tracking-[0.4em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                />
              </label>
            </Field>
          </>
        )}
        {error && (
          <p
            role="alert"
            className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        )}
        <Button variant="default" type="submit" disabled={busy || !password || (totpEnabled && code.length !== 6)}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        {passkeys && passkeysSupported() && (
          <Button variant="outline" type="button" disabled={busy} onClick={() => void signInWithPasskeyClick()}>
            <Icon name="key" size={16} />
            Sign in with a passkey
          </Button>
        )}
      </form>
    </AuthCard>
  );
}
