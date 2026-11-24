import type { MemoryChange, MemorySuggestion, Message } from "@rei/protocol";
import { useId, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { describeMemoryError } from "../api/client.ts";
import { enterIndex, useArrival } from "../lib/motion.tsx";
import { Icon } from "./Icon.tsx";

export type UndoChangeFn = (changeId: string) => Promise<MemoryChange>;

/** Old text struck through, then the new: how an edit reads. Either side may be missing (an add, a remove). Plain text only. */
export function LineDiff({ before, after }: { before: string | null; after: string | null }) {
  if (before !== null && after !== null && before !== after) {
    return (
      <span className="line-diff [overflow-wrap:anywhere]">
        <del className="text-muted-foreground decoration-1">{before}</del>
        <span className="diff-arrow mx-[0.4em] text-muted-foreground" aria-hidden="true">
          →
        </span>
        <ins className="no-underline">{after}</ins>
      </span>
    );
  }
  if (after === null && before !== null) {
    return (
      <span className="line-diff [overflow-wrap:anywhere]">
        <del className="text-muted-foreground decoration-1">{before}</del>
      </span>
    );
  }
  return <span className="line-diff [overflow-wrap:anywhere]">{after ?? before ?? ""}</span>;
}

/** Which doc a memory edit is in, in words: "your profile" or "Dot's notes". */
export const docLabel = (x: { doc: MemoryChange["doc"] }, agentName: string | undefined) =>
  x.doc === "profile" ? "your profile" : `${agentName ?? "the agent"}'s notes`;

const clip = (text: string, n = 40) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * "Memory updated": what the assistant just saved about you, with Undo. Consecutive ones share a row. Drawn from structured
 * fields only; the saved text is plain text.
 */
export function MemoryChipRow({
  messages,
  onUndo,
  agentName,
}: {
  messages: Message[];
  onUndo?: UndoChangeFn | undefined;
  agentName?: ((agentId: string | null) => string | undefined) | undefined;
}) {
  return (
    <li className="msg msg-memory -mt-3" data-msg-id={messages[0]?.id}>
      <ul className="memory-chips m-0 flex list-none flex-col items-start gap-1.5 p-0" aria-label="Memory updates">
        {messages.map((m, i) =>
          m.memory?.review ? (
            <li key={m.id}>
              <a
                className="memory-chip text-sm text-muted-foreground hover:underline"
                href={`/background/${encodeURIComponent(m.memory.review.jobId)}`}
              >
                Memory updated · {m.memory.review.changeIds.length} changes
                {m.memory.review.undoneCount ? ` · ${m.memory.review.undoneCount} undone` : ""}
              </a>
            </li>
          ) : m.memory?.change ? (
            <MemoryChip key={m.id} change={m.memory.change} onUndo={onUndo} agentName={agentName} index={i} />
          ) : null,
        )}
      </ul>
    </li>
  );
}

function MemoryChip({
  change,
  onUndo,
  agentName,
  index = 0,
}: {
  change: MemoryChange;
  onUndo: UndoChangeFn | undefined;
  agentName: ((agentId: string | null) => string | undefined) | undefined;
  index?: number;
}) {
  const arrival = useArrival("rise");
  // What this device did, so the chip is right at once, before the stream catches up.
  const [local, setLocal] = useState<MemoryChange | null>(null);
  const shown = change.undoneAt === null && local ? local : change;
  const undone = shown.undoneAt !== null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = shown.after ?? shown.before ?? "";

  async function undo() {
    if (!onUndo) return;
    setBusy(true);
    setError(null);
    try {
      setLocal(await onUndo(shown.id));
    } catch (e) {
      setError(describeMemoryError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className="memory-chip group/chip flex max-w-full items-start gap-2 rounded-xl border bg-muted/50 py-1.5 pr-1.5 pl-2.5 text-sm text-foreground/80 data-[undone=true]:border-dashed data-[undone=true]:bg-transparent data-[undone=true]:text-muted-foreground"
      data-op={shown.op}
      data-undone={undone ? "true" : undefined}
      data-enter={arrival}
      style={enterIndex(index)}
    >
      <span className="memory-chip-icon mt-1 inline-grid shrink-0 text-muted-foreground" aria-hidden="true">
        <Icon name={undone ? "undo" : "memory"} size={14} />
      </span>
      <span className="memory-chip-body flex min-w-0 flex-wrap items-baseline gap-x-2 pt-0.5">
        <span className="memory-chip-label font-semibold whitespace-nowrap text-foreground group-data-[undone=true]/chip:text-muted-foreground">
          {undone ? "Undone" : "Memory updated"}
          <span className="memory-chip-doc font-normal text-muted-foreground">{` · ${docLabel(shown, agentName?.(shown.agentId))}`}</span>
        </span>
        <span className="memory-chip-text min-w-0 [overflow-wrap:anywhere] group-data-[undone=true]/chip:line-through">
          <LineDiff before={shown.before} after={shown.after} />
        </span>
        {error && (
          <span role="alert" className="memory-chip-error basis-full text-destructive">
            {error}
          </span>
        )}
      </span>
      {!undone && shown.undoable && onUndo && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground max-md:h-8"
          disabled={busy}
          aria-busy={busy}
          aria-label={`Undo: ${clip(text)}`}
          onClick={() => void undo()}
        >
          <Icon name="undo" size={14} />
          Undo
        </Button>
      )}
    </li>
  );
}

const OP_WORD = { add: "Add", replace: "Change", remove: "Remove" } as const;

/**
 * Under a report: the memory edits the session proposed. The agent that started it decides what to write, so this only
 * shows them (plain text, no buttons).
 */
export function MemorySuggestions({
  suggestions,
  agentName,
}: {
  suggestions: MemorySuggestion[];
  agentName?: ((agentId: string | null) => string | undefined) | undefined;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  if (suggestions.length === 0) return null;
  const n = suggestions.length;
  return (
    <div className="report-memory mt-2 border-t pt-2 text-sm text-muted-foreground">
      <p className="report-memory-line m-0 flex items-center gap-1.5">
        <Icon name="memory" size={14} />
        <span>{`Suggested ${n} memory ${n === 1 ? "edit" : "edits"}`}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide" : "Show"}
        </Button>
      </p>
      {open && (
        <ul
          id={listId}
          className="report-memory-list mt-2 mb-0 flex list-none flex-col gap-1.5 p-0"
          aria-label="Suggested memory edits"
        >
          {suggestions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-foreground/80">
              <Badge variant="secondary">{OP_WORD[s.op]}</Badge>
              <span className="report-memory-doc text-muted-foreground">{docLabel(s, agentName?.(s.agentId))}</span>
              <span className="report-memory-text min-w-0 basis-full [overflow-wrap:anywhere]">
                <LineDiff before={s.op === "add" ? null : s.current} after={s.op === "remove" ? null : s.text} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
