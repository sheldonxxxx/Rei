/** Shared look of the Inspector's detail views. */

/** A `<dl>` of label/value pairs; each pair is a `<div>` holding a `<dt>` and `<dd>`. */
export const FACTS =
  "facts m-0 grid grid-cols-[minmax(5.5rem,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm [&>div]:contents [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:text-foreground [&_dd]:[overflow-wrap:anywhere]";

/** A small section label above a block ("Steps · 4", "Output"). */
export const SECTION = "ctx-h mt-1.5 mb-0.5 text-xs font-medium text-muted-foreground";

/** A quiet line of text in a panel ("Loading…", "No runs recorded yet."). */
export const QUIET = "m-0 text-sm text-muted-foreground";

/** A note in a detail view, and the note for something that went wrong. */
export const NOTE = "m-0 text-xs text-muted-foreground";
export const NOTE_ERROR =
  "m-0 flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [&>svg]:mt-0.5 [&>svg]:shrink-0";
