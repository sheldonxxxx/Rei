import type { SaveSearchSetupSettings, SearchProviderId, SearchSetupSettings } from "@rei/protocol";
import { DEFAULT_SEARCH_MODEL, SEARCH_PROVIDER_IDS } from "@rei/protocol";
import { cn } from "cn";
import { useEffect, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Field, FieldGroup, FieldLabel } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

const names: Record<SearchProviderId, string> = {
  "codex-subscription": "ChatGPT / Codex",
  exa: "Exa (keyless)",
  "exa-api": "Exa (API key)",
  brave: "Brave",
  tavily: "Tavily",
  searxng: "SearXNG",
};
export function SearchProviderSettings({ api, onSaved }: { api: Api; onSaved: () => void }) {
  const [settings, setSettings] = useState<SearchSetupSettings | null>(null);
  const [keys, setKeys] = useState<NonNullable<SaveSearchSetupSettings["apiKeys"]>>({});
  const [expanded, setExpanded] = useState<SearchProviderId | null>(null);
  const [dragged, setDragged] = useState<SearchProviderId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void api
      .getSearchSetup()
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch((cause) => {
        if (active) setError(describeError(cause));
      });
    return () => {
      active = false;
    };
  }, [api]);
  const providerOrder = [
    ...new Set([...(settings?.providerOrder ?? settings?.providers ?? []), ...SEARCH_PROVIDER_IDS]),
  ];
  const change = (patch: Partial<SearchSetupSettings>) => {
    setSettings((current) => (current ? { ...current, ...patch } : current));
    setNotice("");
  };
  const move = (id: SearchProviderId, destination: number) => {
    if (!providerOrder[destination]) return;
    const next = providerOrder.filter((item) => item !== id);
    next.splice(destination, 0, id);
    change({ providerOrder: next });
    setNotice(`${names[id]} moved. Save changes to apply.`);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const value = await api.saveSearchSetup({
        providers: providerOrder.filter((id) => settings.providers.includes(id)),
        providerOrder,
        searxngUrl: settings.searxngUrl,
        codexModel: settings.codexModel ?? DEFAULT_SEARCH_MODEL,
        ...(Object.values(keys).some(Boolean) ? { apiKeys: keys } : {}),
      });
      setSettings(value);
      setKeys({});
      setNotice("Saved");
      onSaved();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!settings)
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        Loading search providers…
      </p>
    );
  const firstReady = providerOrder.find(
    (id) =>
      settings.providers.includes(id) &&
      settings.providerStatus?.some(
        (s) => s.id === id && s.configured && !(s.limitedUntil && s.limitedUntil > Date.now()),
      ),
  );
  return (
    <form
      onSubmit={(event) => void save(event)}
      className="flex min-w-0 flex-col gap-4"
      aria-label="Search fallback settings"
    >
      <div>
        <h3 className="m-0 text-base font-medium">Search order</h3>
        <p className="mt-1 mb-0 text-sm text-muted-foreground">
          Try enabled providers from top to bottom. Stop when one returns results.
        </p>
      </div>
      <ol
        aria-label="Search providers in priority order"
        className="m-0 flex list-none flex-col divide-y rounded-2xl border px-3"
      >
        {providerOrder.map((id, index) => {
          const enabled = settings.providers.includes(id);
          const rowName = names[id];
          const readiness = settings.providerStatus?.find((item) => item.id === id);
          const keyId = id === "codex-subscription" || id === "exa" ? null : id === "exa-api" ? "exa" : id;
          const configured = id === "exa" || (readiness?.configured ?? false) || (id === "exa-api" && !!keys.exa);
          const limited = !!readiness?.limitedUntil && readiness.limitedUntil > Date.now();
          const state = !configured
            ? "Needs setup"
            : limited
              ? "Rate limited"
              : readiness?.lastError
                ? "Last attempt failed"
                : "Configured";
          const open = expanded === id;
          const iconButton = (
            label: string,
            icon: "up" | "down" | "settings",
            action: () => void,
            disabled = false,
          ) => (
            <Tip label={label}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={label}
                disabled={busy || disabled}
                onClick={action}
              >
                <Icon name={icon} size={14} />
              </Button>
            </Tip>
          );
          return (
            <li
              key={id}
              aria-label={rowName}
              onDragOver={(event) => {
                if (dragged) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged) move(dragged, index);
                setDragged(null);
              }}
              className="min-w-0 py-3"
            >
              <div className="flex items-center gap-2">
                <Tip label={`Drag ${rowName} to reorder`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Drag ${rowName} to reorder`}
                    draggable={!busy}
                    onDragStart={(event) => {
                      setDragged(id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", id);
                    }}
                    onDragEnd={() => setDragged(null)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp" && index > 0) {
                        event.preventDefault();
                        move(id, index - 1);
                      }
                      if (event.key === "ArrowDown" && index < providerOrder.length - 1) {
                        event.preventDefault();
                        move(id, index + 1);
                      }
                    }}
                  >
                    <Icon name="grip" size={14} />
                  </Button>
                </Tip>
                <span className="w-4 shrink-0 text-center text-xs text-muted-foreground" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn("text-sm font-medium", !configured && "text-muted-foreground")}>{rowName}</span>
                    {enabled && id === firstReady && <Badge variant="secondary">First available</Badge>}
                  </div>
                  <span className="text-xs text-muted-foreground">{state}</span>
                </div>
                <Switch
                  size="sm"
                  aria-label={`Enable ${rowName}`}
                  checked={enabled}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    change({
                      providers: checked
                        ? [...new Set([...settings.providers, id])]
                        : settings.providers.filter((value) => value !== id),
                    })
                  }
                />
                <div className="grid shrink-0 grid-cols-[repeat(3,2rem)] items-center">
                  {iconButton(`Move ${rowName} up`, "up", () => move(id, index - 1), index === 0)}
                  {iconButton(
                    `Move ${rowName} down`,
                    "down",
                    () => move(id, index + 1),
                    index === providerOrder.length - 1,
                  )}
                  {id !== "exa" && (
                    <Tip label={`Configure ${rowName}`}>
                      <Button
                        type="button"
                        variant={open ? "secondary" : "ghost"}
                        size="icon-sm"
                        aria-label={`Configure ${rowName}`}
                        aria-expanded={open}
                        aria-controls={`search-config-${id}`}
                        onClick={() => setExpanded(open ? null : id)}
                      >
                        <Icon name="settings" size={14} />
                      </Button>
                    </Tip>
                  )}
                </div>
              </div>
              {open && (
                <FieldGroup id={`search-config-${id}`} className="mt-3 gap-3 border-t pt-3">
                  {id === "codex-subscription" && (
                    <>
                      <Field>
                        <FieldLabel htmlFor="search-model">Search model</FieldLabel>
                        <Input
                          id="search-model"
                          required
                          maxLength={100}
                          pattern="[a-zA-Z0-9._\-]+"
                          value={settings.codexModel ?? DEFAULT_SEARCH_MODEL}
                          onChange={(event) => change({ codexModel: event.target.value })}
                        />
                      </Field>
                      <p className="m-0 text-xs text-muted-foreground">
                        Uses your OpenAI connection signed in with ChatGPT. The selected model must support web search
                        on your account. <a href="/settings/providers">Manage connection</a>.
                      </p>
                    </>
                  )}
                  {id === "searxng" && (
                    <Field>
                      <FieldLabel htmlFor="search-searxng-url">SearXNG URL</FieldLabel>
                      <Input
                        id="search-searxng-url"
                        type="url"
                        value={settings.searxngUrl}
                        onChange={(event) => change({ searxngUrl: event.target.value })}
                        placeholder="https://search.example.com"
                      />
                    </Field>
                  )}
                  {keyId && (
                    <Field>
                      <FieldLabel htmlFor={`search-key-${id}`}>
                        {id === "searxng"
                          ? "Authentication (optional)"
                          : `${id === "exa-api" ? "Exa" : names[id]} API key`}
                      </FieldLabel>
                      <Input
                        id={`search-key-${id}`}
                        type="password"
                        autoComplete="off"
                        value={keys[keyId] ?? ""}
                        onChange={(event) => {
                          setKeys({ ...keys, [keyId]: event.target.value });
                          setNotice("");
                        }}
                        placeholder="Leave blank to keep a saved credential"
                      />
                    </Field>
                  )}
                  <p className="m-0 text-xs text-muted-foreground">
                    Configuration does not turn this provider on. Credentials stay in the gateway.
                  </p>
                </FieldGroup>
              )}
            </li>
          );
        })}
      </ol>
      <p className="m-0 text-xs text-muted-foreground">
        Queries may be sent to each enabled provider until one succeeds. Providers that need setup or are rate limited
        are skipped. Turn every provider off to disable search.
      </p>
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
      <p role="status" className="m-0 text-xs text-muted-foreground">
        {notice}
      </p>
      <Button type="submit" variant="outline" size="sm" disabled={busy}>
        {busy ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
