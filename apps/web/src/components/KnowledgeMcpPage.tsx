import type { KnowledgeMcpAllowedPage, KnowledgeMcpToken, KnowledgeTreeNode } from "@rei/protocol";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/primitives/empty.tsx";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { ago } from "../lib/time.ts";
import { CopyButton } from "./CopyButton.tsx";
import { ConfirmDialog, DialogError, DialogWarning } from "./dialogParts.tsx";
import { Icon } from "./Icon.tsx";
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

interface TreeIndex {
  nodes: KnowledgeTreeNode[];
  byId: ReadonlyMap<string, KnowledgeTreeNode>;
  pathOf: (id: string) => string;
  ancestorIds: (id: string) => string[];
}

function indexTree(nodes: KnowledgeTreeNode[]): TreeIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ancestorIds = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let at = byId.get(id)?.parentId ?? null;
    while (at && !seen.has(at)) {
      seen.add(at);
      out.unshift(at);
      at = byId.get(at)?.parentId ?? null;
    }
    return out;
  };
  const pathOf = (id: string): string => {
    const node = byId.get(id);
    if (!node) return id;
    const chain = ancestorIds(id).map((a) => byId.get(a)?.title ?? a);
    chain.push(node.title);
    return chain.join(" › ");
  };
  return { nodes, byId, pathOf, ancestorIds };
}

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

  return (
    <PageShell
      title="MCP"
      actions={
        <Button type="button" size="sm" onClick={() => setEditing({ mode: "create" })}>
          <Icon name="plus" size={16} />
          New token
        </Button>
      }
    >
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
              onEdit={() => setEditing({ mode: "edit", token })}
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

      {editing && (
        <TokenDialog
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
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.kind === "rotate" ? `Rotate secret for “${confirm.token.name}”?` : `Revoke “${confirm.token.name}”?`
          }
          description={
            confirm.kind === "rotate" ? (
              <p>
                This immediately invalidates the current secret and issues a new one. Any external client using the old
                secret will stop working until updated.
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

      {revealed && (
        <SecretRevealDialog
          name={revealed.name}
          secret={revealed.secret}
          rotated={revealed.rotated}
          endpointUrl={endpointUrl}
          onClose={() => setRevealed(null)}
        />
      )}
    </PageShell>
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

function TokenDialog({
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
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const nameId = useId();
  const readId = useId();
  const writeId = useId();
  const deleteId = useId();
  const searchId = useId();

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

  const tree = useMemo(() => indexTree(treeNodes ?? []), [treeNodes]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const existingById = useMemo(
    () => new Map((initial?.allowedPages ?? []).map((p): [string, KnowledgeMcpAllowedPage] => [p.pageId, p])),
    [initial],
  );

  const availableNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tree.nodes
      .filter((n) => !selectedSet.has(n.id))
      .map((n) => ({ node: n, path: tree.pathOf(n.id) }))
      .filter(({ node, path }) => !q || node.title.toLowerCase().includes(q) || path.toLowerCase().includes(q));
  }, [tree, selectedSet, search]);

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
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit MCP token" : "New MCP token"}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
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
            <div className="flex flex-col divide-y rounded-2xl border px-3.5">
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

          <div className="flex flex-col gap-2.5">
            <span className="text-sm font-medium">Allowed folders (pages)</span>
            {selectedIds.length === 0 ? (
              <p className="m-0 rounded-xl border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                No allowed folders added — this token cannot access any Knowledge pages.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Selected allowed folders">
                {selectedIds.map((id) => {
                  const live = tree.byId.get(id);
                  const existing = existingById.get(id);
                  const label = live ? tree.pathOf(id) : (existing?.path ?? existing?.title ?? id);
                  const coveringAncestor = live
                    ? tree.ancestorIds(id).find((ancId) => selectedSet.has(ancId) && ancId !== id)
                    : undefined;
                  const status = live ? "live" : (existing?.status ?? "missing");
                  return (
                    <li
                      key={id}
                      className="flex items-center justify-between gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-xs"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <Icon name="folder" size={14} className="shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium">{label}</span>
                        {status === "trashed" && <Badge variant="attention">In Trash</Badge>}
                        {status === "missing" && <Badge variant="destructive">Missing</Badge>}
                        {coveringAncestor && (
                          <span className="text-muted-foreground">
                            · Covered by {tree.byId.get(coveringAncestor)?.title ?? coveringAncestor}
                          </span>
                        )}
                      </div>
                      <Tip label="Remove folder">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={busy}
                          aria-label={`Remove ${label}`}
                          onClick={() => setSelectedIds((prev) => prev.filter((x) => x !== id))}
                        >
                          <Icon name="close" size={14} />
                        </Button>
                      </Tip>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex flex-col gap-2 rounded-2xl border p-3">
              <Label htmlFor={searchId} className="sr-only">
                Search Knowledge pages
              </Label>
              <Input
                id={searchId}
                value={search}
                disabled={busy}
                placeholder="Search Knowledge pages to add…"
                aria-label="Search Knowledge pages"
                onChange={(e) => setSearch(e.target.value)}
              />
              {treeError ? (
                <p role="alert" className="m-0 text-xs text-destructive">
                  {treeError}
                </p>
              ) : treeNodes === null ? (
                <p className="m-0 text-xs text-muted-foreground">Loading Knowledge pages…</p>
              ) : availableNodes.length === 0 ? (
                <p className="m-0 text-xs text-muted-foreground">
                  {tree.nodes.length === 0 ? "No Knowledge pages exist yet." : "No matching Knowledge pages."}
                </p>
              ) : (
                <ul className="m-0 flex max-h-44 list-none flex-col gap-1 overflow-y-auto p-0">
                  {availableNodes.map(({ node, path }) => (
                    <li
                      key={node.id}
                      className="flex items-center justify-between gap-2 rounded-xl px-2 py-1.5 hover:bg-muted"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-xs font-medium text-foreground">{path}</span>
                        {node.childCount > 0 && (
                          <span className="text-[11px] text-muted-foreground">
                            {node.childCount} {node.childCount === 1 ? "subpage" : "subpages"}
                          </span>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={busy}
                        aria-label={`Add ${node.title}`}
                        onClick={() => setSelectedIds((prev) => (prev.includes(node.id) ? prev : [...prev, node.id]))}
                      >
                        Add
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : initial ? "Save changes" : "Create token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretRevealDialog({
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
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rotated ? `New secret for “${name}”` : `Token “${name}” created`}</DialogTitle>
          <DialogDescription>
            Copy this token secret now. For your security, it will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <DialogWarning>Store this secret securely — closing this dialog clears it permanently from view.</DialogWarning>
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
            <pre className="mt-2 overflow-x-auto rounded-xl border bg-muted/40 p-3 font-mono text-xs">
              {snippetJson(endpointUrl, secret)}
            </pre>
          </details>
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
