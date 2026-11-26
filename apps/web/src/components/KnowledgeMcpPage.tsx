import type { KnowledgeMcpAllowedPage, KnowledgeMcpToken, KnowledgeTreeNode } from "@rei/protocol";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/primitives/empty.tsx";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { ago } from "../lib/time.ts";
import { useReportUnsaved } from "../lib/unsaved.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { ConfirmDialog, DialogError, DialogWarning } from "./dialogParts.tsx";
import { Icon } from "./Icon.tsx";
import { indexKnowledgeTree, KnowledgeFolderTree } from "./KnowledgeFolderTree.tsx";
import { PageShell } from "./PageShell.tsx";
import { Tip } from "./Tip.tsx";

type McpApi = Pick<
  Api,
  | "listKnowledgeMcpTokens"
  | "createKnowledgeMcpToken"
  | "updateKnowledgeMcpToken"
  | "rotateKnowledgeMcpToken"
  | "revokeKnowledgeMcpToken"
  | "knowledgeTree"
>;

function snippetJson(endpointUrl: string, tokenPlaceholder = "<token>"): string {
  return JSON.stringify(
    {
      mcpServers: {
        "rei-knowledge": {
          type: "http",
          url: endpointUrl,
          headers: {
            Authorization: `Bearer ${tokenPlaceholder}`,
          },
        },
      },
    },
    null,
    2,
  );
}

