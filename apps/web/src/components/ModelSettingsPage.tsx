import type { CapabilitySource, ModelCapabilityPatch, ModelSettingsResponse, ModelsResponse } from "@rei/protocol";
import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Field, FieldDescription } from "@/components/primitives/field.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { useDirtyBaseline, useReportUnsaved } from "../lib/unsaved.tsx";
import { PageShell } from "./PageShell.tsx";
import { SaveStatus } from "./SaveStatus.tsx";

type SettingsApi = Pick<
  Api,
  "getModelSettings" | "updateModelSettings" | "getModels" | "getProviders" | "scanModelLimits"
>;

/** What the user has typed for one model's limits. Text, so a half-typed number is allowed until save. */
interface LimitDraft {
  contextWindow?: string;
  maxTokens?: string;
}

const LIMIT_SOURCE: Record<CapabilitySource, string> = {
  custom: "Set by you",
  detected: "Reported by the provider",
  built_in: "Built-in default",
  unknown: "Not reported. Enter a value if you know it.",
};

/** A limit field as a patch value: null clears the override, a whole number sets it, undefined is not a valid number. */
function parseLimit(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Web controls for the model defaults formerly edited in models.json. */
export function ModelSettingsPage({ api, embedded = false }: { api: SettingsApi; embedded?: boolean }) {
  const [settings, setSettings] = useState<ModelSettingsResponse | null>(null);
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [limitChoice, setLimitChoice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, LimitDraft>>({});
  // Ids of the custom endpoints; only those can be scanned for limits.
  const [customConnections, setCustomConnections] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  // The default models and the typed limits; the limits section below only reads what the server reports.
  const { dirty, markSaved } = useDirtyBaseline({ fast: settings?.fast, standard: settings?.standard, drafts });
  useReportUnsaved(dirty);

  useEffect(() => {
    let active = true;
    void Promise.all([api.getModelSettings(), api.getModels(), api.getProviders()])
      .then(([next, models, providers]) => {
        if (!active) return;
        setSettings(next);
        markSaved({ fast: next.fast, standard: next.standard, drafts: {} });
        setCatalog(models);
        setCustomConnections(
          new Set(providers.connections.filter((row) => row.kind === "openai-compatible").map((row) => row.id)),
        );
      })
      .catch((reason) => {
        if (active) setError(describeError(reason));
      });
    return () => {
      active = false;
    };
  }, [api, markSaved]);

  const modelOptions = catalog?.models ?? [];
  const labelFor = (model: string) => catalog?.labels?.[model] ?? model;

  const updateModel = (tier: "fast" | "standard", model: string) => {
    setSettings((current) => (current ? { ...current, [tier]: { ...current[tier], model } } : current));
    setSaved(false);
  };
  // The limits section works on one model at a time; it starts on the agent chat default.
  const limitModel = limitChoice ?? settings?.standard.model ?? modelOptions[0] ?? "";
  const capability = settings?.capabilities.find((entry) => entry.id === limitModel);
  const draft: LimitDraft = drafts[limitModel] ?? {};
  const contextText =
    draft.contextWindow ??
    (capability?.contextWindow.source === "custom" ? String(capability.contextWindow.value) : "");
  const maxText =
    draft.maxTokens ?? (capability?.maxTokens.source === "custom" ? String(capability.maxTokens.value) : "");
  const setDraft = (model: string, patch: LimitDraft) => {
    setDrafts((current) => ({ ...current, [model]: { ...current[model], ...patch } }));
    setSaved(false);
  };
  /** Removes the limits the user entered for one model and saves now, so it falls back to detected or built-in values. */
  const clearLimits = async (model: string) => {
    if (!settings) return;
    setSaved(false);
    setError(null);
    setBusy(true);
    try {
      const next = await api.updateModelSettings({
        fast: { model: settings.fast.model },
        standard: { model: settings.standard.model },
        capabilities: { [model]: { contextWindow: null, maxTokens: null } },
      });
      const remaining = { ...drafts };
      delete remaining[model];
      setSettings(next);
      setDrafts(remaining);
      markSaved({ fast: next.fast, standard: next.standard, drafts: remaining });
      setSaved(true);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };
  // A model choice is `connectionId/model`; the bare OpenAI ids have no connection to scan.
  const connectionOf = limitModel.includes("/") ? limitModel.slice(0, limitModel.indexOf("/")) : undefined;
  const canScan = connectionOf !== undefined && customConnections.has(connectionOf);
  const scanLimits = async () => {
    if (!connectionOf) return;
    setScanning(true);
    setScanStatus(null);
    setError(null);
    try {
      const connection = await api.scanModelLimits(connectionOf);
      const next = await api.getModelSettings();
      // Only the limits change here, so unsaved edits to the default models are kept.
      setSettings((current) => (current ? { ...current, capabilities: next.capabilities } : current));
      const reported = Object.keys(connection.modelInfo ?? {}).length;
      setScanStatus(
        reported
          ? `The endpoint reported limits for ${reported} model${reported === 1 ? "" : "s"}.`
          : "The endpoint reports no context or output limits.",
      );
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setScanning(false);
    }
  };

  /** Only the models the user changed, as a PUT body; an invalid number names the model. */
  const limitPatch = (): { capabilities?: Record<string, ModelCapabilityPatch>; error?: string } => {
    const entries = Object.entries(drafts);
    if (!entries.length) return {};
    const capabilities: Record<string, ModelCapabilityPatch> = {};
    for (const [model, change] of entries) {
      const patch: ModelCapabilityPatch = {};
      if (change.contextWindow !== undefined) {
        const value = parseLimit(change.contextWindow);
        if (value === undefined)
          return { error: `Context window for ${labelFor(model)} must be a whole number above 0.` };
        patch.contextWindow = value;
      }
      if (change.maxTokens !== undefined) {
        const value = parseLimit(change.maxTokens);
        if (value === undefined)
          return { error: `Max output tokens for ${labelFor(model)} must be a whole number above 0.` };
        patch.maxTokens = value;
      }
      capabilities[model] = patch;
    }
    return { capabilities };
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setSaved(false);
    setError(null);
    const limits = limitPatch();
    if (limits.error) {
      setError(limits.error);
      return;
    }
    setBusy(true);
    try {
      const next = await api.updateModelSettings({
        fast: { model: settings.fast.model },
        standard: { model: settings.standard.model },
        ...(limits.capabilities ? { capabilities: limits.capabilities } : {}),
      });
      setSettings(next);
      setDrafts({});
      markSaved({ fast: next.fast, standard: next.standard, drafts: {} });
      setSaved(true);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <>
      <p className="m-0 mb-5 text-sm text-muted-foreground">
        Choose the defaults Rei uses for agent chats and background tasks.
      </p>
      {!settings && !error && <p className="m-0 text-sm text-muted-foreground">Loading model settings…</p>}
      {settings && (
        <form className="grid max-w-2xl gap-6" onSubmit={(event) => void save(event)}>
          <section className="grid gap-4 rounded-xl border p-4" aria-labelledby="model-defaults-heading">
            <h2 id="model-defaults-heading" className="m-0 text-sm font-medium">
              Default models
            </h2>
            {!modelOptions.length && (
              <FieldDescription>
                {embedded
                  ? "Connect a provider above to choose models."
                  : "Configure a provider in Settings → Providers to choose models."}
              </FieldDescription>
            )}
            <Field className="gap-2">
              <Label htmlFor="model-standard">Agent chats</Label>
              <NativeSelect
                id="model-standard"
                value={settings.standard.model}
                disabled={busy || !modelOptions.length}
                onChange={(event) => updateModel("standard", event.target.value)}
              >
                {!modelOptions.includes(settings.standard.model) && (
                  <option value={settings.standard.model} disabled>
                    {modelOptions.length ? "Current model unavailable" : "No models available"}
                  </option>
                )}
                {modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {labelFor(model)}
                  </option>
                ))}
              </NativeSelect>
              <FieldDescription>Default model for new agent</FieldDescription>
            </Field>
            <Field className="gap-2">
              <Label htmlFor="model-fast">Background tasks</Label>
              <NativeSelect
                id="model-fast"
                value={settings.fast.model}
                disabled={busy || !modelOptions.length}
                onChange={(event) => updateModel("fast", event.target.value)}
              >
                {!modelOptions.includes(settings.fast.model) && (
                  <option value={settings.fast.model} disabled>
                    {modelOptions.length ? "Current model unavailable" : "No models available"}
                  </option>
                )}
                {modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {labelFor(model)}
                  </option>
                ))}
              </NativeSelect>
              <FieldDescription>Used for agent design and as the default chat title model.</FieldDescription>
            </Field>
          </section>
          {limitModel && (
            <section className="grid gap-4 rounded-xl border p-4" aria-labelledby="model-limits-heading">
              <h2 id="model-limits-heading" className="m-0 text-sm font-medium">
                Model limits
              </h2>
              <FieldDescription>
                The context window and output limit come from the provider when it reports them. Enter a value to
                override it; an empty field uses the reported or built-in value.
              </FieldDescription>
              <Field className="gap-2">
                <Label htmlFor="limit-model">Model</Label>
                <NativeSelect
                  id="limit-model"
                  value={limitModel}
                  disabled={busy}
                  onChange={(event) => setLimitChoice(event.target.value)}
                >
                  {modelOptions.map((model) => (
                    <option key={model} value={model}>
                      {labelFor(model)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {!capability && (
                <FieldDescription>Limits for this model are not available yet. Save to refresh them.</FieldDescription>
              )}
              {capability && (
                <>
                  <Field className="gap-2">
                    <Label htmlFor="limit-context">Context window</Label>
                    <div className="flex items-center gap-2">
                      <input
                        id="limit-context"
                        className="h-9 w-32 rounded-md border bg-background px-3 text-sm"
                        type="number"
                        min={1}
                        step="any"
                        inputMode="numeric"
                        disabled={busy}
                        placeholder={
                          capability.contextWindow.value === null ? "Unknown" : String(capability.contextWindow.value)
                        }
                        value={contextText}
                        onChange={(event) => setDraft(limitModel, { contextWindow: event.target.value })}
                      />
                      <span className="text-sm text-muted-foreground">tokens</span>
                    </div>
                    <FieldDescription>{LIMIT_SOURCE[capability.contextWindow.source]}</FieldDescription>
                  </Field>
                  <Field className="gap-2">
                    <Label htmlFor="limit-max-tokens">Max output tokens</Label>
                    <div className="flex items-center gap-2">
                      <input
                        id="limit-max-tokens"
                        className="h-9 w-32 rounded-md border bg-background px-3 text-sm"
                        type="number"
                        min={1}
                        step="any"
                        inputMode="numeric"
                        disabled={busy}
                        placeholder={
                          capability.maxTokens.value === null ? "Unknown" : String(capability.maxTokens.value)
                        }
                        value={maxText}
                        onChange={(event) => setDraft(limitModel, { maxTokens: event.target.value })}
                      />
                      <span className="text-sm text-muted-foreground">tokens</span>
                    </div>
                    <FieldDescription>{LIMIT_SOURCE[capability.maxTokens.source]}</FieldDescription>
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-fit"
                      disabled={
                        busy ||
                        (capability?.contextWindow.source !== "custom" && capability?.maxTokens.source !== "custom")
                      }
                      onClick={() => void clearLimits(limitModel)}
                    >
                      Clear entered values
                    </Button>
                    {canScan && (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-fit"
                        disabled={busy || scanning}
                        onClick={() => void scanLimits()}
                      >
                        {scanning ? "Scanning…" : "Scan endpoint"}
                      </Button>
                    )}
                  </div>
                  {canScan && (
                    <FieldDescription>
                      {scanStatus ?? "Reads the limits this endpoint reports. Values you enter still take precedence."}
                    </FieldDescription>
                  )}
                </>
              )}
            </section>
          )}
          {error && (
            <p className="m-0 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              type="submit"
              className="w-fit"
              disabled={
                busy ||
                !settings ||
                !modelOptions.includes(settings.standard.model) ||
                !modelOptions.includes(settings.fast.model)
              }
            >
              {busy ? "Saving…" : "Save settings"}
            </Button>
            <SaveStatus dirty={dirty} saved={saved} />
          </div>
        </form>
      )}
      {!settings && error && (
        <p className="m-0 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </>
  );
  return embedded ? content : <PageShell title="Models">{content}</PageShell>;
}
