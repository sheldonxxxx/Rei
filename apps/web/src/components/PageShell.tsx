import type { ReactNode } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  /** The section's name: its heading and its name for assistive tech. */
  title: ReactNode;
  titleLabel?: string;
  /** Detail views only: a small link above the heading back to the list ("Back to <list>"). Omit on a list. */
  backLabel?: string;
  onBack?: (() => void) | undefined;
  /** At the right of the heading. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** The frame the Settings sections share, inside the Settings window: a heading (with Back on a detail view), then the content. */
export function PageShell({ title, titleLabel, backLabel = "Back", onBack, actions, className = "", children }: Props) {
  return (
    <section
      className={`page flex min-w-0 flex-col gap-5 ${className}`.trim()}
      aria-label={titleLabel ?? (typeof title === "string" ? title : undefined)}
    >
      {onBack && (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="page-back -ml-2 w-fit text-muted-foreground"
          onClick={onBack}
          aria-label={backLabel}
        >
          <Icon name="back" size={16} />
          {backLabel}
        </Button>
      )}
      <header className="page-head flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
        {actions}
      </header>
      <div className="page-col flex min-w-0 flex-col gap-6">{children}</div>
    </section>
  );
}
