import type { Agent, KnowledgePageDetail, KnowledgeRevision, KnowledgeTreeNode } from "@rei/protocol";
import { findSlug } from "@rei/protocol";
import { parseKnowledgeSource, serializeKnowledgeSource } from "@rei/protocol/knowledge-source";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/primitives/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/primitives/dropdown-menu.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import { Toggle } from "@/components/primitives/toggle.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/primitives/toggle-group.tsx";
import type { Api } from "../api/client.ts";
import { ApiError, describeError } from "../api/client.ts";
import { parseMarkdown } from "../lib/markdown.ts";
import { knowledgeHref, navigate, sessionHref, useHash } from "../lib/route.ts";
import { ago, formatWhen } from "../lib/time.ts";
import { ConfirmDialog, DialogError, DialogWarning } from "./dialogParts.tsx";
import { Icon } from "./Icon.tsx";
import type { KnowledgeTree } from "./KnowledgePage.tsx";
import { KnowledgeTags } from "./KnowledgeTags.tsx";
import { Markdown, type MarkdownRefs, sectionElementId } from "./Markdown.tsx";
import { Tip } from "./Tip.tsx";

type Draft = {
  title: string;
  description: string;
  tags: string[];
  body: string;
  base: number;
  sourceMarkdown?: string;
};

