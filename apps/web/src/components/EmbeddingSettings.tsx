import type { EmbeddingSetupSettings, SaveEmbeddingSetupSettings } from "@rei/protocol";
import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Field, FieldGroup, FieldLabel } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";

const OMLX_PROFILE = {
  id: "mlx-community/embeddinggemma-2-6bit",
  repository: "mlx-community/embeddinggemma-2-6bit",
  revision: "a61f0b6dcee35cf68475e91b8b28ed830057d7c4",
  quant: "affine-6bit-g64-bf16",
  dims: 768,
  pooling: "mean" as const,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Provider template placeholder.
  docTemplate: "title: none | text: ${t}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Provider template placeholder.
  queryTemplate: "task: search result | query: ${q}",
  maxInputTokens: 2048,
  contextTokens: 2048,
};
const EMPTY: EmbeddingSetupSettings = { provider: "off", baseUrl: "", apiModel: "", profile: null };

export function EmbeddingSettings({ api, onSaved }: { api: Api; onSaved: () => void }) {
  const [settings, setSettings] = useState(EMPTY);
  const [docTemplate, setDocTemplate] = useState("$" + "{t}");
  const [queryTemplate, setQueryTemplate] = useState("$" + "{q}");
  const [contextTokens, setContextTokens] = useState(512);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Save is allowed only for the values that passed Test connection; any edit clears this.
  const [verified, setVerified] = useState(false);
  const [dims, setDims] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    void api
      .getEmbeddingSetup()
      .then((value) => {
        if (!active) return;
        setSettings(value ?? EMPTY);
        setDocTemplate(value?.profile?.docTemplate ?? "$" + "{t}");
        setQueryTemplate(value?.profile?.queryTemplate ?? "$" + "{q}");
        setContextTokens(value?.profile?.contextTokens ?? 512);
        setLoading(false);
      })
      .catch((e) => {
        if (active) {
          setError(describeError(e));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api]);
  const unverify = () => {
    setSaved(false);
    setVerified(false);
    setDims(null);
  };
  const update = (value: Partial<EmbeddingSetupSettings>) => {
    setSettings((current) => ({ ...current, ...value, profile: null }));
    unverify();
  };
  // What the form currently says; Test and Save both send exactly this.
  const formValues = (): SaveEmbeddingSetupSettings => ({
    ...settings,
    profile: settings.provider === "off" ? null : settings.provider === "omlx" ? OMLX_PROFILE : settings.profile,
    ...(settings.provider === "openai" ? { advanced: { docTemplate, queryTemplate, contextTokens } } : {}),
    ...(key ? { apiKey: key } : {}),
  });
  const test = () => {
    setBusy(true);
    setError(null);
    unverify();
    void api
      .checkEmbeddingSetup(formValues())
      .then((result) => {
        setDims(result.dims);
        setVerified(true);
      })
      .catch((e) => setError(describeError(e)))
      .finally(() => setBusy(false));
  };
  const needsTest = settings.provider !== "off";
  return (
    <form
      className="grid min-w-0 gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (needsTest && !verified) return;
        setBusy(true);
        setError(null);
        setSaved(false);
        void (async () => {
          try {
            const result = await api.saveEmbeddingSetup(formValues());
            setSettings(result);
            setKey("");
            setSaved(true);
            setVerified(result.provider !== "off");
            onSaved();
          } catch (e) {
            setError(describeError(e));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <fieldset disabled={loading || busy} className="min-w-0 border-0 p-0">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="embedding-provider">Embedding provider</FieldLabel>
            <NativeSelect
              id="embedding-provider"
              value={settings.provider}
              onChange={(event) => {
                const provider = event.target.value as EmbeddingSetupSettings["provider"];
                update({
                  provider,
                  ...(provider === "omlx"
                    ? { apiModel: OMLX_PROFILE.id, baseUrl: settings.baseUrl || "http://host.docker.internal:18000" }
                    : {}),
                });
              }}
            >
              <option value="off">Off · keyword search</option>
              <option value="omlx">oMLX</option>
              <option value="openai">OpenAI-compatible API</option>
            </NativeSelect>
          </Field>
          {needsTest && (
            <>
              <Field>
                <FieldLabel htmlFor="embedding-url">Embedding URL</FieldLabel>
                <Input
                  id="embedding-url"
                  type="url"
                  required
                  value={settings.baseUrl}
                  onChange={(e) => update({ baseUrl: e.target.value })}
                  placeholder="https://api.example.com"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="embedding-model">Embedding model ID</FieldLabel>
                <Input
                  id="embedding-model"
                  required
                  value={settings.apiModel}
                  onChange={(e) => update({ apiModel: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="embedding-key">Embedding API key (optional)</FieldLabel>
                <Input
                  id="embedding-key"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    unverify();
                  }}
                  placeholder="Leave blank to keep the key for this URL"
                />
              </Field>
              {settings.provider === "openai" && (
                <details>
                  <summary>Advanced</summary>
                  <FieldGroup className="mt-4">
                    <Field>
                      <FieldLabel htmlFor="embedding-context">Text limit (tokens)</FieldLabel>
                      <Input
                        id="embedding-context"
                        type="number"
                        min={1}
                        required
                        value={contextTokens}
                        onChange={(e) => {
                          setContextTokens(Number(e.target.value));
                          setSettings((current) => ({ ...current, profile: null }));
                          unverify();
                        }}
                      />
                      <p className="m-0 text-xs text-muted-foreground">
                        Conservative default: 512. Increase if your model supports longer inputs.
                      </p>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="embedding-document">Document template</FieldLabel>
                      <Textarea
                        id="embedding-document"
                        value={docTemplate}
                        onChange={(e) => {
                          setDocTemplate(e.target.value);
                          setSettings((current) => ({ ...current, profile: null }));
                          unverify();
                        }}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="embedding-query">Search template</FieldLabel>
                      <Textarea
                        id="embedding-query"
                        value={queryTemplate}
                        onChange={(e) => {
                          setQueryTemplate(e.target.value);
                          setSettings((current) => ({ ...current, profile: null }));
                          unverify();
                        }}
                      />
                      <p className="m-0 text-xs text-muted-foreground">
                        Keep the text placeholders. Change templates only if your model requires them.
                      </p>
                    </Field>
                  </FieldGroup>
                </details>
              )}
            </>
          )}
        </FieldGroup>
      </fieldset>
      {verified && (
        <p role="status" className="m-0 text-sm text-primary">
          Connection verified
        </p>
      )}
      {verified && dims !== null && (
        <p role="status" className="m-0 text-sm text-muted-foreground">
          {dims} dimensions detected
        </p>
      )}
      {needsTest && !verified && !error && (
        <p className="m-0 text-xs text-muted-foreground">Test the connection with these values before saving.</p>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="m-0 text-sm text-primary">
          Saved
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {needsTest && (
          <Button
            type="button"
            variant="outline"
            disabled={loading || busy || !settings.baseUrl || !settings.apiModel.trim()}
            onClick={test}
          >
            Test connection
          </Button>
        )}
        <Button type="submit" variant="outline" disabled={loading || busy || (needsTest && !verified)}>
          Save
        </Button>
      </div>
    </form>
  );
}
