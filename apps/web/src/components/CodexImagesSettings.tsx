import type { CodexImagesStatus } from "@rei/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { CopyButton } from "./CopyButton.tsx";

type CodexImagesApi = Pick<
  Api,
  "getCodexImages" | "startCodexImagesSignIn" | "cancelCodexImagesSignIn" | "signOutCodexImages"
>;
const POLL_MS = 2000;

/** Sign in to Codex Images with a device code: the gateway holds the attempt; a dialog shows the code and waits. */
export function CodexImagesSettings({ api }: { api: CodexImagesApi }) {
  const [status, setStatus] = useState<CodexImagesStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getCodexImages();
      if (!mounted.current) return;
      setStatus(next);
      if (next.error) setError(next.error);
    } catch (cause) {
      if (mounted.current) setError(describeError(cause));
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  const pending = status?.pending === true;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const start = () =>
    run(async () => {
      await api.startCodexImagesSignIn();
      await refresh();
    });
  const cancel = () =>
    run(async () => {
      await api.cancelCodexImagesSignIn();
      await refresh();
    });
  const signOut = () =>
    run(async () => {
      await api.signOutCodexImages();
      await refresh();
    });

  if (!status)
    return error ? (
      <p role="alert" className="m-0 text-sm text-destructive">
        {error}
      </p>
    ) : (
      <p role="status" className="m-0 text-sm text-muted-foreground">
        Loading Codex Images…
      </p>
    );
  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="Codex Images">
      <div>
        <h3 className="m-0 text-base font-medium">Codex Images</h3>
        <p className="mt-1 mb-0 text-sm text-muted-foreground">
          Lets agents generate and edit images with a separate ChatGPT sign-in. It counts toward your Codex usage. Chat
          and search keep using the OpenAI connection.
        </p>
      </div>
      {!status.enabled ? (
        <p className="m-0 rounded-xl border p-4 text-sm text-muted-foreground">
          Codex Images is turned off for this installation. See the Codex images guide for turning it on, then sign in
          here.
        </p>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="m-0 min-w-24 flex-1 text-sm font-medium">ChatGPT account for images</p>
            <Badge variant={status.signedIn ? "success" : "secondary"}>
              {status.signedIn ? "Signed in" : "Needs sign-in"}
            </Badge>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={status.signedIn ? "outline" : "default"}
              disabled={busy || pending}
              onClick={() => void start()}
            >
              {status.signedIn ? "Sign in again" : "Sign in to Codex Images"}
            </Button>
            {status.signedIn && (
              <Button type="button" variant="ghost" disabled={busy || pending} onClick={() => void signOut()}>
                Sign out
              </Button>
            )}
          </div>
          <p className="m-0 text-xs text-muted-foreground">
            Your ChatGPT account must allow device-code sign-in (ChatGPT → Settings → Security).
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={pending && !!status.userCode}
        onOpenChange={(open) => {
          if (!open && !busy) void cancel();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign in to Codex Images</DialogTitle>
            <DialogDescription>
              Open the OpenAI page, then enter this code there. Rei finishes sign-in once you approve it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center gap-2">
            <output
              aria-label="Device code"
              className="rounded-lg bg-muted px-4 py-3 font-mono text-2xl tracking-widest"
            >
              {status.userCode}
            </output>
            {status.userCode && <CopyButton text={status.userCode} label="Copy code" />}
          </div>
          <p role="status" className="m-0 text-center text-sm text-muted-foreground">
            Waiting for approval…
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>
              Cancel
            </Button>
            <Button type="button" onClick={() => window.open(status.verificationUrl, "_blank", "noopener,noreferrer")}>
              Open OpenAI page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
