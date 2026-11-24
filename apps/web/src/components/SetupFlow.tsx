import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Card } from "@/components/primitives/card.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import type { Api } from "../api/client.ts";
import { ApiError, describeError } from "../api/client.ts";
import { qrSvg } from "../lib/qr.ts";
import { ReiWordmark } from "./ReiWordmark.tsx";

interface Props {
  api: Api;
  /** The account exists and the cookie is set. */
  onDone: () => void;
  /** The server says it is already set up. */
  onAlreadySetUp: () => void;
}

export function SetupFlow({ api, onDone, onAlreadySetUp }: Props) {
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.code === "already_set_up") onAlreadySetUp();
    setError(describeError(e));
  };

  async function submitDetails(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) return setError("Choose a password of at least 12 characters.");
    if (password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    try {
      await api.setupStart({ setupCode: setupCode.trim(), password });
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Set up Rei" subtitle="Enter the setup code printed on the server and choose a password.">
      <form onSubmit={submitDetails} noValidate>
        <Field>
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">
            <span>Setup code</span>
            <Input
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
            />
          </label>
        </Field>
        <Field>
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">
            <span>Password (12+ characters)</span>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
        </Field>
        <Field>
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">
            <span>Confirm password</span>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
        </Field>
        {error && (
          <p
            role="alert"
            className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        )}
        <Button variant="default" type="submit" disabled={busy || !setupCode.trim() || !password}>
          {busy ? "Checking…" : "Continue"}
        </Button>
      </form>
    </AuthCard>
  );
}

export function QrCode({ value }: { value: string }) {
  const qr = useMemo(() => qrSvg(value), [value]);
  return (
    <svg
      className="qr size-49 self-center rounded-2xl border bg-white p-2.5"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label="QR code for your authenticator app"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#000" />
    </svg>
  );
}

export function AuthCard({
  title,
  subtitle,
  step,
  children,
}: {
  title: string;
  subtitle?: string;
  step?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="auth grid min-h-full place-items-center bg-background px-4 pt-[calc(2rem+var(--safe-t))] pb-[calc(2rem+var(--safe-b))]">
      <Card className="auth-card flex w-full max-w-sm flex-col gap-5 p-8 ring-border max-sm:p-6 [&_form]:flex [&_form]:flex-col [&_form]:gap-4 [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:tracking-tight">
        <ReiWordmark />
        {step && <p className="step m-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{step}</p>}
        <h1>{title}</h1>
        {subtitle && <p className="subtitle m-0 text-sm text-muted-foreground">{subtitle}</p>}
        {children}
      </Card>
    </main>
  );
}