/** Settings → MCP: manage Knowledge MCP access tokens, permissions, and allowed folders. */
export function KnowledgeMcpPage({ api }: { api: McpApi }) {
  const [endpointPath, setEndpointPath] = useState("/api/mcp/knowledge");
  const [tokens, setTokens] = useState<KnowledgeMcpToken[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "edit"; token: KnowledgeMcpToken } | null>(null);
  const [confirm, setConfirm] = useState<
    { kind: "rotate"; token: KnowledgeMcpToken } | { kind: "revoke"; token: KnowledgeMcpToken } | null
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [revealed, setRevealed] = useState<{ name: string; secret: string; rotated: boolean } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await api.listKnowledgeMcpTokens();
      setEndpointPath(res.endpointPath);
      setTokens(res.tokens);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset the Settings scroll container when switching between the token list, editor, or one-time secret reveal.
  const viewKey = editing ? (editing.mode === "edit" ? editing.token.id : "create") : revealed ? "revealed" : "list";
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewKey intentionally triggers scroll reset on view transitions.
  useLayoutEffect(() => {
    const body = anchorRef.current?.closest<HTMLElement>(".settings-body");
    if (body) body.scrollTop = 0;
  }, [viewKey]);

  const endpointUrl = `${window.location.origin}${endpointPath}`;

  async function toggleEnabled(token: KnowledgeMcpToken, enabled: boolean) {
    setBusyId(token.id);
    setError("");
    try {
      const res = await api.updateKnowledgeMcpToken(token.id, { enabled });
      setTokens((prev) => (prev ? prev.map((t) => (t.id === token.id ? res.token : t)) : prev));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  async function runConfirm() {
    if (!confirm || confirmBusy) return;
    setConfirmBusy(true);
    setConfirmError("");
    try {
      if (confirm.kind === "rotate") {
        const res = await api.rotateKnowledgeMcpToken(confirm.token.id);
        setTokens((prev) => (prev ? prev.map((t) => (t.id === confirm.token.id ? res.token : t)) : prev));
        setConfirm(null);
        setRevealed({ name: res.token.name, secret: res.secret, rotated: true });
      } else {
        await api.revokeKnowledgeMcpToken(confirm.token.id);
        setTokens((prev) => (prev ? prev.filter((t) => t.id !== confirm.token.id) : prev));
        setConfirm(null);
      }
    } catch (e) {
      setConfirmError(describeError(e));
    } finally {
      setConfirmBusy(false);
    }
  }

  if (editing) {
    return (
      <div ref={anchorRef} className="min-w-0">
        <TokenEditor
          key={editing.mode === "edit" ? editing.token.id : "create"}
          api={api}
          initial={editing.mode === "edit" ? editing.token : null}
          onClose={() => setEditing(null)}
          onCreated={(res) => {
            setTokens((prev) => (prev ? [res.token, ...prev] : [res.token]));
            setEditing(null);
            setRevealed({ name: res.token.name, secret: res.secret, rotated: false });
          }}
          onUpdated={(updated) => {
            setTokens((prev) => (prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : [updated]));
            setEditing(null);
          }}
        />
      </div>
    );
  }

  return (
    <div ref={anchorRef} className="min-w-0">
      <PageShell
        title="MCP"
        actions={
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setRevealed(null);
              setEditing({ mode: "create" });
            }}
          >
            <Icon name="plus" size={16} />
            New token
          </Button>
        }
      >
        {revealed && (
          <SecretRevealCard
            name={revealed.name}
            secret={revealed.secret}
            rotated={revealed.rotated}
            endpointUrl={endpointUrl}
            onClose={() => setRevealed(null)}
          />
        )}

        <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <div className="flex flex-col gap-1">
            <h4 className="m-0 text-sm font-semibold">Knowledge MCP endpoint</h4>
            <p className="m-0 text-xs text-muted-foreground">
              Access is denied by default. Create a token, choose allowed Knowledge pages, and enable Read, Write, or
              Delete.
            </p>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 rounded-xl border bg-muted/50 px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{endpointUrl}</code>
            <CopyButton text={endpointUrl} label="Copy endpoint URL" />
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
              Client setup example
            </summary>
            <div className="mt-2 flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
              <p className="m-0 text-muted-foreground">
                Send <code className="font-mono">Authorization: Bearer &lt;token&gt;</code> over Streamable HTTP (POST):
              </p>
              <div className="relative">
                <pre className="m-0 overflow-x-auto font-mono text-xs leading-relaxed text-foreground">
                  {snippetJson(endpointUrl)}
                </pre>
              </div>
            </div>
          </details>
        </div>

        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
          >
            <span>{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}

        {tokens === null && !error ? (
          <p className="m-0 text-sm text-muted-foreground">Loading…</p>
        ) : tokens && tokens.length === 0 ? (
          <Empty className="border bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="plug" size={20} />
              </EmptyMedia>
              <EmptyTitle>No MCP tokens yet</EmptyTitle>
              <EmptyDescription>
                Tokens you create will appear here with their permissions and allowed folders.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Knowledge MCP tokens">
            {(tokens ?? []).map((token) => (
              <TokenRow
                key={token.id}
                token={token}
                busy={busyId === token.id}
                onToggle={(enabled) => void toggleEnabled(token, enabled)}
                onEdit={() => {
                  setRevealed(null);
                  setEditing({ mode: "edit", token });
                }}
                onRotate={() => {
                  setConfirmError("");
                  setConfirm({ kind: "rotate", token });
                }}
                onRevoke={() => {
                  setConfirmError("");
                  setConfirm({ kind: "revoke", token });
                }}
              />
            ))}
          </ul>
        )}

        {confirm && (
          <ConfirmDialog
            title={
              confirm.kind === "rotate"
                ? `Rotate secret for “${confirm.token.name}”?`
                : `Revoke “${confirm.token.name}”?`
            }
            description={
              confirm.kind === "rotate" ? (
                <p>
                  This immediately invalidates the current secret and issues a new one. Any external client using the
                  old secret will stop working until updated.
                </p>
              ) : (
                <p>
                  Revoking this token is permanent. External clients using it will lose access immediately. Revision
                  history written by this token keeps its name.
                </p>
              )
            }
            tone={confirm.kind === "revoke" ? "destructive" : "default"}
            confirmLabel={confirm.kind === "rotate" ? "Rotate secret" : "Revoke token"}
            busyLabel={confirm.kind === "rotate" ? "Rotating…" : "Revoking…"}
            busy={confirmBusy}
            error={confirmError}
            onCancel={() => !confirmBusy && setConfirm(null)}
            onConfirm={() => void runConfirm()}
          />
        )}
      </PageShell>
    </div>
  );
}

