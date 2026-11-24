import type {
  Agent,
  KnowledgeMeaningStatus,
  KnowledgeOverview,
  KnowledgeSearchHit,
  KnowledgeTreeNode,
} from "@rei/protocol";
import { cn } from "cn";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/primitives/dialog.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/primitives/empty.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { knowledgeHref, navigate, useMediaQuery } from "../lib/route.ts";
import { ago } from "../lib/time.ts";
import { ConfirmDialog, DialogError } from "./dialogParts.tsx";
import { Icon } from "./Icon.tsx";
import { KnowledgePageView } from "./KnowledgePageView.tsx";
import { Tip } from "./Tip.tsx";

/** "/knowledge/trash" opens the Trash instead of a page. */
export const TRASH_ROUTE = "trash";

/** How many pages the Recent block above the tree lists. */
const RECENT_COUNT = 5;

export interface KnowledgeTree {
  nodes: KnowledgeTreeNode[];
  byId: ReadonlyMap<string, KnowledgeTreeNode>;
  /** Children by parent id ("" for the top level), most recently active first. */
  children: ReadonlyMap<string, KnowledgeTreeNode[]>;
}

function buildTree(nodes: KnowledgeTreeNode[]): KnowledgeTree {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, KnowledgeTreeNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? "";
    children.set(key, [...(children.get(key) ?? []), n]);
  }
  // The Inbox stays first at the top level; everything else keeps the server's order (latest activity first).
  const top = children.get("") ?? [];
  children.set("", [...top.filter((n) => n.inbox), ...top.filter((n) => !n.inbox)]);
  return { nodes, byId, children };
}

/** A page's ancestors, outermost first. */
export function ancestorsOf(tree: KnowledgeTree, id: string): KnowledgeTreeNode[] {
  const out: KnowledgeTreeNode[] = [];
  const seen = new Set<string>();
  let at = tree.byId.get(id)?.parentId ?? null;
  while (at && !seen.has(at)) {
    seen.add(at);
    const node = tree.byId.get(at);
    if (!node) break;
    out.unshift(node);
    at = node.parentId;
  }
  return out;
}

