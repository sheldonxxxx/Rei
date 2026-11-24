import type { Connector, ConnectorTool, ConnectorToolClass, McpProfile } from "@rei/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Empty, EmptyDescription } from "@/components/primitives/empty.tsx";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Item } from "@/components/primitives/item.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import type { Api } from "../api/client.ts";
import { ApiError, describeError } from "../api/client.ts";
import type { CatalogConnector } from "../lib/connector-catalog.ts";
import { CONNECTORS_PATH, connectorHref, navigate as goRoute, pluginHref } from "../lib/route.ts";
import { ConnectorMarketplace } from "./ConnectorMarketplace.tsx";
import { ConfirmDialog } from "./dialogParts.tsx";
import { Icon } from "./Icon.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { PageShell } from "./PageShell.tsx";

type ConnectorsApi = Pick<
  Api,
  | "getConnectors"
  | "createConnector"
  | "updateConnector"
  | "deleteConnector"
  | "getConnectorTools"
  | "setToolClass"
  | "setMcpProfile"
  | "startConnectorSignIn"
  | "finishConnectorSignIn"
>;

interface Props {
  api: ConnectorsApi;
  /** The open connector; null shows the list. */
  id: string | null;
  /** Sends this tab to the provider's sign-in page (no popup: iOS Home Screen apps handle those badly). */
  navigate?: (url: string) => void;
}

const goTo = (url: string) => window.location.assign(url);

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A name guessed from the address: "https://mcp.notion.com/mcp" gives "Notion", "https://api.githubcopilot.com/mcp" gives "Githubcopilot". */
export function nameFromUrl(value: string): string {
  const host = hostOf(/^https?:\/\//i.test(value) ? value : `https://${value}`).replace(/:\d+$/, "");
  const parts = host.split(".").filter((p) => !/^(www|mcp|api|app|server)$/i.test(p));
  // The registrable part is the label before the top-level domain (or the only one left).
  const label = parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? host);
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : host;
}

const STATUS_WORD: Record<Connector["status"], string> = {
  connected: "Connected",
  needs_auth: "Needs sign-in",
  error: "Error",
};
const statusText = (c: Connector): string =>
  c.status === "error" && c.error ? `Error: ${c.error}` : STATUS_WORD[c.status];

const CLASS_LABEL: Record<ConnectorToolClass, string> = {
  read_external: "Read",
  write_external: "Write",
  send: "Send",
  irreversible: "Irreversible",
};
const CLASSES: ConnectorToolClass[] = ["read_external", "write_external", "send", "irreversible"];

/**
 * What the provider's redirect left in the address (`/settings/connectors?state=…&code=…` or `?oauth_error=…`). It is
 * removed from the address bar at once, so the code never stays in history or gets shared.
 */
function takeReturn(): { state: string; code: string; iss: string | null } | { error: string } | null {
  if (window.location.pathname !== CONNECTORS_PATH || !window.location.search) return null;
  const params = new URLSearchParams(window.location.search);
  const state = params.get("state");
  const code = params.get("code");
  const error = params.get("oauth_error");
  if (!(state && code) && !error) return null;
  window.history.replaceState(null, "", CONNECTORS_PATH);
  return error ? { error } : { state: state!, code: code!, iss: params.get("iss") };
}

function TokenFields({
  token,
  tokenHeader,
  hasSavedToken = false,
  onToken,
  onHeader,
}: {
  token: string;
  tokenHeader: string;
  hasSavedToken?: boolean;
  onToken: (value: string) => void;
  onHeader: (value: string) => void;
}) {
  const tokenId = useId();
  const headerId = useId();
  const helpId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={tokenId}>Token</Label>
      <Input
        id={tokenId}
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={hasSavedToken ? "Leave blank to keep the saved token" : undefined}
        value={token}
        onChange={(e) => onToken(e.target.value)}
      />
      <Label htmlFor={headerId}>Token header name</Label>
      <Input
        id={headerId}
        aria-describedby={helpId}
        placeholder="Authorization"
        autoComplete="off"
        spellCheck={false}
        maxLength={128}
        value={tokenHeader}
        onChange={(e) => onHeader(e.target.value)}
      />
      <FieldDescription id={helpId}>Leave blank to send the token as an Authorization bearer token.</FieldDescription>
    </div>
  );
}

