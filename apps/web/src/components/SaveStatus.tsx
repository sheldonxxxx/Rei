/** The line beside a settings form's Save button: "Unsaved changes" while the form differs from the server, then `saved` after a save. */
export function SaveStatus({ dirty, saved, message = "Saved." }: { dirty: boolean; saved: boolean; message?: string }) {
  if (dirty)
    return (
      <p role="status" className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
        Unsaved changes
      </p>
    );
  if (saved)
    return (
      <p role="status" className="m-0 text-sm text-muted-foreground">
        {message}
      </p>
    );
  return null;
}