function TokenRow({
  token,
  busy,
  onToggle,
  onEdit,
  onRotate,
  onRevoke,
}: {
  token: KnowledgeMcpToken;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const hasLiveFolder = token.allowedPages.some((p) => p.status === "live");
  const hasAnyFlag = token.permissions.read || token.permissions.write || token.permissions.delete;
  const effectiveAccess = hasLiveFolder && hasAnyFlag;

  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground [overflow-wrap:anywhere]">{token.name}</span>
            <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {token.tokenPrefix}…
            </code>
            <Badge variant={token.enabled ? "success" : "secondary"}>{token.enabled ? "Active" : "Disabled"}</Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            {token.lastUsedAt ? `Last used ${ago(token.lastUsedAt)}` : "Never used"}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Tip label={token.enabled ? "Disable token" : "Enable token"}>
            <span>
              <Switch
                checked={token.enabled}
                disabled={busy}
                aria-label={`Enable ${token.name}`}
                onCheckedChange={onToggle}
              />
            </span>
          </Tip>
          <Tip label="Edit">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              aria-label={`Edit ${token.name}`}
              onClick={onEdit}
            >
              <Icon name="edit" size={16} />
            </Button>
          </Tip>
          <Tip label="Rotate secret">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              aria-label={`Rotate secret for ${token.name}`}
              onClick={onRotate}
            >
              <Icon name="reload" size={16} />
            </Button>
          </Tip>
          <Tip label="Revoke">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              aria-label={`Revoke ${token.name}`}
              onClick={onRevoke}
            >
              <Icon name="trash" size={16} />
            </Button>
          </Tip>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {!effectiveAccess ? (
          <>
            <Badge variant="secondary">No access</Badge>
            {hasAnyFlag && !hasLiveFolder && (
              <span className="text-xs text-muted-foreground">(no live folders allowed)</span>
            )}
          </>
        ) : (
          <>
            {token.permissions.read && <Badge variant="outline">Read</Badge>}
            {token.permissions.write && <Badge variant="outline">Write</Badge>}
            {token.permissions.delete && <Badge variant="outline">Delete</Badge>}
          </>
        )}
      </div>

      {token.allowedPages.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">No allowed folders.</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={`Allowed folders for ${token.name}`}>
          {token.allowedPages.map((p) => (
            <li
              key={p.pageId}
              className="inline-flex max-w-full items-center gap-1.5 rounded-xl border bg-muted/40 px-2.5 py-1 text-xs"
            >
              <Icon name="folder" size={12} className="shrink-0 text-muted-foreground" />
              <span className="truncate">{p.path ?? p.title ?? p.pageId}</span>
              {p.status === "trashed" && <Badge variant="attention">In Trash</Badge>}
              {p.status === "missing" && <Badge variant="destructive">Missing</Badge>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function TokenEditor({
  api,
  initial,
  onClose,
  onCreated,
  onUpdated,
}: {
  api: McpApi;
  initial: KnowledgeMcpToken | null;
  onClose: () => void;
  onCreated: (res: { token: KnowledgeMcpToken; secret: string }) => void;
  onUpdated: (token: KnowledgeMcpToken) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [canRead, setCanRead] = useState(initial?.permissions.read ?? false);
  const [canWrite, setCanWrite] = useState(initial?.permissions.write ?? false);
  const [canDelete, setCanDelete] = useState(initial?.permissions.delete ?? false);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => initial?.allowedPages.map((p) => p.pageId) ?? []);
  const [treeNodes, setTreeNodes] = useState<KnowledgeTreeNode[] | null>(null);
  const [treeError, setTreeError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const nameId = useId();
  const readId = useId();
  const writeId = useId();
  const deleteId = useId();

  useEffect(() => {
    let cancelled = false;
    api.knowledgeTree().then(
      (res) => {
        if (cancelled) return;
        setTreeNodes(res.pages);
        setTreeError("");
      },
      (e) => !cancelled && setTreeError(describeError(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const initialSnapshot = useMemo(
    () =>
      JSON.stringify({
        name: initial?.name ?? "",
        read: initial?.permissions.read ?? false,
        write: initial?.permissions.write ?? false,
        delete: initial?.permissions.delete ?? false,
        allowedPageIds: initial?.allowedPages.map((p) => p.pageId) ?? [],
      }),
    [initial],
  );
  const dirty =
    JSON.stringify({
      name,
      read: canRead,
      write: canWrite,
      delete: canDelete,
      allowedPageIds: selectedIds,
    }) !== initialSnapshot;
  useReportUnsaved(dirty);

  const tree = useMemo(() => indexKnowledgeTree(treeNodes ?? []), [treeNodes]);
  const existingById = useMemo(
    () => new Map((initial?.allowedPages ?? []).map((p): [string, KnowledgeMcpAllowedPage] => [p.pageId, p])),
    [initial],
  );

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a token name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (initial) {
        const res = await api.updateKnowledgeMcpToken(initial.id, {
          name: trimmed,
          permissions: { read: canRead, write: canWrite, delete: canDelete },
          allowedPageIds: selectedIds,
        });
        onUpdated(res.token);
      } else {
        const res = await api.createKnowledgeMcpToken({
          name: trimmed,
          permissions: { read: canRead, write: canWrite, delete: canDelete },
          allowedPageIds: selectedIds,
        });
        onCreated(res);
      }
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <PageShell
      title={initial ? "Edit MCP token" : "New MCP token"}
      backLabel="Back to MCP"
      onBack={() => {
        if (!busy) onClose();
      }}
    >
      <form
        data-enter="fade"
        className="flex min-w-0 flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void submit();
        }}
      >
        <Field className="gap-1.5">
          <Label htmlFor={nameId}>Token name</Label>
          <Input
            id={nameId}
            value={name}
            maxLength={80}
            disabled={busy}
            autoFocus
            placeholder="e.g. Local editor, Research client"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Permissions</span>
          <div className="flex flex-col divide-y rounded-2xl border bg-card px-4">
            <Field orientation="horizontal" className="items-center justify-between gap-4 py-3">
              <FieldContent>
                <FieldTitle id={readId}>Read</FieldTitle>
                <FieldDescription>Browse, read, and search allowed pages.</FieldDescription>
              </FieldContent>
              <Switch checked={canRead} disabled={busy} aria-labelledby={readId} onCheckedChange={setCanRead} />
            </Field>
            <Field orientation="horizontal" className="items-center justify-between gap-4 py-3">
              <FieldContent>
                <FieldTitle id={writeId}>Write</FieldTitle>
                <FieldDescription>
                  Create, edit, and move pages inside allowed folders (locked pages remain append-only).
                </FieldDescription>
              </FieldContent>
              <Switch checked={canWrite} disabled={busy} aria-labelledby={writeId} onCheckedChange={setCanWrite} />
            </Field>
            <Field orientation="horizontal" className="items-center justify-between gap-4 py-3">
              <FieldContent>
                <FieldTitle id={deleteId}>Delete</FieldTitle>
                <FieldDescription>
                  Move descendant pages inside allowed folders to Trash (recoverable for 30 days; granted root folders
                  cannot be deleted).
                </FieldDescription>
              </FieldContent>
              <Switch checked={canDelete} disabled={busy} aria-labelledby={deleteId} onCheckedChange={setCanDelete} />
            </Field>
          </div>
        </div>

        <KnowledgeFolderTree
          tree={tree}
          loading={treeNodes === null}
          treeError={treeError}
          selectedIds={selectedIds}
          existingById={existingById}
          busy={busy}
          emptySelectionNote="No allowed folders selected — this token cannot access any Knowledge pages."
          onChange={setSelectedIds}
        />

        {error && <DialogError>{error}</DialogError>}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : initial ? "Save changes" : "Create token"}
          </Button>
        </div>
      </form>
    </PageShell>
  );
}

function SecretRevealCard({
  name,
  secret,
  rotated,
  endpointUrl,
  onClose,
}: {
  name: string;
  secret: string;
  rotated: boolean;
  endpointUrl: string;
  onClose: () => void;
}) {
  const bearerHeader = `Authorization: Bearer ${secret}`;
  const heading = rotated ? `New secret for “${name}”` : `Token “${name}” created`;
  const configJson = snippetJson(endpointUrl, secret);

  return (
    <section
      aria-label={heading}
      data-enter="rise"
      className="flex flex-col gap-3 rounded-2xl border border-attention-border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h4 className="m-0 text-sm font-semibold text-foreground">{heading}</h4>
          <p className="m-0 text-xs text-muted-foreground">
            Copy this token secret now. For your security, it will not be shown again.
          </p>
        </div>
        <Button type="button" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>

      <DialogWarning>Store this secret securely — closing this notice clears it permanently from view.</DialogWarning>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Bearer token</span>
          <div className="flex items-center justify-between gap-2 rounded-xl border bg-muted/50 px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{secret}</code>
            <CopyButton text={secret} label="Copy secret" compact />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Authorization header</span>
          <div className="flex items-center justify-between gap-2 rounded-xl border bg-muted/50 px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{bearerHeader}</code>
            <CopyButton text={bearerHeader} label="Copy Authorization header" compact />
          </div>
        </div>
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
            MCP client config JSON
          </summary>
          <div className="mt-2 flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
            <div className="flex justify-end">
              <CopyButton text={configJson} label="Copy MCP client config" compact />
            </div>
            <pre className="m-0 overflow-x-auto font-mono text-xs">{configJson}</pre>
          </div>
        </details>
      </div>
    </section>
  );
}
