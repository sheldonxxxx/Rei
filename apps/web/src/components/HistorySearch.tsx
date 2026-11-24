import type { Agent, HistoryHit, IndexStatus, Session } from "@rei/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/primitives/dialog.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Spinner } from "@/components/primitives/spinner.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/primitives/toggle-group.tsx";
import type { Api } from "../api/client.ts";
import { describeMemoryError } from "../api/client.ts";
import { dayBound, describeIndex, highlightParts, hitRole, whyLine } from "../lib/memory.ts";
import { sessionHref } from "../lib/route.ts";
import { formatWhen } from "../lib/time.ts";
import { Avatar } from "./Avatar.tsx";
import { ConfirmDialog, DialogError } from "./dialogParts.tsx";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

/** A snippet with the words you searched for marked. Plain text; the marks are elements, never HTML from the text. */
export function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((p, i) =>
        p.match ? (
          <mark key={i} className="hit-mark rounded-xs bg-ring/30 px-px text-inherit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * "Search your history": a window over the app, opened from the sidebar. Everything said in every chat, by words and by
 * meaning. With nothing typed it lists your recent chats, so it doubles as a quick switcher.
 */
export function HistorySearchDialog({
  api,
  agents,
  sessions,
  onClose,
}: {
  api: Api;
  agents: Agent[];
  sessions: Session[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // "" is every agent. Only offered when there is a choice.
  const [agent, setAgent] = useState("");
  const several = agents.length > 1;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The query the shown results are for, so editing the box doesn't change how they are marked.
  const [result, setResult] = useState<{ q: string; hits: HistoryHit[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  const queryId = useId();
  const filtersId = useId();

  const q = query.trim();
  const filtered = from !== "" || to !== "" || agent !== "";

  async function run() {
    const mine = ++latest.current;
    setBusy(true);
    setError(null);
    try {
      const r = await api.searchHistory({
        q,
        from: dayBound(from, "start"),
        to: dayBound(to, "end"),
        ...(several && agent ? { agent } : {}),
      });
      if (mine === latest.current) setResult({ q, hits: r.hits });
    } catch (err) {
      if (mine === latest.current) setError(describeMemoryError(err));
    } finally {
      if (mine === latest.current) setBusy(false);
    }
  }
  // Search as you type, once you pause; Enter searches at once.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!q) {
      latest.current++;
      setResult(null);
      setBusy(false);
      setError(null);
      return;
    }
    const t = setTimeout(() => void runRef.current(), 350);
    return () => clearTimeout(t);
  }, [q, from, to, agent]);

  const recent = sessions.slice(0, 8);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[min(40rem,76dvh)] flex-col gap-0 overflow-hidden p-0 md:top-[12vh] md:max-w-2xl md:translate-y-0 max-md:pb-[var(--safe-b)]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          input.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Search your history</DialogTitle>
        <form
          className="search-bar flex items-center gap-1.5 py-2.5 pr-2.5 pl-5 text-muted-foreground"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q) void run();
          }}
        >
          <Icon name="search" size={18} />
          <label htmlFor={queryId} className="sr-only">
            Search your history
          </label>
          <Input
            ref={input}
            id={queryId}
            type="search"
            className="h-10 min-w-0 flex-1 border-0 bg-transparent px-1 text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm [&::-webkit-search-cancel-button]:hidden"
            value={query}
            placeholder="Search…"
            autoComplete="off"
            enterKeyHint="search"
            onChange={(e) => setQuery(e.target.value)}
          />
          {busy && <Spinner aria-label="Searching" />}
          <Tip label="Filters">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={filtered ? "text-foreground" : "text-muted-foreground"}
              aria-label="Filters"
              aria-expanded={filtersOpen}
              aria-controls={filtersOpen ? filtersId : undefined}
              data-active={filtered ? "true" : undefined}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <Icon name="sliders" size={16} />
            </Button>
          </Tip>
          <Tip label="Close" shortcut="Esc">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label="Close search"
              onClick={onClose}
            >
              <Icon name="close" size={16} />
            </Button>
          </Tip>
        </form>
        {filtersOpen && (
          <div id={filtersId} className="search-filters flex flex-col gap-2 px-5 pb-2.5">
            <div className="history-dates flex flex-wrap gap-x-3.5 gap-y-2 max-md:[&>label]:flex-[1_1_10rem]">
              <label className="field-inline flex items-center gap-2 text-sm text-muted-foreground">
                <span>From</span>
                <Input
                  type="date"
                  className="w-auto flex-1"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className="field-inline flex items-center gap-2 text-sm text-muted-foreground">
                <span>To</span>
                <Input
                  type="date"
                  className="w-auto flex-1"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
            {several && <AgentPicker agents={agents} value={agent} onChange={setAgent} />}
          </div>
        )}
        <div className="search-body min-h-30 flex-1 overflow-y-auto px-2.5 pt-1 pb-3.5">
          {error && <DialogError className="m-2 mb-0">{error}</DialogError>}
          {!q && recent.length > 0 && (
            <section aria-label="Recent chats">
              <h3 className="mx-2 mt-2 mb-1.5 text-xs font-medium text-muted-foreground">Recent chats</h3>
              <ul className="search-recent m-0 list-none p-0">
                {recent.map((s) => (
                  <li key={s.id}>
                    <a
                      className="search-recent-row flex min-h-11 items-center gap-3 rounded-2xl px-2.5 text-sm text-foreground no-underline outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30"
                      href={`/s/${encodeURIComponent(s.id)}`}
                      onClick={onClose}
                    >
                      <Icon name="chat" size={16} />
                      <span className="row-title min-w-0 flex-1 truncate">{s.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {result && result.hits.length === 0 && (
            <p className="m-2 mb-0 rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              No sufficiently relevant matches in your history.
            </p>
          )}
          {result && result.hits.length > 0 && result.hits.every((h) => h.relevance === "related") && (
            <p className="mx-2 mt-2 mb-1.5 text-xs font-medium text-muted-foreground">Possible matches</p>
          )}
          {result && result.hits.length > 0 && (
            <ul
              className="hit-list m-0 flex list-none flex-col gap-0.5 p-0"
              aria-label="Search results"
              onClick={(e) => e.target instanceof Element && e.target.closest("a") && onClose()}
            >
              {result.hits.map((h) => (
                <HitRow
                  key={h.chunkId}
                  hit={h}
                  query={result.q}
                  agent={several ? agents.find((a) => a.id === h.agentId) : undefined}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What the search index is up to, with a Rebuild button. Lives on the Memory page. */
export function SearchIndexSection({
  api,
  index,
  onIndex,
}: {
  api: Api;
  index: IndexStatus | null;
  onIndex: (i: IndexStatus) => void;
}) {
  const headId = useId();
  return (
    <section
      className="memory-section flex min-w-0 flex-col gap-3 [&+.memory-section]:border-t [&+.memory-section]:pt-5"
      aria-labelledby={headId}
    >
      <h4 id={headId} className="memory-h m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
        Search index
      </h4>
      {index ? (
        <IndexLine api={api} index={index} onIndex={onIndex} />
      ) : (
        <span className="spinner" role="status" aria-label="Loading" />
      )}
    </section>
  );
}

/** Which agent's chats to search: everyone's, or one. Radio buttons drawn as chips, so the arrow keys move between them. */
function AgentPicker({ agents, value, onChange }: { agents: Agent[]; value: string; onChange: (id: string) => void }) {
  // Radix uses an empty string for no selection, so "all" has a distinct value here.
  const all = "__all_agents__";
  const options = [
    { id: all, label: "All agents", avatar: null as string | null },
    ...agents.map((a) => ({ id: a.id, label: a.name, avatar: a.avatar })),
  ];
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={1}
      value={value || all}
      onValueChange={(id) => id && onChange(id === all ? "" : id)}
      className="agent-picker flex-wrap"
      role="radiogroup"
      aria-label="Search in"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.id}
          value={o.id}
          role="radio"
          aria-checked={(value || all) === o.id}
          className="agent-option gap-1.5"
        >
          {o.avatar !== null && <Avatar value={o.avatar} size={20} />}
          <span>{o.label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function HitRow({ hit, query, agent }: { hit: HistoryHit; query: string; agent: Agent | undefined }) {
  return (
    <li className="hit rounded-2xl hover:bg-muted/60">
      <a
        className="hit-link flex flex-col gap-1 rounded-2xl px-3.5 pt-2.5 pb-1.5 text-foreground no-underline outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        href={sessionHref(hit.sessionId, hit.messageId)}
      >
        <span className="hit-top flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="hit-title min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{hit.sessionTitle}</span>
          <Badge variant="secondary">{hitRole(hit)}</Badge>
          {hit.relevance === "related" && <Badge variant="outline">Possible lead</Badge>}
          {agent && (
            <span className="hit-agent inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <Avatar value={agent.avatar} size={16} />
              <span>{agent.name}</span>
            </span>
          )}
          <time
            className="hit-date ml-auto text-xs whitespace-nowrap text-muted-foreground"
            dateTime={new Date(hit.createdAt).toISOString()}
          >
            {formatWhen(hit.createdAt)}
          </time>
        </span>
        <span className="hit-snippet line-clamp-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">
          <Highlighted text={hit.snippet} query={query} />
        </span>
      </a>
      <details className="hit-why px-3.5 pb-2 text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer">Why this matched</summary>
        <p className="mt-0.5 font-mono">{whyLine(hit)}</p>
      </details>
    </li>
  );
}

function IndexLine({ api, index, onIndex }: { api: Api; index: IndexStatus; onIndex: (i: IndexStatus) => void }) {
  const view = describeIndex(index);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cancel() {
    setConfirming(false);
    setError(null);
  }
  async function rebuild() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.rebuildIndex();
      onIndex(r.index);
      setConfirming(false);
    } catch (e) {
      setError(describeMemoryError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="index-line group/index flex flex-col items-start gap-2 rounded-2xl border p-4 text-sm"
      data-tone={view.tone}
    >
      <p className="index-text m-0 flex items-center gap-2" role="status">
        <span
          className="index-dot size-2 shrink-0 rounded-full bg-success group-data-[tone=busy]/index:animate-pulse group-data-[tone=busy]/index:bg-primary group-data-[tone=warn]/index:bg-warning group-data-[tone=off]/index:bg-muted-foreground"
          aria-hidden="true"
        />
        <span>{view.text}</span>
      </p>
      {view.progress && view.progress.total > 0 && (
        <div
          className="meter h-2 overflow-hidden rounded-full bg-muted [&>span]:block [&>span]:h-full [&>span]:rounded-full [&>span]:bg-primary [&>span]:transition-[width] group-data-[level=near]/budget:[&>span]:bg-warning group-data-[level=full]/budget:[&>span]:bg-destructive slim h-1.5 self-stretch"
          role="progressbar"
          aria-label="Indexing"
          aria-valuemin={0}
          aria-valuemax={view.progress.total}
          aria-valuenow={view.progress.done}
        >
          <span style={{ width: `${Math.min(100, Math.round((view.progress.done / view.progress.total) * 100))}%` }} />
        </div>
      )}
      {index.remote && (
        <p className="index-note m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          The search service is not on your server, so it receives the text of everything indexed.
        </p>
      )}
      {index.state === "down" && index.lastError && (
        <p className="index-note m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{index.lastError}</p>
      )}
      {error && !confirming && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!view.canRebuild || index.building !== null}
          onClick={() => setConfirming(true)}
        >
          Rebuild
        </Button>
      </div>
      {confirming && <RebuildDialog busy={busy} error={error} onCancel={cancel} onConfirm={() => void rebuild()} />}
    </div>
  );
}

function RebuildDialog({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      title="Rebuild the search index?"
      description="Search keeps working; nothing is lost."
      tone="default"
      error={error}
      busy={busy}
      confirmLabel="Rebuild"
      busyLabel="Starting…"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
