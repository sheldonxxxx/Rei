import type { KnowledgeMcpAllowedPage, KnowledgeMcpToken, KnowledgeTreeNode } from "@rei/protocol";
import { cn } from "cn";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Checkbox } from "@/components/primitives/checkbox.tsx";
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
  children: ReadonlyMap<string, KnowledgeTreeNode[]>;
  pathOf: (id: string) => string;
  ancestorIds: (id: string) => string[];
  descendantIds: (id: string) => string[];
}

function indexTree(nodes: KnowledgeTreeNode[]): TreeIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, KnowledgeTreeNode[]>();
  for (const n of nodes) {
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : "";
    children.set(key, [...(children.get(key) ?? []), n]);
  }
  const top = children.get("") ?? [];
  children.set("", [...top.filter((n) => n.inbox), ...top.filter((n) => !n.inbox)]);

  const ancestorIds = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([id]);
    let at = byId.get(id)?.parentId ?? null;
    while (at && !seen.has(at) && byId.has(at)) {
      seen.add(at);
      out.unshift(at);
      at = byId.get(at)?.parentId ?? null;
    }
    return out;
  };

  const descendantIds = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([id]);
    const stack = [...(children.get(id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next || seen.has(next.id)) continue;
      seen.add(next.id);
      out.push(next.id);
      const kids = children.get(next.id);
      if (kids) stack.push(...kids);
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

  return { nodes, byId, children, pathOf, ancestorIds, descendantIds };
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

  const tree = useMemo(() => indexTree(treeNodes ?? []), [treeNodes]);
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

        <AllowedFolderTree
          tree={tree}
          loading={treeNodes === null}
          treeError={treeError}
          selectedIds={selectedIds}
          existingById={existingById}
          busy={busy}
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

function AllowedFolderTree({
  tree,
  loading,
  treeError,
  selectedIds,
  existingById,
  busy,
  onChange,
}: {
  tree: TreeIndex;
  loading: boolean;
  treeError: string;
  selectedIds: string[];
  existingById: ReadonlyMap<string, KnowledgeMcpAllowedPage>;
  busy: boolean;
  onChange: (next: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const initializedRef = useRef(false);
  const searchId = useId();
  const baseId = useId();

  useEffect(() => {
    if (loading || initializedRef.current) return;
    initializedRef.current = true;
    const next = new Set<string>();
    for (const id of selectedIds) {
      for (const anc of tree.ancestorIds(id)) next.add(anc);
    }
    if (tree.nodes.length <= 50) {
      for (const n of tree.children.get("") ?? []) {
        if ((tree.children.get(n.id)?.length ?? 0) > 0) next.add(n.id);
      }
    }
    if (next.size > 0) setExpanded(next);
  }, [loading, selectedIds, tree]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const expandableIds = useMemo(
    () => tree.nodes.filter((n) => (tree.children.get(n.id)?.length ?? 0) > 0).map((n) => n.id),
    [tree],
  );
  const allExpanded = expandableIds.length > 0 && expandableIds.every((id) => expanded.has(id));

  const query = search.trim().toLowerCase();
  const filterState = useMemo(() => {
    if (!query) return null;
    const matchedIds = new Set<string>();
    const visibleIds = new Set<string>();
    const forcedOpenIds = new Set<string>();
    for (const n of tree.nodes) {
      const path = tree.pathOf(n.id);
      if (n.title.toLowerCase().includes(query) || path.toLowerCase().includes(query)) {
        matchedIds.add(n.id);
        visibleIds.add(n.id);
        for (const anc of tree.ancestorIds(n.id)) {
          visibleIds.add(anc);
          forcedOpenIds.add(anc);
        }
      }
    }
    return { matchedIds, visibleIds, forcedOpenIds };
  }, [query, tree]);

  const selectedDescendantsMap = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of selectedIds) {
      for (const anc of tree.ancestorIds(id)) {
        counts.set(anc, (counts.get(anc) ?? 0) + 1);
      }
    }
    return counts;
  }, [selectedIds, tree]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpandAll() {
    if (allExpanded) setExpanded(new Set());
    else setExpanded(new Set(expandableIds));
  }

  function toggleSelect(id: string, checked: boolean) {
    if (checked) {
      const descendants = new Set(tree.descendantIds(id));
      const filtered = selectedIds.filter((x) => x !== id && !descendants.has(x));
      onChange([...filtered, id]);
    } else {
      onChange(selectedIds.filter((x) => x !== id));
    }
  }

  function renderBranch(parentId: string, pathSeen: Set<string>): React.ReactNode {
    const allKids = tree.children.get(parentId) ?? [];
    const kids = filterState ? allKids.filter((n) => filterState.visibleIds.has(n.id)) : allKids;
    if (kids.length === 0) return null;

    return kids.map((node) => {
      if (pathSeen.has(node.id)) return null;
      const nextSeen = new Set(pathSeen);
      nextSeen.add(node.id);

      const allNodeKids = tree.children.get(node.id) ?? [];
      const visibleNodeKids = filterState ? allNodeKids.filter((k) => filterState.visibleIds.has(k.id)) : allNodeKids;
      const hasChildren = visibleNodeKids.length > 0;
      const isExpanded = filterState ? filterState.forcedOpenIds.has(node.id) : expanded.has(node.id);

      const isDirectlySelected = selectedSet.has(node.id);
      const isInherited = tree.ancestorIds(node.id).some((ancId) => selectedSet.has(ancId));
      const selectedDescendantCount = selectedDescendantsMap.get(node.id) ?? 0;
      const isDimmedContext =
        Boolean(filterState) && !filterState?.matchedIds.has(node.id) && !isDirectlySelected && !isInherited;

      const checkId = `${baseId}-chk-${node.id}`;
      const statusId = `${baseId}-st-${node.id}`;
      const folderIcon = node.inbox ? "upload" : hasChildren ? (isExpanded ? "folderOpen" : "folder") : "page";

      return (
        <li key={node.id} className="min-w-0">
          <div
            className={cn(
              "group/row flex min-h-8 items-center gap-1 rounded-lg pl-1 pr-2 transition-colors",
              isDirectlySelected
                ? "bg-accent/70 ring-1 ring-inset ring-primary/25"
                : isInherited
                  ? "bg-accent/30"
                  : "hover:bg-muted/80",
            )}
          >
            {hasChildren ? (
              <button
                type="button"
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={isExpanded ? `Collapse ${node.title}` : `Expand ${node.title}`}
                aria-expanded={isExpanded}
                onClick={() => toggleExpand(node.id)}
              >
                <Icon name={isExpanded ? "chevron" : "forward"} size={14} />
              </button>
            ) : (
              <span className="size-6 shrink-0" aria-hidden="true" />
            )}

            <label htmlFor={checkId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 select-none">
              <Checkbox
                id={checkId}
                checked={isDirectlySelected || isInherited}
                disabled={busy || (isInherited && !isDirectlySelected)}
                aria-describedby={isInherited ? statusId : undefined}
                onCheckedChange={(v) => toggleSelect(node.id, v === true)}
              />
              <Icon
                name={folderIcon}
                size={15}
                className={cn("shrink-0", isDirectlySelected || isInherited ? "text-primary" : "text-muted-foreground")}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  isDirectlySelected && "font-medium text-foreground",
                  isDimmedContext && "text-muted-foreground",
                )}
              >
                {node.title}
              </span>
            </label>

            {node.locked && <Icon name="lock" size={12} className="shrink-0 text-muted-foreground" />}
            {isInherited && !isDirectlySelected ? (
              <span id={statusId} className="shrink-0 text-[11px] text-muted-foreground">
                Included
              </span>
            ) : isInherited && isDirectlySelected ? (
              <span id={statusId} className="shrink-0 text-[11px] text-muted-foreground">
                Covered
              </span>
            ) : !isDirectlySelected && selectedDescendantCount > 0 ? (
              <span className="shrink-0 text-[11px] font-medium tabular-nums text-primary">
                {selectedDescendantCount} selected
              </span>
            ) : hasChildren ? (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{node.childCount}</span>
            ) : null}
          </div>

          {hasChildren && isExpanded && (
            <ul className="m-0 ml-4 list-none border-l border-border/80 p-0 pl-2">{renderBranch(node.id, nextSeen)}</ul>
          )}
        </li>
      );
    });
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Allowed folders</span>
          <span className="text-xs text-muted-foreground">Granting a folder includes all of its subpages.</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {selectedIds.length === 0 ? "None selected" : `${selectedIds.length} selected`}
          </span>
          {selectedIds.length > 0 && (
            <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => onChange([])}>
              Clear all
            </Button>
          )}
        </div>
      </div>

      {selectedIds.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Selected allowed folders">
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
                className="inline-flex max-w-full items-center gap-1.5 rounded-3xl border bg-card py-1 pl-2.5 pr-1.5 text-xs"
              >
                <Icon name="folder" size={12} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium">{label}</span>
                {status === "trashed" && <Badge variant="attention">In Trash</Badge>}
                {status === "missing" && <Badge variant="destructive">Missing</Badge>}
                {coveringAncestor && (
                  <span className="shrink-0 text-muted-foreground">
                    · Covered by {tree.byId.get(coveringAncestor)?.title ?? coveringAncestor}
                  </span>
                )}
                <Tip label="Remove folder">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label={`Remove ${label}`}
                    onClick={() => onChange(selectedIds.filter((x) => x !== id))}
                  >
                    <Icon name="close" size={12} />
                  </Button>
                </Tip>
              </li>
            );
          })}
        </ul>
      )}

      <div className="overflow-hidden rounded-2xl border bg-sidebar/35">
        <div className="flex items-center gap-2 border-b bg-card/60 px-3 py-2">
          <Icon name="search" size={14} className="shrink-0 text-muted-foreground" />
          <Label htmlFor={searchId} className="sr-only">
            Search Knowledge pages
          </Label>
          <Input
            id={searchId}
            value={search}
            disabled={busy}
            className="h-8 flex-1"
            placeholder="Filter folders…"
            aria-label="Search Knowledge pages"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <Tip label="Clear filter">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                aria-label="Clear folder filter"
                onClick={() => setSearch("")}
              >
                <Icon name="close" size={14} />
              </Button>
            </Tip>
          )}
          {!query && expandableIds.length > 0 && (
            <Tip label={allExpanded ? "Collapse all" : "Expand all"}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                aria-label={allExpanded ? "Collapse all folders" : "Expand all folders"}
                onClick={toggleExpandAll}
              >
                <Icon name={allExpanded ? "collapse" : "expand"} size={14} />
              </Button>
            </Tip>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto p-2">
          {treeError ? (
            <p role="alert" className="m-0 px-2 py-2 text-xs text-destructive">
              {treeError}
            </p>
          ) : loading ? (
            <p className="m-0 px-2 py-2 text-xs text-muted-foreground">Loading Knowledge pages…</p>
          ) : tree.nodes.length === 0 ? (
            <p className="m-0 px-2 py-2 text-xs text-muted-foreground">No Knowledge pages exist yet.</p>
          ) : filterState && filterState.visibleIds.size === 0 ? (
            <p className="m-0 px-2 py-2 text-xs text-muted-foreground">No matching folders.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="Knowledge folders">
              {renderBranch("", new Set())}
            </ul>
          )}
        </div>

        {selectedIds.length === 0 && (
          <p className="m-0 border-t bg-card/40 px-3 py-2 text-xs text-muted-foreground">
            No allowed folders selected — this token cannot access any Knowledge pages.
          </p>
        )}
      </div>
    </div>
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
