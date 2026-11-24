import type { Agent, IndexStatus, MemoryChange, MemoryDoc, MemoryLine, MemoryResponse } from "@rei/protocol";
import { MEMORY_LINE_MAX_CHARS } from "@rei/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Empty, EmptyDescription } from "@/components/primitives/empty.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import type { Api } from "../api/client.ts";
import { describeMemoryError } from "../api/client.ts";
import { CHANGE_VERB, changeBy, isStale, sourceLabel, staleFor } from "../lib/memory.ts";
import { sessionHref } from "../lib/route.ts";
import { ago, formatWhen } from "../lib/time.ts";
import { useNow } from "../lib/useNow.ts";
import type { MemoryRev } from "../stream/hooks.ts";
import { Avatar } from "./Avatar.tsx";
import { SearchIndexSection } from "./HistorySearch.tsx";
import { Icon } from "./Icon.tsx";
import { LineDiff } from "./MemoryCards.tsx";
import { MemoryExtractionSettings } from "./MemoryExtractionSettings.tsx";
import { PageShell } from "./PageShell.tsx";
import { Tip } from "./Tip.tsx";

interface Props {
  api: Api;
  agents: Agent[];
  /** From the global stream: each rises when the server says that part of memory changed. */
  rev: MemoryRev;
}

/**
 * The Memory page: the profile docs the assistants always see (with dates, sources, versions, direct editing), the
 * a search of everything you've said. Everything shown is plain text.
 */
export function MemoryPage({ api, agents, rev }: Props) {
  const [data, setData] = useState<MemoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState<IndexStatus | null>(null);

  const load = useCallback(() => {
    api.getMemory().then(
      (r) => {
        setData(r);
        setError(null);
      },
      (e) => setError(describeMemoryError(e)),
    );
  }, [api]);
  const loadIndex = useCallback(() => {
    api.getIndexStatus().then(
      (r) => setIndex(r.index),
      () => {}, // the status line just stays as it was
    );
  }, [api]);
  useEffect(() => {
    load();
  }, [load, rev.lines]);
  useEffect(() => {
    loadIndex();
  }, [loadIndex, rev.index]);

  return (
    <PageShell title="Memory" className="memory-page">
      <MemoryExtractionSettings api={api} />
      <a className="text-sm underline underline-offset-4" href="/background?kind=memory.review">
        View review history
      </a>
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
      {!data && !error && <span className="spinner" role="status" aria-label="Loading" />}
      {data && (
        <>
          <DocSection
            api={api}
            title="About you"
            sub="Shared by every assistant."
            doc="profile"
            lines={data.profile}
            budget={{ used: data.userUsedTokens, limit: data.userTokenBudget }}
            budgetLabel="User Memory"
            onChanged={load}
          />
          {data.agents.map((a) => {
            const agent = agents.find((x) => x.id === a.agentId);
            const name = agent?.name ?? "Agent";
            return (
              <DocSection
                key={a.agentId}
                api={api}
                title={`${name}'s notes`}
                sub={`How ${name} should work with you. Only ${name} sees these.`}
                avatar={agent?.avatar}
                doc="agent"
                agentId={a.agentId}
                lines={a.lines}
                budget={{ used: a.usedTokens, limit: a.tokenBudget }}
                onChanged={load}
              />
            );
          })}
        </>
      )}

      <SearchIndexSection api={api} index={index} onIndex={setIndex} />
    </PageShell>
  );
}

