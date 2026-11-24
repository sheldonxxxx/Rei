import { cn } from "cn";
import { X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useRef, useState } from "react";

interface TagInputProps {
  id?: string;
  value: string[];
  onChange(next: string[]): void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/** Splits typed or pasted text into tag values: commas and line breaks separate them, blanks are dropped. */
function tagsFrom(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * A wrapping list of tags. Enter (or a comma, a line break, or leaving the field) turns the typed text into a tag;
 * each tag has an × to remove it; Backspace in an empty field removes the last tag. Duplicates are ignored.
 */
export function TagInput({ id, value, onChange, placeholder, disabled = false, className }: TagInputProps) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const add = (texts: string[]) => {
    const next = [...value];
    for (const text of texts) if (!next.includes(text)) next.push(text);
    if (next.length !== value.length) onChange(next);
  };
  const commitDraft = () => {
    add(tagsFrom(draft));
    setDraft("");
  };
  const remove = (tag: string) => onChange(value.filter((entry) => entry !== tag));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      // Enter adds the tag; it must not submit the surrounding form.
      event.preventDefault();
      commitDraft();
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[\n,]/.test(text)) return;
    event.preventDefault();
    add(tagsFrom(`${draft},${text}`));
    setDraft("");
  };

  return (
    // Not a <label>: a label's first labelable descendant is the first tag's × button, so clicking the box (or a tag)
    // would activate that button and remove the wrong tag. A click on the box focuses the field instead.
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer convenience only; the input itself is keyboard-reachable.
    // biome-ignore lint/a11y/useKeyWithClickEvents: same
    <div
      onClick={() => input.current?.focus()}
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-control-border bg-card px-2 py-1.5 text-sm transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30",
        disabled && "opacity-50",
        className,
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted py-0.5 pr-1 pl-2 font-mono text-xs"
        >
          <span className="truncate">{tag}</span>
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              remove(tag);
            }}
            className="rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground disabled:pointer-events-none"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={input}
        id={id}
        type="text"
        value={draft}
        placeholder={value.length ? undefined : placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={commitDraft}
        className="min-w-24 flex-1 bg-transparent py-0.5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
    </div>
  );
}
