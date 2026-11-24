/** Shared look of the approval and takeover cards: the label/value facts list and the attention-tinted surface. */

/** A `<dl>` of facts; each row is a `<div>` holding a `<dt>` and `<dd>`. `--dt` is the label column's width. */
export const FACTS =
  "approval-facts m-0 flex flex-col gap-1 text-sm [--dt:6.5rem] max-md:[--dt:5rem] [&>div]:flex [&>div]:min-w-0 [&>div]:items-baseline [&>div]:gap-2.5 [&_dt]:w-(--dt) [&_dt]:shrink-0 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:text-foreground/80 [&_dd]:[overflow-wrap:anywhere]";

/** The surface of a card that needs you: a card with an attention-coloured edge along its left side. */
export const NEEDS_YOU =
  "approval relative gap-0 rounded-2xl bg-card ring-attention-border before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-attention";

/** A decided or finished card: one quiet line. */
export const DONE =
  "approval-done gap-0 rounded-2xl bg-muted/50 py-2 shadow-none ring-border [--card-spacing:--spacing(3)]";

export const HEAD = "approval-head m-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm";
export const SUMMARY = "approval-summary m-0 text-base leading-snug font-medium [overflow-wrap:anywhere]";
export const ACTIONS =
  "approval-actions flex flex-wrap justify-end gap-2.5 border-t pt-3 max-md:[&>*]:min-h-11 max-md:[&>*]:flex-1 [.float-cards_&>*]:flex-1";