function Budget({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const level = used >= limit ? "full" : pct >= 85 ? "near" : "ok";
  const labelId = useId();
  return (
    <div
      className="memory-budget group/budget flex flex-col gap-2 rounded-2xl border bg-muted/40 p-4"
      data-level={level}
    >
      <p
        id={labelId}
        className="memory-budget-text m-0 text-sm text-muted-foreground [&_strong]:text-foreground [&_strong]:tabular-nums"
      >
        {label}: <strong>{used.toLocaleString("en-US")}</strong> of {limit.toLocaleString("en-US")} tokens used
        {level !== "ok" && (
          <span className="memory-budget-warn group-data-[level=near]/budget:text-attention-text group-data-[level=full]/budget:font-medium group-data-[level=full]/budget:text-destructive">
            {" "}
            · {level === "full" ? "Full. Delete or shorten a line before adding more." : "Nearly full."}
          </span>
        )}
      </p>
      <div
        className="meter h-2 overflow-hidden rounded-full bg-muted [&>span]:block [&>span]:h-full [&>span]:rounded-full [&>span]:bg-primary [&>span]:transition-[width] group-data-[level=near]/budget:[&>span]:bg-warning group-data-[level=full]/budget:[&>span]:bg-destructive"
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---- a doc and its lines -----------------------------------------------------------------------------------------------

function DocSection({
  api,
  title,
  sub,
  avatar,
  doc,
  agentId,
  lines,
  budget,
  budgetLabel,
  onChanged,
}: {
  api: Api;
  title: string;
  sub: string;
  avatar?: string | undefined;
  doc: MemoryDoc;
  agentId?: string;
  lines: MemoryLine[];
  budget?: { used: number; limit: number };
  budgetLabel?: string;
  onChanged: () => void;
}) {
  const now = useNow();
  const headId = useId();
  return (
    <section
      className="memory-section flex min-w-0 flex-col gap-3 [&+.memory-section]:border-t [&+.memory-section]:pt-5"
      aria-labelledby={headId}
    >
      <h4 id={headId} className="memory-h m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
        {avatar && <Avatar value={avatar} size={24} />}
        {title}
      </h4>
      <p className="memory-sub m-0 text-sm text-muted-foreground">{sub}</p>
      {budget && <Budget label={budgetLabel ?? title} used={budget.used} limit={budget.limit} />}
      {lines.length === 0 ? (
        <Empty className="page-empty border px-5 py-8">
          <EmptyDescription>{doc === "profile" ? "Nothing yet." : "No notes yet."}</EmptyDescription>
        </Empty>
      ) : (
        <ul className="memory-lines m-0 flex list-none flex-col gap-2 p-0" aria-label={title}>
          {lines.map((line) => (
            <LineRow key={line.id} api={api} line={line} now={now} onChanged={onChanged} />
          ))}
        </ul>
      )}
      <AddLine api={api} doc={doc} {...(agentId ? { agentId } : {})} label={title} onAdded={onChanged} />
    </section>
  );
}

function AddLine({
  api,
  doc,
  agentId,
  label,
  onAdded,
}: {
  api: Api;
  doc: MemoryDoc;
  agentId?: string;
  label: string;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const fieldId = useId();

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setText("");
    setError(null);
    addBtn.current?.focus();
  }
  async function submit() {
    const clean = text.trim();
    if (!clean) return;
    setBusy(true);
    setError(null);
    try {
      await api.addMemoryLine({ doc, ...(agentId ? { agentId } : {}), text: clean });
      onAdded();
      setOpen(false);
      setText("");
    } catch (e) {
      setError(describeMemoryError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div>
        <Button
          variant="outline"
          size="sm"
          ref={addBtn}
          type="button"
          aria-label={`Add a line to ${label}`}
          onClick={() => setOpen(true)}
        >
          <Icon name="plus" size={16} />
          Add a line
        </Button>
      </div>
    );
  }
  return (
    <LineEditor
      fieldId={fieldId}
      fieldRef={field}
      label={`New line for ${label}`}
      value={text}
      busy={busy}
      error={error}
      saveLabel="Add"
      canSave={text.trim() !== ""}
      onChange={setText}
      onSave={() => void submit()}
      onCancel={close}
    />
  );
}

function LineEditor({
  fieldId,
  fieldRef,
  label,
  value,
  busy,
  error,
  saveLabel,
  canSave,
  onChange,
  onSave,
  onCancel,
}: {
  fieldId: string;
  fieldRef: React.RefObject<HTMLTextAreaElement | null>;
  label: string;
  value: string;
  busy: boolean;
  error: string | null;
  saveLabel: string;
  canSave: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const over = value.trim().length > MEMORY_LINE_MAX_CHARS;
  return (
    <form
      className="memory-editor flex flex-col gap-2 pb-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave && !over && !busy) onSave();
      }}
    >
      <label htmlFor={fieldId} className="sr-only">
        {label}
      </label>
      <Textarea
        id={fieldId}
        ref={fieldRef}
        rows={2}
        value={value}
        disabled={busy}
        aria-invalid={over}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            // Enter saves (a line is one line); Shift+Enter is not needed but harmless.
            e.preventDefault();
            if (canSave && !over && !busy) onSave();
          }
        }}
      />
      <div className="memory-editor-foot flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className="memory-count text-xs tabular-nums text-muted-foreground data-over:font-medium data-over:text-destructive"
          data-over={over ? "true" : undefined}
          aria-live="polite"
        >
          {value.trim().length} / {MEMORY_LINE_MAX_CHARS}
        </span>
        {error && (
          <span role="alert" className="memory-editor-error flex-[1_1_12rem] text-xs text-destructive">
            {error}
          </span>
        )}
        <span className="memory-editor-actions ml-auto flex gap-2">
          <Button variant="outline" size="sm" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="default" size="sm" type="submit" disabled={busy || !canSave || over}>
            {busy ? "Saving…" : saveLabel}
          </Button>
        </span>
      </div>
    </form>
  );
}

