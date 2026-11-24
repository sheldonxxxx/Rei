import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

/** Copies `text`. The tooltip says "Copy" (or `label`) and then "Copied"; `compact` also shows the word. */
export function CopyButton({
  text,
  label = "Copy",
  compact = false,
}: {
  text: string;
  label?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // clipboard blocked (insecure origin or permissions): nothing to do
    }
  }

  return (
    <Tip label={copied ? "Copied" : label}>
      <Button
        type="button"
        variant="ghost"
        size={compact ? "xs" : "icon-sm"}
        className="text-muted-foreground"
        onClick={() => void copy()}
        aria-label={copied ? "Copied" : label}
      >
        <Icon name={copied ? "check" : "copy"} size={compact ? 14 : 16} />
        {compact && <span>{copied ? "Copied" : "Copy"}</span>}
      </Button>
    </Tip>
  );
}
