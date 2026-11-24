import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Checkbox } from "@/components/primitives/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog.tsx";
import type { Api } from "../api/client.ts";
import { FIRST_TIME_SETUP_SESSION_KEY, readSessionFlag, writeSessionFlag } from "../lib/storage.ts";
import { EmbeddingSettings } from "./EmbeddingSettings.tsx";
import { ModelSettingsPage } from "./ModelSettingsPage.tsx";
import { ProvidersPage } from "./ProvidersPage.tsx";
import { SetupServices } from "./SetupServices.tsx";

interface SetupStatus {
  provider: boolean | null;
  embedding: boolean | null;
  embeddingDown: boolean;
  embeddingModel: string | null;
  webSearch: boolean | null;
  searchProviders: string[];
}

function complete(status: SetupStatus): boolean {
  return status.provider === true && status.embedding === true && status.webSearch === true;
}

export function FirstTimeSetupDialog({ api }: { api: Api }) {
  const [providerRev, setProviderRev] = useState(0);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const openedRef = useRef(false);
  const dontShowAgainRef = useRef(false);

  // Whether "Don't show again" was chosen on this instance. null until the server answers. A server that predates the
  // setting (or a failed read) counts as not dismissed: the dialog still shows only while setup is incomplete.
  const [serverDismissed, setServerDismissed] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof api.getFirstTimeSetup !== "function") {
      setServerDismissed(false);
      return;
    }
    api
      .getFirstTimeSetup()
      .then((settings) => setServerDismissed(settings.dismissed))
      .catch(() => setServerDismissed(false));
  }, [api]);

  const refresh = useCallback(async () => {
    if (readSessionFlag(FIRST_TIME_SETUP_SESSION_KEY, false)) return;
    if (
      typeof api.getProviders !== "function" ||
      typeof api.getIndexStatus !== "function" ||
      typeof api.getWebSearchStatus !== "function"
    )
      return;
    setChecking(true);
    const [providers, index, search] = await Promise.allSettled([
      Promise.resolve().then(() => api.getProviders()),
      Promise.resolve().then(() => api.getIndexStatus()),
      Promise.resolve().then(() => api.getWebSearchStatus()),
    ]);
    const next: SetupStatus = {
      provider:
        providers.status === "fulfilled" ? providers.value.connections.some((provider) => provider.connected) : null,
      embedding:
        index.status === "fulfilled" ? index.value.index.state !== "off" && index.value.index.state !== "down" : null,
      embeddingDown: index.status === "fulfilled" && index.value.index.state === "down",
      embeddingModel: index.status === "fulfilled" ? index.value.index.model : null,
      webSearch: search.status === "fulfilled" ? search.value.providers.some((provider) => provider.configured) : null,
      searchProviders:
        search.status === "fulfilled"
          ? search.value.providers.filter((provider) => provider.configured).map((provider) => provider.id)
          : [],
    };
    setStatus(next);
    setChecking(false);
    // Opened once per session while setup is incomplete. Once open it stays open, so finishing a step never yanks it away.
    if (!openedRef.current) {
      if (complete(next) || readSessionFlag(FIRST_TIME_SETUP_SESSION_KEY, false)) return;
      openedRef.current = true;
      setOpen(true);
    }
  }, [api]);

  useEffect(() => {
    if (serverDismissed !== false) return;
    void refresh();
  }, [serverDismissed, refresh]);

  const close = () => {
    writeSessionFlag(FIRST_TIME_SETUP_SESSION_KEY, true);
    if (dontShowAgainRef.current) {
      setServerDismissed(true);
      if (typeof api.updateFirstTimeSetup === "function") {
        void api.updateFirstTimeSetup({ dismissed: true }).catch(() => undefined);
      }
    }
    setOpen(false);
  };
  const setDontShow = (checked: boolean) => {
    dontShowAgainRef.current = checked;
    setDontShowAgain(checked);
  };

  if (!status && !open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else setOpen(true);
      }}
    >
      <DialogContent
        size="xl"
        className="flex h-dvh max-h-dvh flex-col gap-5 overflow-hidden max-md:rounded-none md:h-[min(46rem,88dvh)] md:max-w-[min(60rem,92vw)]"
      >
        <DialogHeader className="shrink-0 gap-1.5">
          <DialogTitle className="pr-8 text-xl">Welcome to Rei</DialogTitle>
          <DialogDescription>A few quick steps to get your agents ready.</DialogDescription>
        </DialogHeader>

        <div className="grid shrink-0 gap-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Step {step + 1} of 3</span>
            <span>{["Model provider", "Memory", "Web search"][step]}</span>
          </div>
          <div
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={3}
            aria-valuenow={step + 1}
            aria-valuetext={`Step ${step + 1} of 3`}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
              style={{ width: `${((step + 1) / 3) * 100}%` }}
            />
          </div>
          <ol aria-label="Setup steps" className="m-0 grid list-none grid-cols-3 gap-2 p-0">
            {["Model", "Memory", "Search"].map((label, index) => (
              <li key={label}>
                <button
                  type="button"
                  aria-current={step === index ? "step" : undefined}
                  onClick={() => setStep(index)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs transition-colors hover:bg-muted ${step === index ? "font-medium text-foreground" : "text-muted-foreground"}`}
                >
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-full ${step === index ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                  >
                    {index + 1}
                  </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
        </div>

        <div className="grid min-h-0 min-w-0 grid-cols-1 content-start gap-3 overflow-y-auto" aria-live="polite">
          <div hidden={step !== 0}>
            <SetupItem title="Model provider" ready={status?.provider ?? null} checking={checking}>
              <ProvidersPage
                api={api}
                embedded
                onChanged={() => {
                  setProviderRev((value) => value + 1);
                  void refresh();
                }}
              />
              <ModelSettingsPage api={api} embedded key={providerRev} />
            </SetupItem>
          </div>

          <div hidden={step !== 1}>
            <SetupItem
              title="Memory embeddings"
              ready={status?.embedding ?? null}
              statusLabel={
                status?.embeddingDown
                  ? "Needs attention"
                  : status?.embedding === false
                    ? "Keyword search ready"
                    : undefined
              }
              checking={checking}
              detail={
                status?.embeddingDown
                  ? "The embedding provider is configured but not responding. Keyword search still works."
                  : status?.embedding
                    ? status.embeddingModel
                      ? `Meaning search is enabled · ${status.embeddingModel}`
                      : "Meaning search is enabled. The index is starting."
                    : "Optional: find past conversations by meaning. Keyword search works without embeddings."
              }
            >
              <EmbeddingSettings api={api} onSaved={() => void refresh()} />
            </SetupItem>
          </div>

          <div hidden={step !== 2}>
            <SetupItem
              title="Web search"
              statusLabel={status?.webSearch === false ? "Optional" : undefined}
              ready={status?.webSearch ?? null}
              checking={checking}
              detail={
                status?.webSearch
                  ? `Available through ${status.searchProviders.map((provider) => providerName(provider)).join(", ")}.`
                  : "Let agents look up current information. Included search may work without an API key."
              }
            >
              <SetupServices api={api} kind="search" onSaved={() => void refresh()} />
            </SetupItem>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t pt-4">
          <label
            htmlFor="setup-dont-show"
            className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"
          >
            <Checkbox
              id="setup-dont-show"
              checked={dontShowAgain}
              onCheckedChange={(checked) => setDontShow(checked === true)}
            />
            <span>Don’t show again</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={checking} onClick={() => void refresh()}>
              {checking ? "Checking…" : "Check again"}
            </Button>
            {step > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button type="button" variant="default" size="sm" onClick={() => (step < 2 ? setStep(step + 1) : close())}>
              {step === 2 ? "Finish setup" : "Continue"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SetupItem({
  title,
  ready,
  checking,
  statusLabel,
  detail,
  children,
}: {
  title: string;
  ready: boolean | null;
  checking: boolean;
  statusLabel?: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  const state =
    statusLabel ??
    (checking && ready === null
      ? "Checking…"
      : ready === true
        ? "Ready"
        : ready === false
          ? "Needs setup"
          : "Unavailable");
  return (
    <section className="grid min-w-0 grid-cols-1 gap-2 rounded-2xl border p-4" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="m-0 text-sm font-medium">{title}</h2>
        <span
          className={`text-xs font-medium ${ready === true ? "text-primary" : statusLabel ? "text-warning" : ready === false ? "text-muted-foreground" : "text-warning"}`}
          aria-live="polite"
        >
          {state}
        </span>
      </div>
      {detail ? <p className="m-0 text-sm text-muted-foreground">{detail}</p> : null}
      {children}
    </section>
  );
}

function providerName(id: string): string {
  return id === "searxng" ? "SearXNG" : id.charAt(0).toUpperCase() + id.slice(1);
}
