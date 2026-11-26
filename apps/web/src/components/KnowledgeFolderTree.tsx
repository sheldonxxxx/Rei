import type { KnowledgeMcpAllowedPage, KnowledgeTreeNode } from "@rei/protocol";
import { cn } from "cn";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Checkbox } from "@/components/primitives/checkbox.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

export interface KnowledgeTreeIndex {
  nodes: KnowledgeTreeNode[];
  byId: ReadonlyMap<string, KnowledgeTreeNode>;
  children: ReadonlyMap<string, KnowledgeTreeNode[]>;
  pathOf: (id: string) => string;
  ancestorIds: (id: string) => string[];
  descendantIds: (id: string) => string[];
}

export function indexKnowledgeTree(nodes: KnowledgeTreeNode[]): KnowledgeTreeIndex {
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

export interface KnowledgeFolderTreeProps {
  tree: KnowledgeTreeIndex;
  loading: boolean;
  treeError: string;
  selectedIds: string[];
  existingById?: ReadonlyMap<string, KnowledgeMcpAllowedPage>;
  busy: boolean;
  emptySelectionNote?: string;
  onChange: (next: string[]) => void;
}

/** Hierarchical Knowledge folder picker with subtree inheritance and search filtering. */
export function KnowledgeFolderTree({
  tree,
  loading,
  treeError,
  selectedIds,
  existingById,
  busy,
  emptySelectionNote = "No allowed folders selected — no Knowledge pages can be accessed.",
  onChange,
}: KnowledgeFolderTreeProps) {
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

  function renderBranch(parentId: string, pathSeen: Set<string>): ReactNode {
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
            const existing = existingById?.get(id);
            const label = live ? tree.pathOf(id) : (existing?.path ?? existing?.title ?? id);
            const coveringAncestor = live
              ? tree.ancestorIds(id).find((ancId) => selectedSet.has(ancId) && ancId !== id)
              : undefined;
            const status = live ? "live" : existing ? existing.status : loading ? "loading" : "unavailable";
            return (
              <li
                key={id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-3xl border bg-card py-1 pl-2.5 pr-1.5 text-xs"
              >
                <Icon name="folder" size={12} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium">{label}</span>
                {status === "trashed" && <Badge variant="attention">In Trash</Badge>}
                {status === "missing" && <Badge variant="destructive">Missing</Badge>}
                {status === "unavailable" && <Badge variant="secondary">Unavailable</Badge>}
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
          <p className="m-0 border-t bg-card/40 px-3 py-2 text-xs text-muted-foreground">{emptySelectionNote}</p>
        )}
      </div>
    </div>
  );
}