/** Settings → Capabilities → Connectors: the apps the assistant can use, added by address, with their tools and how careful to be with each. */
export function ConnectorsPage({ api, id, navigate = goTo }: Props) {
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [rev, setRev] = useState(0);

  // Coming back from a provider's sign-in page: finish it, say how it went, and clean the address.
  useEffect(() => {
    const back = takeReturn();
    if (!back) return;
    if ("error" in back) {
      setNotice({ ok: false, text: `Sign-in didn't complete: ${back.error}` });
      return;
    }
    void api.finishConnectorSignIn({ state: back.state, code: back.code, ...(back.iss ? { iss: back.iss } : {}) }).then(
      (r) => {
        setNotice({ ok: true, text: `Signed in to ${r.connector.name}.` });
        setRev((n) => n + 1);
      },
      (e) => setNotice({ ok: false, text: describeError(e) }),
    );
  }, [api]);

  const banner = notice && (
    <p role={notice.ok ? "status" : "alert"} className={notice.ok ? "setting-help" : "form-error"}>
      {notice.text}
    </p>
  );
  if (id) return <ConnectorDetail key={id} api={api} id={id} rev={rev} navigate={navigate} banner={banner} />;
  return <ConnectorList api={api} rev={rev} navigate={navigate} banner={banner} />;
}

interface SignInProps {
  api: ConnectorsApi;
  connectorId: string;
  navigate: (url: string) => void;
  /** Called with the sentence when it can't start. */
  onError: (text: string) => void;
}

/** Starts a sign-in: this tab goes to the provider. A server that can't register a client by itself needs a client ID first. */
function useSignIn({ api, connectorId, navigate, onError }: SignInProps) {
  const [needsClient, setNeedsClient] = useState(false);
  const [busy, setBusy] = useState(false);
  const start = async (creds?: { clientId: string; clientSecret: string }, forId: string = connectorId) => {
    setBusy(true);
    try {
      const { authorizationUrl } = await api.startConnectorSignIn(
        forId,
        creds?.clientId
          ? { clientId: creds.clientId, ...(creds.clientSecret ? { clientSecret: creds.clientSecret } : {}) }
          : {},
      );
      navigate(authorizationUrl);
    } catch (e) {
      if (e instanceof ApiError && e.code === "client_id_required") setNeedsClient(true);
      else onError(describeError(e));
      setBusy(false);
    }
  };
  return { start, needsClient, busy };
}

