import type { Session } from "@rei/protocol";
import { useEffect, useRef } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Item } from "@/components/primitives/item.tsx";
import { Sheet, SheetContent, SheetTitle } from "@/components/primitives/sheet.tsx";
import { cn } from "@/lib/utils.ts";
import { effectiveStatus } from "../lib/policy.ts";
import { useMediaQuery } from "../lib/route.ts";
import { Icon } from "./Icon.tsx";
import { PANEL_HEAD, PANEL_TITLE, SIDE_PANEL } from "./panelStyles.ts";
import { StatusChip } from "./StatusChip.tsx";
import { Tip } from "./Tip.tsx";

interface Props {
  id: string;
  /** The sessions this chat's agent started. */
  sessions: Session[];
  onClose: () => void;
}

/** Side panel on wide screens, a focus-trapped Sheet on phones. */
export function SessionsPanel({ id, sessions, onClose }: Props) {
  const wide = useMediaQuery("(min-width: 768px)");
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (wide) root.current?.focus();
  }, [wide]);
  const contents = (
    <>
      <div className={PANEL_HEAD}>
        {wide ? (
          <h3 id={`${id}-h`} className={PANEL_TITLE}>
            Sessions
          </h3>
        ) : (
          <SheetTitle id={`${id}-h`} className={PANEL_TITLE}>
            Sessions
          </SheetTitle>
        )}
        <Tip label="Close">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Close sessions"
            onClick={onClose}
          >
            <Icon name="close" />
          </Button>
        </Tip>
      </div>
      <ul className="panel-list m-0 flex list-none flex-col gap-2 overflow-y-auto px-2.5 pb-3 [scrollbar-width:thin]">
        {sessions.map((s) => (
          <li key={s.id}>
            <Item
              asChild
              variant="outline"
              size="sm"
              className="child-row flex-col flex-nowrap items-stretch gap-1 bg-card py-2.5 text-foreground no-underline"
            >
              <a href={`/s/${encodeURIComponent(s.id)}`}>
                <span className="child-top flex items-center justify-between gap-2">
                  <span className="child-title min-w-0 truncate text-sm font-semibold">{s.title}</span>
                  <StatusChip status={effectiveStatus(s)} />
                </span>
                {s.preview && (
                  <span className="child-preview line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {s.preview}
                  </span>
                )}
              </a>
            </Item>
          </li>
        ))}
      </ul>
    </>
  );
  if (!wide)
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()}>
        <SheetContent
          id={id}
          side="bottom"
          showCloseButton={false}
          aria-modal="true"
          aria-describedby={undefined}
          aria-labelledby={`${id}-h`}
          className="sessions-panel max-h-[min(75dvh,36rem)] rounded-t-2xl pb-[var(--safe-b)]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (event.target instanceof HTMLElement) event.target.focus();
          }}
        >
          {contents}
        </SheetContent>
      </Sheet>
    );
  return (
    <aside
      ref={root}
      tabIndex={-1}
      className={cn("sessions-panel w-75 flex-none outline-none", SIDE_PANEL)}
      id={id}
      aria-labelledby={`${id}-h`}
      onKeyDown={(event) => event.key === "Escape" && onClose()}
    >
      {contents}
    </aside>
  );
}
