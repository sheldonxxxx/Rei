import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/primitives/alert-dialog.tsx";
import { cn } from "@/lib/utils.ts";
import { Icon } from "./Icon.tsx";

/** A native checkbox or radio: kept native (forms and tests read `.checked`), drawn in the app's colour. */
export const NATIVE_CHECK = "size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed";

/** One choice among several, drawn as a bordered card around a native radio (the card lights up when its radio is checked). */
export const OPTION_CARD =
  "flex cursor-pointer items-start gap-3 rounded-2xl border px-3.5 py-3 transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-muted has-focus-visible:ring-3 has-focus-visible:ring-ring/30 has-disabled:cursor-not-allowed has-disabled:opacity-60";

/** A failure inside a dialog: announced when it appears, tinted so it can't be missed. */
export function DialogError({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      role="alert"
      className={cn(
        "m-0 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** A warning inside a dialog (YOLO, effects that can't be undone): the attention colour, never red. */
export function DialogWarning({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "m-0 flex items-start gap-2 rounded-2xl bg-attention-soft px-3 py-2.5 text-sm font-medium text-attention-text",
        className,
      )}
    >
      <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

interface ConfirmProps {
  title: string;
  /** What will happen. Paragraphs are fine; this is the dialog's description. */
  description: ReactNode;
  /** Extra choices between the description and the buttons (a checkbox). */
  children?: ReactNode;
  error?: string | null | undefined;
  busy?: boolean;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  /** Red for deleting, the plain primary look otherwise. */
  tone?: "destructive" | "default";
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * A confirmation: an alert dialog whose first focus is Cancel (the safe choice). While `busy` it can't be dismissed, and
 * the confirm button never closes it on its own: whoever confirms decides when it is done.
 */
export function ConfirmDialog({
  title,
  description,
  children,
  error,
  busy = false,
  confirmLabel,
  busyLabel,
  cancelLabel = "Cancel",
  tone = "destructive",
  confirmDisabled = false,
  onCancel,
  onConfirm,
}: ConfirmProps) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <AlertDialogContent onEscapeKeyDown={(e) => busy && e.preventDefault()}>
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2 text-pretty [overflow-wrap:anywhere] [&_p]:m-0">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        {error && <DialogError>{error}</DialogError>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={tone}
            disabled={busy || confirmDisabled}
            aria-busy={busy || undefined}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {busy && busyLabel ? busyLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