export function KnowledgePage({
  api,
  pageId,
  rev,
  changedPageId,
  agents,
  defaultAgentId,
  onAsk,
  onBack,
}: {
  api: Api;
  pageId: string | null;
  /** Rises whenever the server says some page changed. */
  rev: number;
  changedPageId: string | null;
  agents: Agent[];
  defaultAgentId: string;
  onAsk: (page: { id: string; title: string }, question: string, agentId: string) => Promise<void>;
  /** Phones only: back to the list of chats, where the sidebar is its own screen. Wide screens keep the sidebar beside it. */
  onBack?: (() => void) | undefined;
}) {
  const wide = useMediaQuery("(min-width: 768px)");
  const [nodes, setNodes] = useState<KnowledgeTreeNode[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  const [editNext, setEditNext] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rev is the stream's refresh signal; a change refetches.
  useEffect(() => {
    let cancelled = false;
    api.knowledgeTree().then(
      (r) => {
        if (cancelled) return;
        setNodes(r.pages);
        setError("");
      },
      (e) => !cancelled && setError(describeError(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, rev]);

  const tree = useMemo(() => buildTree(nodes ?? []), [nodes]);
  const view = pageId === TRASH_ROUTE ? "trash" : pageId ? "page" : "overview";

  return (
    <section className="knowledge-page flex h-full min-h-0 min-w-0" aria-label="Knowledge" data-enter="fade">
      {wide && (
        <TreePane
          tree={tree}
          loading={nodes === null}
          currentId={pageId}
          onNew={() => setCreating({ parentId: null })}
          onNewChild={(parentId) => setCreating({ parentId })}
        />
      )}
      <div className="knowledge-main flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="knowledge-header flex flex-wrap items-center gap-2 border-b px-5 py-3 pt-[calc(0.625rem+var(--safe-t))] max-md:px-3.5">
          {!wide && onBack && (
            <Tip label="Back">
              <Button
                size="icon-sm"
                variant="ghost"
                type="button"
                className="size-11"
                aria-label="Back"
                onClick={onBack}
              >
                <Icon name="back" />
              </Button>
            </Tip>
          )}
          <a
            href={knowledgeHref()}
            className="mr-2 shrink-0 text-xl font-semibold tracking-tight text-foreground no-underline"
          >
            Knowledge
          </a>
          <SearchBox key={pageId ?? "overview"} api={api} />
          <Button
            type="button"
            size="sm"
            className="max-sm:size-11"
            onClick={() => setCreating({ parentId: view === "page" ? pageId : null })}
          >
            <Icon name="plus" size={16} />
            <span className="max-sm:sr-only">New page</span>
          </Button>
        </header>
        {error && (
          <p role="alert" className="form-error m-3 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="knowledge-scroll min-h-0 flex-1 overflow-auto">
          {view === "overview" && (
            <Overview api={api} rev={rev} tree={tree} wide={wide} onNew={() => setCreating({ parentId: null })} />
          )}
          {view === "trash" && <TrashView api={api} rev={rev} />}
          {view === "page" && pageId && (
            <KnowledgePageView
              key={pageId}
              api={api}
              pageId={pageId}
              rev={rev}
              changedPageId={changedPageId}
              tree={tree}
              wide={wide}
              agents={agents}
              defaultAgentId={defaultAgentId}
              startEditing={editNext === pageId}
              onEditingStarted={() => setEditNext(null)}
              onAsk={onAsk}
              onNewChild={(parentId) => setCreating({ parentId })}
            />
          )}
        </div>
      </div>
      {creating && (
        <NewPageDialog
          api={api}
          parent={creating.parentId ? (tree.byId.get(creating.parentId) ?? null) : null}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            setEditNext(id);
            navigate(knowledgeHref(id));
          }}
        />
      )}
    </section>
  );
}

// ---- tree ------------------------------------------------------------------------------------------------------------

const ROW =
  "flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-sm text-sidebar-foreground no-underline hover:bg-muted aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium";

function TreePane({
  tree,
  loading,
  currentId,
  onNew,
  onNewChild,
}: {
  tree: KnowledgeTree;
  loading: boolean;
  currentId: string | null;
  onNew: () => void;
  onNewChild: (parentId: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Opening a page shows where it sits: its ancestors unfold.
  useEffect(() => {
    if (!currentId || currentId === TRASH_ROUTE) return;
    const chain = ancestorsOf(tree, currentId);
    if (chain.length === 0 || chain.every((n) => expanded.has(n.id))) return;
    setExpanded((s) => new Set([...s, ...chain.map((n) => n.id)]));
  }, [currentId, tree, expanded]);
  // Newest edits first: a page edited or created just now shows here whatever its place in the tree.
  const recent = useMemo(
    () => [...tree.nodes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_COUNT),
    [tree.nodes],
  );
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const level = (parentId: string, depth: number) =>
    (tree.children.get(parentId) ?? []).map((n) => (
      <li key={n.id}>
        <div className="group/row flex items-center" style={{ paddingLeft: depth * 12 }}>
          {n.childCount > 0 ? (
            <button
              type="button"
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted"
              aria-label={expanded.has(n.id) ? `Collapse ${n.title}` : `Expand ${n.title}`}
              aria-expanded={expanded.has(n.id)}
              onClick={() => toggle(n.id)}
            >
              <Icon name={expanded.has(n.id) ? "chevron" : "forward"} size={14} />
            </button>
          ) : (
            <span className="size-6 shrink-0" />
          )}
          <a href={knowledgeHref(n.id)} className={ROW} aria-current={currentId === n.id ? "page" : undefined}>
            <span className="min-w-0 flex-1 truncate">{n.title}</span>
            {n.pinned && <Icon name="pin" size={12} className="shrink-0 text-muted-foreground" />}
            {n.locked && <Icon name="lock" size={12} className="shrink-0 text-muted-foreground" />}
          </a>
          <Tip label="Add subpage">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Add subpage under ${n.title}`}
              className="ml-0.5 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
              onClick={() => onNewChild(n.id)}
            >
              <Icon name="plus" size={14} />
            </Button>
          </Tip>
        </div>
        {expanded.has(n.id) && n.childCount > 0 && <ul className="m-0 list-none p-0">{level(n.id, depth + 1)}</ul>}
      </li>
    ));

  return (
    <nav
      className="knowledge-tree flex w-64 shrink-0 flex-col gap-1 overflow-auto border-r bg-sidebar/40 p-2 pt-[calc(0.5rem+var(--safe-t))]"
      aria-label="Pages"
    >
      <a href={knowledgeHref()} className={ROW} aria-current={currentId === null ? "page" : undefined}>
        <Icon name="usage" size={16} className="text-muted-foreground" />
        Overview
      </a>
      {recent.length > 0 && (
        <section aria-label="Recent pages" className="mt-2 flex flex-col gap-0.5">
          <h2 className="m-0 px-2 text-xs font-medium text-muted-foreground">Recent</h2>
          <ul className="m-0 list-none p-0">
            {recent.map((n) => (
              <li key={n.id}>
                <a href={knowledgeHref(n.id)} className={ROW} aria-current={currentId === n.id ? "page" : undefined}>
                  <span className="min-w-0 flex-1 truncate">{n.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{ago(n.updatedAt)}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="mt-2 flex items-center justify-between px-2 text-xs font-medium text-muted-foreground">
        <span>Pages</span>
        <Tip label="New top-level page">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="New top-level page" onClick={onNew}>
            <Icon name="plus" size={14} />
          </Button>
        </Tip>
      </div>
      {loading ? (
        <p className="px-2 text-sm text-muted-foreground">Loading pages…</p>
      ) : (
        <ul className="m-0 list-none p-0">{level("", 0)}</ul>
      )}
      <a
        href={knowledgeHref(TRASH_ROUTE)}
        className={cn(ROW, "mt-auto")}
        aria-current={currentId === TRASH_ROUTE ? "page" : undefined}
      >
        <Icon name="trash" size={16} className="text-muted-foreground" />
        Trash
      </a>
    </nav>
  );
}

// ---- search ----------------------------------------------------------------------------------------------------------

function SearchBox({ api }: { api: Api }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<KnowledgeSearchHit[] | null>(null);
  const [open, setOpen] = useState(false);
  const listId = useId();
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.searchKnowledge(query).then(
        (r) => !cancelled && setHits(r.hits),
        () => !cancelled && setHits([]),
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, q]);
  const go = (id: string) => {
    setOpen(false);
    setQ("");
    navigate(knowledgeHref(id));
  };
  return (
    <div className="knowledge-search relative flex min-w-32 flex-1 flex-wrap items-center gap-1.5">
      <Input
        type="search"
        aria-label="Search Knowledge"
        placeholder="Search pages"
        value={q}
        aria-controls={listId}
        aria-expanded={open && hits !== null}
        role="combobox"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setQ("");
          }
          if (e.key === "Enter" && hits?.[0]) go(hits[0].pageId);
        }}
        className="h-8 max-w-md flex-1 max-sm:h-11"
      />
      {open && hits !== null && (
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 top-full z-30 mt-1 max-h-[60vh] w-[min(32rem,calc(100vw-2rem))] overflow-auto rounded-2xl border bg-popover p-1 shadow-lg max-md:fixed max-md:inset-x-4 max-md:top-[calc(3.5rem+var(--safe-t))] max-md:w-auto"
        >
          {hits.length === 0 ? (
            <p className="m-0 px-3 py-2.5 text-sm text-muted-foreground">No pages match.</p>
          ) : (
            hits.map((h) => (
              <button
                key={`${h.pageId}:${h.section}`}
                type="button"
                role="option"
                aria-selected={false}
                className="block w-full rounded-xl px-3 py-2 text-left hover:bg-accent"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(h.pageId)}
              >
                <span className="flex items-baseline gap-2">
                  <strong className="block min-w-0 truncate text-sm font-medium">{h.title}</strong>
                  {h.matched.includes("meaning") && !h.matched.includes("keyword") && (
                    <span
                      className="shrink-0 text-[11px] text-muted-foreground"
                      title="Shares no words with your search: found by similar meaning."
                    >
                      similar meaning
                    </span>
                  )}
                </span>
                <small className="block truncate text-xs text-muted-foreground">
                  {h.path}
                  {h.section ? ` › ${h.section}` : ""}
                </small>
                {h.snippet && <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{h.snippet}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---- overview --------------------------------------------------------------------------------------------------------

function PageList({
  pages,
  empty,
  showPath = false,
}: {
  pages: KnowledgeTreeNode[];
  empty?: string;
  showPath?: boolean;
}) {
  if (pages.length === 0) return empty ? <p className="m-0 text-sm text-muted-foreground">{empty}</p> : null;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {pages.map((p) => (
        <li key={p.id}>
          <a
            href={knowledgeHref(p.id)}
            className="-mx-2 flex min-w-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-foreground no-underline hover:bg-muted"
          >
            <Icon name={p.inbox ? "upload" : "page"} size={16} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{p.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {showPath && p.path ? `${p.path} · ` : ""}
                {p.updatedBy.name} · {ago(p.updatedAt)}
                {p.childCount > 0 ? ` · ${p.childCount} subpage${p.childCount === 1 ? "" : "s"}` : ""}
              </span>
            </span>
            {p.pinned && <Icon name="pin" size={14} className="shrink-0 text-muted-foreground" />}
            {p.locked && <Icon name="lock" size={14} className="shrink-0 text-muted-foreground" />}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="knowledge-card flex min-w-0 flex-col gap-2.5 rounded-2xl border bg-card p-4" aria-label={title}>
      <header className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function Overview({
  api,
  rev,
  tree,
  wide,
  onNew,
}: {
  api: Api;
  rev: number;
  tree: KnowledgeTree;
  wide: boolean;
  onNew: () => void;
}) {
  const [data, setData] = useState<KnowledgeOverview | null>(null);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev is the stream's refresh signal; a change refetches.
  useEffect(() => {
    let cancelled = false;
    api.knowledgeOverview().then(
      (r) => {
        if (!cancelled) {
          setData(r);
          setError("");
        }
      },
      (e) => !cancelled && setError(describeError(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, rev]);
  if (error)
    return (
      <p role="alert" className="m-5 text-sm text-destructive">
        {error}
      </p>
    );
  if (!data)
    return (
      <p role="status" className="m-5 text-sm text-muted-foreground">
        Loading Knowledge…
      </p>
    );
  const top = tree.children.get("") ?? [];
  const onlyInbox = data.pageCount <= 1;
  const weekTotal = data.week.reduce((n, w) => n + w.created + w.edited, 0);
  return (
    <div className="knowledge-overview mx-auto flex max-w-5xl flex-col gap-5 p-6 max-md:p-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm text-muted-foreground">
        <span>
          <strong className="text-2xl font-semibold tabular-nums text-foreground">{data.pageCount}</strong>{" "}
          {data.pageCount === 1 ? "page" : "pages"}
        </span>
        <span>
          <strong className="text-2xl font-semibold tabular-nums text-foreground">{weekTotal}</strong>{" "}
          {weekTotal === 1 ? "change" : "changes"} this week
        </span>
        <span className="ml-auto text-xs" title={data.meaning.lastError ?? undefined}>
          {meaningText(data.meaning)}
        </span>
      </div>
      {onlyInbox && (
        <Empty className="rounded-2xl border border-dashed">
          <EmptyHeader>
            <EmptyTitle>Nothing here yet</EmptyTitle>
            <EmptyDescription>
              Agents write pages here when they learn something worth keeping: plans, how-tos, decisions. You can write
              pages too.
            </EmptyDescription>
          </EmptyHeader>
          <Button type="button" onClick={onNew}>
            <Icon name="plus" size={16} />
            New page
          </Button>
        </Empty>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {data.pinned.length > 0 && (
          <Card title="Pinned">
            <PageList pages={data.pinned} showPath />
          </Card>
        )}
        <Card title="Recently updated">
          <PageList pages={data.recent} showPath empty="No pages yet." />
        </Card>
        <Card title="This week">
          {data.week.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">No pages were written this week.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-1 font-medium">Who</th>
                  <th className="pb-1 text-right font-medium">Created</th>
                  <th className="pb-1 text-right font-medium">Edited</th>
                </tr>
              </thead>
              <tbody>
                {data.week.map((w) => (
                  <tr key={`${w.actor.kind}:${w.actor.id ?? ""}`} className="border-t">
                    <td className="py-1.5">{w.actor.name}</td>
                    <td className="py-1.5 text-right tabular-nums">{w.created}</td>
                    <td className="py-1.5 text-right tabular-nums">{w.edited}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      {/* On a phone the tree pane is hidden: this list is where drilling down starts. */}
      {!wide && top.length > 0 && (
        <Card title="All pages">
          <PageList pages={top} />
          <a className="text-sm" href={knowledgeHref(TRASH_ROUTE)}>
            Trash
          </a>
        </Card>
      )}
    </div>
  );
}

/** How search finds pages right now, in the Memory settings' words. */
export function meaningText(m: KnowledgeMeaningStatus): string {
  switch (m.state) {
    case "off":
      return "Keyword search only";
    case "down":
      return "Embedder down — keyword search only";
    case "indexing":
      return `Meaning search: ${m.embedded} of ${m.sections} sections ready`;
    case "ready":
      return "Keyword and meaning search";
  }
}

// ---- trash -----------------------------------------------------------------------------------------------------------

function TrashView({ api, rev }: { api: Api; rev: number }) {
  const [pages, setPages] = useState<KnowledgeTreeNode[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [purging, setPurging] = useState<KnowledgeTreeNode | null>(null);
  const [local, setLocal] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev is the stream's refresh signal; a change refetches.
  useEffect(() => {
    let cancelled = false;
    void local;
    api.knowledgeTrash().then(
      (r) => !cancelled && setPages(r.pages),
      (e) => !cancelled && setError(describeError(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, rev, local]);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      setLocal((n) => n + 1);
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="knowledge-trash mx-auto flex max-w-3xl flex-col gap-4 p-5 max-md:p-3.5">
      <header>
        <h1 className="m-0 text-xl font-semibold">Trash</h1>
        <p className="m-0 mt-1 text-sm text-muted-foreground">
          Pages stay here for 30 days, then are deleted. A page moved to Trash takes its subpages with it.
        </p>
      </header>
      {error && (
        <p role="alert" className="m-0 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          {error}
        </p>
      )}
      {pages === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : pages.length === 0 ? (
        <p className="text-sm text-muted-foreground">Trash is empty.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y rounded-2xl border p-0">
          {pages.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{p.title}</span>
                <span className="block text-xs text-muted-foreground">
                  Moved to Trash {p.trashedAt ? ago(p.trashedAt) : ""}
                  {p.childCount > 0 ? ` · with ${p.childCount} subpage${p.childCount === 1 ? "" : "s"}` : ""}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const d = await api.restoreKnowledgePage(p.id);
                    navigate(knowledgeHref(d.page.id));
                  })
                }
              >
                Restore
              </Button>
              <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => setPurging(p)}>
                Delete permanently
              </Button>
            </li>
          ))}
        </ul>
      )}
      {purging && (
        <ConfirmDialog
          title={`Delete “${purging.title}” permanently?`}
          description={
            <p>
              The page{purging.childCount > 0 ? ", its subpages," : ""} and all its history will be deleted. This can't
              be undone.
            </p>
          }
          busy={busy}
          confirmLabel="Delete permanently"
          busyLabel="Deleting…"
          onCancel={() => setPurging(null)}
          onConfirm={() =>
            void act(() => api.purgeKnowledgePage(purging.id)).then((ok) => {
              if (ok) setPurging(null);
            })
          }
        />
      )}
    </div>
  );
}

// ---- new page --------------------------------------------------------------------------------------------------------

function NewPageDialog({
  api,
  parent,
  onClose,
  onCreated,
}: {
  api: Api;
  parent: KnowledgeTreeNode | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [topLevel, setTopLevel] = useState(!parent);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  async function save() {
    setBusy(true);
    setError("");
    try {
      const d = await api.createKnowledgePage({
        parentId: topLevel ? null : (parent?.id ?? null),
        title: title.trim(),
      });
      onCreated(d.page.id);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          input.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>New page</DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim() && !busy) void save();
          }}
        >
          <Field className="gap-2">
            <Label htmlFor={titleId}>Title</Label>
            <Input
              ref={input}
              id={titleId}
              value={title}
              maxLength={200}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          {parent && (
            <label className="flex min-w-0 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={!topLevel}
                onChange={(e) => setTopLevel(!e.target.checked)}
              />
              <span className="shrink-0">Inside</span>
              <Badge variant="secondary" className="min-w-0 max-w-full justify-start" title={parent.title}>
                <span className="truncate">{parent.title}</span>
              </Badge>
            </label>
          )}
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