function LineRow({ api, line, now, onChanged }: { api: Api; line: MemoryLine; now: number; onChanged: () => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [draft, setDraft] = useState(line.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const editBtn = useRef<HTMLButtonElement>(null);
  const fieldId = useId();
  const versionsId = useId();
  const stale = isStale(line, now);

  useEffect(() => {
    if (mode === "edit") {
      field.current?.focus();
      field.current?.setSelectionRange(field.current.value.length, field.current.value.length);
    }
  }, [mode]);

  async function run(action: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
      after?.();
    } catch (e) {
      setError(describeMemoryError(e));
    } finally {
      setBusy(false);
    }
  }
  const save = () =>
    void run(
      () => api.updateMemoryLine(line.id, { text: draft.trim() }),
      () => setMode("view"),
    );
  const remove = () => void run(() => api.deleteMemoryLine(line.id));
  const confirmStill = () => void run(() => api.updateMemoryLine(line.id, { text: line.text }));
  const cancelEdit = () => {
    setMode("view");
    setError(null);
    queueMicrotask(() => editBtn.current?.focus());
  };

  return (
    <li
      className="memory-line rounded-2xl border bg-card px-4 pt-3 pb-2 data-stale:border-attention-border data-stale:bg-attention-soft"
      data-stale={stale ? "true" : undefined}
    >
      {mode === "edit" ? (
        <LineEditor
          fieldId={fieldId}
          fieldRef={field}
          label="Edit line"
          value={draft}
          busy={busy}
          error={error}
          saveLabel="Save"
          canSave={draft.trim() !== "" && draft.trim() !== line.text}
          onChange={setDraft}
          onSave={save}
          onCancel={cancelEdit}
        />
      ) : (
        <>
          <p className="memory-line-text m-0 text-sm leading-relaxed [overflow-wrap:anywhere]">{line.text}</p>
          <p className="memory-line-meta mt-1 mb-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <Tip label={`Last confirmed ${formatWhen(line.confirmedAt, now)}`}>
              <time dateTime={new Date(line.confirmedAt).toISOString()}>Confirmed {ago(line.confirmedAt, now)}</time>
            </Tip>
            {stale && (
              <Tip label={`${staleFor(line, now)}. Confirm it, or edit it if it changed.`}>
                <Badge
                  className="stale-chip bg-attention-soft text-attention-text ring-1 ring-inset ring-attention-border"
                  tabIndex={0}
                >
                  Stale
                </Badge>
              </Tip>
            )}
            <span className="memory-source [&_a]:font-medium">
              {line.source ? (
                <Tip label="Open the message this came from">
                  <a href={sessionHref(line.source.sessionId, line.source.messageId)}>{sourceLabel(line)}</a>
                </Tip>
              ) : (
                sourceLabel(line)
              )}
            </span>
          </p>
          {error && (
            <p
              role="alert"
              className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
          )}
          {mode === "delete" ? (
            <div
              className="memory-line-actions -ml-2 mt-2 flex flex-wrap items-center gap-1"
              role="group"
              aria-label="Delete this line?"
            >
              <span className="grant-confirm text-sm font-medium text-destructive">Delete this line?</span>
              <Button
                variant="destructive"
                size="sm"
                type="button"
                disabled={busy}
                onClick={remove}
                aria-label={`Yes, delete: ${line.text}`}
              >
                {busy ? "Deleting…" : "Delete"}
              </Button>
              <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => setMode("view")}>
                Keep
              </Button>
            </div>
          ) : (
            <div className="memory-line-actions -ml-2 mt-2 flex flex-wrap items-center gap-1">
              {stale && (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={busy}
                  onClick={confirmStill}
                  aria-label={`Still true: ${line.text}`}
                >
                  Still true
                </Button>
              )}
              <Tip label="Edit">
                <Button
                  variant="ghost"
                  size="sm"
                  ref={editBtn}
                  type="button"
                  aria-label={`Edit: ${line.text}`}
                  onClick={() => {
                    setDraft(line.text);
                    setError(null);
                    setMode("edit");
                  }}
                >
                  <Icon name="edit" size={16} />
                  Edit
                </Button>
              </Tip>
              <Tip label="Earlier versions">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  aria-expanded={versionsOpen}
                  aria-controls={versionsOpen ? versionsId : undefined}
                  aria-label={`History: ${line.text}`}
                  onClick={() => setVersionsOpen((v) => !v)}
                >
                  <Icon name="clock" size={16} />
                  History
                </Button>
              </Tip>
              <Tip label="Delete">
                <Button
                  variant="destructive"
                  size="sm"
                  type="button"
                  className="danger-text text-destructive"
                  aria-label={`Delete: ${line.text}`}
                  onClick={() => setMode("delete")}
                >
                  <Icon name="trash" size={16} />
                  Delete
                </Button>
              </Tip>
            </div>
          )}
          {versionsOpen && <Versions api={api} line={line} id={versionsId} onChanged={onChanged} />}
        </>
      )}
    </li>
  );
}