function ClientIdFields({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (creds: { clientId: string; clientSecret: string }) => void;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const idId = useId();
  const secretId = useId();
  return (
    <form
      className="setting-controls flex min-w-0 w-full max-w-xl flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (clientId.trim()) onSubmit({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      }}
    >
      <FieldDescription className="setting-help m-0 max-w-xl text-sm text-muted-foreground">
        This server can't set up sign-in by itself. Enter the client ID from its developer settings.
      </FieldDescription>
      <Label htmlFor={idId} className="setting-label text-sm font-medium">
        Client ID
      </Label>
      <Input
        id={idId}
        className="setting-input w-full"
        autoComplete="off"
        spellCheck={false}
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
      />
      <Label htmlFor={secretId} className="setting-label text-sm font-medium">
        Client secret (if it has one)
      </Label>
      <Input
        id={secretId}
        className="setting-input w-full"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={clientSecret}
        onChange={(e) => setClientSecret(e.target.value)}
      />
      <div className="setting-line flex min-w-0 flex-wrap items-center gap-3">
        <Button variant="default" type="submit" disabled={busy || clientId.trim() === ""}>
          Continue to sign in
        </Button>
      </div>
    </form>
  );
}

function ConnectorList({
  api,
  rev,
  navigate,
  banner,
}: {
  api: ConnectorsApi;
  rev: number;
  navigate: (url: string) => void;
  banner: React.ReactNode;
}) {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogConnector | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api.getConnectors().then(
      (r) => {
        setConnectors(r.connectors);
        setError(null);
      },
      (e) => setError(describeError(e)),
    );
  }, [api]);
  useEffect(() => {
    load();
  }, [load, rev]);

  return (
    <PageShell title="Connectors" className="connectors-page">
      <p className="m-0 text-sm text-muted-foreground">
        Apps an assistant can use. A connector you add here stands on its own; a plugin's connectors come and go with
        it. Choose which agents may use each one in the agent's settings.
      </p>
      {banner}
      {error && (
        <div
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          <span>{error}</span>
          <Button variant="ghost" size="sm" type="button" onClick={load}>
            Try again
          </Button>
        </div>
      )}
      {!connectors && !error && <span className="spinner" role="status" aria-label="Loading" />}
      {connectors && connectors.length === 0 && (
        <Empty className="page-empty border px-5 py-8">
          <EmptyDescription>No connectors yet.</EmptyDescription>
        </Empty>
      )}
      {connectors && connectors.length > 0 && (
        <ul className="cfg-list m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-label="Connectors">
          {connectors.map((c) => (
            <li key={c.id}>
              <Item asChild variant="outline">
                <a
                  className="cfg-item relative flex min-w-0 flex-col items-stretch gap-1.5 rounded-2xl px-4 py-3 text-foreground no-underline [overflow-wrap:anywhere] [&:is(a)]:pr-10 [&:is(a)]:hover:bg-muted"
                  href={connectorHref(c.id)}
                >
                  <span className="cfg-item-top flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="cfg-item-name inline-flex min-w-0 flex-[1_1_8rem] items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
                      {c.name}
                    </span>
                    <Badge>{STATUS_WORD[c.status]}</Badge>
                    <Badge variant="secondary">{c.plugin ? `Plugin: ${c.plugin.name}` : "Standalone"}</Badge>
                    {c.plugin && !c.plugin.enabled && <Badge variant="outline">Plugin disabled</Badge>}
                  </span>
                  <span className="cfg-item-line text-sm text-muted-foreground [overflow-wrap:anywhere] clamp line-clamp-2">
                    {hostOf(c.url)}
                  </span>
                  <span className="cfg-item-meta flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere] [&_[data-tone=bad]]:text-destructive">
                    <span>
                      {c.toolCount === null
                        ? "Tools not listed yet"
                        : `${c.toolCount} ${c.toolCount === 1 ? "tool" : "tools"}`}
                    </span>
                    {c.status === "error" && c.error && <span>{c.error}</span>}
                  </span>
                  <span
                    className="cfg-item-action absolute top-1/2 right-3 inline-grid -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  >
                    <Icon name="forward" size={16} />
                  </span>
                </a>
              </Item>
            </li>
          ))}
        </ul>
      )}
      <ConnectorMarketplace connectors={connectors} disabled={adding} onSelect={setSelected} />
      <AddConnector
        key={selected?.id ?? "custom"}
        api={api}
        navigate={navigate}
        onAdded={load}
        preset={selected}
        onCustom={() => setSelected(null)}
        onBusyChange={setAdding}
      />
    </PageShell>
  );
}

