import type { CustomEndpointApi, ModelLimits, ProviderConnection, SaveProviderConnectionRequest } from "@rei/protocol";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/primitives/dialog.tsx";
import { Field, FieldDescription } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { TagInput } from "@/components/primitives/tag-input.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { useOpenAiOAuth } from "../lib/useOpenAiOAuth.ts";
import { PageShell } from "./PageShell.tsx";

type ProviderApi = Pick<
  Api,
  | "getProviders"
  | "scanProviderModels"
  | "saveProvider"
  | "removeProvider"
  | "startOpenAiOAuth"
  | "getOpenAiOAuthStatus"
  | "submitOpenAiOAuthCallback"
  | "cancelOpenAiOAuth"
>;
type Kind = SaveProviderConnectionRequest["kind"];

/** Model provider credentials are written directly to the policy gateway and never returned to the browser. */
export function ProvidersPage({
  api,
  embedded = false,
  onChanged,
  description,
}: {
  api: ProviderApi;
  embedded?: boolean;
  description?: string;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<ProviderConnection[]>([]);
  const [kind, setKind] = useState<Kind>("openai");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [originalAuth, setOriginalAuth] = useState<"api_key" | "oauth" | null>(null);
  const [name, setName] = useState("OpenAI");
  const [baseUrl, setBaseUrl] = useState("");
  const [endpointApi, setEndpointApi] = useState<CustomEndpointApi>("chat");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  // Limits the provider reported on the last scan; saved with the model IDs so the server keeps them.
  const [modelInfo, setModelInfo] = useState<Record<string, ModelLimits> | undefined>(undefined);
  const [auth, setAuth] = useState<"api_key" | "oauth">("oauth");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [oauthInstructionsOpen, setOauthInstructionsOpen] = useState(false);
  const [formBusy, setBusy] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const listGeneration = useRef(0);
  const active = useRef(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const reload = async () => {
    const mine = ++listGeneration.current;
    const result = await api.getProviders();
    if (!active.current || mine !== listGeneration.current) return;
    setRows(result.connections);
    changed.current?.();
  };
  const oauth = useOpenAiOAuth(api, setError, reload);
  const busy = formBusy || oauth.busy;
  useEffect(() => {
    active.current = true;
    const mine = ++listGeneration.current;
    void api
      .getProviders()
      .then((providers) => {
        if (active.current && mine === listGeneration.current) setRows(providers.connections);
      })
      .catch((e) => {
        if (active.current && mine === listGeneration.current) setError(describeError(e));
      });
    return () => {
      active.current = false;
      listGeneration.current++;
    };
  }, [api]);

  const choose = (next: Kind) => {
    setEditingId(null);
    setOriginalAuth(null);
    setKind(next);
    setAuth(next === "openai" ? "oauth" : "api_key");
    setName(next === "openai" ? "OpenAI" : "My endpoint");
    setApiKey("");
    setBaseUrl("");
    setEndpointApi("chat");
    setModels([]);
    setModelInfo(undefined);
  };
  const edit = (row: ProviderConnection) => {
    setEditingId(row.id);
    setOriginalAuth(row.auth);
    setKind(row.kind);
    setName(row.name);
    setAuth(row.auth);
    setBaseUrl(row.baseUrl ?? "");
    setEndpointApi(row.api ?? "chat");
    setModels(row.models);
    setModelInfo(undefined);
    setApiKey("");
    setError(null);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.saveProvider({
        ...(editingId ? { id: editingId } : {}),
        name,
        kind,
        ...(kind === "openai" ? { auth } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(kind === "openai-compatible"
          ? {
              baseUrl,
              api: endpointApi,
              models,
              ...(modelInfo ? { modelInfo } : {}),
            }
          : {}),
      });
      if (saved?.replacedModels?.length) {
        const to = saved.replacedModels[0]?.to;
        setNotice(
          `${saved.replacedModels.map((entry) => entry.from).join(", ")} ${saved.replacedModels.length === 1 ? "was" : "were"} removed from the list, so agents and defaults that used ${saved.replacedModels.length === 1 ? "it" : "them"} now use ${to}.`,
        );
      }
      setApiKey("");
      setBaseUrl("");
      setEndpointApi("chat");
      setModels([]);
      setModelInfo(undefined);
      setEditingId(null);
      setOriginalAuth(null);
      await reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const scan = async () => {
    setBusy(true);
    setError(null);
    setScanResult(null);
    try {
      const result = await api.scanProviderModels({
        baseUrl,
        ...(editingId ? { id: editingId } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      setModels(result.models);
      setModelInfo(result.modelInfo);
      setScanResult(
        result.models.length
          ? `Found ${result.models.length} models. Review the IDs before saving.`
          : "No models found.",
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const submitCallback = async () => {
    if (await oauth.submit(callbackUrl)) setCallbackUrl("");
  };
  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.removeProvider(id);
      await reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const cancelOAuth = async () => {
    if (await oauth.cancel()) setCallbackUrl("");
  };

  const content = (
    <>
      <p className="m-0 mb-5 text-sm text-muted-foreground">
        {description ??
          (embedded
            ? "Connect a provider, then choose your default models below."
            : "Connect a provider, then choose models in Settings → Models.")}
      </p>
      <section className="divide-y rounded-xl border" aria-label="Saved providers">
        {rows.length === 0 && <p className="m-0 p-4 text-sm text-muted-foreground">No providers connected yet.</p>}
        {rows.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-24 flex-1">
              <p className="m-0 truncate text-sm font-medium">{row.name}</p>
              <p className="m-0 mt-1 text-xs text-muted-foreground">
                {row.kind === "openai-compatible"
                  ? row.baseUrl
                  : `OpenAI · ${row.auth === "oauth" ? "ChatGPT" : "API key"}`}
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-1 text-xs ${row.connected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
            >
              {row.connected ? "Connected" : "Needs setup"}
            </span>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => edit(row)}>
              Edit
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void remove(row.id)}>
              Remove
            </Button>
          </div>
        ))}
      </section>
      {notice && (
        <p role="status" className="m-0 mt-4 rounded-lg bg-muted/50 p-3 text-sm">
          {notice}
        </p>
      )}
      <form className="mt-6 grid gap-4 rounded-xl border p-4" onSubmit={(e) => void save(e)}>
        <h2 className="m-0 text-sm font-medium">{editingId ? "Edit provider" : "Add provider"}</h2>
        <fieldset className="grid min-w-0 gap-4 border-0 p-0">
          <legend className="mb-3 flex items-center gap-2 text-sm font-medium">
            <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">
              1
            </span>
            Choose a provider
          </legend>
          <Field className="gap-2">
            <Label htmlFor="provider-kind">Provider</Label>
            <NativeSelect
              id="provider-kind"
              value={kind}
              disabled={busy || !!editingId}
              onChange={(e) => choose(e.target.value as Kind)}
            >
              <option value="openai">OpenAI</option>
              <option value="openai-compatible">Custom OpenAI-compatible endpoint</option>
            </NativeSelect>
          </Field>
          <Field className="gap-2">
            <Label htmlFor="provider-name">Name</Label>
            <Input
              id="provider-name"
              value={name}
              maxLength={80}
              required
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </fieldset>
        <fieldset className="grid min-w-0 gap-4 border-0 border-t p-0 pt-4">
          <legend className="mb-3 flex items-center gap-2 text-sm font-medium">
            <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">
              2
            </span>
            Connect your account
          </legend>
          <p className="m-0 text-xs text-muted-foreground">
            {kind === "openai"
              ? "Use an OpenAI API key or sign in with your ChatGPT subscription."
              : "Enter your endpoint URL and API key, if required."}
          </p>
          {kind === "openai" && (
            <Field className="gap-2">
              <Label htmlFor="provider-auth">Sign-in method</Label>
              <NativeSelect
                id="provider-auth"
                value={auth}
                disabled={busy}
                onChange={(e) => setAuth(e.target.value as "api_key" | "oauth")}
              >
                <option value="oauth">Use ChatGPT subscription</option>
                <option value="api_key">OpenAI API key</option>
              </NativeSelect>
            </Field>
          )}
          {kind === "openai" && auth === "oauth" && (
            <div className="grid gap-3 rounded-lg bg-muted/50 p-3">
              {!oauth.pending ? (
                <Button
                  type="button"
                  className="w-fit"
                  disabled={busy}
                  data-oai-siwc-button
                  onClick={() => setOauthInstructionsOpen(true)}
                >
                  Use ChatGPT subscription
                </Button>
              ) : (
                <>
                  <a className="w-fit text-sm underline" href={oauth.authorizationUrl} target="_blank" rel="noreferrer">
                    OpenAI sign-in page
                  </a>
                  <p className="m-0 text-xs text-muted-foreground">
                    Complete sign-in. If the browser cannot reach Rei’s local callback, paste the full redirect URL
                    below.
                  </p>
                  <Field className="gap-2">
                    <Label htmlFor="provider-oauth-callback">Redirect URL</Label>
                    <Input
                      id="provider-oauth-callback"
                      type="url"
                      value={callbackUrl}
                      placeholder="http://127.0.0.1:1455/auth/callback?..."
                      disabled={busy}
                      onChange={(e) => setCallbackUrl(e.target.value)}
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Button type="button" disabled={busy || !callbackUrl} onClick={() => void submitCallback()}>
                      Finish sign-in
                    </Button>
                    <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancelOAuth()}>
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          {kind === "openai-compatible" && (
            <>
              <Field className="gap-2">
                <Label htmlFor="provider-url">Base URL</Label>
                <Input
                  id="provider-url"
                  type="url"
                  value={baseUrl}
                  placeholder="https://api.example.com/v1"
                  required
                  disabled={busy}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <FieldDescription>
                  HTTPS endpoints are supported. HTTP supports localhost and host.docker.internal for local servers.
                </FieldDescription>
              </Field>
              <Field className="gap-2">
                <Label htmlFor="provider-api">API</Label>
                <NativeSelect
                  id="provider-api"
                  value={endpointApi}
                  disabled={busy}
                  onChange={(e) => setEndpointApi(e.target.value as CustomEndpointApi)}
                >
                  <option value="chat">Chat Completions</option>
                  <option value="responses">Responses</option>
                </NativeSelect>
                <FieldDescription>
                  Most OpenAI-compatible servers use Chat Completions. Choose Responses only if the endpoint supports
                  the Responses API at /responses.
                </FieldDescription>
              </Field>
            </>
          )}
          {!(kind === "openai" && auth === "oauth") && (
            <Field className="gap-2">
              <Label htmlFor="provider-key">{kind === "openai" ? "OpenAI API key" : "API key (optional)"}</Label>
              <Input
                id="provider-key"
                type="password"
                autoComplete="new-password"
                value={apiKey}
                disabled={busy}
                required={kind !== "openai-compatible" && (!editingId || originalAuth !== "api_key")}
                onChange={(e) => setApiKey(e.target.value)}
              />
              {editingId && originalAuth === "api_key" && (
                <FieldDescription>Leave blank to keep the current key.</FieldDescription>
              )}
              {editingId && originalAuth === "oauth" && kind === "openai" && (
                <FieldDescription>Enter an API key to switch from ChatGPT sign-in.</FieldDescription>
              )}
            </Field>
          )}
        </fieldset>
        {kind === "openai-compatible" && (
          <fieldset className="grid min-w-0 gap-4 border-0 border-t p-0 pt-4">
            <legend className="mb-3 flex items-center gap-2 text-sm font-medium">
              <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">
                3
              </span>
              Find your models
            </legend>
            <Field className="gap-2">
              <Label htmlFor="provider-models">Model IDs</Label>
              <TagInput
                id="provider-models"
                value={models}
                onChange={setModels}
                placeholder="Type a model ID and press Enter"
                disabled={busy}
              />
              <FieldDescription>
                Scan after entering your URL and key, or type model IDs and press Enter. Requests use{" "}
                {endpointApi === "responses" ? "Responses" : "Chat Completions"}.
              </FieldDescription>
              <Button
                type="button"
                variant="secondary"
                className="w-fit"
                disabled={busy || !baseUrl.trim()}
                onClick={() => void scan()}
              >
                Scan models
              </Button>
              {scanResult && (
                <p role="status" className="m-0 text-xs text-muted-foreground">
                  {scanResult}
                </p>
              )}
            </Field>
          </fieldset>
        )}
        {error && (
          <p className="m-0 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          {!(kind === "openai" && auth === "oauth") && (
            <Button type="submit" className="w-fit" disabled={busy}>
              {editingId ? "Save changes" : "Save connection"}
            </Button>
          )}
          {editingId && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => choose("openai")}>
              Cancel
            </Button>
          )}
        </div>
      </form>
      <Dialog open={oauthInstructionsOpen} onOpenChange={setOauthInstructionsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Before you sign in</DialogTitle>
          </DialogHeader>
          <ol aria-label="ChatGPT sign-in steps" className="m-0 grid list-none gap-4 p-0">
            <li className="flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                1
              </span>
              <div className="grid gap-1">
                <p className="m-0 text-sm font-medium">Sign in to ChatGPT</p>
                <p className="m-0 text-sm text-muted-foreground">Continue opens ChatGPT in a new tab. Sign in there.</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                2
              </span>
              <div className="grid gap-1">
                <p className="m-0 text-sm font-medium">Copy the callback</p>
                <p className="m-0 text-sm text-muted-foreground">
                  If the final page cannot connect, copy its full URL from the address bar, including the question mark
                  and everything after it.
                </p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                3
              </span>
              <div className="grid gap-1">
                <p className="m-0 text-sm font-medium">Return to Rei</p>
                <p className="m-0 text-sm text-muted-foreground">
                  Paste the URL into Redirect URL, then choose Finish sign-in.
                </p>
              </div>
            </li>
          </ol>
          <p className="m-0 text-sm text-muted-foreground">
            If sign-in returns automatically, Rei will finish connecting in the background.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOauthInstructionsOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                setOauthInstructionsOpen(false);
                void oauth.start();
              }}
            >
              Continue to ChatGPT
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
  return embedded ? content : <PageShell title="Providers">{content}</PageShell>;
}
