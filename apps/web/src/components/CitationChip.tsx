import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/popover.tsx";

export function CitationChip({ label, more = 0, children }: { label: string; more?: number; children: ReactNode }) {
  const [mode, setMode] = useState<"closed" | "preview" | "pinned">("closed");
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const restoringFocus = useRef(false);
  const name = more ? `${label} +${more}` : label;

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  function preview() {
    window.clearTimeout(leaveTimer.current);
    setMode((current) => (current === "closed" ? "preview" : current));
  }

  function leave() {
    window.clearTimeout(leaveTimer.current);
    // Allow the pointer to cross the gap between the chip and its card.
    leaveTimer.current = window.setTimeout(() => {
      if (trigger.current?.matches(":focus-visible") || card.current?.contains(document.activeElement)) return;
      setMode((current) => (current === "preview" ? "closed" : current));
    }, 180);
  }

  return (
    <Popover open={mode !== "closed"} onOpenChange={(open) => !open && setMode("closed")}>
      <PopoverTrigger asChild>
        <Button
          ref={trigger}
          variant="secondary"
          className="md-citation h-auto gap-[0.3em] rounded-full border-0 bg-foreground/8 px-[0.65em] py-[0.1em] text-[0.75em] leading-[1.6] text-muted-foreground hover:bg-foreground/14 hover:text-foreground aria-expanded:bg-foreground/14 aria-expanded:text-foreground"
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") preview();
          }}
          onPointerLeave={leave}
          onFocus={(event) => {
            if (!restoringFocus.current && event.currentTarget.matches(":focus-visible")) preview();
          }}
          onClick={(event) => {
            event.preventDefault();
            window.clearTimeout(leaveTimer.current);
            setMode(mode === "pinned" ? "closed" : "pinned");
            if (mode === "preview") card.current?.focus({ preventScroll: true });
          }}
        >
          <span className="truncate">{label}</span>
          {more > 0 && <span>+{more}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={card}
        aria-label={name}
        align="start"
        side="top"
        collisionPadding={8}
        className="md-citation-card w-[min(20rem,calc(100vw-1rem))] gap-2.5 rounded-xl p-3"
        onPointerEnter={() => window.clearTimeout(leaveTimer.current)}
        onPointerLeave={leave}
        onOpenAutoFocus={(event) => {
          if (mode === "preview") event.preventDefault();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => {
          if (card.current?.contains(document.activeElement)) {
            restoringFocus.current = true;
            trigger.current?.focus({ preventScroll: true });
            restoringFocus.current = false;
          }
        }}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