function AddConnector({
  api,
  navigate,
  onAdded,
  preset,
  onCustom,
  onBusyChange,
}: {
  api: ConnectorsApi;
  navigate: (url: string) => void;
  onAdded: () => void;
  preset: CatalogConnector | null;
  onCustom: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [url, setUrl] = useState<string>(preset?.url ?? "");
  const [name, setName] = useState<string>(preset?.name ?? "");
  const [nameEdited, setNameEdited] = useState(false);
  const [token, setToken] = useState("");
  const [tokenHeader, setTokenHeader] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Connector | null>(null);
  const urlId = useId();
  const nameId = useId();
  const signIn = useSignIn({ api, connectorId: added?.id ?? "", navigate, onError: setError });

  const onUrl = (value: string) => {
    setUrl(value);
    if (!nameEdited) setName(value.trim() ? nameFromUrl(value.trim()) : "");
  };

  async function connect() {
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      if (added) {
        await signIn.start(undefined, added.id);
        return;
      }
      const { connector } = await api.createConnector({
        url: url.trim(),
        name: name.trim() || hostOf(url.trim()),
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(tokenHeader.trim() ? { tokenHeader: tokenHeader.trim() } : {}),
      });
      onAdded();
      if (connector.status === "needs_auth" && connector.auth !== "token") {
        setAdded(connector);
        await signIn.start(undefined, connector.id);
      } else {
        onCustom();
        setUrl("");
        setName("");
        setToken("");
        setTokenHeader("");
        setNameEdited(false);
        if (connector.status === "needs_auth") goRoute(connectorHref(connector.id));
      }
    } catch (e2) {
      setError(describeError(e2));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || url.trim() === "") return;
    await connect();
  }

  // Picking a catalog connector goes straight to its sign-in. The form only shows when the server needs a client ID
  // or the attempt fails, so the user can retry. The form remounts for each pick, so this runs once per pick.
  const pickStarted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount, with the preset's own values.
  useEffect(() => {
    if (!preset || pickStarted.current) return;
    pickStarted.current = true;
    void connect();
  }, [preset]);

  return (
    <Field
      orientation="vertical"
      className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t setting-stack items-stretch"
    >
      <FieldContent className="setting-text min-w-0">
        <FieldTitle className="setting-label text-sm font-medium">
          {preset ? `Set up ${preset.name}` : "Add a connector"}
        </FieldTitle>
        {preset?.id === "gmail" && (
          <FieldDescription>
            Requires Google Workspace Developer Preview access, the Gmail and Gmail MCP APIs enabled in your Google
            Cloud project, and an OAuth client marked for an AI-powered agent. Register this redirect URI:{" "}
            {window.location.origin}/api/mcp/oauth/callback.{" "}
            <a href={preset.docsUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              Follow Google’s setup guide
            </a>
            .
          </FieldDescription>
        )}
        {preset && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit"
            disabled={busy || signIn.busy}
            onClick={onCustom}
          >
            Use a custom connector
          </Button>
        )}
      </FieldContent>
      {added && signIn.needsClient ? (
        <ClientIdFields busy={signIn.busy} onSubmit={(creds) => void signIn.start(creds, added.id)} />
      ) : (
        <form className="setting-controls flex min-w-0 w-full max-w-xl flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <Label htmlFor={urlId} className="setting-label text-sm font-medium">
            Address
          </Label>
          <Input
            id={urlId}
            className="setting-input w-full"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://example.com/mcp"
            value={url}
            onChange={(e) => onUrl(e.target.value)}
          />
          <Label htmlFor={nameId} className="setting-label text-sm font-medium">
            Name
          </Label>
          <Input
            id={nameId}
            className="setting-input w-full"
            autoComplete="off"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
          />
          <details className="setting-more my-0.5 [&_summary]:flex [&_summary]:min-h-8 [&_summary]:cursor-pointer [&_summary]:items-center [&_summary]:text-sm [&_summary]:font-medium [&[open]_summary]:mb-2">
            <summary>Use a token instead</summary>
            <InfoTip label="About token authentication">
              For a server that gives you a token (an API key) instead of a sign-in page.
            </InfoTip>
            <TokenFields token={token} tokenHeader={tokenHeader} onToken={setToken} onHeader={setTokenHeader} />
          </details>
          <div className="setting-line flex min-w-0 flex-wrap items-center gap-3">
            <Button variant="default" type="submit" disabled={busy || url.trim() === ""}>
              {busy ? "Adding…" : added ? "Try sign-in again" : "Add connector"}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
    </Field>
  );
}

export function ConnectorDetail({
  api,
  id,
  rev,
  navigate,
  banner,
  onBack,
}: {
  api: ConnectorsApi;
  id: string;
  rev: number;
  navigate: (url: string) => void;
  banner: React.ReactNode;
  onBack?: () => void;
}) {
  const [connector, setConnector] = useState<Connector | null>(null);
  const [missing, setMissing] = useState(false);
  const [tools, setTools] = useState<ConnectorTool[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [trustBusy, setTrustBusy] = useState(false);
  const [token, setToken] = useState("");
  const [tokenHeader, setTokenHeader] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [confirmYolo, setConfirmYolo] = useState(false);
  const profileId = useId();
  const holdsId = useId();
  const signIn = useSignIn({ api, connectorId: id, navigate, onError: setError });

  const loadTools = useCallback(
    (refresh: boolean) => {
      setRefreshing(refresh);
      api.getConnectorTools(id, refresh).then(
        (r) => {
          setTools(r.tools);
          setToolsError(null);
          setRefreshing(false);
          // A successful fetch moves a connector out of "error"; pick up the new status.
          api.getConnectors().then(
            (list) => {
              const fresh = list.connectors.find((x) => x.id === id);
              if (fresh) setConnector((cur) => (cur && cur.status !== fresh.status ? fresh : cur));
            },
            () => {},
          );
        },
        (e) => {
          setTools(null);
          setToolsError(
            e instanceof ApiError && e.code === "needs_auth"
              ? "Sign in to see this connector's tools."
              : describeError(e),
          );
          setRefreshing(false);
        },
      );
    },
    [api, id],
  );

  useEffect(() => {
    let live = true;
    api.getConnectors().then(
      (r) => {
        if (!live) return;
        const c = r.connectors.find((x) => x.id === id);
        if (!c) return setMissing(true);
        setConnector(c);
        setName(c.name);
        setTokenHeader(c.tokenHeader ?? "");
        if (c.status === "connected" || c.status === "error") loadTools(false);
        else setToolsError(c.status === "needs_auth" ? "Sign in to see this connector's tools." : null);
      },
      (e) => live && setError(describeError(e)),
    );
    return () => {
      live = false;
    };
  }, [api, id, rev, loadTools]);

  const patch = async (req: { name?: string; holdsPrivate?: boolean }) => {
    setError(null);
    try {
      const r = await api.updateConnector(id, req);
      setConnector(r.connector);
      setName(r.connector.name);
    } catch (e) {
      setError(describeError(e));
      setName(connector?.name ?? "");
    }
  };
  const saveName = () => {
    const next = name.trim();
    if (next === "" || next === connector?.name) {
      setName(connector?.name ?? "");
      setEditingName(false);
      return;
    }
    void patch({ name: next });
    setEditingName(false);
  };

  const nextHeader = tokenHeader.trim();
  const headerChanged = nextHeader.toLowerCase() !== (connector?.tokenHeader ?? "").toLowerCase();
  const saveAuthentication = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connector || authBusy || (!token.trim() && !headerChanged)) return;
    setAuthBusy(true);
    setError(null);
    try {
      const { connector: updated } = await api.updateConnector(id, {
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(headerChanged ? { tokenHeader: nextHeader || null } : {}),
      });
      setConnector(updated);
      setToken("");
      setTokenHeader(updated.tokenHeader ?? "");
      setTools(null);
      if (updated.status === "connected") loadTools(false);
      else setToolsError(updated.error);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setAuthBusy(false);
    }
  };

  const setProfile = async (profile: McpProfile, confirmed = false) => {
    if (!connector) return;
    setTrustBusy(true);
    setError(null);
    try {
      const r = await api.setMcpProfile(
        id,
        profile,
        connector.providerIdentity!,
        connector.mcpProfileRevision!,
        confirmed,
      );
      setConnector(r.connector);
      setConfirmYolo(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setTrustBusy(false);
    }
  };

  const setClass = async (tool: ConnectorTool, value: ConnectorToolClass | null) => {
    setError(null);
    try {
      await api.setToolClass(id, tool.name, value, tool.definitionFingerprint);
      setTools(
        (list) =>
          list?.map((t) =>
            t.name === tool.name
              ? {
                  ...t,
                  override: value,
                  effectiveClass: t.defaultClass === "irreversible" ? "irreversible" : (value ?? t.defaultClass),
                }
              : t,
          ) ?? null,
      );
    } catch (e) {
      setError(describeError(e));
    }
  };

  const back = onBack ?? (() => goRoute(CONNECTORS_PATH));
  if (missing) {
    return (
      <PageShell title="Connector" backLabel={onBack ? "Back to plugin" : "Back to Connectors"} onBack={back}>
        <Empty className="page-empty border px-5 py-8">
          <EmptyDescription>That connector no longer exists.</EmptyDescription>
        </Empty>
      </PageShell>
    );
  }
  if (!connector) {
    return (
      <PageShell title="Connector" backLabel={onBack ? "Back to plugin" : "Back to Connectors"} onBack={back}>
        {error ? (
          <p
            role="alert"
            className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        ) : (
          <span className="spinner" role="status" aria-label="Loading" />
        )}
      </PageShell>
    );
  }

  return (
    <PageShell
      title={
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {editingName ? (
            <form
              className="inline-flex min-w-0 items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                saveName();
              }}
            >
              <Input
                aria-label="Connector name"
                className="setting-input h-9 w-48 max-w-[60vw] text-base font-semibold"
                autoComplete="off"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  setName(connector.name);
                  setEditingName(false);
                }}
              />
              <Button type="submit" size="xs" disabled={!name.trim()}>
                Save
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  setName(connector.name);
                  setEditingName(false);
                }}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <>
              <span>{connector.name}</span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Edit connector name"
                title="Edit name"
                onClick={() => setEditingName(true)}
              >
                <Icon name="edit" size={14} />
              </Button>
            </>
          )}
        </span>
      }
      titleLabel={connector.name}
      backLabel={onBack ? "Back to plugin" : "Back to Connectors"}
      onBack={back}
    >
      {banner}
      {error && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      <Field
        orientation="horizontal"
        className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t"
      >
        <FieldContent className="setting-text min-w-0">
          <FieldTitle className="setting-label text-sm font-medium">Status</FieldTitle>
          <FieldDescription className="setting-help m-0 max-w-xl text-sm text-muted-foreground">
            {connector.auth === "token" && connector.status === "needs_auth" ? "Token rejected" : statusText(connector)}{" "}
            · {hostOf(connector.url)}
          </FieldDescription>
          <FieldDescription className="setting-help m-0 max-w-xl text-sm text-muted-foreground">
            {connector.plugin ? (
              <>
                Part of the plugin <a href={pluginHref(connector.plugin.id)}>{connector.plugin.name}</a>
                {connector.plugin.enabled ? "" : " (disabled)"}
              </>
            ) : (
              "Standalone: no plugin owns it"
            )}
          </FieldDescription>
        </FieldContent>
        {connector.status === "needs_auth" && connector.auth !== "token" && !signIn.needsClient && (
          <Button variant="outline" type="button" disabled={signIn.busy} onClick={() => void signIn.start()}>
            Sign in again
          </Button>
        )}
      </Field>
      {signIn.needsClient && (
        <Field
          orientation="vertical"
          className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t setting-stack items-stretch"
        >
          <ClientIdFields busy={signIn.busy} onSubmit={(creds) => void signIn.start(creds)} />
        </Field>
      )}
      {connector.auth === "token" && (
        <Field className="setting-row min-w-0 gap-3 py-5 [&+[data-slot=field]]:border-t">
          <FieldTitle>Token authentication</FieldTitle>
          {connector.status === "needs_auth" && <FieldDescription>{connector.error}</FieldDescription>}
          <form
            className="setting-controls flex min-w-0 w-full max-w-xl flex-col items-start gap-3 [&>div]:w-full"
            onSubmit={(e) => void saveAuthentication(e)}
          >
            <TokenFields
              token={token}
              tokenHeader={tokenHeader}
              hasSavedToken
              onToken={setToken}
              onHeader={setTokenHeader}
            />
            <Button type="submit" disabled={authBusy || (!token.trim() && !headerChanged)}>
              {authBusy ? "Saving…" : "Save authentication"}
            </Button>
          </form>
        </Field>
      )}
      <Field
        orientation="horizontal"
        className="setting-row max-sm:flex-col max-sm:items-stretch min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t"
      >
        <FieldContent className="setting-text min-w-0">
          <Label htmlFor={profileId} className="setting-label text-sm font-medium">
            MCP permission profile
          </Label>
          <FieldDescription className="setting-help m-0 max-w-xl text-sm text-muted-foreground">
            Always Ask asks before every call. Read-only runs claimed read-only tools automatically and asks before
            every other action. Read and write also runs reversible writes automatically but still asks before sends,
            deletes and tools marked destructive. YOLO runs all tools, including permanent deletes, without per-call
            prompts. Chat permissions do not change this profile. A provider can mislabel a tool.
          </FieldDescription>
        </FieldContent>
        <NativeSelect
          id={profileId}
          className="setting-select min-w-0 max-w-full shrink-0 max-sm:w-full"
          value={connector.mcpProfile ?? "always_ask"}
          disabled={trustBusy || !connector.providerIdentity || !connector.mcpProfileRevision}
          onChange={(e) =>
            e.target.value === "yolo" ? setConfirmYolo(true) : void setProfile(e.target.value as McpProfile)
          }
        >
          <option value="always_ask">Always Ask</option>
          <option value="read_only">Read-only</option>
          <option value="read_write">Read and write</option>
          <option value="yolo">YOLO</option>
        </NativeSelect>
      </Field>
      <Field
        orientation="horizontal"
        className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t"
      >
        <FieldContent className="setting-text min-w-0">
          <FieldTitle id={holdsId} className="setting-label text-sm font-medium">
            Holds my data
            <InfoTip label="About private data">
              Reading from it marks the chat as having read your private data, so sending things out asks first.
            </InfoTip>
          </FieldTitle>
        </FieldContent>
        <Switch
          checked={connector.holdsPrivate}
          aria-labelledby={holdsId}
          onCheckedChange={() => void patch({ holdsPrivate: !connector.holdsPrivate })}
        />
      </Field>
      <Field
        orientation="vertical"
        className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t setting-stack items-stretch"
      >
        <div className="setting-line flex min-w-0 flex-wrap items-center gap-3">
          <FieldContent className="setting-text min-w-0">
            <FieldTitle className="setting-label text-sm font-medium">
              Tools
              <InfoTip label="About effect classifications">
                These are effect classifications, not permissions. A manual Read downgrade is bound to the inspected
                definition and never makes an unmarked tool automatic in Read-only. The MCP profile decides which calls
                need approval.
              </InfoTip>
            </FieldTitle>
          </FieldContent>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={refreshing || (connector.status !== "connected" && connector.status !== "error")}
            onClick={() => loadTools(true)}
          >
            <Icon name="reload" size={16} />
            {refreshing ? "Refreshing…" : "Refresh tools"}
          </Button>
        </div>
        {toolsError && (
          <p
            role="alert"
            className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            {toolsError}
          </p>
        )}
        {tools && tools.length === 0 && (
          <Empty className="page-empty border px-5 py-8">
            <EmptyDescription>This connector has no tools.</EmptyDescription>
          </Empty>
        )}
        {tools && tools.length > 0 && (
          <ul className="cfg-list m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-label="Tools">
            {tools.map((t) => {
              const value = t.effectiveClass ?? t.override ?? t.defaultClass;
              return (
                <li
                  key={t.name}
                  className="connector-tool flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-4 max-sm:flex-col max-sm:items-stretch"
                >
                  <FieldContent className="setting-text min-w-0">
                    <FieldTitle className="setting-label text-sm font-medium">{t.name}</FieldTitle>
                    {t.description && (
                      <p className="setting-help m-0 max-w-xl text-sm text-muted-foreground clamp line-clamp-2">
                        {t.description}
                      </p>
                    )}
                  </FieldContent>
                  <div className="setting-line flex min-w-0 flex-wrap items-center gap-3">
                    {t.defaultClass === "irreversible" && (
                      <InfoTip label={`Why ${t.name} cannot be changed`}>
                        This tool is classified as irreversible and cannot be downgraded. Whether approval is required
                        depends on the connector MCP permission profile.
                      </InfoTip>
                    )}
                    <NativeSelect
                      className="setting-select min-w-0 max-w-full shrink-0 max-sm:w-full"
                      aria-label={`Class of ${t.name}`}
                      value={value}
                      disabled={t.defaultClass === "irreversible"}
                      onChange={(e) =>
                        void setClass(
                          t,
                          e.target.value === t.defaultClass ? null : (e.target.value as ConnectorToolClass),
                        )
                      }
                    >
                      {CLASSES.map((c) => (
                        <option key={c} value={c}>
                          {CLASS_LABEL[c]}
                          {c === t.defaultClass ? " (default)" : ""}
                        </option>
                      ))}
                    </NativeSelect>
                    {t.override && (
                      <Button variant="ghost" size="sm" type="button" onClick={() => void setClass(t, null)}>
                        Reset
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Field>
      {!onBack && (
        <Field
          orientation="horizontal"
          className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t"
        >
          <Button
            variant="destructive"
            type="button"
            className="danger-text text-destructive"
            onClick={() => setConfirmRemove(true)}
          >
            <Icon name="trash" size={18} />
            Remove connector
          </Button>
        </Field>
      )}
      {confirmRemove && (
        <RemoveDialog api={api} connector={connector} onCancel={() => setConfirmRemove(false)} onRemoved={back} />
      )}
      {confirmYolo && (
        <YoloDialog
          busy={trustBusy}
          onCancel={() => setConfirmYolo(false)}
          onConfirm={() => void setProfile("yolo", true)}
        />
      )}
    </PageShell>
  );
}

function YoloDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog
      title="Enable YOLO for this connector?"
      description={
        <p>
          All MCP tools may run without asking, including writes, messages and irreversible deletion. Data can be
          permanently lost or sent outside your control. Chat permissions and trigger allowlists will not add prompts.
          Enable this only if you accept those risks.
        </p>
      }
      busy={busy}
      confirmLabel="Enable YOLO, including irreversible actions"
      busyLabel="Saving…"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

function RemoveDialog({
  api,
  connector,
  onCancel,
  onRemoved,
}: {
  api: ConnectorsApi;
  connector: Connector;
  onCancel: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteConnector(connector.id);
      onRemoved();
    } catch (e) {
      if (e instanceof ApiError && (e.code === "not_found" || e.code === "connector_not_found")) onRemoved();
      else {
        setError(describeError(e));
        setBusy(false);
      }
    }
  }

  return (
    <ConfirmDialog
      title="Remove this connector?"
      description={
        <p>
          “{connector.name}” is signed out and forgotten, and the permissions you gave for its tools end. You can add it
          again later.
        </p>
      }
      error={error}
      busy={busy}
      confirmLabel="Remove"
      busyLabel="Removing…"
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    />
  );
}
