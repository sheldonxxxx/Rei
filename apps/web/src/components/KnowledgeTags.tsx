import { normalizeTags, tagKey } from "@rei/protocol/knowledge-source";
import { useId, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";

export function KnowledgeTags({
  tags,
  suggestions,
  disabled,
  onChange,
}: {
  tags: string[];
  suggestions: string[];
  disabled?: boolean;
  onChange: (tags: string[]) => void;
}) {
  const id = useId();
  const [entry, setEntry] = useState("");
  const [error, setError] = useState("");
  function add() {
    if (!entry.trim()) return;
    try {
      onChange(normalizeTags([...tags, entry]));
      setEntry("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the tag.");
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Tags</Label>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <Badge
            key={tagKey(tag)}
            variant="secondary"
            className="max-w-full whitespace-normal [overflow-wrap:anywhere]"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              disabled={disabled}
              className="ml-1 rounded px-1 focus-visible:outline-2"
              onClick={() => onChange(tags.filter((t) => t !== tag))}
            >
              ×
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          id={id}
          value={entry}
          disabled={disabled}
          list={`${id}-suggestions`}
          placeholder="Add a tag"
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled || !entry.trim()} onClick={add}>
          Add tag
        </Button>
      </div>
      <datalist id={`${id}-suggestions`}>
        {suggestions
          .filter((s) => !tags.some((t) => tagKey(t) === tagKey(s)))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