function Versions({ api, line, id, onChanged }: { api: Api; line: MemoryLine; id: string; onChanged: () => void }) {
  const [changes, setChanges] = useState<MemoryChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getMemoryChanges(line.id).then(
      (r) => {
        setChanges(r.changes);
        setError(null);
      },
      (e) => setError(describeMemoryError(e)),
    );
  }, [api, line.id]);
  useEffect(() => {
    load();
  }, [load, line.updatedAt]);

  async function undo(change: MemoryChange) {
    setBusyId(change.id);
    setError(null);
    try {
      await api.undoMemoryChange(change.id);
      onChanged();
      load();
    } catch (e) {
      setError(describeMemoryError(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      id={id}
      className="memory-versions mt-2 mb-1 border-t border-dashed pt-3 pb-1"
      role="group"
      aria-label="Versions"
    >
      {!changes && !error && <span className="spinner" role="status" aria-label="Loading versions" />}
      {error && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      {changes && (
        <ol className="version-list m-0 flex list-none flex-col gap-3 p-0">
          {[...changes].reverse().map((c) => (
            <li
              key={c.id}
              className="version group/version flex items-start justify-between gap-2"
              data-undone={c.undoneAt !== null ? "true" : undefined}
            >
              <div className="version-main min-w-0">
                <p className="version-what m-0 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
                  <strong>{CHANGE_VERB[c.op]}</strong> by {changeBy(c)} ·{" "}
                  <time dateTime={new Date(c.at).toISOString()}>{formatWhen(c.at)}</time>
                  {c.undoneAt !== null && <Badge>Undone</Badge>}
                </p>
                <p className="version-text m-0 text-sm [overflow-wrap:anywhere] group-data-undone/version:text-muted-foreground">
                  {c.op === "confirm" ? (
                    "Confirmed again; the text did not change."
                  ) : (
                    <LineDiff before={c.before} after={c.after} />
                  )}
                </p>
              </div>
              {c.undoable && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busyId !== null}
                  aria-label={`Undo ${CHANGE_VERB[c.op].toLowerCase()}: ${c.after ?? c.before ?? ""}`}
                  onClick={() => void undo(c)}
                >
                  <Icon name="undo" size={14} />
                  Undo
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
