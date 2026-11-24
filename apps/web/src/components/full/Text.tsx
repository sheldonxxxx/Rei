import { useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { cn } from "@/lib/utils.ts";
import { CopyButton } from "../CopyButton.tsx";

const LIMIT = 4000;

/** Long recorded text, cut with "Show more" so a 200,000-character prompt doesn't freeze the page. Plain text only. */
export function LongText({
  text,
  limit = LIMIT,
  className = "",
}: {
  text: string;
  limit?: number;
  className?: string;
}) {
  const [all, setAll] = useState(false);
  const cut = !all && text.length > limit;
  return (
    <div className={cn("long-text", className)}>
      <pre className="m-0 max-h-[28rem] overflow-auto rounded-lg border bg-muted px-2.5 py-2 font-[inherit] text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {cut ? text.slice(0, limit) : text}
      </pre>
      {text.length > limit && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-ml-2 text-muted-foreground"
          aria-expanded={all}
          onClick={() => setAll((a) => !a)}
        >
          {all ? "Show less" : `Show more (${(text.length - limit).toLocaleString()} more characters)`}
        </Button>
      )}
    </div>
  );
}

export function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/** A JSON value, pretty-printed, with a copy button. */
export function JsonView({ value, label }: { value: unknown; label: string }) {
  const text = pretty(value);
  return (
    <div className="json-view">
      <div className="json-head flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} compact />
      </div>
      <LongText text={text} className="font-mono" />
    </div>
  );
}