export function KnowledgePageView({
  api,
  pageId,
  rev,
  changedPageId,
  tree,
  wide,
  agents,
  defaultAgentId,
  startEditing,
  onEditingStarted,
  onAsk,
  onNewChild,
}: {
  api: Api;
  pageId: string;
  rev: number;
  changedPageId: string | null;
  tree: KnowledgeTree;
  wide: boolean;
  agents: Agent[];
  defaultAgentId: string;
  startEditing: boolean;
  onEditingStarted: () => void;
  onAsk: (page: { id: string; title: string }, question: string, agentId: string) => Promise<void>;
  onNewChild: (parentId: string) => void;
}) {
  const [detail, setDetail] = useState<KnowledgePageDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The page as it is now, when it changed under an open editor. */
  const [newer, setNewer] = useState<KnowledgePageDetail | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "move" }
    | { kind: "trash" }
    | { kind: "ask" }
    | { kind: "history" }
    | { kind: "revision"; revision: KnowledgeRevision }
    | null
  >(null);
  const editing = draft !== null;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const load = useCallback(async () => {
    try {
      const d = await api.getKnowledgePage(pageId);
      setMissing(false);
      setError("");
      const open = draftRef.current;
      if (open && d.page.revision !== open.base) setNewer(d);
      else setDetail(d);
      return d;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(describeError(e));
      return null;
    }
  }, [api, pageId]);

  // First load, and again whenever some page changes (a subpage, a backlink or the title of a linked page may be it).
  const loaded = useRef(false);
  const opening = useRef({ startEditing, onEditingStarted });
  opening.current = { startEditing, onEditingStarted };
  useEffect(() => {
    void rev;
    void changedPageId;
    void load().then((d) => {
      if (d && !loaded.current) {
        loaded.current = true;
        if (opening.current.startEditing) {
          setDraft({
            tags: d.page.metadata.tags,
            title: d.page.title,
            description: d.page.description,
            body: d.body,
            base: d.page.revision,
          });
          opening.current.onEditingStarted();
        }
      }
    });
  }, [load, rev, changedPageId]);

  // A section link (/knowledge/<id>#<slug>) scrolls to its heading once the page is shown; an unknown slug shows the
  // top of the page. Reloads of the same page (another page changed) do not scroll again; following a link again does.
  const { hash, moves } = useHash();
  const scrolled = useRef<string | null>(null);
  const article = useRef<HTMLElement>(null);
  const shownBody = detail && !draft ? detail.body : null;
  useEffect(() => {
    if (shownBody === null || !hash) return;
    const key = `${pageId}${hash}${moves}`;
    if (scrolled.current === key) return;
    scrolled.current = key;
    const slugs = parseMarkdown(shownBody).flatMap((b) => (b.t === "h" && b.slug ? [b.slug] : []));
    const at = findSlug(slugs, hash.slice(1));
    const target = at >= 0 ? document.getElementById(sectionElementId(slugs[at]!)) : article.current;
    target?.scrollIntoView?.({ block: "start" });
  }, [shownBody, hash, moves, pageId]);

  const refs: MarkdownRefs = useMemo(
    () => ({
      pageTitle: (id) => tree.byId.get(id)?.title ?? (tree.nodes.length > 0 ? null : undefined),
      file: (fileId, versionId) => detail?.files.find((f) => f.fileId === fileId && f.versionId === versionId),
      onTask: (index, done) => {
        if (!detail) return;
        // Shown at once; the server's answer (or a reload after a failure) settles it.
        api.patchKnowledgePage(detail.page.id, { task: { index, done } }).then(setDetail, (e) => {
          setError(describeError(e));
          void load();
        });
      },
    }),
    [tree, detail, api, load],
  );

  if (missing)
    return (
      <div className="mx-auto max-w-2xl p-8 text-center text-sm text-muted-foreground">
        <p>This page doesn't exist any more. It may have been moved to Trash.</p>
        <p>
          <a href={knowledgeHref("trash")}>Open Trash</a> · <a href={knowledgeHref()}>Overview</a>
        </p>
      </div>
    );
  if (!detail)
    return error ? (
      <p role="alert" className="m-5 text-sm text-destructive">
        {error}
      </p>
    ) : (
      <p className="m-5 text-sm text-muted-foreground">Loading…</p>
    );

  const { page } = detail;
  const parent = detail.ancestors[detail.ancestors.length - 1];

  return (
    <div className="knowledge-reader flex min-h-full">
      <article
        ref={article}
        className="knowledge-article mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-5 px-8 py-7 max-md:px-4 max-md:py-5"
      >
        <nav
          aria-label="Page location"
          className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground"
        >
          {!wide && (
            <a
              href={knowledgeHref(parent?.id ?? null)}
              className="mr-1 inline-flex items-center gap-0.5 text-muted-foreground"
              aria-label={parent ? `Back to ${parent.title}` : "Back to overview"}
            >
              <Icon name="back" size={14} />
            </a>
          )}
          <a href={knowledgeHref()} className="text-muted-foreground">
            Knowledge
          </a>
          {detail.ancestors.map((a) => (
            <span key={a.id} className="inline-flex min-w-0 items-center gap-1">
              <span aria-hidden="true">›</span>
              <a href={knowledgeHref(a.id)} className="max-w-48 truncate text-muted-foreground">
                {a.title}
              </a>
            </span>
          ))}
        </nav>

        {editing ? (
          <Editor
            api={api}
            page={detail}
            draft={draft}
            newer={newer}
            wide={wide}
            onChange={setDraft}
            onCancel={() => {
              setDraft(null);
              if (newer) setDetail(newer);
              setNewer(null);
            }}
            onSaved={(d) => {
              setDraft(null);
              setNewer(null);
              setDetail(d);
            }}
            onConflict={async () => {
              const d = await api.getKnowledgePage(page.id);
              setNewer(d);
            }}
            onTakeTheirs={() => {
              if (!newer) return;
              setDetail(newer);
              setDraft({
                tags: newer.page.metadata.tags,
                title: newer.page.title,
                description: newer.page.description,
                body: newer.body,
                base: newer.page.revision,
              });
              setNewer(null);
            }}
            onKeepMine={() => {
              if (!newer || !draft) return;
              setDetail(newer);
              setDraft({ ...draft, base: newer.page.revision });
              setNewer(null);
            }}
          />
        ) : (
          <>
            <header className="flex flex-col gap-2">
              <div className="flex flex-wrap items-start gap-2">
                <h1 className="m-0 min-w-0 flex-1 text-3xl max-md:text-2xl font-semibold leading-tight tracking-tight [overflow-wrap:anywhere]">
                  {page.title}
                </h1>
                <PageActions
                  api={api}
                  detail={detail}
                  onEdit={() =>
                    setDraft({
                      tags: page.metadata.tags,
                      title: page.title,
                      description: page.description,
                      body: detail.body,
                      base: page.revision,
                    })
                  }
                  onDetail={setDetail}
                  onError={setError}
                  onDialog={(kind) => setDialog({ kind })}
                  onNewChild={() => onNewChild(page.id)}
                />
              </div>
              {page.description && <p className="m-0 text-base text-muted-foreground">{page.description}</p>}
              {page.metadata.tags.length > 0 && (
                <section aria-label="Page tags" className="flex flex-wrap gap-1.5">
                  {page.metadata.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="max-w-full whitespace-normal [overflow-wrap:anywhere]"
                    >
                      {tag}
                    </Badge>
                  ))}
                </section>
              )}
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Tip label="Page history">
                  <button
                    type="button"
                    className="cursor-pointer rounded-md bg-transparent p-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => setDialog({ kind: "history" })}
                  >
                    Updated by {page.updatedBy.name} · {ago(page.updatedAt)}
                  </button>
                </Tip>
                {page.inbox && <Badge variant="secondary">Inbox</Badge>}
              </div>
            </header>
            {error && (
              <p role="alert" className="m-0 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                {error}
              </p>
            )}
            {detail.body.trim() ? (
              <Markdown text={detail.body} refs={refs} headingShift={1} sectionsOf={page.id} />
            ) : (
              <p className="m-0 text-sm text-muted-foreground">This page is empty.</p>
            )}
            {(detail.children.length > 0 || !page.inbox) && (
              <Subpages pages={detail.children} onAdd={() => onNewChild(page.id)} />
            )}
            <PageLinks detail={detail} />
          </>
        )}
      </article>
      {dialog?.kind === "history" && (
        <HistoryDialog
          detail={detail}
          onClose={() => setDialog(null)}
          onOpenRevision={(revision) => setDialog({ kind: "revision", revision })}
        />
      )}
      {dialog?.kind === "move" && (
        <MoveDialog api={api} detail={detail} tree={tree} onClose={() => setDialog(null)} onMoved={setDetail} />
      )}
      {dialog?.kind === "trash" && (
        <TrashDialog
          api={api}
          detail={detail}
          tree={tree}
          onClose={() => setDialog(null)}
          onTrashed={() => {
            navigate(knowledgeHref(parent?.id ?? null));
          }}
        />
      )}
      {dialog?.kind === "ask" && (
        <AskDialog
          page={{ id: page.id, title: page.title }}
          agents={agents}
          defaultAgentId={defaultAgentId}
          onClose={() => setDialog(null)}
          onAsk={onAsk}
        />
      )}
      {dialog?.kind === "revision" && (
        <RevisionDialog
          api={api}
          detail={detail}
          revision={dialog.revision}
          refs={refs}
          onClose={() => setDialog(null)}
          onRestored={(d) => {
            setDetail(d);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function Subpages({ pages, onAdd }: { pages: KnowledgeTreeNode[]; onAdd: () => void }) {
  return (
    <section className="knowledge-subpages mt-2 flex flex-col gap-1.5 border-t pt-4" aria-label="Subpages">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-sm font-semibold text-muted-foreground">Subpages</h2>
        <Button type="button" variant="ghost" size="xs" onClick={onAdd}>
          <Icon name="plus" size={12} />
          Add subpage
        </Button>
      </div>
      {pages.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">No subpages.</p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0 sm:grid-cols-2">
          {pages.map((c) => (
            <li key={c.id}>
              <a
                href={knowledgeHref(c.id)}
                className="flex min-w-0 items-start gap-2 rounded-xl border px-3 py-2 text-foreground no-underline hover:bg-muted"
              >
                <Icon name="page" size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{c.title}</span>
                  {c.description ? (
                    <span className="line-clamp-2 text-xs text-muted-foreground">{c.description}</span>
                  ) : (
                    <span className="block text-xs text-muted-foreground">{ago(c.updatedAt)}</span>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PageActions({
  api,
  detail,
  onEdit,
  onDetail,
  onError,
  onDialog,
  onNewChild,
}: {
  api: Api;
  detail: KnowledgePageDetail;
  onEdit: () => void;
  onDetail: (d: KnowledgePageDetail) => void;
  onError: (message: string) => void;
  onDialog: (kind: "move" | "trash" | "ask" | "history") => void;
  onNewChild: () => void;
}) {
  const { page } = detail;
  const flag = (patch: { locked?: boolean; pinned?: boolean }) =>
    api.patchKnowledgePage(page.id, patch).then(onDetail, (e) => onError(describeError(e)));
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tip label="Ask about this page">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Ask about this page"
          onClick={() => onDialog("ask")}
        >
          <Icon name="chat" size={16} />
        </Button>
      </Tip>
      <Tip label="Edit">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit" onClick={onEdit}>
          <Icon name="edit" size={16} />
        </Button>
      </Tip>
      <Tip
        label={
          page.pinned ? "Pinned: in the overview and every agent's prompt" : "Pin to the overview and agent prompts"
        }
      >
        <Toggle
          size="sm"
          className="size-8 min-w-8 px-0"
          aria-label="Pin"
          pressed={page.pinned}
          onPressedChange={(pinned) => void flag({ pinned })}
        >
          <Icon name="pin" size={16} />
        </Toggle>
      </Tip>
      <Tip
        label={
          page.locked ? "Locked: agents can only add to the end" : "Lock for agents (they can only add to the end)"
        }
      >
        <Toggle
          size="sm"
          className="size-8 min-w-8 px-0"
          aria-label="Lock for agents"
          pressed={page.locked}
          onPressedChange={(locked) => void flag({ locked })}
        >
          <Icon name="lock" size={16} />
        </Toggle>
      </Tip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="More page actions">
            <Icon name="more" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onNewChild}>
            <Icon name="plus" size={16} /> Add subpage
          </DropdownMenuItem>
          {!page.inbox && (
            <DropdownMenuItem onSelect={() => onDialog("move")}>
              <Icon name="forward" size={16} /> Move to…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => onDialog("history")}>
            <Icon name="history" size={16} /> History
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={api.knowledgeMarkdownUrl(page.id)} download>
              <Icon name="down" size={16} /> Download .md
            </a>
          </DropdownMenuItem>
          {!page.inbox && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onDialog("trash")}>
                <Icon name="trash" size={16} /> Move to Trash
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ---- links, files and history ----------------------------------------------------------------------------------------

/** What points at this page and the Library files it uses; nothing is shown when there are none. */
function PageLinks({ detail }: { detail: KnowledgePageDetail }) {
  if (detail.backlinks.length === 0 && detail.files.length === 0) return null;
  return (
    <div className="flex flex-col gap-4 border-t pt-4 text-sm">
      {detail.backlinks.length > 0 && (
        <section className="flex flex-col gap-1" aria-label="Linked from">
          <h2 className="m-0 text-xs font-medium text-muted-foreground">Linked from</h2>
          {detail.backlinks.map((b) => (
            <a key={b.id} href={knowledgeHref(b.id)} className="truncate" title={b.path}>
              {b.title}
            </a>
          ))}
        </section>
      )}
      {detail.files.length > 0 && (
        <section className="flex flex-col gap-1" aria-label="Files">
          <h2 className="m-0 text-xs font-medium text-muted-foreground">Library files</h2>
          {detail.files.map((f) =>
            f.available ? (
              <a
                key={`${f.fileId}@${f.versionId ?? ""}`}
                href={`/library/${encodeURIComponent(f.fileId)}`}
                className="flex min-w-0 items-center gap-1.5"
              >
                <Icon name="file" size={14} className="shrink-0" />
                <span className="truncate">{f.name ?? f.fileId}</span>
                {f.versionId && <span className="shrink-0 text-xs text-muted-foreground">pinned version</span>}
              </a>
            ) : (
              <span
                key={`${f.fileId}@${f.versionId ?? ""}`}
                className="flex items-center gap-1.5 text-muted-foreground"
              >
                <Icon name="file" size={14} />
                <span className="truncate line-through">{f.name ?? f.fileId}</span>
                <span className="text-xs">File removed</span>
              </span>
            ),
          )}
        </section>
      )}
    </div>
  );
}

function HistoryDialog({
  detail,
  onClose,
  onOpenRevision,
}: {
  detail: KnowledgePageDetail;
  onClose: () => void;
  onOpenRevision: (r: KnowledgeRevision) => void;
}) {
  const { page } = detail;
  const [showAll, setShowAll] = useState(false);
  const history = showAll ? detail.revisions : detail.revisions.slice(0, 8);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <p className="m-0 text-xs text-muted-foreground">
            Created by {page.createdBy.name}, {formatWhen(page.createdAt)}
          </p>
        </DialogHeader>
        <ol className="m-0 flex min-h-0 list-none flex-col overflow-auto p-0 text-sm">
          {history.map((r, i) => (
            <li key={r.revision}>
              <button
                type="button"
                className="-mx-2 flex w-[calc(100%+1rem)] flex-col rounded-lg px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => onOpenRevision(r)}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{r.actor.name}</span>
                  {i === 0 && <Badge variant="secondary">Current</Badge>}
                  {r.external && (
                    <Tip label="Written by a chat that had read outside content">
                      <Icon name="globe" size={12} className="text-attention-text" />
                    </Tip>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {ago(r.updatedAt)}
                  {r.note ? ` · ${r.note}` : ""}
                  {r.sessionTitle ? ` · in “${r.sessionTitle}”` : ""}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {detail.revisions.length > history.length && (
          <Button type="button" variant="ghost" size="xs" className="self-start" onClick={() => setShowAll(true)}>
            Show all {detail.revisions.length}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- editor ----------------------------------------------------------------------------------------------------------

function Editor({
  api,
  page,
  draft,
  newer,
  wide,
  onChange,
  onCancel,
  onSaved,
  onConflict,
  onTakeTheirs,
  onKeepMine,
}: {
  api: Api;
  page: KnowledgePageDetail;
  draft: Draft;
  newer: KnowledgePageDetail | null;
  wide: boolean;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSaved: (d: KnowledgePageDetail) => void;
  onConflict: () => Promise<void>;
  onTakeTheirs: () => void;
  onKeepMine: () => void;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void api.knowledgeTags().then(
      (r) => {
        if (live) setSuggestions(r.tags);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api]);
  const [mode, setMode] = useState<"write" | "preview" | "split">("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleId = useId();
  const descId = useId();
  const bodyId = useId();
  const dirty =
    draft.title !== page.page.title ||
    draft.description !== page.page.description ||
    draft.body !== page.body ||
    JSON.stringify(draft.tags) !== JSON.stringify(page.page.metadata.tags) ||
    draft.sourceMarkdown !== undefined;
  async function save() {
    setBusy(true);
    setError("");
    try {
      const d = await api.saveKnowledgePage(
        page.page.id,
        draft.base,
        draft.sourceMarkdown !== undefined
          ? { sourceMarkdown: draft.sourceMarkdown }
          : {
              metadata: { tags: draft.tags },
              title: draft.title,
              description: draft.description,
              body: draft.body,
            },
      );
      onSaved(d);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await onConflict().catch(() => {});
      else setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  const preview = (
    <section className="min-h-64 min-w-0 flex-1 overflow-auto rounded-2xl border px-4 py-3" aria-label="Preview">
      {draft.body.trim() ? (
        <Markdown text={draft.body} headingShift={1} />
      ) : (
        <p className="m-0 text-sm text-muted-foreground">Nothing to preview.</p>
      )}
    </section>
  );
  const source = (
    <Textarea
      id={bodyId}
      aria-label="Page text (Markdown)"
      className="min-h-[24rem] min-w-0 flex-1 resize-y font-mono text-sm leading-6"
      value={draft.body}
      disabled={busy}
      onChange={(e) => onChange({ ...draft, body: e.target.value })}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          if (!busy) void save();
        }
      }}
    />
  );
  return (
    <form
      className="knowledge-editor flex flex-col gap-3"
      aria-label="Edit page"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void save();
      }}
    >
      {newer && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-2xl border border-attention-border bg-attention-soft p-3 text-sm"
        >
          <strong className="text-attention-text">Page changed — review</strong>
          <span>
            {newer.page.updatedBy.name} changed this page {ago(newer.page.updatedAt)} while you were editing.
          </span>
          <details>
            <summary className="cursor-pointer text-muted-foreground">Latest saved version</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-background p-3 font-mono text-xs">
              {serializeKnowledgeSource(newer.page, newer.body)}
            </pre>
          </details>
          <details>
            <summary className="cursor-pointer text-muted-foreground">Base version</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-background p-3 font-mono text-xs">
              {serializeKnowledgeSource(page.page, page.body)}
            </pre>
          </details>
          <details>
            <summary className="cursor-pointer text-muted-foreground">Your draft</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-background p-3 font-mono text-xs">
              {draft.sourceMarkdown ??
                serializeKnowledgeSource({ ...draft, metadata: { tags: draft.tags } }, draft.body)}
            </pre>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onTakeTheirs}>
              Discard mine, edit theirs
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onKeepMine}>
              Keep mine (replaces theirs when saved)
            </Button>
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setError("");
            if (draft.sourceMarkdown === undefined)
              onChange({
                ...draft,
                sourceMarkdown: serializeKnowledgeSource({ ...draft, metadata: { tags: draft.tags } }, draft.body),
              });
            else {
              try {
                const parsed = parseKnowledgeSource(draft.sourceMarkdown);
                onChange({
                  title: parsed.title,
                  description: parsed.description,
                  body: parsed.body,
                  tags: parsed.metadata.tags,
                  base: draft.base,
                });
              } catch (e) {
                setError(e instanceof Error ? e.message : "Check the YAML header.");
              }
            }
          }}
        >
          {draft.sourceMarkdown === undefined ? "Edit Markdown Source" : "Edit properties and body"}
        </Button>
      </div>
      {draft.sourceMarkdown !== undefined ? (
        <Field>
          <Label htmlFor={bodyId}>Markdown source</Label>
          <Textarea
            id={bodyId}
            aria-label="Markdown source"
            className="min-h-[30rem] font-mono text-sm leading-6"
            value={draft.sourceMarkdown}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, sourceMarkdown: e.target.value })}
          />
        </Field>
      ) : (
        <>
          <Field className="gap-1.5">
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              value={draft.title}
              maxLength={200}
              disabled={busy}
              onChange={(e) => onChange({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field className="gap-1.5">
            <Label htmlFor={descId}>Description</Label>
            <Input
              id={descId}
              value={draft.description}
              maxLength={300}
              disabled={busy}
              placeholder="One line on what this page is for (agents see it when browsing)"
              onChange={(e) => onChange({ ...draft, description: e.target.value })}
            />
          </Field>
          <KnowledgeTags
            tags={draft.tags}
            suggestions={suggestions}
            disabled={busy}
            onChange={(tags) => onChange({ ...draft, tags })}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor={bodyId}>Text</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={mode}
              onValueChange={(v) => v && setMode(v as typeof mode)}
              aria-label="Editor view"
            >
              <ToggleGroupItem value="write">Write</ToggleGroupItem>
              <ToggleGroupItem value="preview">Preview</ToggleGroupItem>
              {wide && <ToggleGroupItem value="split">Side by side</ToggleGroupItem>}
            </ToggleGroup>
          </div>
          <div className="flex min-w-0 gap-3">
            {mode !== "preview" && source}
            {mode !== "write" && preview}
          </div>
          <p className="m-0 text-xs text-muted-foreground">
            Markdown. Link a page with <code>[title](page:ID)</code>, a Library file with <code>[name](file:ID)</code>,
            an image with <code>![](file:ID)</code>. Tasks: <code>- [ ] Do it @Agent 📅 2026-12-01</code>. Callouts:{" "}
            <code>&gt; [!NOTE]</code>, folded with <code>&gt; [!TIP]-</code>.
          </p>
        </>
      )}
      {error && <DialogError>{error}</DialogError>}
      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background py-3">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={busy || !!newer || (draft.sourceMarkdown === undefined && !draft.title.trim()) || !dirty}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

// ---- dialogs ---------------------------------------------------------------------------------------------------------

function descendantsOf(tree: KnowledgeTree, id: string): Set<string> {
  const out = new Set<string>();
  const walk = (at: string) => {
    for (const c of tree.children.get(at) ?? []) {
      if (out.has(c.id)) continue;
      out.add(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

function MoveDialog({
  api,
  detail,
  tree,
  onClose,
  onMoved,
}: {
  api: Api;
  detail: KnowledgePageDetail;
  tree: KnowledgeTree;
  onClose: () => void;
  onMoved: (d: KnowledgePageDetail) => void;
}) {
  const [target, setTarget] = useState(detail.page.parentId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectId = useId();
  const blocked = useMemo(() => {
    const s = descendantsOf(tree, detail.page.id);
    s.add(detail.page.id);
    return s;
  }, [tree, detail.page.id]);
  const options: { id: string; label: string }[] = [];
  const walk = (parent: string, depth: number) => {
    for (const n of tree.children.get(parent) ?? []) {
      if (blocked.has(n.id)) continue;
      options.push({ id: n.id, label: `${" ".repeat(depth)}${n.title}` });
      walk(n.id, depth + 1);
    }
  };
  walk("", 0);
  async function move() {
    setBusy(true);
    setError("");
    try {
      onMoved(await api.patchKnowledgePage(detail.page.id, { parentId: target || null }));
      onClose();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Move “{detail.page.title}”</DialogTitle>
        </DialogHeader>
        <Field className="gap-2">
          <Label htmlFor={selectId}>Put it inside</Label>
          <NativeSelect id={selectId} value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
            <option value="">Top level</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {error && <DialogError>{error}</DialogError>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || target === (detail.page.parentId ?? "")} onClick={() => void move()}>
            {busy ? "Moving…" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TrashDialog({
  api,
  detail,
  tree,
  onClose,
  onTrashed,
}: {
  api: Api;
  detail: KnowledgePageDetail;
  tree: KnowledgeTree;
  onClose: () => void;
  onTrashed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const below = descendantsOf(tree, detail.page.id).size;
  return (
    <ConfirmDialog
      title={`Move “${detail.page.title}” to Trash?`}
      description={
        <>
          {below > 0 && (
            <p>
              Its {below} subpage{below === 1 ? "" : "s"} go{below === 1 ? "es" : ""} with it.
            </p>
          )}
          <p>You can restore it from Trash for 30 days.</p>
        </>
      }
      error={error}
      busy={busy}
      confirmLabel="Move to Trash"
      busyLabel="Moving…"
      onCancel={onClose}
      onConfirm={() => {
        setBusy(true);
        api.trashKnowledgePage(detail.page.id).then(onTrashed, (e) => {
          setError(describeError(e));
          setBusy(false);
        });
      }}
    />
  );
}

function AskDialog({
  page,
  agents,
  defaultAgentId,
  onClose,
  onAsk,
}: {
  page: { id: string; title: string };
  agents: Agent[];
  defaultAgentId: string;
  onClose: () => void;
  onAsk: (page: { id: string; title: string }, question: string, agentId: string) => Promise<void>;
}) {
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agentSelect = useId();
  const questionId = useId();
  async function ask() {
    setBusy(true);
    setError("");
    try {
      await onAsk(page, question.trim(), agentId);
      onClose();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Ask about “{page.title}”</DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim() && !busy) void ask();
          }}
        >
          {agents.length > 1 && (
            <Field className="gap-2">
              <Label htmlFor={agentSelect}>Agent</Label>
              <NativeSelect id={agentSelect} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field className="gap-2">
            <Label htmlFor={questionId}>Question</Label>
            <Textarea
              id={questionId}
              value={question}
              autoFocus
              disabled={busy}
              placeholder="What would you like to know or change?"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && question.trim() && !busy) void ask();
              }}
            />
          </Field>
          <p className="m-0 text-xs text-muted-foreground">
            Starts a new chat; the agent reads the page's latest version.
          </p>
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !question.trim()}>
              {busy ? "Starting…" : "Ask"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevisionDialog({
  api,
  detail,
  revision,
  refs,
  onClose,
  onRestored,
}: {
  api: Api;
  detail: KnowledgePageDetail;
  revision: KnowledgeRevision;
  refs: MarkdownRefs;
  onClose: () => void;
  onRestored: (d: KnowledgePageDetail) => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = revision.revision === detail.page.revision;
  useEffect(() => {
    let cancelled = false;
    api.getKnowledgeRevision(detail.page.id, revision.revision).then(
      (r) => !cancelled && setBody(r.body),
      (e) => !cancelled && setError(describeError(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, detail.page.id, revision.revision]);
  async function restore() {
    setBusy(true);
    setError("");
    try {
      onRestored(await api.restoreKnowledgeRevision(detail.page.id, revision.revision, detail.page.revision));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? "The page changed since you opened this. Close and try again."
          : describeError(e),
      );
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{revision.title}</DialogTitle>
          <p className="m-0 text-xs text-muted-foreground">
            {revision.actor.name} · {formatWhen(revision.updatedAt)}
            {revision.note ? ` · ${revision.note}` : ""}
            {revision.sessionId && (
              <>
                {" · "}
                <a href={sessionHref(revision.sessionId)}>
                  {revision.sessionTitle ? `“${revision.sessionTitle}”` : "Open chat"}
                </a>
              </>
            )}
          </p>
        </DialogHeader>
        {revision.external && (
          <DialogWarning>This version was written by a chat that had read outside content.</DialogWarning>
        )}
        <div className="flex flex-col gap-1">
          <strong>{revision.title}</strong>
          {revision.description && <p>{revision.description}</p>}
          <div className="flex flex-wrap gap-1.5">
            {revision.metadata.tags.map((tag) => (
              <Badge variant="secondary" key={tag}>
                {tag}
              </Badge>
            ))}
          </div>
        </div>
        <div className="min-h-0 overflow-auto rounded-2xl border px-4 py-3">
          {body === null ? (
            <p className="m-0 text-sm text-muted-foreground">Loading…</p>
          ) : body.trim() ? (
            <Markdown text={body} refs={{ ...refs, onTask: undefined }} headingShift={1} />
          ) : (
            <p className="m-0 text-sm text-muted-foreground">Empty.</p>
          )}
        </div>
        {error && <DialogError>{error}</DialogError>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Close
          </Button>
          {!current && (
            <Button type="button" disabled={busy || body === null} onClick={() => void restore()}>
              {busy ? "Restoring…" : "Restore this version"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
