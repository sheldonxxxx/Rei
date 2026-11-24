import type { FocusEvent, ReactElement } from "react";
import { Kbd } from "@/components/primitives/kbd.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/primitives/tooltip.tsx";

/** Focus that code moved here (a panel focusing its close button as it opens) is not a keyboard visit, so it shows no tooltip. */
function quietFocus(e: FocusEvent<HTMLElement>) {
  try {
    if (!e.currentTarget.matches(":focus-visible")) e.preventDefault();
  } catch {
    // :focus-visible is not supported here; fall back to showing the tooltip.
  }
}

/** A tooltip on one control: hover or keyboard focus shows `label` (and the `shortcut` as keys). The child keeps its own aria-label.
 *  Tooltips use layer 60, above dialogs (40) and popups (50).
 *  Radix needs a provider above every tooltip, so each Tip brings one rather than every test and screen having to supply it. */
export function Tip({
  label,
  shortcut,
  side,
  className,
  children,
}: {
  label: string;
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  children: ReactElement;
}) {
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild onFocus={quietFocus}>
          {children}
        </TooltipTrigger>
        <TooltipContent side={side} className={className}>
          {label}
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
